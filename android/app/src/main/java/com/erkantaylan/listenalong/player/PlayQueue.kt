package com.erkantaylan.listenalong.player

import androidx.media3.common.PlaybackException
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.LocalSong

/** Where one queued song's audio comes from. */
sealed interface PlaySource {
    val uri: String

    /** The downloaded file (a MediaStore content:// URI): plays with no connection. */
    data class Local(override val uri: String) : PlaySource

    /** `/api/library/:id/file` on the server, with the Bearer token added by the HTTP client. */
    data class Stream(override val uri: String) : PlaySource
}

/** One entry of the play queue, decided before it is handed to the player. */
data class QueueEntry(val song: Song, val source: PlaySource)

/** What [PlayQueue.build] produced: the entries, where to start, and what was left out. */
data class BuiltQueue(val entries: List<QueueEntry>, val startIndex: Int, val skipped: Int)

/**
 * Turns "play these songs, starting at that one" into a player queue.
 *
 * A song that is on the device always plays from its file — no data used, no
 * waiting, and it works offline. Everything else streams. With no connection,
 * songs that are not downloaded are left out (they could only fail), and the
 * start moves to the nearest playable song at or after the one asked for.
 *
 * The connection can also go away after the queue was built (a tunnel, a car
 * hotspot with no uplink): then the player skips the streamed entries with
 * [nextPlayable] instead of stopping on them, and [meansUnreachable] tells a
 * dead server from one bad song.
 */
object PlayQueue {

    fun build(
        songs: List<Song>,
        startIndex: Int,
        downloaded: Map<String, LocalSong>,
        streamUrl: ((songId: String) -> String)?,
        online: Boolean,
    ): BuiltQueue {
        val entries = ArrayList<QueueEntry>(songs.size)
        var start = -1
        var skipped = 0
        songs.forEachIndexed { i, song ->
            val source = sourceFor(song, downloaded[song.id], streamUrl, online)
            if (source == null) {
                skipped++
            } else {
                if (start < 0 && i >= startIndex) start = entries.size
                entries += QueueEntry(song, source)
            }
        }
        // Nothing playable at or after the start: wrap to the first playable one.
        if (start < 0) start = 0
        return BuiltQueue(entries, if (entries.isEmpty()) 0 else start, skipped)
    }

    fun sourceFor(
        song: Song,
        local: LocalSong?,
        streamUrl: ((songId: String) -> String)?,
        online: Boolean,
    ): PlaySource? = when {
        local != null -> PlaySource.Local(local.uri)
        online && streamUrl != null -> PlaySource.Stream(streamUrl(song.id))
        else -> null
    }

    /**
     * Walks the play order from [from] (not included), one [next] at a time
     * (-1 past the end), and returns the first index [playable] accepts, or -1.
     * At most [count] steps, so a repeat-all loop with nothing playable ends.
     * [next] is the player's order: shuffle and repeat included, forwards or
     * backwards.
     */
    fun nextPlayable(from: Int, count: Int, next: (Int) -> Int, playable: (Int) -> Boolean): Int {
        var i = from
        repeat(count) {
            i = next(i)
            if (i < 0 || i == from) return -1
            if (playable(i)) return i
        }
        return -1
    }

    /**
     * Whether a failed stream means the server cannot be reached right now
     * (no route, DNS, timeouts, a dropped connection, a 5xx), as opposed to
     * something about this one song (a 404, a rejected token, a bad file).
     */
    fun meansUnreachable(errorCode: Int, httpStatus: Int?): Boolean = when (errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED -> true
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> httpStatus == null || httpStatus >= 500
        else -> false
    }
}
