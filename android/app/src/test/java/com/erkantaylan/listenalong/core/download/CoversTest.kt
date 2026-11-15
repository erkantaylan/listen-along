package com.erkantaylan.listenalong.core.download

import com.erkantaylan.listenalong.core.model.CoverArt
import com.erkantaylan.listenalong.core.network.ImageHttp
import com.erkantaylan.listenalong.core.network.LibraryClient
import com.erkantaylan.listenalong.core.network.SessionEndedInterceptor
import com.erkantaylan.listenalong.core.storage.CoverStore
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import com.erkantaylan.listenalong.testing.FakeApi
import com.erkantaylan.listenalong.testing.local
import com.erkantaylan.listenalong.testing.song
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException

class CoversTest {
    @get:Rule val tmp = TemporaryFolder()
    private val server = MockWebServer().apply { start() }

    @After
    fun stop() = server.close()

    @Test
    fun `the image client never sends the session to an image host`() {
        // The API client carries the session; the image client must be a separate one with nothing added.
        val image = ImageHttp.newClient()
        assertTrue(image.interceptors.isEmpty())
        assertTrue(image.networkInterceptors.isEmpty())
        val api = LibraryClient.defaultHttpClient.newBuilder().addInterceptor(SessionEndedInterceptor {}).build()
        assertFalse(image === api)

        server.enqueue(MockResponse.Builder().body(Buffer().write(byteArrayOf(1, 2, 3))).build())
        val bytes = ImageHttp.fetch(image, server.url("/vi/abcdefghijk/hqdefault.jpg").toString())
        assertArrayEquals(byteArrayOf(1, 2, 3), bytes)
        val recorded = server.takeRequest()
        assertNull(recorded.headers["Authorization"])
        assertNull(recorded.headers["Cookie"])
    }

    @Test
    fun `a missing thumbnail is null, a server error is an error, a huge body is refused`() {
        val client = ImageHttp.newClient()
        server.enqueue(MockResponse.Builder().code(404).build())
        assertNull(ImageHttp.fetch(client, server.url("/a").toString()))
        server.enqueue(MockResponse.Builder().code(503).build())
        assertTrue(runCatching { ImageHttp.fetch(client, server.url("/b").toString()) }.exceptionOrNull() is IOException)
        server.enqueue(MockResponse.Builder().body(Buffer().write(ByteArray((ImageHttp.MAX_BYTES + 10).toInt()))).build())
        assertNull(ImageHttp.fetch(client, server.url("/c").toString()))
    }

    @Test
    fun `thumbnail urls are built only from real-looking video ids`() {
        assertEquals("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", CoverArt.thumbnailUrl("dQw4w9WgXcQ"))
        assertNull(CoverArt.thumbnailUrl(null))
        assertNull(CoverArt.thumbnailUrl(""))
        assertNull(CoverArt.thumbnailUrl("../../etc"))
        assertNull(CoverArt.thumbnailUrl("a b"))
    }

    @Test
    fun `the cover store keeps one file per song and forgets removed songs`() {
        val store = CoverStore(tmp.newFolder("covers"))
        store.save("8e100674-da28-75b4-81d3-5aeed873508d", byteArrayOf(9))
        store.save("../evil", byteArrayOf(8))
        assertTrue(store.file("../evil").parentFile == store.file("x").parentFile)
        val reloaded = CoverStore(store.file("x").parentFile!!).apply { load() }
        assertEquals(setOf("8e100674-da28-75b4-81d3-5aeed873508d", "../evil"), reloaded.known.value)
        assertEquals(1, reloaded.retainOnly(setOf("8e100674-da28-75b4-81d3-5aeed873508d")))
        assertFalse(reloaded.file("../evil").exists())
    }

    private fun sync(api: FakeApi, index: DownloadIndex, store: CoverStore, images: Map<String, ByteArray?>, offline: Boolean = false) =
        CoverSync(index, store, { api }, fetch = { url ->
            if (offline) throw IOException("offline")
            images[url.substringAfter("/vi/").substringBefore("/")]
        }, io = Dispatchers.Unconfined)

    @Test
    fun `a new download gets its cover, an old one learns its video from the library`() = runBlocking {
        val api = FakeApi().apply { library += song("old").copy(youtubeId = "oldVideo123") }
        val index = DownloadIndex(MemoryTextStore())
        index.put(local("old"))                                   // downloaded before covers were kept
        val store = CoverStore(tmp.newFolder("c1"))
        val sync = sync(api, index, store, mapOf("oldVideo123" to byteArrayOf(1), "newVideo123" to byteArrayOf(2)))

        sync.fetchFor(local("new").copy(youtubeId = "newVideo123"))
        assertTrue(store.has("new"))

        assertEquals(1, sync.sync())
        assertTrue(store.has("old"))
        assertEquals("oldVideo123", index["old"]?.youtubeId)
        assertEquals(1, api.calls.count { it.startsWith("listAll") })
        assertEquals(0, sync.sync())                              // nothing left to do, no second lookup
        assertEquals(1, api.calls.count { it.startsWith("listAll") })
    }

    @Test
    fun `offline it stops quietly and catches up later`() = runBlocking {
        val api = FakeApi()
        val index = DownloadIndex(MemoryTextStore())
        index.put(local("a").copy(youtubeId = "videoAaaaaa"))
        val store = CoverStore(tmp.newFolder("c2"))
        assertEquals(0, sync(api, index, store, emptyMap(), offline = true).sync())
        assertFalse(store.has("a"))
        assertEquals(1, sync(api, index, store, mapOf("videoAaaaaa" to byteArrayOf(5))).sync())
        assertTrue(store.has("a"))
    }

    @Test
    fun `songs with no video are left alone, and a removed download loses its cover`() = runBlocking {
        val api = FakeApi().apply { library += song("plain") }
        val index = DownloadIndex(MemoryTextStore())
        index.put(local("plain"))
        val store = CoverStore(tmp.newFolder("c3"))
        store.save("gone", byteArrayOf(1))
        assertEquals(0, sync(api, index, store, emptyMap()).sync())
        assertFalse(store.has("plain"))
        assertFalse(store.has("gone"))
    }
}
