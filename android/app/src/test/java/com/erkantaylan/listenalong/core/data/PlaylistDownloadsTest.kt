package com.erkantaylan.listenalong.core.data

import com.erkantaylan.listenalong.core.domain.NetworkInfo
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.domain.SyncHold
import com.erkantaylan.listenalong.core.domain.SyncSettings
import com.erkantaylan.listenalong.core.download.DownloadQueue
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.download.QueuedSong
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import com.erkantaylan.listenalong.core.storage.TextStore
import com.erkantaylan.listenalong.testing.FakeApi
import com.erkantaylan.listenalong.testing.FakePrefs
import com.erkantaylan.listenalong.testing.MemorySink
import com.erkantaylan.listenalong.testing.local
import com.erkantaylan.listenalong.testing.song
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** The sync run against an in-memory server, queue, index and files. */
class PlaylistDownloadsTest {

    private val api = FakeApi().apply {
        listOf("a", "b", "c", "d", "e").forEach { library += song(it) }
        addPlaylist("p", "Road trip", listOf("a", "b", "c"))
        addPlaylist("q", "Gym", listOf("c", "d"))
    }
    private val stores = mutableMapOf<String, TextStore>()
    private val repo = PlaylistRepository({ api }, PlaylistCache(MemoryTextStore(), { stores.getOrPut(it) { MemoryTextStore() } }))
    private val sink = MemorySink()
    private val index = DownloadIndex(MemoryTextStore())
    private val queue = DownloadQueue(MemoryTextStore())
    private val network = MutableStateFlow(NetworkInfo())
    private val prefs = FakePrefs()
    private val missing = mutableListOf<String>()
    private lateinit var sync: PlaylistDownloads
    private val downloads = Downloads(
        queue, index, sink, { api }, kick = {}, io = Dispatchers.Unconfined,
        mayFetchAuto = { com.erkantaylan.listenalong.core.domain.PlaylistSyncPlanner.mayDownload(network.value, prefs.sync.value) },
        onMissing = { sync.markMissing(it) },
    )
    private val store = MemoryTextStore()
    private var scheduled: Boolean? = null

    init {
        sync = PlaylistDownloads(store, { api }, repo, downloads, prefs, { network.value }, now = { 1_000_000L },
                                 schedule = { enabled, _ -> scheduled = enabled })
    }

    private fun queuedIds() = queue.pending.value.map { it.id }

    /** Pretends the worker downloaded everything queued (as playlist sync's files). */
    private fun finishQueue() {
        queue.pending.value.forEach { q -> index.put(local(q.id, manual = q.manual)); queue.finish(q.id) }
    }

    @Test
    fun `turning Download on queues every song for the playlist, not as the user's`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        assertEquals(listOf("a", "b", "c"), queuedIds())
        assertTrue(queue.pending.value.none { it.manual })
        assertEquals(true, scheduled)
        assertTrue(sync.isDownloaded("p"))
    }

    @Test
    fun `songs added on the server download at the next sync, removed ones are deleted (default on)`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        // Someone adds d and e, and removes b, on another client.
        api.entries["p"]!!.removeAll { it.libraryId == "b" }
        api.addToPlaylist("p", listOf("d", "e"))

        sync.sync()
        assertEquals(listOf("d", "e"), queuedIds())
        assertFalse(index.contains("b"))
        assertTrue(sink.deleted.any { it.endsWith("/b") })
    }

    @Test
    fun `with removal off the removed song stays`() = runBlocking {
        prefs.setRemoveUnlisted(false)
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        api.entries["p"]!!.removeAll { it.libraryId == "b" }
        sync.sync()
        assertTrue(index.contains("b"))
    }

    @Test
    fun `a song shared by two downloaded playlists downloads once and stays while one holds it`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        sync.enable(api.playlists["q"]!!)
        assertEquals(listOf("a", "b", "c", "d"), queuedIds())
        finishQueue()
        api.entries["p"]!!.removeAll { it.libraryId == "c" }
        sync.sync()
        assertTrue(index.contains("c"))
    }

    @Test
    fun `a song downloaded by hand is never removed by the sync`() = runBlocking {
        index.put(local("b")) // the user's own, from before
        sync.enable(api.playlists["p"]!!)
        assertEquals(listOf("a", "c"), queuedIds())
        finishQueue()
        api.entries["p"]!!.removeAll { it.libraryId == "b" }
        sync.sync()
        assertTrue(index.contains("b"))
    }

    @Test
    fun `offline nothing is fetched, nothing deleted, and it says why it waits`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        queue.cancelAll()
        network.value = NetworkInfo(online = false)
        api.fail = IOException("offline")
        assertEquals(SyncHold.OFFLINE, sync.sync())
        assertEquals(listOf("a", "b", "c"), queuedIds()) // from the saved copy, waiting
        assertTrue(api.calls.none { it == "songs:p" && false })
    }

    @Test
    fun `a playlist that is gone is kept as unavailable with its files`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        api.playlists.remove("p")
        sync.sync()
        assertTrue(sync.record("p")!!.unavailable)
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
    }

    @Test
    fun `turning Download off can keep the files (they become the user's) or remove them`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        sync.enable(api.playlists["q"]!!)
        finishQueue()

        assertEquals(0, sync.disable("q", removeFiles = false))
        assertTrue(index["d"]!!.manual)          // kept as the user's own
        assertFalse(index["c"]!!.manual)         // p still holds c

        assertEquals(3, sync.disable("p", removeFiles = true))
        assertFalse(index.contains("a"))
        assertTrue(index.contains("d"))          // the user's now
        assertEquals(false, scheduled)
    }

    @Test
    fun `waiting for Wi-Fi, playlist downloads hold on mobile data, the user's do not`() = runBlocking {
        prefs.setAllowMetered(false)
        network.value = NetworkInfo(metered = true)
        assertEquals(SyncHold.WAITING_FOR_WIFI, run { sync.enable(api.playlists["p"]!!); sync.hold.value })
        api.files["a"] = byteArrayOf(1); api.files["b"] = byteArrayOf(1); api.files["c"] = byteArrayOf(1); api.files["e"] = byteArrayOf(2)
        downloads.enqueue(listOf(song("e")))     // the user's own
        downloads.drain()
        assertTrue(index.contains("e"))
        assertEquals(listOf("a", "b", "c"), queuedIds())

        network.value = NetworkInfo(metered = false)
        downloads.drain()
        assertTrue(queuedIds().isEmpty())
        assertFalse(index["a"]!!.manual)
    }

    @Test
    fun `a file missing on the server is skipped, not looped`() = runBlocking {
        api.files["a"] = byteArrayOf(1); api.files["c"] = byteArrayOf(1) // b: 404
        sync.enable(api.playlists["p"]!!)
        downloads.drain()
        assertFalse(index.contains("b"))
        sync.sync()
        assertTrue("b" !in queuedIds())          // skipped for a day
        val status = sync.statuses(downloads.snapshots, network).first()["p"]
        assertEquals(PlaylistDownloadStatus.Downloaded(2, 2, missingOnServer = 1), status)
    }

    @Test
    fun `the user asking for a song the sync had queued makes it theirs`() {
        queue.enqueue(listOf(QueuedSong("a", "A", manual = false)), index::contains)
        downloads.enqueue(listOf(song("a")))
        assertTrue(queue.pending.value.single().manual)
    }

    @Test
    fun `the saved list belongs to its server`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        val other = PlaylistDownloads(store, { FakeApi(com.erkantaylan.listenalong.core.network.ServerUrl.normalize("https://other.example")!!) },
                                      repo, downloads, prefs, { network.value })
        assertTrue(other.playlists.value.isEmpty())
        assertFalse(other.isDownloaded("p"))
        assertTrue(sync.isDownloaded("p"))
        assertNull(other.record("p"))
    }
}
