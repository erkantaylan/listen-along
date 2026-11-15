package com.erkantaylan.listenalong.core.domain

import com.erkantaylan.listenalong.core.model.PlaylistEntry
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.storage.LocalSong
import kotlinx.serialization.Serializable

/**
 * A playlist the user turned "Download" on for, as the phone remembers it.
 * [known] is the playlist's song list as last accepted (library ids, in
 * order, each once): what the downloads follow and what protects files from
 * removal. [pendingShrink] is a song list that would remove a large share of
 * the downloads at once; it is only accepted when a complete answer at least
 * [PlaylistSyncPlanner.SHRINK_CONFIRM_MS] after [pendingSince] still says the
 * same ([pendingHash] is that list's fingerprint; see
 * [PlaylistSyncPlanner.isBigShrink]).
 */
@Serializable
data class DownloadedPlaylist(
    val id: String,
    val name: String,
    val enabledAt: Long = 0,
    val known: List<String> = emptyList(),
    val pendingShrink: List<String>? = null,
    /** When [pendingShrink] was first seen (wall clock; a clock set back restarts the wait). */
    val pendingSince: Long? = null,
    /** [PlaylistSyncPlanner.fingerprint] of [pendingShrink]. */
    val pendingHash: String? = null,
    /** The server answered 404 (deleted, or made private): not synced any more, its files are kept. */
    val unavailable: Boolean = false,
    val lastSyncAt: Long? = null,
) {
    /** The songs this playlist wants on the phone now: the accepted list plus whatever a held shrink adds. */
    val wanted: List<String> get() = (known + pendingShrink.orEmpty()).distinct()
}

/** What the sync learnt about a playlist this time. */
sealed interface PlaylistFetch {
    /**
     * The server's complete list, just now: every entry named its library
     * song. The only kind of answer that can remove anything.
     */
    data class Fresh(val songs: List<Song>) : PlaylistFetch

    /**
     * An answer with entries that name no library song (a failed library
     * lookup on the server answers 200 with `library_id: null` everywhere,
     * or an old YouTube-only entry): [songs] are the ones that could be read.
     * New songs are downloaded; nothing is removed and a held shrink is
     * neither confirmed nor reset.
     */
    data class Partial(val songs: List<Song>) : PlaylistFetch

    /** Not asked or not answered (offline, a 5xx, a refusal, an unreadable answer): the last saved copy, for the songs' details only. */
    data class Stale(val songs: List<Song>) : PlaylistFetch

    /** The server says it does not exist for us (404). */
    data object Gone : PlaylistFetch

    companion object {
        /** A server answer: [Fresh] only when every entry maps to a library song. */
        fun of(entries: List<PlaylistEntry>): PlaylistFetch {
            val songs = entries.mapNotNull { it.toSong() }
            return if (songs.size == entries.size) Fresh(songs) else Partial(songs)
        }
    }
}

/** Whether the network in force may be used, and why not. */
data class NetworkInfo(
    val online: Boolean = true,
    /** The system says this network costs money per byte (mobile data, a metered hotspot). */
    val metered: Boolean = false,
    val roaming: Boolean = false,
    /** Data Saver (restricted background data) is on; it only restricts metered networks. */
    val dataSaver: Boolean = false,
)

data class SyncSettings(
    /** "Remove downloads of songs removed from a playlist" (default on). */
    val removeUnlisted: Boolean = true,
    /** "Download over mobile data" (default on); off = Wi-Fi / unmetered only. */
    val allowMetered: Boolean = true,
)

/** Why playlist downloads are not running now. */
enum class SyncHold { OFFLINE, WAITING_FOR_WIFI }

data class SyncInput(
    val playlists: List<Pair<DownloadedPlaylist, PlaylistFetch>>,
    val downloaded: Map<String, LocalSong>,
    /** Queued songs and whether the user asked for them (true) or playlist sync did (false). */
    val queued: Map<String, Boolean>,
    /** Songs whose file the server did not have, and when that was (they are skipped for [MISSING_RETRY_MS]). */
    val missing: Map<String, Long>,
    val settings: SyncSettings,
    val network: NetworkInfo,
    val now: Long,
    /** Songs wanted by downloaded playlists saved for another server or account: never removed. */
    val elsewhere: Set<String> = emptySet(),
)

data class SyncPlan(
    /** New downloads for playlist sync, in playlist order, each once. */
    val download: List<Song>,
    /** Files to remove (playlist sync's own, dropped by their playlist just now, wanted by none). */
    val delete: List<String>,
    /** Playlist sync's queued songs that no downloaded playlist wants any more. */
    val cancel: List<String>,
    /** The playlists as they are to be saved. */
    val playlists: List<DownloadedPlaylist>,
    /** Playlists whose removals are held this time (a big shrink not confirmed yet). */
    val heldShrinks: List<String>,
    val hold: SyncHold?,
    /** Missing-file marks old enough to try again: forget them. */
    val retryMissing: List<String>,
)

/**
 * Plans one playlist sync: a pure function of what the server said, what is
 * on the phone and the settings, so every rule is unit tested
 * (PlaylistSyncPlannerTest). Executing the plan is core/data/PlaylistDownloads.
 *
 * - Every song of every available downloaded playlist is downloaded, once,
 *   however many playlists or times it appears in; not if it is on the phone,
 *   queued, or its file was missing on the server within the last day.
 * - Removal (only with [SyncSettings.removeUnlisted]) is derived from what
 *   a playlist itself wanted, never from "everything not protected": a song
 *   may go only when it was in a playlist's previous [DownloadedPlaylist.wanted],
 *   a complete answer ([PlaylistFetch.Fresh]) just dropped it, no downloaded
 *   playlist here (available or not) or of another server / account
 *   ([SyncInput.elsewhere]) wants it, and its file is playlist sync's own
 *   (`manual` false, not `reclaimed` from an earlier install). Files the user
 *   downloaded, and every download from before playlist sync (they read as
 *   manual), are never removed.
 * - A playlist that answers 404 becomes unavailable: no new downloads, its
 *   files are kept (its songs stay protected).
 * - Offline, a fetch that failed, or an answer with entries that name no
 *   library song ([PlaylistFetch.Partial]): nothing is removed on its account.
 * - The mass-deletion guard: a complete list that is empty after a non-empty
 *   one, or that drops more than half of the songs (and at least two), is held
 *   ([DownloadedPlaylist.pendingShrink], with the time it was first seen):
 *   its new songs download, nothing is removed. It is accepted only by a
 *   complete answer with the same list at least [SHRINK_CONFIRM_MS] after
 *   it was first seen; a different list starts again; a clock set back
 *   restarts the wait instead of confirming early.
 */
object PlaylistSyncPlanner {
    /** A song whose file was missing on the server is tried again after a day. */
    const val MISSING_RETRY_MS = 24L * 60 * 60 * 1000

    /** A big shrink is accepted when the same list is still there this long after it was first seen. */
    const val SHRINK_CONFIRM_MS = 24L * 60 * 60 * 1000

    fun isBigShrink(previous: List<String>, next: List<String>): Boolean {
        if (previous.isEmpty()) return false
        if (next.isEmpty()) return true
        val removed = previous.toSet() - next.toSet()
        return removed.size >= 2 && removed.size * 2 > previous.toSet().size
    }

    /** A song list's fingerprint, order and repeats aside (SHA-256 of the sorted ids). */
    fun fingerprint(ids: Collection<String>): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        ids.toSortedSet().forEach { digest.update(it.toByteArray(Charsets.UTF_8)); digest.update(0) }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Whether playlist sync may download on this network with these settings. */
    fun mayDownload(network: NetworkInfo, settings: SyncSettings): Boolean = when {
        !network.online -> false
        !network.metered -> true
        // Metered: only with the setting on, never while roaming, never under Data Saver.
        else -> settings.allowMetered && !network.roaming && !network.dataSaver
    }

    /** A complete answer for [record]: the list as accepted, or the shrink held. */
    private fun accept(record: DownloadedPlaylist, next: List<String>, now: Long): Pair<DownloadedPlaylist, Boolean> {
        if (!isBigShrink(record.known, next)) {
            return record.copy(known = next, pendingShrink = null, pendingSince = null, pendingHash = null) to false
        }
        val hash = fingerprint(next)
        val since = record.pendingSince
        val same = since != null && record.pendingHash == hash && record.pendingShrink.orEmpty().toSet() == next.toSet()
        return when {
            // The same big shrink, a day after it was first seen: it is real.
            same && now >= since!! && now - since >= SHRINK_CONFIRM_MS ->
                record.copy(known = next, pendingShrink = null, pendingSince = null, pendingHash = null) to false
            // The same, but the clock is now before the first sighting: start the wait again from now.
            same && now < since!! -> record.copy(pendingSince = now) to true
            same -> record to true
            // A new (or different) big shrink: held from now.
            else -> record.copy(pendingShrink = next, pendingSince = now, pendingHash = hash) to true
        }
    }

    fun plan(input: SyncInput): SyncPlan {
        val details = LinkedHashMap<String, Song>()
        val updated = ArrayList<DownloadedPlaylist>()
        val held = ArrayList<String>()
        /** Songs a complete answer dropped from a playlist just now: the only removal candidates. */
        val dropped = LinkedHashSet<String>()

        for ((record, fetch) in input.playlists) {
            when (fetch) {
                PlaylistFetch.Gone -> updated += record.copy(unavailable = true)
                is PlaylistFetch.Stale -> {
                    fetch.songs.forEach { details.putIfAbsent(it.id, it) }
                    updated += record
                }
                is PlaylistFetch.Partial -> {
                    // Additions only: what it lacks proves nothing.
                    fetch.songs.forEach { details.putIfAbsent(it.id, it) }
                    val known = (record.known + fetch.songs.map { it.id }).distinct()
                    updated += record.copy(known = known, unavailable = false)
                }
                is PlaylistFetch.Fresh -> {
                    fetch.songs.forEach { details.putIfAbsent(it.id, it) }
                    val next = fetch.songs.map { it.id }.distinct()
                    val (accepted, isHeld) = accept(record, next, input.now)
                    if (isHeld) held += record.id
                    else dropped += record.wanted - accepted.wanted.toSet()
                    updated += accepted.copy(unavailable = false, lastSyncAt = input.now)
                }
            }
        }

        val retryMissing = input.missing.filterValues { input.now - it >= MISSING_RETRY_MS }.keys.toList()
        val stillMissing = input.missing.keys - retryMissing.toSet()

        // What downloads follow: the available playlists' lists.
        val wanted = LinkedHashSet<String>()
        updated.filter { !it.unavailable }.forEach { wanted += it.wanted }
        // What protects files: every downloaded playlist's best-known list, unavailable ones too, and other servers'.
        val protected = HashSet<String>(input.elsewhere)
        updated.forEach { protected += it.wanted }

        val download = wanted.asSequence()
            .filter { it !in input.downloaded && it !in input.queued && it !in stillMissing }
            .mapNotNull { details[it] }
            .toList()

        val delete = if (!input.settings.removeUnlisted) emptyList() else dropped
            .filter { it !in protected && input.queued[it] != true }
            .filter { id -> input.downloaded[id]?.let { !it.manual && !it.reclaimed } == true }

        val cancel = input.queued.filter { (id, manual) -> !manual && id !in wanted }.keys.toList()

        val autoPending = download.isNotEmpty() || input.queued.any { (id, manual) -> !manual && id in wanted }
        val hold = when {
            !input.network.online && autoPending -> SyncHold.OFFLINE
            autoPending && !mayDownload(input.network, input.settings) -> SyncHold.WAITING_FOR_WIFI
            else -> null
        }
        return SyncPlan(download, delete, cancel, updated, held, hold, retryMissing)
    }

    /**
     * The Download switch turned off for [record]. Its songs that another
     * downloaded playlist holds ([others], or [elsewhere]: another server's or
     * account's) are left alone. Of the rest, the files playlist sync saved
     * ([LocalSong.manual] false, not [LocalSong.reclaimed]) are
     * [Release.removable] (deleted when the user chose "Remove downloads") or
     * become the user's own ([Release.keep], marked manual when they chose to
     * keep them, so no later sync removes them); [Release.cancel] are its
     * queued sync downloads.
     */
    fun release(
        record: DownloadedPlaylist,
        others: List<DownloadedPlaylist>,
        downloaded: Map<String, LocalSong>,
        queued: Map<String, Boolean>,
        elsewhere: Set<String> = emptySet(),
    ): Release {
        val held = others.filter { it.id != record.id }.flatMapTo(HashSet(elsewhere)) { it.wanted }
        val mine = record.wanted.filter { it !in held }
        val owned = mine.mapNotNull { downloaded[it] }.filter { !it.manual && !it.reclaimed }.map { it.songId }
        val cancel = mine.filter { queued[it] == false }
        return Release(removable = owned, keep = owned, cancel = cancel)
    }

    data class Release(val removable: List<String>, val keep: List<String>, val cancel: List<String>)
}

/** What a downloaded playlist shows next to its name. */
sealed interface PlaylistDownloadStatus {
    data object Off : PlaylistDownloadStatus
    data class Downloaded(val count: Int, val bytes: Long, val missingOnServer: Int = 0) : PlaylistDownloadStatus
    data class Downloading(val done: Int, val total: Int, val bytes: Long) : PlaylistDownloadStatus
    data class WaitingForWifi(val done: Int, val total: Int, val bytes: Long) : PlaylistDownloadStatus
    /** Wanted but offline (nothing can run). */
    data class Paused(val done: Int, val total: Int, val bytes: Long) : PlaylistDownloadStatus
    data class Failed(val done: Int, val total: Int, val bytes: Long, val message: String) : PlaylistDownloadStatus
    data class Unavailable(val done: Int, val bytes: Long) : PlaylistDownloadStatus
}

/**
 * A downloaded playlist's status (pure): [failures] are this run's download
 * failures by song id, [missing] the songs whose file the server lacks.
 */
fun playlistStatus(
    record: DownloadedPlaylist?,
    downloaded: Map<String, LocalSong>,
    queued: Set<String>,
    failures: Map<String, String>,
    missing: Set<String>,
    network: NetworkInfo,
    settings: SyncSettings,
): PlaylistDownloadStatus {
    if (record == null) return PlaylistDownloadStatus.Off
    val ids = record.wanted
    val here = ids.filter { it in downloaded }
    val bytes = here.sumOf { downloaded[it]?.bytes ?: 0 }
    if (record.unavailable) return PlaylistDownloadStatus.Unavailable(here.size, bytes)
    val notOnServer = ids.count { it !in downloaded && it in missing }
    val total = ids.size - notOnServer
    val pending = ids.count { it in queued }
    val failed = ids.filter { it !in downloaded && it !in queued && it in failures && it !in missing }
    return when {
        here.size >= total -> PlaylistDownloadStatus.Downloaded(here.size, bytes, notOnServer)
        pending > 0 && !network.online -> PlaylistDownloadStatus.Paused(here.size, total, bytes)
        pending > 0 && !PlaylistSyncPlanner.mayDownload(network, settings) -> PlaylistDownloadStatus.WaitingForWifi(here.size, total, bytes)
        pending > 0 -> PlaylistDownloadStatus.Downloading(here.size, total, bytes)
        failed.isNotEmpty() -> PlaylistDownloadStatus.Failed(here.size, total, bytes, failures.getValue(failed.first()))
        !network.online -> PlaylistDownloadStatus.Paused(here.size, total, bytes)
        else -> PlaylistDownloadStatus.Downloading(here.size, total, bytes)
    }
}
