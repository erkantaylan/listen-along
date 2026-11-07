package com.erkantaylan.listenalong.player

import androidx.media3.common.PlaybackException
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.LocalSong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayQueueTest {

    private val songs = (1..5).map { Song(id = "s$it", title = "Song $it") }
    private fun local(id: String) = LocalSong(id, "content://media/$id", "$id.m4a", id, mimeType = "audio/mp4")
    private val stream: (String) -> String = { "https://srv/api/library/$it/file" }

    @Test
    fun `downloaded songs play from the file, the rest stream`() {
        val q = PlayQueue.build(songs, 2, mapOf("s2" to local("s2")), stream, online = true)
        assertEquals(5, q.entries.size)
        assertEquals(2, q.startIndex)
        assertEquals(PlaySource.Local("content://media/s2"), q.entries[1].source)
        assertEquals(PlaySource.Stream("https://srv/api/library/s3/file"), q.entries[2].source)
        assertEquals(0, q.skipped)
    }

    @Test
    fun `offline keeps only downloaded songs and moves the start to the next playable one`() {
        val downloaded = mapOf("s1" to local("s1"), "s4" to local("s4"))
        val q = PlayQueue.build(songs, 1, downloaded, stream, online = false)
        assertEquals(listOf("s1", "s4"), q.entries.map { it.song.id })
        assertEquals(1, q.startIndex) // s2 asked for, s4 is the next one on the device
        assertEquals(3, q.skipped)
        assertTrue(q.entries.all { it.source is PlaySource.Local })
    }

    @Test
    fun `nothing playable after the start wraps to the first playable song`() {
        val q = PlayQueue.build(songs, 4, mapOf("s1" to local("s1")), stream, online = false)
        assertEquals(listOf("s1"), q.entries.map { it.song.id })
        assertEquals(0, q.startIndex)
    }

    @Test
    fun `no token means no streaming`() {
        val q = PlayQueue.build(songs, 0, emptyMap(), streamUrl = null, online = true)
        assertTrue(q.entries.isEmpty())
        assertEquals(5, q.skipped)
    }

    // --- Skipping what cannot play (the connection went away after the queue was built) ---

    /** Play order 0..n-1, -1 past the end (repeat off). */
    private fun linear(n: Int): (Int) -> Int = { i -> if (i + 1 < n) i + 1 else -1 }
    private fun backwards(): (Int) -> Int = { i -> i - 1 }
    private fun loop(n: Int): (Int) -> Int = { i -> (i + 1) % n }

    @Test
    fun `offline skip goes to the next downloaded entry`() {
        val local = setOf(0, 3, 5)
        assertEquals(3, PlayQueue.nextPlayable(0, 6, linear(6)) { it in local })
        assertEquals(5, PlayQueue.nextPlayable(3, 6, linear(6)) { it in local })
    }

    @Test
    fun `nothing downloaded after the current entry gives -1 with repeat off`() {
        assertEquals(-1, PlayQueue.nextPlayable(5, 6, linear(6)) { it == 0 })
    }

    @Test
    fun `previous walks backwards to the nearest downloaded entry`() {
        val local = setOf(0, 3)
        assertEquals(3, PlayQueue.nextPlayable(5, 6, backwards()) { it in local })
        assertEquals(-1, PlayQueue.nextPlayable(0, 6, backwards()) { it in local })
    }

    @Test
    fun `repeat all wraps to an earlier downloaded entry`() {
        assertEquals(1, PlayQueue.nextPlayable(4, 6, loop(6)) { it == 1 })
    }

    @Test
    fun `repeat all with nothing downloaded ends instead of looping`() {
        assertEquals(-1, PlayQueue.nextPlayable(2, 6, loop(6)) { false })
        // The only downloaded entry is the current one: there is nowhere else to go.
        assertEquals(-1, PlayQueue.nextPlayable(2, 6, loop(6)) { it == 2 })
    }

    @Test
    fun `shuffled play order is followed, not the list order`() {
        val order = listOf(4, 1, 5, 0, 2, 3)
        val next: (Int) -> Int = { i -> order.getOrNull(order.indexOf(i) + 1) ?: -1 }
        // From 4 the order goes 1, 5, 0...: 0 is downloaded but 5 comes first.
        assertEquals(5, PlayQueue.nextPlayable(4, 6, next) { it == 5 || it == 0 })
    }

    @Test
    fun `network failures and server errors mean the server is unreachable`() {
        assertTrue(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, null))
        assertTrue(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT, null))
        assertTrue(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, null))
        assertTrue(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 502))
    }

    @Test
    fun `a missing song, a rejected token or a bad file are about that song only`() {
        assertFalse(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 404))
        assertFalse(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, 401))
        assertFalse(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND, null))
        assertFalse(PlayQueue.meansUnreachable(PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, null))
    }
}
