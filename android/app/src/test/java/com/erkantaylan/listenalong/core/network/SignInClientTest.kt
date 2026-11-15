package com.erkantaylan.listenalong.core.network

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException

/** The contract of backend/src/mobileAuth.js, from the app's side. */
class SignInClientTest {

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

    private fun client() = SignInClient(ServerUrl.normalize(server.url("/").toString())!!)

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test
    fun `exchange posts the code, verifier and nonce and reads the session`() = runTest {
        server.enqueue(json("""{"token":"lam_x","token_type":"Bearer","expires_at":1800000000000,"mode":"central",
            "user":{"id":"u1","name":"Erkan","status":"approved"},"extra":true}"""))
        val grant = client().exchange("c", "s".repeat(16), "v".repeat(43), "n".repeat(16), "https://id/", previousToken = "lam_old",
            redirectUri = "https://music.etaylan.com/auth/mobile/callback")
        assertEquals("lam_x", grant.token)
        assertEquals("central", grant.mode)
        assertEquals("Erkan", grant.user?.name)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/auth/mobile/exchange", request.url.encodedPath)
        assertEquals("Bearer lam_old", request.headers["Authorization"])
        val body = apiJson.parseToJsonElement(request.body!!.utf8()).jsonObject
        assertEquals("c", body["code"]!!.jsonPrimitive.content)
        assertEquals("v".repeat(43), body["code_verifier"]!!.jsonPrimitive.content)
        assertEquals("n".repeat(16), body["nonce"]!!.jsonPrimitive.content)
        assertEquals("s".repeat(16), body["state"]!!.jsonPrimitive.content)
        assertEquals("https://id/", body["iss"]!!.jsonPrimitive.content)
        assertEquals("the redirect the sign-in was started with", "https://music.etaylan.com/auth/mobile/callback", body["redirect_uri"]!!.jsonPrimitive.content)
    }

    @Test
    fun `no previous session, no iss - neither is sent`() = runTest {
        server.enqueue(json("""{"token":"lam_x","mode":"dev"}"""))
        assertEquals("dev", client().exchange("c", "s", "v", "n", null, null, "com.etaylan.listen:/oauth2redirect").mode)
        val request = server.takeRequest()
        assertNull(request.headers["Authorization"])
        assertFalse(apiJson.parseToJsonElement(request.body!!.utf8()).jsonObject.containsKey("iss"))
    }

    private suspend fun refusedWith(response: MockResponse): String {
        server.enqueue(response)
        try {
            client().exchange("c", "s", "v", "n", null, null, "com.etaylan.listen:/oauth2redirect")
            fail("expected a refusal")
        } catch (e: SignInException) {
            return e.code
        }
        error("unreachable")
    }

    @Test
    fun `the server's refusal codes come through`() = runTest {
        assertEquals("signin_failed", refusedWith(json("""{"error":"x","code":"signin_failed"}""", 400)))
        assertEquals("account_disabled", refusedWith(json("""{"error":"x","code":"account_disabled"}""", 403)))
        assertEquals("registrations_closed", refusedWith(json("""{"error":"x","code":"registrations_closed"}""", 403)))
        assertEquals("link_conflict", refusedWith(json("""{"error":"x","code":"link_conflict"}""", 409)))
        assertEquals("signin_unavailable", refusedWith(json("""{"error":"x","code":"signin_unavailable"}""", 503)))
        assertEquals("rate_limited", refusedWith(json("""{"error":"Too many sign-in attempts"}""", 429)))
        assertEquals("not_supported", refusedWith(json("""{"error":"Not found"}""", 404)))
    }

    @Test
    fun `a proxy's 502 page is an outage, not a refusal`() = runTest {
        server.enqueue(MockResponse.Builder().code(502).body("<html>Bad gateway</html>").build())
        try {
            client().exchange("c", "s", "v", "n", null, null, "com.etaylan.listen:/oauth2redirect")
            fail("expected IOException")
        } catch (e: SignInException) {
            fail("not a refusal")
        } catch (_: IOException) {
        }
    }

    @Test
    fun `logout sends the session`() = runTest {
        server.enqueue(json("""{"success":true}"""))
        client().logout("lam_x")
        val request = server.takeRequest()
        assertEquals("/auth/mobile/logout", request.url.encodedPath)
        assertEquals("Bearer lam_x", request.headers["Authorization"])
    }
}
