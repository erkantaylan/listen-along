package com.erkantaylan.listenalong.auth

import com.erkantaylan.listenalong.BuildConfig
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLEncoder

class AuthFlowTest {

    private val server = "https://music.example.com/".toHttpUrl()
    private val now = 1_800_000_000_000L
    private val pending = PendingSignIn("state-abcdefghijklmnop", "nonce-abcdefghijklmnop", "v".repeat(43), server.toString(), now)

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    @Test
    fun `the redirect is exactly the one registered at the central login`() {
        assertEquals("com.etaylan.listen:/oauth2redirect", AuthFlow.REDIRECT_URI)
        assertEquals("com.etaylan.listen", BuildConfig.AUTH_REDIRECT_SCHEME)
    }

    @Test
    fun `S256 gives what the server computes (Node crypto, mobileTokens s256)`() {
        assertEquals(
            "FuEq_-Cd4c52HjjpFLYGmZmc64RONMQXlJPQNyR4pr8",
            AuthFlow.challenge("dBjftJeZ4CVP-mJ92K9YWUAAh7iKQq0ZC9XzBXhP8Jw"),
        )
    }

    @Test
    fun `a new sign-in has a fresh verifier, state and nonce of the allowed characters`() {
        val a = AuthFlow.newPending(server, now)
        val b = AuthFlow.newPending(server, now)
        val allowed = Regex("^[A-Za-z0-9_-]{43}$")
        for (v in listOf(a.state, a.nonce, a.verifier)) assertTrue(v, allowed.matches(v))
        assertNotEquals(a.verifier, b.verifier)
        assertNotEquals(a.state, b.state)
        assertNotEquals(a.state, a.nonce)
        assertEquals(server.toString(), a.server)
    }

    @Test
    fun `the start page carries state, nonce and the challenge, never the verifier`() {
        val url = AuthFlow.startUrl("https://music.example.com/sub/".toHttpUrl(), pending)
        assertEquals("/sub/auth/mobile/start", url.encodedPath)
        assertEquals(pending.state, url.queryParameter("state"))
        assertEquals(pending.nonce, url.queryParameter("nonce"))
        assertEquals(AuthFlow.challenge(pending.verifier), url.queryParameter("code_challenge"))
        assertEquals("S256", url.queryParameter("code_challenge_method"))
        assertTrue(!url.toString().contains(pending.verifier))
    }

    @Test
    fun `a redirect with our state gives the code`() {
        val r = AuthFlow.parseRedirect(
            "com.etaylan.listen:/oauth2redirect?code=${enc("a/b+c")}&state=${pending.state}&iss=${enc("https://id.example.com/x/")}",
            pending, now + 1000,
        )
        assertEquals(Redirect.Code("a/b+c", "https://id.example.com/x/", pending), r)
    }

    @Test
    fun `anything else is not ours, or unexpected`() {
        assertEquals(Redirect.NotOurs, AuthFlow.parseRedirect("https://music.example.com/?code=x", pending, now))
        assertEquals(Redirect.NotOurs, AuthFlow.parseRedirect("com.etaylan.listen:/other?code=x&state=${pending.state}", pending, now))
        assertEquals(Redirect.NotOurs, AuthFlow.parseRedirect("com.etaylan.listenx:/oauth2redirect?code=x", pending, now))
        // Ours in shape, but no sign-in waiting, another state, none at all, or too old.
        assertEquals(Redirect.Unexpected, AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?code=x&state=${pending.state}", null, now))
        assertEquals(Redirect.Unexpected, AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?code=x&state=forged", pending, now))
        assertEquals(Redirect.Unexpected, AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?code=x", pending, now))
        assertEquals(Redirect.Unexpected,
            AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?code=x&state=${pending.state}", pending, now + AuthFlow.MAX_AGE_MS + 1))
        // A second state parameter does not win over the first.
        assertEquals(Redirect.Unexpected,
            AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?code=x&state=forged&state=${pending.state}", pending, now))
    }

    @Test
    fun `errors come back as errors, a code-less answer is invalid`() {
        assertEquals(Redirect.Error("access_denied"),
            AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?error=access_denied&state=${pending.state}", pending, now))
        assertEquals(Redirect.Error("invalid_request"),
            AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?state=${pending.state}", pending, now))
    }

    @Test
    fun `the pending sign-in survives storage, garbage reads as none`() {
        assertEquals(pending, AuthFlow.decode(AuthFlow.encode(pending)))
        assertNull(AuthFlow.decode(""))
        assertNull(AuthFlow.decode(null))
        assertNull(AuthFlow.decode("{not json"))
    }
}
