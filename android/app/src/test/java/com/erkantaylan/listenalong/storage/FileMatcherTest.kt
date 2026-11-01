package com.erkantaylan.listenalong.storage

import com.erkantaylan.listenalong.api.Song
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FileMatcherTest {

    private fun song(id: String, artist: String, title: String, sec: Double? = 200.0) =
        Song(id = id, artist = artist, title = title, durationRaw = sec)

    private fun file(id: Int, name: String, sec: Long? = 200) =
        SavedFile("u$id", name, sec?.times(1000), 10, "audio/mp4")

    private fun ids(songs: List<Song>, files: List<SavedFile>) =
        FileMatcher.match(songs, files).map { (s, f) -> s.id to f.uri }

    @Test
    fun `matches by the saved name and duration, with Turkish letters and any known extension`() {
        val songs = listOf(
            song("a", "İbrahim Sarıpınar", "Aha Şenlik"),
            song("b", "Ceza", "Türk Marşı (Turkish March)"),
        )
        val files = listOf(
            file(1, "İbrahim Sarıpınar - Aha Şenlik.m4a", 202),
            file(2, "Ceza - Türk Marşı (Turkish March).mp3", 197),
        )
        assertEquals(listOf("a" to "u1", "b" to "u2"), ids(songs, files))
    }

    @Test
    fun `uses the same sanitised name as saving`() {
        val title = "What? A/B: \"C\""
        val name = FileNames.displayName("Art", title, AudioFormat.M4A)
        assertEquals(listOf("a" to "u1"), ids(listOf(song("a", "Art", title)), listOf(file(1, name))))
        val long = "ş".repeat(300)
        assertEquals(listOf("b" to "u2"),
            ids(listOf(song("b", "Art", long)), listOf(file(2, FileNames.displayName("Art", long, AudioFormat.M4A)))))
    }

    @Test
    fun `an Unknown artist and a playlist's cleaned title match too`() {
        assertEquals(listOf("a" to "u1"), ids(listOf(song("a", "Unknown", "Song")), listOf(file(1, "Song.m4a"))))
        assertEquals(listOf("b" to "u2"), ids(listOf(song("b", "Art", "Tune - Art")), listOf(file(2, "Art - Tune.m4a"))))
    }

    @Test
    fun `same name with another length is a different song`() {
        assertTrue(ids(listOf(song("a", "A", "T", 200.0)), listOf(file(1, "A - T.m4a", 204))).isEmpty())
    }

    @Test
    fun `a duration that cannot be checked is no match`() {
        assertTrue(ids(listOf(song("a", "A", "T", null)), listOf(file(1, "A - T.m4a"))).isEmpty())
        assertTrue(ids(listOf(song("a", "A", "T", 0.0)), listOf(file(1, "A - T.m4a", 0))).isEmpty())
        assertTrue(ids(listOf(song("a", "A", "T")), listOf(file(1, "A - T.m4a", null))).isEmpty())
    }

    @Test
    fun `copies and foreign files are left alone`() {
        val songs = listOf(song("a", "A", "T"))
        assertTrue(ids(songs, listOf(file(1, "A - T (1).m4a"))).isEmpty())
        assertTrue(ids(songs, listOf(file(1, "A - T.txt"))).isEmpty())
        assertTrue(ids(songs, listOf(file(1, "a - t.m4a"))).isEmpty())
    }

    @Test
    fun `one file fitting two songs, or one song fitting two files, stays unmatched`() {
        val twoSongs = listOf(song("a", "A", "T", 200.0), song("b", "A", "T", 201.0))
        assertTrue(ids(twoSongs, listOf(file(1, "A - T.m4a"))).isEmpty())
        assertTrue(ids(listOf(song("a", "A", "T")), listOf(file(1, "A - T.m4a"), file(2, "A - T.mp3"))).isEmpty())
    }

    @Test
    fun `two songs of one name are told apart by duration`() {
        val songs = listOf(song("a", "A", "T", 100.0), song("b", "A", "T", 300.0))
        assertEquals(listOf("b" to "u1"), ids(songs, listOf(file(1, "A - T.m4a", 300))))
    }
}
