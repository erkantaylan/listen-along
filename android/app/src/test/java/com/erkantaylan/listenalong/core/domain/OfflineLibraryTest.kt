package com.erkantaylan.listenalong.core.domain

import com.erkantaylan.listenalong.core.model.SortOrder
import com.erkantaylan.listenalong.core.storage.LocalSong
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
}
