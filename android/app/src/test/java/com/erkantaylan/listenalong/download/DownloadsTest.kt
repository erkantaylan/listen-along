package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.ServerUrl
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.AudioFormat
import com.erkantaylan.listenalong.storage.AudioSink
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.MemoryTextStore
import com.erkantaylan.listenalong.storage.PendingAudio
import com.erkantaylan.listenalong.storage.SavedAudio
import com.erkantaylan.listenalong.storage.SavedFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Records what would have gone into MediaStore, and how many files were open at once. */
private class FakeSink : AudioSink {
    val saved = ConcurrentHashMap<String, ByteArray>()
    val names = ConcurrentHashMap<String, String>()
    val aborted = AtomicInteger()
    val open = AtomicInteger()
    val maxOpen = AtomicInteger()
    private val counter = AtomicInteger()

    override fun begin(displayName: String, format: AudioFormat): PendingAudio {
        maxOpen.accumulateAndGet(open.incrementAndGet(), ::maxOf)
        val buffer = ByteArrayOutputStream()
        return object : PendingAudio {
            var closed = false
            override val output = buffer
            override fun commit(): SavedAudio {
                close()
                val uri = "content://fake/${counter.incrementAndGet()}"
                saved[uri] = buffer.toByteArray()
                names[uri] = displayName
                return SavedAudio(uri, displayName)
            }
            override fun abort() {
                if (!closed) aborted.incrementAndGet()
                close()
            }
            private fun close() {
                if (!closed) { closed = true; open.decrementAndGet() }
            }
        }
    }

    val cleanups = AtomicInteger()
    override fun cleanupAbandoned(): Int {
        cleanups.incrementAndGet()
        return 0
    }

    /** Files an earlier install left behind, with this install's access to them. */
    val leftovers = java.util.concurrent.CopyOnWriteArrayList<SavedFile>()
    var hasMediaAccess = true
    override val canSeeAllFiles get() = hasMediaAccess
    override fun listSaved(): List<SavedFile> = if (hasMediaAccess) leftovers.toList() else emptyList()

    override fun exists(uri: String) =
        saved.containsKey(uri) || (hasMediaAccess && leftovers.any { it.uri == uri })

    // A leftover is not this install's to delete.
    override fun delete(uri: String) = saved.remove(uri) != null
}

class DownloadsTest {

    private lateinit var server: MockWebServer
    private lateinit var sink: FakeSink
    private lateinit var index: DownloadIndex
    private lateinit var queue: DownloadQueue
    private var kicks = 0

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        sink = FakeSink()
        index = DownloadIndex(MemoryTextStore())
        queue = DownloadQueue(MemoryTextStore())
    }

    @After
    fun tearDown() = server.close()

    private fun downloads(concurrency: Int = 2, client: LibraryClient? = LibraryClient(
        ServerUrl.normalize(server.url("/").toString())!!, token = null)) =
        Downloads(queue, index, sink, { client }, { kicks++ }, concurrency, retryDelaysMs = listOf(10))

    private fun song(id: String, title: String = "Title $id", artist: String = "Artist") =
        Song(id = id, title = title, artist = artist, durationRaw = 200.0)

    private fun audio(bytes: ByteArray, type: String = "audio/mp4", throttle: Boolean = false) =
        MockResponse.Builder()
            .addHeader("Content-Type", type)
            .body(Buffer().write(bytes))
            .apply { if (throttle) throttleBody(16 * 1024, 20, TimeUnit.MILLISECONDS) }
            .build()

    private fun bytesFor(id: String, size: Int = 50_000) = ByteArray(size) { (it * 31 + id.hashCode()).toByte() }

    private fun route(handler: (String) -> MockResponse) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val id = request.url.pathSegments[2]
                return handler(id)
            }
        }
    }

    @Test
    fun `drain saves every queued song byte for byte and records it`() = runBlocking {
        val payloads = listOf("a", "b", "c").associateWith { bytesFor(it) }
        route { id -> audio(payloads.getValue(id), if (id == "b") "audio/mpeg" else "audio/mp4") }
        val d = downloads()

        assertEquals(3, d.enqueue(listOf(song("a"), song("b", "Bad: Title?", "AC/DC"), song("c"))))
        assertTrue("enqueue starts the worker", kicks > 0)
        val stats = DrainStats()
        d.drain(stats)

        assertEquals(3, stats.done.get())
        assertEquals("orphans from a dead process are swept first", 1, sink.cleanups.get())
        assertTrue(queue.pending.value.isEmpty())
        for ((id, bytes) in payloads) {
            val local = index[id]!!
            assertTrue("bytes for $id unchanged", bytes.contentEquals(sink.saved.getValue(local.uri)))
            assertEquals(bytes.size.toLong(), local.bytes)
        }
        // The container follows the response, not an assumption.
        assertEquals("audio/mpeg", index["b"]!!.mimeType)
        assertEquals("AC DC - Bad Title.mp3", index["b"]!!.displayName)
        assertEquals("audio/mp4", index["a"]!!.mimeType)
        assertEquals("Artist - Title a.m4a", index["a"]!!.displayName)
        assertTrue(d.snapshot().stateOf("a") is DownloadState.Done)
    }

    @Test
    fun `legacy webm and ogg songs are saved with their own extension`() = runBlocking {
        // What the real server sends for migrated .webm / .opus cache files.
        route { id -> audio(bytesFor(id), if (id == "w") "audio/webm" else "audio/ogg") }
        val d = downloads()
        d.enqueue(listOf(song("w", "Old Webm"), song("o", "Old Opus")))
        d.drain()

        assertEquals("Artist - Old Webm.mka", index["w"]!!.displayName)
        assertEquals("audio/x-matroska", index["w"]!!.mimeType)
        assertEquals("Artist - Old Opus.ogg", index["o"]!!.displayName)
        assertEquals("audio/ogg", index["o"]!!.mimeType)
    }

    @Test
    fun `never more than the configured number at once`() = runBlocking {
        route { id -> audio(bytesFor(id, 64 * 1024), throttle = true) }
        val d = downloads(concurrency = 2)
        d.enqueue((1..6).map { song("s$it") })

        withTimeout(30_000) { d.drain() }

        assertEquals(6, index.entries.value.size)
        assertEquals(2, sink.maxOpen.get())
    }

    @Test
    fun `songs already on the device are not queued again`() = runBlocking {
        route { id -> audio(bytesFor(id)) }
        val d = downloads()
        d.enqueue(listOf(song("a")))
        d.drain()
        val requests = server.requestCount

        assertEquals(0, d.enqueue(listOf(song("a"))))
        d.drain()
        assertEquals(requests, server.requestCount)
    }

    @Test
    fun `a 404 fails at once, without retries, and the rest carry on`() = runBlocking {
        val hits = ConcurrentHashMap<String, AtomicInteger>()
        route { id ->
            hits.getOrPut(id) { AtomicInteger() }.incrementAndGet()
            if (id == "gone") MockResponse.Builder().code(404).body("""{"error":"Song not found"}""").build()
            else audio(bytesFor(id))
        }
        val d = downloads()
        d.enqueue(listOf(song("gone"), song("ok")))
        val stats = DrainStats()
        d.drain(stats)

        assertEquals(1, stats.done.get())
        assertEquals(1, stats.failed.get())
        assertEquals(1, hits.getValue("gone").get())
        assertEquals(DownloadState.Failed("Not on the server any more"), d.snapshot().stateOf("gone"))
        assertTrue(queue.pending.value.isEmpty())

        // Tapping again clears the failure and queues it.
        assertEquals(1, d.enqueue(listOf(song("gone"))))
        assertEquals(DownloadState.Queued, d.snapshot().stateOf("gone"))
    }

    @Test
    fun `a transient server error is retried`() = runBlocking {
        val attempts = AtomicInteger()
        route { id ->
            if (attempts.incrementAndGet() == 1) MockResponse.Builder().code(503).build()
            else audio(bytesFor(id))
        }
        val d = downloads()
        d.enqueue(listOf(song("a")))
        d.drain()
        assertTrue(index.contains("a"))
        assertEquals(2, attempts.get())
    }

    @Test
    fun `a body shorter than its Content-Length is rejected and thrown away`() = runBlocking {
        route { _ ->
            MockResponse.Builder()
                .addHeader("Content-Type", "audio/mp4")
                .body(Buffer().write(ByteArray(1000)))
                .onResponseBody(mockwebserver3.SocketEffect.ShutdownConnection)
                .build()
        }
        val d = downloads()
        d.enqueue(listOf(song("a")))
        d.drain()
        assertFalse(index.contains("a"))
        assertTrue(d.snapshot().stateOf("a") is DownloadState.Failed)
        assertEquals(0, sink.open.get())
    }

    @Test
    fun `cancelling one song mid-transfer discards it and leaves the others`() = runBlocking {
        route { id -> audio(bytesFor(id, 2_000_000), throttle = true) }
        val d = downloads(concurrency = 2)
        d.enqueue(listOf(song("slow"), song("other")))

        val drain = launch(Dispatchers.Default) { d.drain() }
        withTimeout(10_000) {
            while (d.snapshot().progress["slow"]?.bytesRead ?: 0 <= 0) delay(10)
        }
        d.cancel("slow")
        drain.join()

        assertFalse(index.contains("slow"))
        assertTrue(index.contains("other"))
        assertEquals(DownloadState.Absent, d.snapshot().stateOf("slow"))
        assertTrue(sink.aborted.get() >= 1)
        assertEquals(0, sink.open.get())
    }

    @Test
    fun `stopping the drain keeps unfinished songs queued`() = runBlocking {
        route { id -> audio(bytesFor(id, 2_000_000), throttle = true) }
        val d = downloads(concurrency = 1)
        d.enqueue(listOf(song("a"), song("b")))

        val drain = launch(Dispatchers.Default) { d.drain() }
        withTimeout(10_000) {
            while (d.snapshot().progress["a"]?.bytesRead ?: 0 <= 0) delay(10)
        }
        drain.cancel()
        drain.join()

        assertEquals(listOf("a", "b"), queue.pending.value.map { it.id })
        assertFalse(queue.isRunning("a"))
        assertEquals(0, sink.open.get())
    }

    @Test
    fun `with no server configured, queued songs fail with a pointer to Settings`() = runBlocking {
        val d = downloads(client = null)
        d.enqueue(listOf(song("a")))
        d.drain()
        val state = d.snapshot().stateOf("a")
        assertTrue(state is DownloadState.Failed && state.message.contains("Settings"))
    }

    @Test
    fun `reconcile and delete keep the index honest`() = runBlocking {
        route { id -> audio(bytesFor(id)) }
        val d = downloads()
        d.enqueue(listOf(song("a"), song("b")))
        d.drain()

        // The user deletes "a" in a file manager.
        sink.saved.remove(index["a"]!!.uri)
        assertEquals(1, d.reconcile())
        assertFalse(index.contains("a"))

        assertTrue(d.delete(index["b"]!!))
        assertTrue(index.entries.value.isEmpty())
    }

    private fun leftover(id: Int, name: String, sec: Long = 200, mime: String? = "audio/mp4") =
        SavedFile("content://old/$id", name, sec * 1000, 1234, mime)

    private fun library(vararg songs: Song) {
        val body = songs.joinToString(",", "{\"songs\":[", "],\"total\":${songs.size}}") {
            "{\"id\":\"${it.id}\",\"title\":\"${it.title}\",\"artist\":\"${it.artist}\",\"duration_sec\":${it.durationRaw}}"
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                libraryFetches.incrementAndGet()
                return MockResponse.Builder().addHeader("Content-Type", "application/json").body(body).build()
            }
        }
    }

    private val libraryFetches = AtomicInteger()

    @Test
    fun `reclaim recognises leftover files and fetches the library only when something is new`() = runBlocking {
        library(song("a"), song("b"))
        sink.leftovers += leftover(1, "Artist - Title a.m4a")
        sink.leftovers += leftover(2, "Artist - Title b (1).m4a")
        sink.leftovers += leftover(3, "Someone Else - Mine.m4a")
        val d = downloads()

        assertEquals(1, d.reclaim())
        val a = index["a"]!!
        assertEquals("content://old/1", a.uri)
        assertEquals("Artist - Title a.m4a", a.displayName)
        assertEquals(1234L, a.bytes)
        assertTrue(a.reclaimed)
        assertFalse(index.contains("b"))

        val fetches = libraryFetches.get()
        assertEquals(0, d.reclaim())
        assertEquals("unmatched files are not compared on every resume", fetches, libraryFetches.get())
        sink.leftovers += leftover(4, "Artist - Title b.m4a")
        assertEquals(1, d.reclaim())
        assertEquals("content://old/4", index["b"]!!.uri)
    }

    @Test
    fun `a reclaimed opus file keeps its own type`() = runBlocking {
        library(song("a"), song("b"))
        sink.leftovers += leftover(1, "Artist - Title a.ogg", mime = null)
        sink.leftovers += leftover(2, "Artist - Title b.opus", mime = "application/octet-stream")
        assertEquals(2, downloads().reclaim())
        assertEquals("audio/ogg", index["a"]!!.mimeType)
        assertEquals("audio/ogg", index["b"]!!.mimeType)
    }

    @Test
    fun `a reclaimed song is not downloaded again and no copy is made`() = runBlocking {
        library(song("a"))
        sink.leftovers += leftover(1, "Artist - Title a.m4a")
        val d = downloads()
        d.enqueue(listOf(song("a")))
        d.drain()
        assertEquals("content://old/1", index["a"]!!.uri)
        assertTrue(sink.saved.isEmpty())
        assertTrue(queue.pending.value.isEmpty())
    }

    @Test
    fun `reclaim failing leaves things alone and tries again`() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse.Builder().code(500).build()
        }
        sink.leftovers += leftover(1, "Artist - Title a.m4a")
        val d = downloads()
        assertEquals(0, d.reclaim())
        library(song("a"))
        assertEquals(1, d.reclaim())
    }

    @Test
    fun `no access is not proof a reclaimed file is gone, and access proves it`() = runBlocking {
        library(song("a"))
        sink.leftovers += leftover(1, "Artist - Title a.m4a")
        val d = downloads()
        d.reclaim()

        sink.hasMediaAccess = false
        assertEquals(0, d.reconcile())
        assertTrue(index.contains("a"))

        sink.hasMediaAccess = true
        assertEquals(0, d.reconcile())
        assertTrue(index.contains("a"))

        sink.leftovers.clear()
        assertEquals(1, d.reconcile())
        assertFalse(index.contains("a"))
    }

    @Test
    fun `found without access only own files exist, so absence still means deleted`() = runBlocking {
        library(song("a"))
        route { id -> audio(bytesFor(id)) }
        val d = downloads()
        d.enqueue(listOf(song("a")))
        d.drain()
        assertFalse(index["a"]!!.reclaimed)
        sink.hasMediaAccess = false
        sink.saved.clear()
        assertEquals(1, d.reconcile())
    }

    @Test
    fun `deleting a reclaimed file this app may not delete keeps the entry for the consent prompt`() = runBlocking {
        library(song("a"))
        sink.leftovers += leftover(1, "Artist - Title a.m4a")
        val d = downloads()
        d.reclaim()
        val local = index["a"]!!

        assertFalse(d.delete(local))
        assertTrue(index.contains("a"))

        // Gone by other means meanwhile: nothing left to ask about.
        sink.leftovers.clear()
        assertTrue(d.delete(local))
        assertFalse(index.contains("a"))
    }
}
