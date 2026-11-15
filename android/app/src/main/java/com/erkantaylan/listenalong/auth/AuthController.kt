package com.erkantaylan.listenalong.auth

import com.erkantaylan.listenalong.api.SessionGrant
import com.erkantaylan.listenalong.api.SignInException
import com.erkantaylan.listenalong.settings.ServerConfig
import com.erkantaylan.listenalong.storage.TextStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.security.SecureRandom

/** Where the session lives (SettingsStore; a fake in tests). */
interface SessionHolder {
    /** The server in force and its session, if any. */
    val current: ServerConfig
    fun signIn(token: String, userName: String?)
    /** Forgets [token] if it is still the session in force; true when it was. */
    fun endSession(token: String): Boolean
}

/** The server calls of a sign-in (api/SignInClient; a fake in tests). */
interface SignInApi {
    /** [redirectUri]: the redirect the sign-in was started with (the server binds the code to it). */
    suspend fun exchange(code: String, state: String, verifier: String, nonce: String, iss: String?, previousToken: String?, redirectUri: String): SessionGrant
    suspend fun logout(token: String)
}

/** The sign-in card's state. Signed in or not is the session itself ([SessionHolder.current]). */
sealed interface SignInUi {
    /** Nothing under way; [message] is the outcome of the last attempt or why the session ended. */
    data class Idle(val message: String? = null, val error: Boolean = false) : SignInUi
    /** The browser is open on the sign-in page. */
    data object InBrowser : SignInUi
    /** The code is being exchanged. */
    data object Exchanging : SignInUi
}

sealed interface AuthEvent {
    data class SignedIn(val name: String?) : AuthEvent
    /** The server answered 401 for the session: back to "Sign in". */
    data object SessionEnded : AuthEvent
}

/**
 * The app's sign-in as a small state machine:
 *
 *   signed out --begin()--> InBrowser --redirect with code--> Exchanging --200--> signed in
 *                               |                                  |
 *                               +--error / unexpected / cancel ----+--refused / offline--> Idle(message)
 *   signed in --401 for that session (sessionEnded)--> signed out, "Your session ended"
 *   signed in --signOut()--> signed out (the server is told when it can be reached)
 *
 * Only a definite 401 ends a session ([SessionEndedInterceptor]); being
 * offline never does. The pending sign-in (state, nonce, verifier) is kept in
 * [pendingStore] (encrypted) so a redirect still works after the process was
 * killed while the browser was open; it is single-use. A redirect whose state
 * is not ours is refused and leaves a real sign-in in progress alone. A
 * development server's session (`mode: dev`) is refused unless
 * [allowDevSignIn] (debug builds). The redirect (App Link or custom scheme)
 * is picked once per sign-in by [AuthFlow.redirectFor]; [appLinks] is whether
 * this build declares the App Link (release builds).
 */
class AuthController(
    private val sessions: SessionHolder,
    private val pendingStore: TextStore,
    private val apiFor: (HttpUrl) -> SignInApi,
    private val allowDevSignIn: Boolean,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
    private val appLinks: Boolean = false,
) {
    private val _ui = MutableStateFlow<SignInUi>(SignInUi.Idle())
    val ui: StateFlow<SignInUi> = _ui.asStateFlow()

    private val _events = MutableSharedFlow<AuthEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<AuthEvent> = _events.asSharedFlow()

    /** Starts a sign-in against the server in force; returns the page for the Custom Tab. */
    fun begin(): HttpUrl {
        val server = sessions.current.baseUrl
        val pending = AuthFlow.newPending(server, now(), random, AuthFlow.redirectFor(server, appLinks))
        pendingStore.write(AuthFlow.encode(pending))
        _ui.value = SignInUi.InBrowser
        return AuthFlow.startUrl(server, pending)
    }

    /** Back in the app with no redirect (the browser was closed): stop waiting. A late redirect still works. */
    fun browserClosed() {
        if (_ui.value == SignInUi.InBrowser) _ui.value = SignInUi.Idle()
    }

    fun cancel() {
        clearPending()
        _ui.value = SignInUi.Idle()
    }

    /** True when [uri] was a sign-in redirect (handled, whatever came of it). */
    fun handleRedirect(uri: String): Boolean {
        val pending = AuthFlow.decode(pendingStore.read())
        when (val r = AuthFlow.parseRedirect(uri, pending, now())) {
            Redirect.NotOurs -> return false
            Redirect.Unexpected -> {
                // A link from elsewhere must not cancel a real sign-in; a stale one goes.
                if (pending != null && now() - pending.startedAt > AuthFlow.MAX_AGE_MS) clearPending()
                fail("unexpected")
            }
            is Redirect.Error -> {
                clearPending()
                fail(r.error)
            }
            is Redirect.Code -> {
                clearPending()
                exchange(r)
            }
        }
        return true
    }

    private fun exchange(r: Redirect.Code) {
        val server = r.pending.server.toHttpUrlOrNull()
        val current = sessions.current
        if (server == null || server != current.baseUrl) {
            fail("unexpected") // the server was changed while the browser was open
            return
        }
        _ui.value = SignInUi.Exchanging
        scope.launch {
            try {
                val p = r.pending
                val grant = apiFor(server).exchange(r.code, p.state, p.verifier, p.nonce, r.iss, current.token, p.redirect)
                if (grant.mode == "dev" && !allowDevSignIn) {
                    runCatching { apiFor(server).logout(grant.token) }
                    fail("dev_refused")
                    return@launch
                }
                sessions.signIn(grant.token, grant.user?.name?.takeIf { it.isNotBlank() })
                _ui.value = SignInUi.Idle(
                    if (grant.user?.status == "pending") "Signed in. Your account is waiting for approval." else null,
                )
                _events.tryEmit(AuthEvent.SignedIn(grant.user?.name))
            } catch (c: CancellationException) {
                throw c
            } catch (e: SignInException) {
                fail(e.code)
            } catch (e: IOException) {
                fail("signin_unavailable")
            }
        }
    }

    /** The server answered 401 for [token] (any request, any thread). */
    fun sessionEnded(token: String) {
        if (sessions.endSession(token)) {
            _ui.value = SignInUi.Idle("Your session ended. Sign in again.", error = true)
            _events.tryEmit(AuthEvent.SessionEnded)
        }
    }

    /** Signs out here at once; the server is told in the background (best effort). */
    fun signOut() {
        val config = sessions.current
        val token = config.token ?: return
        sessions.endSession(token)
        _ui.value = SignInUi.Idle("Signed out.")
        scope.launch {
            try {
                apiFor(config.baseUrl).logout(token)
            } catch (c: CancellationException) {
                throw c
            } catch (_: Exception) {
                // Offline: the server's session ends by itself (30 days at most).
            }
        }
    }

    private fun clearPending() = pendingStore.write("")

    private fun fail(code: String) {
        _ui.value = SignInUi.Idle(AuthFlow.message(code, sessions.current.baseUrl.host), error = true)
    }
}
