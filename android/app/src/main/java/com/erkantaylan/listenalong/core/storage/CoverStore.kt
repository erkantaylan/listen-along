package com.erkantaylan.listenalong.core.storage

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.File

/**
 * The covers of downloaded songs, one small image file per song id in the
 * app's private files (never in Music/ListenAlong, so no stray file shows up
 * in the user's music), so lists, the player, the notification and the car
 * have a picture with no connection. Removed with the song's download.
 */
class CoverStore(private val dir: File) {

    private val _known = MutableStateFlow<Set<String>>(emptySet())
    /** Song ids with a cover on disk (read once at start, then kept in step). */
    val known: StateFlow<Set<String>> = _known.asStateFlow()

    /** Reads what is on disk. Does I/O. */
    fun load() {
        _known.value = dir.listFiles().orEmpty().filter { it.isFile && it.name.endsWith(EXT) }
            .mapNotNullTo(HashSet()) { decode(it.name.removeSuffix(EXT)) }
    }

    fun has(songId: String): Boolean = songId in _known.value

    fun file(songId: String): File = File(dir, encode(songId) + EXT)

    /** Saves [bytes] as [songId]'s cover (written to a temporary file and renamed). Does I/O. */
    fun save(songId: String, bytes: ByteArray) {
        dir.mkdirs()
        val target = file(songId)
        val tmp = File(dir, target.name + ".tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
        _known.update { it + songId }
    }

    fun delete(songId: String) {
        file(songId).delete()
        _known.update { it - songId }
    }

    /** Deletes every cover whose song is no longer downloaded. Returns how many. Does I/O. */
    fun retainOnly(songIds: Set<String>): Int {
        val gone = _known.value - songIds
        gone.forEach { file(it).delete() }
        if (gone.isNotEmpty()) _known.update { it - gone }
        return gone.size
    }

    companion object {
        const val EXT = ".img"

        /** Song ids are UUIDs; anything else is hex-encoded so it can never escape the folder. */
        fun encode(songId: String): String =
            if (Regex("^[A-Za-z0-9-]{1,64}$").matches(songId)) songId
            else "_" + songId.toByteArray().joinToString("") { "%02x".format(it) }

        fun decode(name: String): String? = when {
            name.startsWith("_") && name.length % 2 == 1 ->
                runCatching { String(name.drop(1).chunked(2).map { it.toInt(16).toByte() }.toByteArray()) }.getOrNull()
            Regex("^[A-Za-z0-9-]{1,64}$").matches(name) -> name
            else -> null
        }
    }
}
