package com.erkantaylan.listenalong.feature.downloads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.PlaylistDownloads
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.domain.DownloadedPlaylist
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.domain.sortedForDevice
import com.erkantaylan.listenalong.core.domain.toSong
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.core.ui.UserMessages
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A downloaded playlist in On device: what the phone remembers, what the list knows of it, its status. */
data class DeviceListPlaylist(
    val record: DownloadedPlaylist,
    /** From the saved playlists list (owner, privacy); null when it is not there (unavailable). */
    val playlist: Playlist?,
    val status: PlaylistDownloadStatus,
) {
    val id: String get() = record.id
    val name: String get() = playlist?.displayName ?: record.name
}

data class OnDeviceUi(
    val query: String = "",
    val snapshot: DownloadSnapshot = DownloadSnapshot(),
    /** Downloaded playlists first (Spotify's "Downloaded" shelf), in the order they were turned on. */
    val playlists: List<DeviceListPlaylist> = emptyList(),
    /**
     * Songs downloaded on their own: the user's downloads, and anything no
     * available downloaded playlist holds; matching [query], artist then title.
     */
    val songs: List<LocalSong> = emptyList(),
    /** Every downloaded song (for "Play all"), matching [query]. */
    val allSongs: List<LocalSong> = emptyList(),
    val refreshing: Boolean = false,
) {
    val asSongs: List<Song> get() = songs.map { it.toSong() }
    val allAsSongs: List<Song> get() = allSongs.map { it.toSong() }
    val totalBytes: Long get() = snapshot.downloaded.values.sumOf { it.bytes }
    val reclaimedCount: Int get() = snapshot.downloaded.values.count { it.reclaimed }
}

/**
 * On device: downloaded playlists, then songs downloaded on their own, and
 * the queue while it runs. Pull to refresh forgets files deleted elsewhere,
 * recognises files already in the folder and syncs the downloaded playlists.
 */
class OnDeviceViewModel(
    private val downloads: Downloads,
    private val messages: UserMessages,
    private val playlistDownloads: PlaylistDownloads,
    statuses: StateFlow<Map<String, PlaylistDownloadStatus>>,
    private val repo: PlaylistRepository,
) : ViewModel() {

    private val query = MutableStateFlow("")
    private val refreshing = MutableStateFlow(false)

    val state: StateFlow<OnDeviceUi> = combine(
        downloads.snapshots, query, refreshing, playlistDownloads.playlists, statuses,
    ) { snapshot, q, busy, records, status ->
        build(snapshot, q, busy, records, status)
    }.stateIn(
        viewModelScope, SharingStarted.Eagerly,
        build(downloads.snapshot(), "", false, playlistDownloads.playlists.value, statuses.value),
    )

    private fun build(
        snapshot: DownloadSnapshot,
        q: String,
        busy: Boolean,
        records: List<DownloadedPlaylist>,
        status: Map<String, PlaylistDownloadStatus>,
    ): OnDeviceUi {
        val known = repo.cachedPlaylists().orEmpty().associateBy { it.id }
        val held = records.filter { !it.unavailable }.flatMapTo(HashSet()) { it.wanted }
        val all = sortedForDevice(snapshot.downloaded.values, q)
        val needle = q.trim().lowercase()
        val lists = records
            .map { DeviceListPlaylist(it, known[it.id], status[it.id] ?: PlaylistDownloadStatus.Off) }
            .filter { needle.isEmpty() || it.name.lowercase().contains(needle) }
        return OnDeviceUi(
            query = q,
            snapshot = snapshot,
            playlists = lists,
            songs = all.filter { it.manual || it.songId !in held },
            allSongs = all,
            refreshing = busy,
        )
    }

    fun onQueryChange(text: String) {
        query.value = text
    }

    fun refresh() {
        refreshing.value = true
        viewModelScope.launch {
            val gone = downloads.reconcile()
            val found = downloads.reclaim(force = true)
            runCatching { playlistDownloads.sync() }
            refreshing.update { false }
            if (gone > 0) messages.say("$gone deleted outside the app — forgotten")
            if (found > 0) messages.say("$found songs found in the folder")
        }
    }

    fun cancel(songId: String) = downloads.cancel(songId)

    fun cancelAll() = downloads.cancelAll()

    /** A downloaded playlist that is no longer available: stop remembering it ([removeFiles] as when turning Download off). */
    fun forget(playlistId: String, removeFiles: Boolean) {
        viewModelScope.launch { playlistDownloads.disable(playlistId, removeFiles) }
    }

    /**
     * Deletes the file. An earlier install's file needs the system's consent
     * prompt, which only the activity can show: [needsConsent] asks for it.
     */
    fun delete(song: LocalSong, needsConsent: (LocalSong) -> Unit) {
        viewModelScope.launch {
            if (downloads.delete(song)) messages.say("Deleted") else needsConsent(song)
        }
    }

    /** The downloaded playlists that hold [songId] (deleting it from the phone: it would come back). */
    fun playlistsHolding(songId: String): List<String> =
        playlistDownloads.playlists.value.filter { !it.unavailable && songId in it.wanted }.map { it.name }
}
