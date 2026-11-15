package com.erkantaylan.listenalong.core.download

import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.storage.TextStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** What the worker needs to fetch and name a song, without asking the server again. */
@Serializable
data class QueuedSong(
    val id: String,
    val title: String,
    val artist: String = "",
    val durationSec: Int? = null,
    /** For the cover saved next to the download. */
    val youtubeId: String? = null,
    /** Asked for by the user (true, the default for anything queued before playlist sync) or by playlist sync. */
    val manual: Boolean = true,
) {
    companion object {
        fun of(song: Song, manual: Boolean = true) =
            QueuedSong(song.id, song.title, song.artist, song.durationSec, youtubeId = song.youtubeId, manual = manual)
    }
}

/**
 * Songs waiting to be downloaded, persisted so they survive the process
 * dying: WorkManager restarts the worker, and the worker picks up whatever is
 * still here.
 *
 * Which entries are being worked on right now is deliberately NOT persisted.
 * After a crash nothing is running, so everything pending is up for grabs
 * again — a half-written file was already thrown away (or is left pending in
 * MediaStore, which cleans those up itself).
 */
class DownloadQueue(private val store: TextStore) {

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()
    private val running = HashSet<String>()

    private val _pending = MutableStateFlow(load())
    val pending: StateFlow<List<QueuedSong>> = _pending.asStateFlow()

    fun contains(id: String): Boolean = _pending.value.any { it.id == id }

    fun isRunning(id: String): Boolean = synchronized(lock) { id in running }

    /** Whether [id] is queued as the user's (true) rather than playlist sync's. */
    fun isManual(id: String): Boolean = _pending.value.any { it.id == id && it.manual }

    /**
     * Adds [songs] in order, skipping anything already queued, anything
     * [isDownloaded] says is on the device, and repeats within [songs] itself.
     * Returns what was actually added.
     */
    fun enqueue(songs: List<QueuedSong>, isDownloaded: (String) -> Boolean): List<QueuedSong> =
        synchronized(lock) {
            val seen = _pending.value.mapTo(HashSet()) { it.id }
            val added = songs.filter { !isDownloaded(it.id) && seen.add(it.id) }
            // The user asking for a song playlist sync had queued makes it theirs.
            val upgrade = songs.filter { it.manual }.mapTo(HashSet()) { it.id }
            val current = _pending.value.map { if (!it.manual && it.id in upgrade) it.copy(manual = true) else it }
            if (added.isNotEmpty() || current != _pending.value) write(current + added)
            added
        }

    /** The first pending song nobody is working on, now marked as running. */
    fun claimNext(): QueuedSong? = claimNext { true }

    /** The first pending song nobody is working on that [allowed] accepts, now marked as running. */
    fun claimNext(allowed: (QueuedSong) -> Boolean): QueuedSong? = synchronized(lock) {
        _pending.value.firstOrNull { it.id !in running && allowed(it) }?.also { running += it.id }
    }

    /** Done with [id], whatever the outcome: it leaves the queue. */
    fun finish(id: String) = synchronized(lock) {
        running -= id
        if (contains(id)) write(_pending.value.filterNot { it.id == id })
    }

    /** Stop working on [id] but keep it queued (the worker is being stopped). */
    fun release(id: String) = synchronized(lock) { running -= id }

    /** The user changed their mind. Returns whether it was running at the time. */
    fun cancel(id: String): Boolean = synchronized(lock) {
        val wasRunning = running.remove(id)
        if (contains(id)) write(_pending.value.filterNot { it.id == id })
        wasRunning
    }

    fun cancelAll() = synchronized(lock) {
        running.clear()
        write(emptyList())
    }

    private fun write(list: List<QueuedSong>) {
        store.write(json.encodeToString(list))
        _pending.value = list
    }

    private fun load(): List<QueuedSong> {
        val raw = store.read() ?: return emptyList()
        return runCatching { json.decodeFromString<List<QueuedSong>>(raw) }
            .getOrDefault(emptyList())
            .distinctBy { it.id }
    }
}
