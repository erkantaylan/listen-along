package com.erkantaylan.listenalong.storage

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** A song that is on the device: which library song, and where MediaStore put it. */
@Serializable
data class LocalSong(
    val songId: String,
    /** content:// URI of the MediaStore row. */
    val uri: String,
    /** What MediaStore actually named it — it appends " (1)" on a clash. */
    val displayName: String,
    val title: String,
    val artist: String = "",
    val durationSec: Int? = null,
    val mimeType: String,
    val bytes: Long = 0,
    val savedAt: Long = 0,
)

/**
 * Song id -> MediaStore URI, for everything downloaded.
 *
 * This is how the app knows what is on the device and avoids fetching a song
 * twice. It is a record, not the truth: the user can delete a file from any
 * file manager or player, so [reconcile] drops entries whose file is gone.
 *
 * Plain JSON in SharedPreferences, like kitaplik's stores: a few hundred
 * records filtered in memory need neither SQL nor a schema.
 */
class DownloadIndex(private val store: TextStore) {

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()

    private val _entries = MutableStateFlow(load())
    val entries: StateFlow<Map<String, LocalSong>> = _entries.asStateFlow()

    operator fun get(songId: String): LocalSong? = _entries.value[songId]

    fun contains(songId: String): Boolean = _entries.value.containsKey(songId)

    fun put(song: LocalSong) = mutate { it + (song.songId to song) }

    fun remove(songId: String) = mutate { it - songId }

    /**
     * Drops every entry whose file no longer exists and returns them.
     * [exists] does I/O; call this off the main thread.
     */
    fun reconcile(exists: (LocalSong) -> Boolean): List<LocalSong> {
        val missing = _entries.value.values.filterNot { runCatching { exists(it) }.getOrDefault(true) }
        if (missing.isNotEmpty()) {
            val ids = missing.map { it.songId }.toSet()
            mutate { current -> current.filterKeys { it !in ids } }
        }
        return missing
    }

    private fun mutate(change: (Map<String, LocalSong>) -> Map<String, LocalSong>) {
        synchronized(lock) {
            val next = change(_entries.value)
            store.write(json.encodeToString(next.values.toList()))
            _entries.value = next
        }
    }

    private fun load(): Map<String, LocalSong> {
        val raw = store.read() ?: return emptyMap()
        return runCatching { json.decodeFromString<List<LocalSong>>(raw) }
            .getOrDefault(emptyList())
            .associateBy { it.songId }
    }
}
