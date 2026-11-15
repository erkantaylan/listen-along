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
import kotlinx.serialization.SerializationException
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
 * Saved per server AND account (another server's or account's playlists are
 * other playlists): one record each in [store]. The download index is
 * global, so a record never removes anything it did not itself want. When
 * the app can no longer sync a record (the server address changed, another
 * account signed in), its playlists stop being synced and their files
 * become the user's own (`manual`), so nothing ever removes them later.
 * Signing out alone changes nothing: the same account signing in again
 * carries on. A store that cannot be read is copied to [corruptStore], its
 * files become the user's own, and the app starts over with no removals.
 * The songs whose file the server lacks (404) are kept with the time, and
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
    /** The signed-in account's id when known (null signed out, or not learnt yet). */
    private val account: () -> String? = { null },
    /** Asks the server who is signed in (a session saved before the app kept the id); null when it cannot tell. */
    private val learnAccount: suspend () -> String? = { null },
    /** Where an unreadable record store is copied before starting over. */
    private val corruptStore: TextStore? = null,
    /** Playlists that stopped being synced (another server or account): their files stayed, as the user's own. */
    private val onDetached: (List<DownloadedPlaylist>) -> Unit = {},
) {
    /** One server and account's downloaded playlists. [account] null: saved before records had one. */
    @Serializable
    private data class Record(
        val server: String,
        val account: String? = null,
        val playlists: List<DownloadedPlaylist> = emptyList(),
        val missing: Map<String, Long> = emptyMap(),
    )

    /** The store: every record. Both fields are required, so the single-record format of earlier builds never reads as an empty one. */
    @Serializable
    private data class Saved(val version: Int, val records: List<Record>)

    private data class Key(val server: String, val account: String?)

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()
    private val writeLock = Any()

    private val _playlists = MutableStateFlow<List<DownloadedPlaylist>>(emptyList())
    /** The downloaded playlists of the server and account in force. */
    val playlists: StateFlow<List<DownloadedPlaylist>> = _playlists.asStateFlow()

    private val _missing = MutableStateFlow<Map<String, Long>>(emptyMap())

    private val _hold = MutableStateFlow<SyncHold?>(null)
    /** Why playlist downloads are not running now (offline, no Wi-Fi), from the last sync. */
    val hold: StateFlow<SyncHold?> = _hold.asStateFlow()

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    /** Every record in [store] (all servers and accounts), once read. */
    private var records: List<Record>? = null
    private var loadedFor: Key? = null

    private fun server(): String? = api()?.baseUrl?.toString()

    private fun read(): List<Record> {
        val raw = store.read()
        if (raw.isNullOrBlank()) return emptyList()
        runCatching { return json.decodeFromString<Saved>(raw).records }
        runCatching { return listOf(json.decodeFromString<Record>(raw)) }
        // Unreadable: keep a copy, and make every file playlist sync saved the
        // user's own, since nothing can tell any more which playlist wanted it.
        runCatching { corruptStore?.write(raw) }
        downloads.index.markManual(downloads.index.entries.value.filterValues { !it.manual }.keys)
        return emptyList()
    }

    private fun write(all: List<Record>) {
        store.write(json.encodeToString(Saved(STORE_VERSION, all.filter { it.playlists.isNotEmpty() || it.missing.isNotEmpty() })))
        records = all
    }

    /** The record of [key], or for a signed-out key the server's record (whoever it belonged to). */
    private fun liveOf(all: List<Record>, key: Key): Record? =
        all.firstOrNull { it.server == key.server && it.account == key.account }
            ?: all.firstOrNull { it.server == key.server && (key.account == null || it.account == null) }

    /**
     * The saved record for the server and account in force (re-read after a
     * change of either). Only reads: other records are detached by the first
     * sync or enable under the new key ([syncKey]), never by merely showing
     * (a debug build starts on the saved server before its override applies).
     */
    private fun ensureLoaded() = synchronized(writeLock) {
        val all = records ?: read().also { records = it }
        val server = server()
        if (server == null) {
            _playlists.value = emptyList()
            _missing.value = emptyMap()
            loadedFor = null
            return@synchronized
        }
        val key = Key(server, account())
        if (key == loadedFor) return@synchronized
        val live = liveOf(all, key)
        _playlists.value = live?.playlists.orEmpty()
        _missing.value = live?.missing.orEmpty()
        loadedFor = key
    }

    /**
     * Records the app can no longer sync: another server's, or another
     * account's on this server ([key]'s account is known). Their
     * songs' files become the user's own first, so nothing can remove them
     * later; their queued sync downloads are cancelled; then they are
     * forgotten. A record from before accounts were kept is adopted by the
     * first account known on its server. Returns the records left.
     */
    private fun detachOthers(all: List<Record>, key: Key): List<Record> {
        val detached = all.filter { r ->
            r.playlists.isNotEmpty() &&
                (r.server != key.server || (key.account != null && r.account != null && r.account != key.account))
        }
        val adopt = key.account != null && all.none { it.server == key.server && it.account == key.account } &&
            all.any { it.server == key.server && it.account == null }
        if (detached.isEmpty() && !adopt) return all
        var rest = all - detached.toSet()
        if (adopt) rest = rest.map { if (it.server == key.server && it.account == null) it.copy(account = key.account) else it }
        if (detached.isNotEmpty()) {
            val ids = detached.flatMapTo(HashSet()) { r -> r.playlists.flatMap { it.wanted } }
            val stillWanted = rest.flatMapTo(HashSet()) { r -> r.playlists.flatMap { it.wanted } }
            downloads.index.markManual(ids)
            downloads.queue.pending.value.filter { !it.manual && it.id in ids && it.id !in stillWanted }
                .forEach { downloads.cancel(it.id) }
        }
        write(rest)
        if (detached.isNotEmpty()) runCatching { onDetached(detached.flatMap { it.playlists }) }
        return rest
    }

    /** Saves the playlists of [key], unless the server or account in force changed meanwhile. */
    private fun saveFor(key: Key, playlists: List<DownloadedPlaylist>, missing: Map<String, Long>): Boolean =
        synchronized(writeLock) {
            ensureLoaded()
            if (loadedFor != key) return@synchronized false
            val all = records.orEmpty()
            val previous = liveOf(all, key)
            // Signed out (account not known), the record stays its account's.
            val record = Record(key.server, key.account ?: previous?.account, playlists, missing)
            write(if (previous == null) all + record else all.map { if (it === previous) record else it })
            _playlists.value = playlists
            _missing.value = missing
            true
        }

    /** Songs wanted by records of other servers or accounts (normally none: they are detached). */
    private fun elsewhere(key: Key): Set<String> = synchronized(writeLock) {
        val live = liveOf(records.orEmpty(), key)
        records.orEmpty().filter { it !== live }.flatMapTo(HashSet()) { r -> r.playlists.flatMap { it.wanted } }
    }

    /**
     * The key to sync under: the account must be known (asked from the server
     * once if need be). The records of other servers and accounts are
     * detached here, before anything is synced under it.
     */
    private suspend fun syncKey(): Key? {
        if (account() == null) runCatching { learnAccount() }
        return synchronized(writeLock) {
            ensureLoaded()
            val key = loadedFor?.takeIf { it.account != null } ?: return@synchronized null
            detachOthers(records.orEmpty(), key)
            key
        }
    }

    fun reload() {
        synchronized(writeLock) {
            records = null
            loadedFor = null
        }
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
    fun markMissing(songId: String) = synchronized(writeLock) {
        ensureLoaded()
        val key = loadedFor ?: return@synchronized
        if (_playlists.value.isEmpty()) return@synchronized
        saveFor(key, _playlists.value, _missing.value + (songId to now()))
        Unit
    }

    /** Every downloaded playlist's status, live (the rows' marks, the On device list). */
    fun statuses(snapshots: Flow<DownloadSnapshot>, networkInfo: Flow<NetworkInfo>): Flow<Map<String, PlaylistDownloadStatus>> =
        combine(playlists, snapshots, networkInfo, prefs.sync, _missing) { list, snap, net, settings, missing ->
            val queued = snap.pending.mapTo(HashSet()) { it.id }
            list.associate { it.id to playlistStatus(it, snap.downloaded, queued, snap.failures, missing.keys, net, settings) }
        }

    /**
     * "Download" switched on: the playlist is remembered and synced at once.
     * Throws an IOException when the account signed in cannot be told (the
     * record would not know whose it is).
     */
    suspend fun enable(playlist: Playlist, songs: PlaylistSongs? = null) {
        lock.withLock {
            val key = syncKey() ?: throw IOException("Could not check who is signed in: try again")
            if (_playlists.value.none { it.id == playlist.id }) {
                saveFor(key, _playlists.value + DownloadedPlaylist(playlist.id, playlist.displayName, enabledAt = now()), _missing.value)
            }
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
        val key = loadedFor ?: return 0
        val record = _playlists.value.firstOrNull { it.id == playlistId } ?: return 0
        val snapshot = downloads.snapshot()
        val release = PlaylistSyncPlanner.release(
            record, _playlists.value, snapshot.downloaded,
            snapshot.pending.associate { it.id to it.manual },
            elsewhere(key),
        )
        release.cancel.forEach(downloads::cancel)
        var deleted = 0
        if (removeFiles) {
            release.removable.forEach { id -> snapshot.downloaded[id]?.let { if (downloads.deleteOwned(it)) deleted++ } }
        } else {
            downloads.index.markManual(release.keep)
        }
        val rest = _playlists.value.filterNot { it.id == playlistId }
        saveFor(key, rest, if (rest.isEmpty()) emptyMap() else _missing.value)
        schedule(rest.isNotEmpty(), prefs.sync.value.allowMetered)
        deleted
    }

    /**
     * One sync. [fresh]: song lists the caller just fetched (the playlist page
     * after a refresh), so they are not asked for again. Safe offline: nothing
     * is fetched, nothing is removed, the downloads wait. Nothing at all when
     * the account signed in is not known, or when the server or account
     * changes while it runs. Never throws for the network; returns the plan's
     * hold.
     */
    suspend fun sync(fresh: Map<String, PlaylistSongs> = emptyMap()): SyncHold? = lock.withLock {
        val key = syncKey() ?: return null
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
                    elsewhere = elsewhere(key),
                )
            )
            // The answers were for this server and account: if either changed meanwhile, they mean nothing.
            ensureLoaded()
            if (loadedFor != key) return null
            // Names follow the server's renames.
            val names = fetched.mapNotNull { (r, f) -> (f as? PlaylistFetch.Fresh ?: f as? PlaylistFetch.Partial)?.let { r.id } }.toSet()
            val renamed = plan.playlists.map { p -> repo.cachedPlaylists()?.firstOrNull { it.id == p.id && p.id in names }
                ?.let { p.copy(name = it.displayName) } ?: p }
            // Removals first: a run that dies after them finds the same list
            // next time; one that died after saving would forget them. Each
            // file is checked again (still playlist sync's own) as it goes; one
            // that cannot be deleted stays, and is not tried again.
            plan.delete.forEach { id -> downloads.index[id]?.let { runCatching { downloads.deleteOwned(it) } } }
            if (!saveFor(key, renamed, _missing.value - plan.retryMissing.toSet())) return null
            plan.cancel.forEach(downloads::cancel)
            downloads.clearFailures(plan.download.map { it.id })
            if (plan.download.isNotEmpty()) downloads.enqueue(plan.download, manual = false)
            _hold.value = plan.hold
            plan.hold
        } finally {
            _syncing.value = false
        }
    }

    private suspend fun fetch(record: DownloadedPlaylist, given: PlaylistSongs?, net: NetworkInfo): PlaylistFetch {
        if (given != null) return PlaylistFetch.of(given.songs)
        val cached = { PlaylistFetch.Stale(repo.cachedSongs(record.id)?.songs.orEmpty().mapNotNull { it.toSong() }) }
        if (!net.online) return cached()
        return try {
            val loaded = repo.songs(record.id)
            if (loaded.fromCache) PlaylistFetch.Stale(loaded.value.songs.mapNotNull { it.toSong() })
            else PlaylistFetch.of(loaded.value.songs)
        } catch (c: CancellationException) {
            throw c
        } catch (e: ApiException) {
            if (e.code == 404) PlaylistFetch.Gone else cached()
        } catch (_: IOException) {
            cached()
        } catch (_: SerializationException) {
            cached()
        }
    }

    companion object {
        private const val STORE_VERSION = 2
    }
}
