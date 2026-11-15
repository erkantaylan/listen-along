package com.erkantaylan.listenalong.core.network

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Offline must never look like signed out: only a 401 counts. */
class SessionEndedInterceptorTest {

    private lateinit var server: MockWebServer
    private val ended = mutableListOf<String>()
    private val http = OkHttpClient.Builder()
        .addInterceptor(SessionEndedInterceptor { ended += it })
        .connectTimeout(2, TimeUnit.SECONDS)
        .build()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun call(token: String?) = http.newCall(
        Request.Builder().url(server.url("/api/library"))
            .apply { if (token != null) header("Authorization", "Bearer $token") }.build()
    ).execute().use { it.code }

    @Test
    fun `a 401 SESSION_ENDED for a session names that session, and the caller still reads the body`() {
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":"Your session has ended","code":"SESSION_ENDED"}""").build())
        val body = http.newCall(Request.Builder().url(server.url("/api/library")).header("Authorization", "Bearer lam_abc").build())
            .execute().use { it.body.string() }
        assertTrue(body.contains("Your session has ended"))
        assertEquals(listOf("lam_abc"), ended)
    }

    @Test
    fun `a bare 401, a 401 AUTH_REQUIRED, an HTML 401 or a redirect to the login page sign nobody out`() {
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":"Admin login required"}""").build())
        server.enqueue(MockResponse.Builder().code(401).body("""{"error":"Authentication required","code":"AUTH_REQUIRED"}""").build())
        server.enqueue(MockResponse.Builder().code(401).body("<html>Unauthorized</html>").build())
        server.enqueue(MockResponse.Builder().code(401).build())
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/login").build())
        server.enqueue(MockResponse.Builder().code(200).body("<html>login</html>").build())
        repeat(5) { call("lam_abc") }
        assertTrue(ended.isEmpty())
    }

    @Test
    fun `403, 5xx, 404 and a 401 without a session sign nobody out`() {
        for (code in listOf(403, 500, 502, 503, 404)) server.enqueue(MockResponse.Builder().code(code).build())
        server.enqueue(MockResponse.Builder().code(401).build())
        repeat(5) { call("lam_abc") }
        call(null)
        assertTrue(ended.isEmpty())
    }

    @Test
    fun `no answer at all signs nobody out`() {
        val url = server.url("/api/library")
        server.close()
        try {
            http.newCall(Request.Builder().url(url).header("Authorization", "Bearer lam_abc").build()).execute().close()
            fail("expected a connection failure")
        } catch (_: IOException) {
        }
        assertTrue(ended.isEmpty())
    }
}
