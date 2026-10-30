package com.erkantaylan.listenalong.reports

import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.api.SongReport
import com.erkantaylan.listenalong.storage.TextStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Every song with an open "needs replacement" report, by song id — the
 * app's copy of the web's song-reports.js store.
 *
 * Library pages carry their songs' reports, but playlist entries, downloaded
 * songs and the player do not, so the warning icon everywhere reads from
 * here. It is filled from `GET /api/library?reported=1` ([refresh]), kept in
 * step with every library page that is loaded ([absorb]) and with the
 * answers to marking / unmarking. The last copy is saved per server, so the
 * icons still show offline; marking needs a connection (the screens disable it).
 */
class ReportStore(
    private val clientProvider: () -> LibraryClient?,
    private val store: TextStore,
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Serializable
    private data class Record(val server: String, val reports: Map<String, List<SongReport>>)

    private val _reports = MutableStateFlow<Map<String, List<SongReport>>>(emptyMap())
    /** Song id → its open reports. Songs with none are absent. */
    val reports: StateFlow<Map<String, List<SongReport>>> = _reports.asStateFlow()

    init {
        loadSaved()
    }

    fun reportsFor(songId: String?): List<SongReport> = songId?.let { _reports.value[it] }.orEmpty()

    /** The saved copy for the current server (after a server change, or at start). */
    fun loadSaved() {
        val server = clientProvider()?.baseUrl?.toString()
        val saved = store.read()?.let { runCatching { json.decodeFromString<Record>(it) }.getOrNull() }
        _reports.value = if (saved != null && saved.server == server) saved.reports else emptyMap()
    }

    /** Fetches every reported song. Throws on failure; the old copy stays. */
    suspend fun refresh() {
        val client = clientProvider() ?: return
        val songs = client.listAll(reported = true)
        _reports.value = songs.filter { it.reports.isNotEmpty() }.associate { it.id to it.reports }
        save(client)
    }

    /** Library songs fresh from the server: their reports replace what was known about them. */
    fun absorb(songs: List<Song>) {
        if (songs.isEmpty()) return
        val before = _reports.value
        val after = before.toMutableMap()
        for (song in songs) {
            if (song.reports.isEmpty()) after.remove(song.id) else after[song.id] = song.reports
        }
        if (after != before) {
            _reports.value = after
            clientProvider()?.let(::save)
        }
    }

    /** Marks a song as broken (or updates your reason). Returns whether it was an update. */
    suspend fun mark(songId: String, reason: String?): Boolean {
        val client = clientProvider() ?: error("No server set — see Settings")
        val hadMine = reportsFor(songId).any { it.mine }
        val result = client.report(songId, ReportReasons.clean(reason))
        val fresh = result.song?.reports
        _reports.update { map ->
            val list = fresh ?: (map[songId].orEmpty().filterNot { it.mine } + result.report)
            if (list.isEmpty()) map - songId else map + (songId to list)
        }
        save(client)
        return hadMine
    }

    /** Withdraws your own report on a song. */
    suspend fun unmark(songId: String) {
        val client = clientProvider() ?: error("No server set — see Settings")
        try {
            client.unmark(songId)
        } catch (e: com.erkantaylan.listenalong.api.ApiException) {
            // 404: it was not (or no longer) yours to withdraw; drop the stale copy anyway.
            if (e.code != 404) throw e
        }
        _reports.update { map ->
            val left = map[songId].orEmpty().filterNot { it.mine }
            if (left.isEmpty()) map - songId else map + (songId to left)
        }
        save(client)
    }

    private fun save(client: LibraryClient) {
        runCatching { store.write(json.encodeToString(Record(client.baseUrl.toString(), _reports.value))) }
    }
}

/** The reason presets and limits of the web's "Mark as broken" dialog. */
object ReportReasons {
    const val MAX = 200
    val PRESETS = listOf("Wrong song", "Bad audio", "Cut off", "Too quiet / too loud")

    /** As the server stores it: control characters and runs of spaces collapsed, trimmed, ≤ [MAX]; null when empty. */
    fun clean(reason: String?): String? =
        reason?.replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")
            ?.replace(Regex("\\s+"), " ")
            ?.trim()
            ?.take(MAX)
            ?.takeIf { it.isNotEmpty() }

    /** "Needs replacement — marked as broken by 2 people" (the icon's TalkBack label and tooltip). */
    fun summary(count: Int): String =
        "Needs replacement — marked as broken by $count ${if (count == 1) "person" else "people"}"

    /** "you" or the reporter's name. */
    fun who(report: SongReport): String = if (report.mine) "you" else report.reportedBy

    /** "just now", "5m ago", "3h ago", "2d ago", else the date. Blank when unparseable. */
    fun relative(timestamp: String?, now: Instant = Instant.now()): String {
        val at = timestamp?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
        val s = Duration.between(at, now).seconds.coerceAtLeast(0)
        return when {
            s < 60 -> "just now"
            s < 3600 -> "${s / 60}m ago"
            s < 86400 -> "${s / 3600}h ago"
            s < 86400L * 30 -> "${s / 86400}d ago"
            else -> DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault()).withZone(ZoneId.systemDefault()).format(at)
        }
    }

    /** One line per report: "“Wrong song” — Ayşe, 2h ago" (the Broken list's detail lines). */
    fun lines(reports: List<SongReport>, now: Instant = Instant.now()): List<String> = reports.map { r ->
        val reason = r.reason?.takeIf { it.isNotBlank() }?.let { "“$it”" } ?: "No reason given"
        val time = relative(r.updatedAt ?: r.createdAt, now)
        "$reason — ${who(r)}" + if (time.isNotEmpty()) ", $time" else ""
    }
}
