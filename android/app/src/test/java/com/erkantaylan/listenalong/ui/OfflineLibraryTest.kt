package com.erkantaylan.listenalong.ui

import com.erkantaylan.listenalong.api.SortOrder
import com.erkantaylan.listenalong.storage.LocalSong
import org.junit.Assert.assertEquals
import org.junit.Test

class OfflineLibraryTest {

    private fun local(id: String, title: String, artist: String, savedAt: Long) =
        LocalSong(id, "content://x/$id", "$artist - $title.m4a", title, artist, 200, "audio/mp4", 1, savedAt)

    private val songs = listOf(
        local("1", "Dağlar Dağlar", "Barış Manço", 30),
        local("2", "One More Time", "Daft Punk", 10),
        local("3", "Around the World", "Daft Punk", 20),
    )

    @Test
    fun `search matches every word in title or artist`() {
        assertEquals(listOf("2"), offlineLibrary(songs, "daft one", SortOrder.TITLE).map { it.id })
        assertEquals(listOf("1"), offlineLibrary(songs, "barış", SortOrder.TITLE).map { it.id })
    }

    @Test
    fun `sort orders follow the server's meaning`() {
        assertEquals(listOf("1", "3", "2"), offlineLibrary(songs, "", SortOrder.RECENT).map { it.id })
        assertEquals(listOf("3", "1", "2"), offlineLibrary(songs, "", SortOrder.TITLE).map { it.id })
        assertEquals(listOf("1", "3", "2"), offlineLibrary(songs, "", SortOrder.ARTIST).map { it.id })
    }

    @Test
    fun `added messages read naturally`() {
        assertEquals("Added 1 song to Road", PlaylistsViewModel.addedMessage(1, 0, "Road"))
        assertEquals("Added 3 songs to Road (1 already there)", PlaylistsViewModel.addedMessage(3, 1, "Road"))
        assertEquals("Nothing added to Road (2 already there)", PlaylistsViewModel.addedMessage(0, 2, "Road"))
    }
}
