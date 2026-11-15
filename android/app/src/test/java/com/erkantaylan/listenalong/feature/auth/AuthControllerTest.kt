package com.erkantaylan.listenalong.feature.auth

import com.erkantaylan.listenalong.core.network.SessionGrant
import com.erkantaylan.listenalong.core.network.SessionUser
import com.erkantaylan.listenalong.core.network.SignInException
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class AuthControllerTest {

    private val server = "https://music.example.com/".toHttpUrl()

    private class FakeSessions(var config: ServerConfig) : SessionHolder {
        override val current: ServerConfig get() = config
        override fun signIn(token: String, userName: String?) {
            config = config.copy(token = token, userName = userName)
        }
        override fun endSession(token: String): Boolean {
            if (config.token != token) return false
            config = config.copy(token = null, userName = null)
            return true
        }
    }

    private class FakeApi : SignInApi {
        val exchanges = mutableListOf<List<String?>>()
        val logouts = mutableListOf<String>()
        var answer: () -> SessionGrant = { SessionGrant(token = "lam_new", user = SessionUser("u1", "Erkan", "approved")) }
        var logoutFails = false
        val redirects = mutableListOf<String>()
        override suspend fun exchange(code: String, state: String, verifier: String, nonce: String, iss: String?, previousToken: String?, redirectUri: String): SessionGrant {
            exchanges += listOf(code, state, verifier, nonce, iss, previousToken)
            redirects += redirectUri
            return answer()
        }
        override suspend fun logout(token: String) {
            logouts += token
            if (logoutFails) throw IOException("offline")
        }
    }

    private class Rig(scope: TestScope, server: HttpUrl, token: String? = null, allowDev: Boolean = false,
                      val store: MemoryTextStore = MemoryTextStore(), var clock: Long = 1_800_000_000_000L,
                      appLinks: Boolean = false) {
        val sessions = FakeSessions(ServerConfig(server, token))
        val api = FakeApi()
        val auth = AuthController(sessions, store, { api }, allowDev, scope, now = { clock }, appLinks = appLinks)
        val events = mutableListOf<AuthEvent>()

        /** begin(), then what the IdP would send back for that sign-in. */
        fun startAndRedirect(extra: String = "&code=the-code&iss=https%3A%2F%2Fid.example.com%2F"): String {
            val url = auth.begin()
            val state = url.queryParameter("state")!!
            return "com.etaylan.listen:/oauth2redirect?state=$state$extra"
        }
    }

    private fun TestScope.rig(token: String? = null, allowDev: Boolean = false) = Rig(this, server, token, allowDev)

    @Test
    fun `happy path - browser, redirect, exchange, signed in`() = runTest {
        val r = rig(token = null)
        val url = r.auth.begin()
        assertEquals(SignInUi.InBrowser, r.auth.ui.value)
        assertEquals("/auth/mobile/start", url.encodedPath)
        val pending = AuthFlow.decode(r.store.read())!!
        assertEquals(AuthFlow.challenge(pending.verifier), url.queryParameter("code_challenge"))

        assertTrue(r.auth.handleRedirect("com.etaylan.listen:/oauth2redirect?code=c1&state=${pending.state}&iss=https%3A%2F%2Fid"))
        assertEquals(SignInUi.Exchanging, r.auth.ui.value)
        assertNull("the pending sign-in is single-use", AuthFlow.decode(r.store.read()))
        advanceUntilIdle()

        assertEquals(listOf("c1", pending.state, pending.verifier, pending.nonce, "https://id", null), r.api.exchanges.single())
        assertEquals("lam_new", r.sessions.config.token)
        assertEquals("Erkan", r.sessions.config.userName)
        assertEquals(SignInUi.Idle(), r.auth.ui.value)
    }

    @Test
    fun `release build on the production server - the App Link, handled exactly like the scheme`() = runTest {
        val r = Rig(this, "https://music.etaylan.com/".toHttpUrl(), appLinks = true)
        val url = r.auth.begin()
        val appLink = "https://music.etaylan.com/auth/mobile/callback"
        assertEquals(appLink, url.queryParameter("redirect_uri"))
        val pending = AuthFlow.decode(r.store.read())!!
        assertEquals(appLink, pending.redirect)

        // A forged one (not our state) leaves the real sign-in waiting.
        assertTrue(r.auth.handleRedirect("$appLink?code=c0&state=forged"))
        assertTrue(r.api.exchanges.isEmpty())
        assertTrue("left waiting for the real one", AuthFlow.decode(r.store.read()) != null)

        val redirect = "$appLink?code=c1&state=${pending.state}"
        assertTrue(r.auth.handleRedirect(redirect))
        assertNull("single-use", AuthFlow.decode(r.store.read()))
        advanceUntilIdle()
        assertEquals("c1", r.api.exchanges.single()[0])
        assertEquals("the exchange names the same redirect", listOf(appLink), r.api.redirects)
        assertEquals("lam_new", r.sessions.config.token)
        assertTrue(r.auth.handleRedirect(redirect))
        advanceUntilIdle()
        assertEquals("a replay exchanges nothing", 1, r.api.exchanges.size)
    }

    @Test
    fun `the custom scheme everywhere else - debug builds, other servers - and the exchange says so`() = runTest {
        for ((server, appLinks) in listOf("https://music.etaylan.com/" to false, "https://music.example.com/" to true)) {
            val r = Rig(this, server.toHttpUrl(), appLinks = appLinks)
            val url = r.auth.begin()
            assertEquals(AuthFlow.REDIRECT_URI, url.queryParameter("redirect_uri"))
            val state = url.queryParameter("state")!!
            r.auth.handleRedirect("com.etaylan.listen:/oauth2redirect?code=c2&state=$state")
            advanceUntilIdle()
            assertEquals(listOf(AuthFlow.REDIRECT_URI), r.api.redirects)
        }
    }

    @Test
    fun `the same redirect twice exchanges once`() = runTest {
        val r = rig()
        val redirect = r.startAndRedirect()
        r.auth.handleRedirect(redirect)
        advanceUntilIdle()
        assertTrue(r.auth.handleRedirect(redirect))
        advanceUntilIdle()
        assertEquals(1, r.api.exchanges.size)
        assertEquals("a replayed link does not sign out", "lam_new", r.sessions.config.token)
    }

    @Test
    fun `a forged redirect is refused and leaves the real sign-in alone`() = runTest {
        val r = rig()
        val real = r.startAndRedirect()
        assertTrue(r.auth.handleRedirect("com.etaylan.listen:/oauth2redirect?code=attacker&state=forged"))
        val ui = r.auth.ui.value as SignInUi.Idle
        assertTrue(ui.error)
        assertTrue(r.api.exchanges.isEmpty())
        r.auth.handleRedirect(real)
        advanceUntilIdle()
        assertEquals("the-code", r.api.exchanges.single()[0])
        assertTrue(r.sessions.config.signedIn)
    }

    @Test
    fun `other links are not ours`() = runTest {
        val r = rig()
        assertFalse(r.auth.handleRedirect("https://music.example.com/playlist/1"))
    }

    @Test
    fun `a sign-in that took too long is refused`() = runTest {
        val r = rig()
        val redirect = r.startAndRedirect()
        r.clock += AuthFlow.MAX_AGE_MS + 1
        r.auth.handleRedirect(redirect)
        advanceUntilIdle()
        assertTrue(r.api.exchanges.isEmpty())
        assertNull("a stale pending sign-in is dropped", AuthFlow.decode(r.store.read()))
    }

    @Test
    fun `cancelled in the browser`() = runTest {
        val r = rig()
        r.auth.handleRedirect(r.startAndRedirect("&error=access_denied"))
        assertEquals(SignInUi.Idle("Sign-in was cancelled.", error = true), r.auth.ui.value)
        assertFalse(r.sessions.config.signedIn)
    }

    @Test
    fun `refusals and outages leave the app signed out with a reason`() = runTest {
        val cases = mapOf(
            SignInException("account_disabled", 403, "x") to "Your account has been disabled.",
            SignInException("registrations_closed", 403, "x") to "There is no account for you on music.example.com, and it is not taking new ones.",
            SignInException("link_conflict", 409, "x") to "This sign-in could not be linked to your account. Contact the administrator.",
            SignInException("signin_failed", 400, "x") to "Sign-in did not work. Try again.",
            IOException("no route") to "Sign-in cannot be reached right now. Try again later.",
        )
        for ((thrown, message) in cases) {
            val r = rig()
            r.api.answer = { throw thrown }
            r.auth.handleRedirect(r.startAndRedirect())
            advanceUntilIdle()
            assertFalse(r.sessions.config.signedIn)
            assertEquals(SignInUi.Idle(message, error = true), r.auth.ui.value)
        }
    }

    @Test
    fun `a development server's session is refused by release builds, taken by debug ones`() = runTest {
        val release = rig(allowDev = false)
        release.api.answer = { SessionGrant(token = "lam_dev", mode = "dev") }
        release.auth.handleRedirect(release.startAndRedirect())
        advanceUntilIdle()
        assertFalse(release.sessions.config.signedIn)
        assertEquals(listOf("lam_dev"), release.api.logouts)
        assertTrue((release.auth.ui.value as SignInUi.Idle).message!!.contains("development"))

        val debug = rig(allowDev = true)
        debug.api.answer = { SessionGrant(token = "lam_dev", mode = "dev") }
        debug.auth.handleRedirect(debug.startAndRedirect())
        advanceUntilIdle()
        assertEquals("lam_dev", debug.sessions.config.token)
    }

    @Test
    fun `a pending account is signed in and told so`() = runTest {
        val r = rig()
        r.api.answer = { SessionGrant(token = "lam_p", user = SessionUser("u2", "New", "pending")) }
        r.auth.handleRedirect(r.startAndRedirect())
        advanceUntilIdle()
        assertTrue(r.sessions.config.signedIn)
        assertEquals("Signed in. Your account is waiting for approval.", (r.auth.ui.value as SignInUi.Idle).message)
    }

    @Test
    fun `signing in again sends the old session so the server ends it`() = runTest {
        val r = rig(token = "lam_old")
        r.auth.handleRedirect(r.startAndRedirect())
        advanceUntilIdle()
        assertEquals("lam_old", r.api.exchanges.single()[5])
        assertEquals("lam_new", r.sessions.config.token)
    }

    @Test
    fun `the server was changed while the browser was open`() = runTest {
        val r = rig()
        val redirect = r.startAndRedirect()
        r.sessions.config = ServerConfig("https://other.example.com/".toHttpUrl(), null)
        r.auth.handleRedirect(redirect)
        advanceUntilIdle()
        assertTrue(r.api.exchanges.isEmpty())
        assertFalse(r.sessions.config.signedIn)
    }

    @Test
    fun `the pending sign-in survives the process being killed while the browser was open`() = runTest {
        val first = rig()
        val redirect = first.startAndRedirect()
        val second = Rig(this, server, store = first.store, clock = first.clock + 5_000)
        second.auth.handleRedirect(redirect)
        advanceUntilIdle()
        assertEquals("lam_new", second.sessions.config.token)
    }

    @Test
    fun `closing the browser stops waiting, a late redirect still works`() = runTest {
        val r = rig()
        val redirect = r.startAndRedirect()
        r.auth.browserClosed()
        assertEquals(SignInUi.Idle(), r.auth.ui.value)
        r.auth.handleRedirect(redirect)
        advanceUntilIdle()
        assertTrue(r.sessions.config.signedIn)
    }

    @Test
    fun `only a 401 for the session in force signs out`() = runTest {
        val r = rig(token = "lam_live")
        val job = launch(UnconfinedTestDispatcher(testScheduler)) { r.auth.events.collect { r.events += it } }
        r.auth.sessionEnded("lam_older")
        assertTrue("a 401 for an older session changes nothing", r.sessions.config.signedIn)
        r.auth.sessionEnded("lam_live")
        assertFalse(r.sessions.config.signedIn)
        assertEquals(SignInUi.Idle("Your session ended. Sign in again.", error = true), r.auth.ui.value)
        advanceUntilIdle()
        assertEquals(listOf<AuthEvent>(AuthEvent.SessionEnded), r.events)
        r.auth.sessionEnded("lam_live")
        advanceUntilIdle()
        assertEquals("ended once", 1, r.events.size)
        job.cancel()
    }

    @Test
    fun `sign out is immediate here, and the server is told even when that fails`() = runTest {
        val r = rig(token = "lam_live")
        r.api.logoutFails = true
        r.auth.signOut()
        assertFalse(r.sessions.config.signedIn)
        advanceUntilIdle()
        assertEquals(listOf("lam_live"), r.api.logouts)
        assertEquals(SignInUi.Idle("Signed out."), r.auth.ui.value)
    }
}
