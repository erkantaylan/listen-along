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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
    /** The server in Settings (tests change it). */
    private var current: FakeApi = api
    /** The account signed in (null: signed out). */
    private var account: String? = "u1"
    private var clock = 1_000_000L
    private val stores = mutableMapOf<String, TextStore>()
    private val repo = PlaylistRepository({ current }, PlaylistCache(MemoryTextStore(), { stores.getOrPut(it) { MemoryTextStore() } }))
    private val sink = MemorySink()
    private val indexStore = MemoryTextStore()
    private val index = DownloadIndex(indexStore)
    private val queue = DownloadQueue(MemoryTextStore())
    private val network = MutableStateFlow(NetworkInfo())
    private val prefs = FakePrefs()
    private lateinit var sync: PlaylistDownloads
    private val downloads = Downloads(
        queue, index, sink, { current }, kick = {}, io = Dispatchers.Unconfined,
        mayFetchAuto = { com.erkantaylan.listenalong.core.domain.PlaylistSyncPlanner.mayDownload(network.value, prefs.sync.value) },
        onMissing = { sync.markMissing(it) },
    )
    private val store = MemoryTextStore()
    private val unreadable = MemoryTextStore()
    private var scheduled: Boolean? = null
    private val detached = mutableListOf<String>()

    /** The app as it starts: a new instance over the same saved stores (a restart, a reboot). */
    private fun start(downloads: Downloads = this.downloads) = PlaylistDownloads(
        store, { current }, repo, downloads, prefs, { network.value }, now = { clock },
        schedule = { enabled, _ -> scheduled = enabled },
        account = { account },
        corruptStore = unreadable,
        onDetached = { gone -> detached += gone.map { it.id } },
    )

    init {
        sync = start()
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

    private val day = 24L * 60 * 60 * 1000
    private fun synced(vararg ids: String) = ids.all { index[it]?.manual == false }
    private fun mine(vararg ids: String) = ids.all { index[it]?.manual == true }

    // --- Finding 1: a degraded answer, and the time a big shrink needs ----------

    @Test
    fun `an answer whose entries lost their library ids deletes nothing, however often it comes`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        // The server's library lookup fails: 200, every library_id null.
        api.degraded += "p"
        repeat(3) { sync.sync() }
        clock += 3 * day
        sync.sync()
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
        assertTrue(sink.deleteAttempts.isEmpty())
        assertEquals(listOf("a", "b", "c"), sync.record("p")!!.known)
        assertNull("not even held: it says nothing", sync.record("p")!!.pendingShrink)
    }

    @Test
    fun `an unreadable answer (no songs) keeps the saved list and deletes nothing`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        // What LibraryClient throws for a 200 it cannot read (a missing `songs`): PlaylistApiTest.
        api.playlistErrors["p"] = IOException("Unexpected answer from /api/playlists/p/songs")
        repeat(2) { sync.sync() }
        clock += 2 * day
        sync.sync()
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
        assertEquals(listOf("a", "b", "c"), sync.record("p")!!.known)
    }

    @Test
    fun `an emptied playlist is removed only when a fetch a day later still says so, across a restart`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        api.entries["p"]!!.clear()
        sync.sync()
        sync.sync()                                         // seconds later: the same
        clock += day / 2
        sync.sync()
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
        assertEquals(1_000_000L, sync.record("p")!!.pendingSince)

        // The app is killed and the phone rebooted; a day after the first sighting:
        sync = start()
        clock = 1_000_000L + day
        sync.sync()
        assertFalse(index.contains("a") || index.contains("b") || index.contains("c"))
        assertTrue(sync.record("p")!!.known.isEmpty())
    }

    @Test
    fun `a different list resets the wait, and a clock set back never confirms early`() = runBlocking {
        api.addPlaylist("big", "Big", listOf("a", "b", "c", "d", "e"))
        sync.enable(api.playlists["big"]!!)
        finishQueue()
        api.entries["big"]!!.removeAll { it.libraryId in setOf("b", "c", "d") }   // a, e
        sync.sync()
        val first = sync.record("big")!!.pendingSince!!

        clock += day - 1
        api.entries["big"]!!.removeAll { it.libraryId == "e" }                     // a: different
        sync.sync()
        assertEquals("reset", clock, sync.record("big")!!.pendingSince)
        clock = first + day                                                          // a day after the FIRST list
        sync.sync()
        assertTrue("not yet: a day after the second", index.contains("b") && index.contains("e"))

        // The clock goes back two days: the wait starts again from there.
        clock -= 2 * day
        sync.sync()
        assertEquals(clock, sync.record("big")!!.pendingSince)
        clock += day - 1
        sync.sync()
        assertTrue(index.contains("b") && index.contains("e"))
        clock += 1
        sync.sync()
        assertFalse(index.contains("b") || index.contains("c") || index.contains("d") || index.contains("e"))
        assertTrue(index.contains("a"))
    }

    // --- Finding 2: another server or account --------------------------------------

    @Test
    fun `changing the server address then turning Download on deletes nothing, the first server's files become the user's`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        assertTrue(synced("a", "b", "c"))

        // Settings: the same server over http instead of https; signing in again there.
        current = FakeApi(com.erkantaylan.listenalong.core.network.ServerUrl.normalize("http://music.test")!!).apply {
            library += song("x")
            addPlaylist("other", "Other", listOf("x"))
        }
        account = null
        sync.reload()
        assertTrue("not this server's", sync.playlists.value.isEmpty())
        assertTrue("signed out there: nothing is synced yet", detached.isEmpty())

        account = "u1"
        sync.enable(current.playlists["other"]!!)
        assertEquals("the first sync there stops the old server's", listOf("p"), detached)
        assertTrue(mine("a", "b", "c"))
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
        assertTrue(sink.deleteAttempts.isEmpty())
        assertEquals(listOf("x"), queuedIds())

        // Back to the first server: p shows as not downloaded, its files are the user's for good.
        current = api
        sync.reload()
        assertFalse(sync.isDownloaded("p"))
        api.entries["p"]!!.clear()
        sync.sync()
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
    }

    @Test
    fun `signing out changes nothing, another account signing in stops the sync and keeps the files`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()

        account = null                       // signed out (or the session ended)
        sync.reload()
        assertTrue(sync.isDownloaded("p"))
        assertTrue(synced("a", "b", "c"))
        assertNull("no sync without an account", sync.sync())
        assertTrue(api.calls.count { it == "songs:p" } == 1)

        account = "u1"                       // the same account again: it carries on
        sync.reload()
        assertTrue(sync.isDownloaded("p"))
        assertTrue(detached.isEmpty())

        account = "u2"                       // someone else
        sync.reload()
        assertFalse(sync.isDownloaded("p"))
        sync.sync()
        assertEquals(listOf("p"), detached)
        assertTrue(mine("a", "b", "c"))
        sync.enable(api.playlists["q"]!!)
        assertTrue(index.contains("a") && index.contains("b"))
        account = "u1"                       // the first account again: p was detached for good
        sync.reload()
        assertFalse(sync.isDownloaded("p"))
    }

    @Test
    fun `a sync whose server changes while it runs applies nothing`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        api.entries["p"]!!.removeAll { it.libraryId == "c" }
        val other = FakeApi(com.erkantaylan.listenalong.core.network.ServerUrl.normalize("https://other.test")!!)
        api.beforeSongs = { current = other }   // Settings changed while the answer was on its way
        sync.sync()
        assertTrue(index.contains("c"))
        assertTrue(sink.deleteAttempts.isEmpty())
        current = api
        assertEquals("the record was not touched", listOf("a", "b", "c"), sync.record("p")!!.known)
    }

    @Test
    fun `a record store that cannot be read means no removals, a copy is kept, its files become the user's`() = runBlocking {
        listOf("a", "b").forEach { index.put(local(it, manual = false)) }
        store.write("""{"version":2,"records":[{"server":""") // cut short
        sync = start()
        assertFalse(sync.isDownloaded("p"))
        assertEquals("""{"version":2,"records":[{"server":""", unreadable.read())
        assertTrue(mine("a", "b"))

        sync.enable(api.playlists["p"]!!)
        api.entries["p"]!!.removeAll { it.libraryId == "a" }
        sync.sync()
        assertTrue(index.contains("a") && index.contains("b"))
    }

    @Test
    fun `the single-record store of earlier builds is read and taken over by the account`() = runBlocking {
        store.write("""{"server":"https://music.test/","playlists":[{"id":"p","name":"Road trip","known":["a","b","c"]}]}""")
        listOf("a", "b", "c").forEach { index.put(local(it, manual = false)) }
        sync = start()
        assertTrue(sync.isDownloaded("p"))
        api.entries["p"]!!.removeAll { it.libraryId == "c" }
        sync.sync()
        assertFalse(index.contains("c"))
        assertTrue(store.read()!!.contains("\"account\":\"u1\""))
    }

    @Test
    fun `an index that cannot be read deletes nothing and does not crash`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        indexStore.write("not json")
        val freshDownloads = Downloads(queue, DownloadIndex(indexStore), sink, { current }, kick = {}, io = Dispatchers.Unconfined)
        sync = start(freshDownloads)
        api.entries["p"]!!.clear()
        sync.sync()
        clock += 2 * day
        sync.sync()
        assertTrue(sink.deleteAttempts.isEmpty())
    }

    // --- One lock; a file that cannot be deleted --------------------------------------

    @Test
    fun `turning Download on while a sync runs waits for it and is kept`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        val inside = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        api.beforeSongs = { id -> if (id == "p" && !inside.isCompleted) { inside.complete(Unit); release.await() } }
        val running = launch(Dispatchers.Default) { sync.sync() }
        inside.await()
        val enabling = launch(Dispatchers.Default) { sync.enable(api.playlists["q"]!!) }
        delay(100)
        assertFalse("enable waits for the running sync", sync.isDownloaded("q"))
        release.complete(Unit)
        running.join(); enabling.join()
        api.beforeSongs = null
        assertTrue(sync.isDownloaded("p") && sync.isDownloaded("q"))
        assertTrue("saved too", start().let { it.isDownloaded("p") && it.isDownloaded("q") })
        assertTrue("d" in queuedIds())
    }

    @Test
    fun `a file scoped storage will not let the app delete stays, without a crash or a loop`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        sink.failDeletes = true
        api.entries["p"]!!.removeAll { it.libraryId == "b" }
        sync.sync()
        assertEquals(1, sink.deleteAttempts.size)
        assertTrue(index.contains("b"))
        sync.sync()
        sync.sync()
        assertEquals("left, not tried on every sync", 1, sink.deleteAttempts.size)
        assertEquals(listOf("a", "c"), sync.record("p")!!.known)
    }

    // --- Finding 3: the user asking for a synced song ----------------------------------

    @Test
    fun `a song the user downloads after the sync saved it is theirs and stays when it leaves the playlist`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        assertTrue(synced("b"))
        assertEquals(0, downloads.enqueue(listOf(song("b"))))   // the Download button: nothing to fetch
        assertTrue(mine("b"))
        api.entries["p"]!!.removeAll { it.libraryId == "b" }
        sync.sync()
        assertTrue(index.contains("b"))
    }

    @Test
    fun `Download playlist makes the songs already here the user's`() = runBlocking {
        sync.enable(api.playlists["p"]!!)
        finishQueue()
        val plan = com.erkantaylan.listenalong.core.download.BulkPlan.of(listOf("a", "b", "c", "e").map { song(it) }, downloads.snapshot())
        assertEquals(listOf("e"), plan.toDownload.map { it.id })
        assertEquals(1, downloads.enqueue(plan.all))
        assertTrue(mine("a", "b", "c"))
        api.entries["p"]!!.clear()
        sync.sync()
        clock += 2 * day
        sync.sync()
        assertTrue(index.contains("a") && index.contains("b") && index.contains("c"))
    }

    @Test
    fun `the user asking while the sync's download of it is under way saves it as theirs`() = runBlocking {
        listOf("a", "b", "c").forEach { api.files[it] = byteArrayOf(1, 2) }
        sync.enable(api.playlists["p"]!!)
        api.duringStream = { id -> if (id == "b") downloads.enqueue(listOf(song("b"))) }
        downloads.drain()
        assertTrue(synced("a", "c"))
        assertTrue(mine("b"))
        // And a later sync download never turns it back.
        index.put(index["b"]!!.copy(manual = false))
        assertTrue(mine("b"))
    }
}
