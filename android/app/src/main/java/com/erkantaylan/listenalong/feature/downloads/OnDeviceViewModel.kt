package com.erkantaylan.listenalong.feature.downloads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.domain.sortedForDevice
import com.erkantaylan.listenalong.core.domain.toSong
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.Downloads
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

data class OnDeviceUi(
    val query: String = "",
    val snapshot: DownloadSnapshot = DownloadSnapshot(),
    /** The downloaded songs matching [query], artist then title. */
    val songs: List<LocalSong> = emptyList(),
    val refreshing: Boolean = false,
) {
    val asSongs: List<Song> get() = songs.map { it.toSong() }
    val totalBytes: Long get() = snapshot.downloaded.values.sumOf { it.bytes }
    val reclaimedCount: Int get() = snapshot.downloaded.values.count { it.reclaimed }
}

/**
 * On device: the downloaded songs (from the download index, [Downloads]) and
 * the queue while it runs. Pull to refresh forgets files deleted elsewhere
 * and recognises files already in the folder.
 */
class OnDeviceViewModel(
    private val downloads: Downloads,
    private val messages: UserMessages,
) : ViewModel() {

    private val query = MutableStateFlow("")
    private val refreshing = MutableStateFlow(false)

    val state: StateFlow<OnDeviceUi> = combine(downloads.snapshots, query, refreshing) { snapshot, q, busy ->
        OnDeviceUi(q, snapshot, sortedForDevice(snapshot.downloaded.values, q), busy)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, OnDeviceUi(snapshot = downloads.snapshot()).let {
        it.copy(songs = sortedForDevice(it.snapshot.downloaded.values, ""))
    })

    fun onQueryChange(text: String) {
        query.value = text
    }

    fun refresh() {
        refreshing.value = true
        viewModelScope.launch {
            val gone = downloads.reconcile()
            val found = downloads.reclaim(force = true)
            refreshing.update { false }
            if (gone > 0) messages.say("$gone deleted outside the app — forgotten")
            if (found > 0) messages.say("$found songs found in the folder")
        }
    }

    fun cancel(songId: String) = downloads.cancel(songId)

    fun cancelAll() = downloads.cancelAll()

    /**
     * Deletes the file. An earlier install's file needs the system's consent
     * prompt, which only the activity can show: [needsConsent] asks for it.
     */
    fun delete(song: LocalSong, needsConsent: (LocalSong) -> Unit) {
        viewModelScope.launch {
            if (downloads.delete(song)) messages.say("Deleted") else needsConsent(song)
        }
    }
}
