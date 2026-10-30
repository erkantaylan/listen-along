package com.erkantaylan.listenalong.player

import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.LocalSong
import org.junit.Assert.assertEquals
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
}
