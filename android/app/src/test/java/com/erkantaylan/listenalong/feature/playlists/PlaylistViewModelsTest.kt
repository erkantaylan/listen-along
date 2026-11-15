package com.erkantaylan.listenalong.feature.playlists

import com.erkantaylan.listenalong.core.data.PlaylistCache
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.download.DownloadQueue
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.Visibility
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import com.erkantaylan.listenalong.core.storage.TextStore
import com.erkantaylan.listenalong.core.ui.UserMessages
import com.erkantaylan.listenalong.testing.FakeApi
import com.erkantaylan.listenalong.testing.FakeNetwork
import com.erkantaylan.listenalong.testing.MainDispatcherRule
import com.erkantaylan.listenalong.testing.MemorySink
import com.erkantaylan.listenalong.testing.signedIn
import com.erkantaylan.listenalong.testing.song
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.IOException

class PlaylistViewModelsTest {
    @get:Rule val main = MainDispatcherRule()

    private val api = FakeApi().apply {
        addPlaylist("p1", "Road trip", listOf("s1", "s2", null))
        addPlaylist("p2", "Theirs", listOf("s3"), owner = false)
    }
    private val stores = mutableMapOf<String, TextStore>()
    private val repo = PlaylistRepository(
        { api },
        PlaylistCache(MemoryTextStore(), { id -> stores.getOrPut(id) { MemoryTextStore() } }, { stores.remove(it) }),
    )
    private val network = FakeNetwork()
    private val messages = UserMessages()
    private val said = mutableListOf<String>()
    private val downloads = Downloads(DownloadQueue(MemoryTextStore()), DownloadIndex(MemoryTextStore()), MemorySink(), { api }, kick = {}, io = main.dispatcher)

    private fun listVm() = PlaylistsViewModel(MutableStateFlow(signedIn()), network, repo, messages)
    private val playlistDownloads = com.erkantaylan.listenalong.core.data.PlaylistDownloads(
        MemoryTextStore(), { api }, repo, downloads, com.erkantaylan.listenalong.testing.FakePrefs(), { network.network.value },
    )
    private fun detailVm(id: String = "p1") = PlaylistViewModel(
        id, network, repo, downloads, messages, playlistDownloads, kotlinx.coroutines.flow.MutableStateFlow(emptyMap()),
    )

    private fun collectMessages() = kotlinx.coroutines.CoroutineScope(main.dispatcher).launch { messages.messages.collect { said += it } }

    @Test
    fun `the list loads, yours first`() {
        val s = listVm().state.value
        assertEquals(listOf("p1", "p2"), s.playlists.map { it.id })
        assertFalse(s.fromCache)
    }

    @Test
    fun `offline the saved list is shown read-only`() {
        listVm()
        api.fail = IOException("offline")
        val s = listVm().state.value
        assertTrue(s.fromCache)
        assertEquals(2, s.playlists.size)
    }

    @Test
    fun `a rename on the playlist page shows on the list at once`() {
        val list = listVm()
        val detail = detailVm()
        detail.rename("Long drive")
        assertEquals("Long drive", list.state.value.playlists.first { it.id == "p1" }.name)
        assertEquals("Long drive", detail.state.value.playlist?.name)
    }

    @Test
    fun `creating opens the new playlist`() = runTest {
        val vm = listVm()
        var opened: String? = null
        val job = launch(main.dispatcher) { vm.opened.collect { opened = it } }
        vm.create("Fresh", Visibility.PRIVATE)
        assertNotNull(opened)
        assertTrue(vm.state.value.playlists.any { it.name == "Fresh" })
        job.cancel()
    }

    @Test
    fun `the page shows the songs and which entries have a library song`() {
        val s = detailVm().state.value
        assertEquals(3, s.entries.size)
        assertEquals(listOf("s1", "s2"), s.songs.map { it.id })
        assertFalse(s.loading)
    }

    @Test
    fun `a playlist that answers 404 is gone and leaves the list`() {
        val list = listVm()
        api.playlists.remove("p1")
        val s = detailVm().state.value
        assertTrue(s.gone)
        assertTrue(list.state.value.playlists.none { it.id == "p1" })
    }

    @Test
    fun `remove waits for Undo, then reaches the server`() {
        val vm = detailVm()
        val first = vm.state.value.entries.first()
        vm.remove(first)
        assertEquals(2, vm.state.value.entries.size)
        vm.undoRemove()
        assertEquals(3, vm.state.value.entries.size)
        assertTrue(api.calls.none { it.startsWith("remove:") })

        vm.remove(first)
        vm.commitPendingRemoval(first.entryId)
        assertTrue(api.calls.contains("remove:p1:${first.entryId}"))
        assertEquals(2, api.entries["p1"]!!.size)
    }

    @Test
    fun `a drag sends one move`() {
        val vm = detailVm()
        vm.startEditing()
        val (a, b) = vm.state.value.entries
        vm.startDrag(a.entryId)
        vm.dragOver(b.entryId)
        vm.endDrag()
        assertTrue(api.calls.contains("move:p1:${a.entryId}:2"))
    }

    @Test
    fun `deleting from the page closes it`() = runTest {
        val vm = detailVm()
        var closed = false
        val job = launch(main.dispatcher) { vm.closed.collect { closed = true } }
        vm.delete()
        assertTrue(closed)
        assertNull(api.playlists["p1"])
        job.cancel()
    }

    @Test
    fun `a failed change says why`() {
        val job = collectMessages()
        val vm = detailVm("p2")
        api.fail = ApiException(403, "Only the owner can rename this playlist")
        vm.rename("Mine now")
        assertEquals(listOf("Could not rename the playlist: Only the owner can rename this playlist"), said)
        job.cancel()
    }

    @Test
    fun `add to playlist reports what was added`() {
        val job = collectMessages()
        val vm = AddToPlaylistViewModel(repo, messages)
        vm.refresh()
        vm.add(api.playlists["p2"]!!, listOf(song("s3"), song("s9")))
        assertEquals("Added 1 song to Theirs (1 already there)", said.single())
        job.cancel()
    }

    @Test
    fun `added messages read naturally`() {
        assertEquals("Added 1 song to Road", PlaylistsViewModel.addedMessage(1, 0, "Road"))
        assertEquals("Added 3 songs to Road (1 already there)", PlaylistsViewModel.addedMessage(3, 1, "Road"))
        assertEquals("Nothing added to Road (2 already there)", PlaylistsViewModel.addedMessage(0, 2, "Road"))
    }
}
