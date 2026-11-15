package com.erkantaylan.listenalong.core.auth

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
    fun `the App Link is the production server's https callback`() {
        assertEquals("music.etaylan.com", BuildConfig.AUTH_APP_LINK_HOST)
        assertEquals("https://music.etaylan.com/auth/mobile/callback", AuthFlow.APP_LINK_URI)
    }

    @Test
    fun `redirectFor - the App Link only for a release build on the production server`() {
        val appLink = AuthFlow.APP_LINK_URI
        val scheme = AuthFlow.REDIRECT_URI
        assertEquals(appLink, AuthFlow.redirectFor("https://music.etaylan.com/".toHttpUrl(), appLinks = true))
        assertEquals(appLink, AuthFlow.redirectFor("https://MUSIC.etaylan.com/".toHttpUrl(), appLinks = true))
        // Debug builds: never verified for the production host.
        assertEquals(scheme, AuthFlow.redirectFor("https://music.etaylan.com/".toHttpUrl(), appLinks = false))
        // Any other server cannot be declared in the manifest.
        for (other in listOf(
            "https://music.example.com/", "http://music.etaylan.com/", "https://music.etaylan.com:8443/",
            "https://music.etaylan.com/sub/", "https://etaylan.com/", "https://x.music.etaylan.com/",
            "http://localhost:8091/", "http://10.0.2.2:3100/",
        )) assertEquals(other, scheme, AuthFlow.redirectFor(other.toHttpUrl(), appLinks = true))
        assertEquals("this build's default", if (BuildConfig.AUTH_APP_LINKS) appLink else scheme,
            AuthFlow.redirectFor("https://music.etaylan.com/".toHttpUrl()))
    }

    @Test
    fun `the start page asks for the sign-in's redirect`() {
        val link = pending.copy(redirect = AuthFlow.APP_LINK_URI)
        assertEquals(AuthFlow.APP_LINK_URI, AuthFlow.startUrl(server, link).queryParameter("redirect_uri"))
        assertEquals(AuthFlow.REDIRECT_URI, AuthFlow.startUrl(server, pending).queryParameter("redirect_uri"))
    }

    @Test
    fun `an App Link redirect is read exactly like the scheme`() {
        val link = pending.copy(redirect = AuthFlow.APP_LINK_URI)
        assertEquals(Redirect.Code("a/b+c", null, link),
            AuthFlow.parseRedirect("https://music.etaylan.com/auth/mobile/callback?code=${enc("a/b+c")}&state=${pending.state}", link, now))
        assertEquals(Redirect.Error("access_denied"),
            AuthFlow.parseRedirect("https://music.etaylan.com/auth/mobile/callback?error=access_denied&state=${pending.state}", link, now))
        assertEquals(Redirect.Unexpected,
            AuthFlow.parseRedirect("https://music.etaylan.com/auth/mobile/callback?code=x&state=forged", link, now))
        assertEquals(Redirect.Unexpected,
            AuthFlow.parseRedirect("https://music.etaylan.com/auth/mobile/callback?code=x&state=${pending.state}", null, now))
        // A server from before App Links ignores redirect_uri and answers on the
        // scheme: still this sign-in (the state says so).
        assertEquals(Redirect.Code("x", null, link),
            AuthFlow.parseRedirect("com.etaylan.listen:/oauth2redirect?code=x&state=${pending.state}", link, now))
        // Not ours: another path, host or scheme.
        for (other in listOf(
            "https://music.etaylan.com/auth/mobile/callbackx?code=x&state=${pending.state}",
            "https://music.etaylan.com/auth/mobile/start?code=x&state=${pending.state}",
            "https://evil.example/auth/mobile/callback?code=x&state=${pending.state}",
            "http://music.etaylan.com/auth/mobile/callback?code=x&state=${pending.state}",
        )) assertEquals(other, Redirect.NotOurs, AuthFlow.parseRedirect(other, link, now))
    }

    @Test
    fun `a sign-in stored by an older version used the custom scheme`() {
        val old = """{"state":"${pending.state}","nonce":"${pending.nonce}","verifier":"${pending.verifier}","server":"$server","startedAt":$now}"""
        assertEquals(AuthFlow.REDIRECT_URI, AuthFlow.decode(old)!!.redirect)
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
