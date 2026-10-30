package com.erkantaylan.listenalong.api

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class LibraryClientTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun client(token: String? = null, prefix: String = "/") =
        LibraryClient(ServerUrl.normalize(server.url(prefix).toString())!!, token)

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private val twoSongs = """
        {"songs":[
          {"id":"0b9e6f0e-1111-4a5b-9c1d-000000000001","youtube_id":"dQw4w9WgXcQ","title":"Never Gonna",
           "artist":"Rick","album":null,"duration_sec":213,"uploaded_by":"erkan",
           "created_at":"2026-10-01T10:00:00.000Z","source_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
          {"id":"0b9e6f0e-1111-4a5b-9c1d-000000000002","youtube_id":null,"title":"Legacy",
           "artist":"Unknown","duration_sec":187.6,"uploaded_by":"migration","created_at":"2025-01-01",
           "extra_field_from_a_newer_server":true}
        ],"total":42}
    """.trimIndent()

    @Test
    fun `list parses songs and sends query, paging and sort`() = runTest {
        server.enqueue(json(twoSongs))

        val page = client().list(query = "  rick astley ", limit = 50, offset = 100, sort = SortOrder.ARTIST)

        assertEquals(42, page.total)
        assertEquals(2, page.songs.size)
        val first = page.songs[0]
        assertEquals("0b9e6f0e-1111-4a5b-9c1d-000000000001", first.id)
        assertEquals("Never Gonna", first.title)
        assertEquals("Rick", first.artist)
        assertEquals(213, first.durationSec)
        assertEquals("erkan", first.uploadedBy)
        assertNull(first.album)
        assertEquals(188, page.songs[1].durationSec) // fractional seconds round

        val request = server.takeRequest()
        val url = request.url
        assertEquals("/api/library", url.encodedPath)
        assertEquals("rick astley", url.queryParameter("q"))
        assertEquals("50", url.queryParameter("limit"))
        assertEquals("100", url.queryParameter("offset"))
        assertEquals("artist", url.queryParameter("sort"))
        assertNull("no token, no Authorization header", request.headers["Authorization"])
    }

    @Test
    fun `blank query is omitted and limit is clamped to the server maximum`() = runTest {
        server.enqueue(json("""{"songs":[],"total":0}"""))
        client().list(query = "   ", limit = 5000)
        val url = server.takeRequest().url
        assertNull(url.queryParameter("q"))
        assertEquals("1000", url.queryParameter("limit"))
        assertEquals("recent", url.queryParameter("sort"))
    }

    @Test
    fun `token is sent as a bearer header`() = runTest {
        server.enqueue(json("""{"songs":[],"total":0}"""))
        client(token = " secret-token ").list()
        assertEquals("Bearer secret-token", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun `base url path prefix is kept`() = runTest {
        server.enqueue(json("""{"songs":[],"total":0}"""))
        client(prefix = "/listen/").list()
        assertEquals("/listen/api/library", server.takeRequest().url.encodedPath)
    }

    @Test
    fun `me returns the token's name`() = runTest {
        server.enqueue(json("""{"name":"erkan-phone"}"""))
        assertEquals("erkan-phone", client(token = "t").me().name)
        val request = server.takeRequest()
        assertEquals("/api/me", request.url.encodedPath)
        assertEquals("Bearer t", request.headers["Authorization"])
    }

    @Test
    fun `error answers become ApiException with the server's message`() = runTest {
        server.enqueue(json("""{"error":"Invalid or revoked token"}""", code = 401))
        try {
            client(token = "bad").me()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(401, e.code)
            assertTrue(e.unauthorized)
            assertEquals("Invalid or revoked token", e.message)
        }
    }

    @Test
    fun `non-json error body falls back to the status`() = runTest {
        server.enqueue(MockResponse.Builder().code(502).body("<html>Bad gateway</html>").build())
        try {
            client().list()
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(502, e.code)
            assertFalse(e.unauthorized)
            assertEquals("HTTP 502", e.message)
        }
    }

    @Test
    fun `listAll walks every page`() = runTest {
        server.enqueue(json("""{"songs":[{"id":"a","title":"A"},{"id":"b","title":"B"}],"total":5}"""))
        server.enqueue(json("""{"songs":[{"id":"c","title":"C"},{"id":"d","title":"D"}],"total":5}"""))
        server.enqueue(json("""{"songs":[{"id":"e","title":"E"}],"total":5}"""))

        val all = client().listAll(query = "x", pageSize = 2)

        assertEquals(listOf("a", "b", "c", "d", "e"), all.map { it.id })
        assertEquals("0", server.takeRequest().url.queryParameter("offset"))
        assertEquals("2", server.takeRequest().url.queryParameter("offset"))
        assertEquals("4", server.takeRequest().url.queryParameter("offset"))
    }

    @Test
    fun `listAll stops on an empty page even if total says otherwise`() = runTest {
        server.enqueue(json("""{"songs":[{"id":"a"}],"total":10}"""))
        server.enqueue(json("""{"songs":[],"total":10}"""))
        assertEquals(1, client().listAll(pageSize = 1).size)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `streamFile hands over content type, length and the exact bytes`() {
        val bytes = ByteArray(300_000) { (it % 251).toByte() }
        server.enqueue(
            MockResponse.Builder()
                .addHeader("Content-Type", "audio/mpeg")
                .body(okio.Buffer().write(bytes))
                .build()
        )

        val (type, length, received) = client(token = "t").streamFile("song-id/with?odd chars") { ct, len, body ->
            Triple(ct, len, body.readBytes())
        }

        assertEquals("audio/mpeg", type)
        assertEquals(bytes.size.toLong(), length)
        assertTrue(bytes.contentEquals(received))
        val request = server.takeRequest()
        // The id is one path segment, percent-encoded, never a path traversal.
        assertEquals("/api/library/song-id%2Fwith%3Fodd%20chars/file", request.url.encodedPath)
        assertEquals("Bearer t", request.headers["Authorization"])
    }

    @Test
    fun `streamFile surfaces a 404 as ApiException`() {
        server.enqueue(json("""{"error":"Song not found"}""", code = 404))
        try {
            client().streamFile("nope") { _, _, _ -> Unit }
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(404, e.code)
            assertEquals("Song not found", e.message)
        }
    }
}
