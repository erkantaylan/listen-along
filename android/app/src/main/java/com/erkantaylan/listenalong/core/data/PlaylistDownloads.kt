package com.erkantaylan.listenalong.core.data

import com.erkantaylan.listenalong.core.domain.DownloadedPlaylist
import com.erkantaylan.listenalong.core.domain.NetworkInfo
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.domain.PlaylistFetch
import com.erkantaylan.listenalong.core.domain.PlaylistSyncPlanner
import com.erkantaylan.listenalong.core.domain.SyncHold
import com.erkantaylan.listenalong.core.domain.SyncInput
import com.erkantaylan.listenalong.core.domain.SyncSettings
import com.erkantaylan.listenalong.core.domain.playlistStatus
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.PlaylistSongs
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.ApiProvider
import com.erkantaylan.listenalong.core.storage.TextStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException

/** "Download over mobile data" and "Remove downloads of songs removed from a playlist" (SettingsStore). */
interface DownloadPrefs {
    val sync: StateFlow<SyncSettings>
    fun setAllowMetered(allow: Boolean)
    fun setRemoveUnlisted(remove: Boolean)
}

/**
 * Downloaded playlists ("Download" switched on), kept in step with the
 * server: every song of such a playlist is downloaded, songs added later
 * (by anyone, anywhere) follow, songs removed are removed with the rules of
 * [PlaylistSyncPlanner] (the plan is pure; this runs it). The app has no
 * live updates, so the sync runs at moments: the app starts, the playlists
 * or a downloaded playlist are loaded or pulled to refresh, the connection
 * returns, and every 6 hours in the background (PlaylistSyncWorker). Each run
 * is idempotent: the queue, the index and the saved records make a repeated
 * or interrupted run pick up where the last one stopped.
 *
 * Saved per server (another server's playlists are other playlists); the
 * songs whose file the server lacks (404) are kept with the time, and
 * skipped for a day.
 */
class PlaylistDownloads(
    private val store: TextStore,
    private val api: ApiProvider,
    private val repo: PlaylistRepository,
    private val downloads: Downloads,
    private val prefs: DownloadPrefs,
    private val network: () -> NetworkInfo,
    private val now: () -> Long = System::currentTimeMillis,
    /** Keeps the background sync scheduled while there is something to sync (WorkManager). */
    private val schedule: (enabled: Boolean, allowMetered: Boolean) -> Unit = { _, _ -> },
) {
    @Serializable
    private data class Record(
        val server: String,
        val playlists: List<DownloadedPlaylist> = emptyList(),
        val missing: Map<String, Long> = emptyMap(),
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()
    private val writeLock = Any()

    private val _playlists = MutableStateFlow<List<DownloadedPlaylist>>(emptyList())
    /** The downloaded playlists of the server in force. */
    val playlists: StateFlow<List<DownloadedPlaylist>> = _playlists.asStateFlow()

    private val _missing = MutableStateFlow<Map<String, Long>>(emptyMap())

    private val _hold = MutableStateFlow<SyncHold?>(null)
    /** Why playlist downloads are not running now (offline, no Wi-Fi), from the last sync. */
    val hold: StateFlow<SyncHold?> = _hold.asStateFlow()

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    private var loadedFor: String? = null

    private fun server(): String? = api()?.baseUrl?.toString()

    /** The saved record for the server in force (re-read after a server change). */
    private fun ensureLoaded() = synchronized(writeLock) {
        val server = server()
        if (server == loadedFor) return@synchronized
        val saved = store.read()?.let { runCatching { json.decodeFromString<Record>(it) }.getOrNull() }
        val mine = saved?.takeIf { it.server == server }
        _playlists.value = mine?.playlists.orEmpty()
        _missing.value = mine?.missing.orEmpty()
        loadedFor = server
    }

    private fun save(playlists: List<DownloadedPlaylist>, missing: Map<String, Long>) = synchronized(writeLock) {
        val server = server() ?: return@synchronized
        store.write(json.encodeToString(Record(server, playlists, missing)))
        _playlists.value = playlists
        _missing.value = missing
        loadedFor = server
    }

    fun reload() {
        loadedFor = null
        ensureLoaded()
        schedule(_playlists.value.isNotEmpty(), prefs.sync.value.allowMetered)
    }

    fun isDownloaded(playlistId: String): Boolean {
        ensureLoaded()
        return _playlists.value.any { it.id == playlistId }
    }

    fun record(playlistId: String): DownloadedPlaylist? {
        ensureLoaded()
        return _playlists.value.firstOrNull { it.id == playlistId }
    }

    /** The server did not have this song's file (404): skip it for a day. */
    fun markMissing(songId: String) {
        ensureLoaded()
        if (_playlists.value.isEmpty()) return
        save(_playlists.value, _missing.value + (songId to now()))
    }

    /** Every downloaded playlist's status, live (the rows' marks, the On device list). */
    fun statuses(snapshots: Flow<DownloadSnapshot>, networkInfo: Flow<NetworkInfo>): Flow<Map<String, PlaylistDownloadStatus>> =
        combine(playlists, snapshots, networkInfo, prefs.sync, _missing) { list, snap, net, settings, missing ->
            val queued = snap.pending.mapTo(HashSet()) { it.id }
            list.associate { it.id to playlistStatus(it, snap.downloaded, queued, snap.failures, missing.keys, net, settings) }
        }

    /** "Download" switched on: the playlist is remembered and synced at once. */
    suspend fun enable(playlist: Playlist, songs: PlaylistSongs? = null) {
        ensureLoaded()
        if (_playlists.value.none { it.id == playlist.id }) {
            save(_playlists.value + DownloadedPlaylist(playlist.id, playlist.displayName, enabledAt = now()), _missing.value)
        }
        schedule(true, prefs.sync.value.allowMetered)
        sync(fresh = songs?.let { mapOf(playlist.id to it) }.orEmpty())
    }

    /**
     * "Download" switched off. [removeFiles]: delete the files playlist sync
     * saved for it that no other downloaded playlist holds (the user's own
     * downloads stay); otherwise those files become the user's own and stay.
     * Returns how many files were deleted.
     */
    suspend fun disable(playlistId: String, removeFiles: Boolean): Int = lock.withLock {
        ensureLoaded()
        val record = _playlists.value.firstOrNull { it.id == playlistId } ?: return 0
        val snapshot = downloads.snapshot()
        val release = PlaylistSyncPlanner.release(
            record, _playlists.value, snapshot.downloaded,
            snapshot.pending.associate { it.id to it.manual },
        )
        release.cancel.forEach(downloads::cancel)
        var deleted = 0
        if (removeFiles) {
            release.removable.forEach { id -> snapshot.downloaded[id]?.let { if (downloads.deleteOwned(it)) deleted++ } }
        } else {
            downloads.index.markManual(release.keep)
        }
        val rest = _playlists.value.filterNot { it.id == playlistId }
        save(rest, if (rest.isEmpty()) emptyMap() else _missing.value)
        schedule(rest.isNotEmpty(), prefs.sync.value.allowMetered)
        deleted
    }

    /**
     * One sync. [fresh]: song lists the caller just fetched (the playlist page
     * after a refresh), so they are not asked for again. Safe offline: nothing
     * is fetched, nothing is removed, the downloads wait. Never throws for
     * the network; returns the plan's hold.
     */
    suspend fun sync(fresh: Map<String, PlaylistSongs> = emptyMap()): SyncHold? = lock.withLock {
        ensureLoaded()
        val records = _playlists.value
        if (records.isEmpty()) {
            _hold.value = null
            return null
        }
        _syncing.value = true
        try {
            val net = network()
            val fetched = records.map { it to fetch(it, fresh[it.id], net) }
            val snapshot = downloads.snapshot()
            val plan = PlaylistSyncPlanner.plan(
                SyncInput(
                    playlists = fetched,
                    downloaded = snapshot.downloaded,
                    queued = snapshot.pending.associate { it.id to it.manual },
                    missing = _missing.value,
                    settings = prefs.sync.value,
                    network = net,
                    now = now(),
                )
            )
            // Names follow the server's renames.
            val names = fetched.mapNotNull { (r, f) -> (f as? PlaylistFetch.Fresh)?.let { r.id } }.toSet()
            val renamed = plan.playlists.map { p -> repo.cachedPlaylists()?.firstOrNull { it.id == p.id && p.id in names }
                ?.let { p.copy(name = it.displayName) } ?: p }
            save(renamed, _missing.value - plan.retryMissing.toSet())
            plan.cancel.forEach(downloads::cancel)
            downloads.clearFailures(plan.download.map { it.id })
            if (plan.download.isNotEmpty()) downloads.enqueue(plan.download, manual = false)
            plan.delete.forEach { id -> downloads.index[id]?.let { downloads.deleteOwned(it) } }
            _hold.value = plan.hold
            plan.hold
        } finally {
            _syncing.value = false
        }
    }

    private suspend fun fetch(record: DownloadedPlaylist, given: PlaylistSongs?, net: NetworkInfo): PlaylistFetch {
        if (given != null) return PlaylistFetch.Fresh(given.songs.mapNotNull { it.toSong() })
        val cached = { PlaylistFetch.Stale(repo.cachedSongs(record.id)?.songs.orEmpty().mapNotNull { it.toSong() }) }
        if (!net.online) return cached()
        return try {
            val loaded = repo.songs(record.id)
            if (loaded.fromCache) PlaylistFetch.Stale(loaded.value.songs.mapNotNull { it.toSong() })
            else PlaylistFetch.Fresh(loaded.value.songs.mapNotNull { it.toSong() })
        } catch (c: CancellationException) {
            throw c
        } catch (e: ApiException) {
            if (e.code == 404) PlaylistFetch.Gone else cached()
        } catch (_: IOException) {
            cached()
        }
    }
}
