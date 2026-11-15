package com.erkantaylan.listenalong.auth

import com.erkantaylan.listenalong.BuildConfig
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * One sign-in in progress: what the app made before opening the browser and
 * keeps until the redirect comes back (stored encrypted, so it survives the
 * process being killed while the browser is open). The PKCE [verifier] never
 * leaves the app until the code exchange; [server] is the listen-along server
 * the sign-in was started against; [redirect] the redirect it asked for
 * ([AuthFlow.redirectFor]), sent again at the exchange (the server requires
 * start and exchange to name the same one). A sign-in stored by an older version has none:
 * it used the custom scheme.
 */
@Serializable
data class PendingSignIn(
    val state: String,
    val nonce: String,
    val verifier: String,
    val server: String,
    val startedAt: Long,
    val redirect: String = AuthFlow.REDIRECT_URI,
)

/** What came back to a sign-in redirect ([AuthFlow.REDIRECT_URI] or [AuthFlow.APP_LINK_URI]). */
sealed interface Redirect {
    /** Not our redirect at all (another scheme or path): ignore it. */
    data object NotOurs : Redirect
    /** Ours in shape, but no sign-in was waiting, its state differs, or it is too old. */
    data object Unexpected : Redirect
    /** The IdP (or the server) said no: `access_denied`, `temporarily_unavailable`, ... */
    data class Error(val error: String) : Redirect
    /** The authorization code, for the exchange. [iss] is passed on when the IdP sent one. */
    data class Code(val code: String, val iss: String?, val pending: PendingSignIn) : Redirect
}

/**
 * The app's half of the sign-in (backend/src/mobileAuth.js): authorization
 * code + PKCE S256 + state + nonce, started at `<server>/auth/mobile/start`,
 * which sends the browser on to the central login with the registered
 * redirect; the code then goes to `/auth/mobile/exchange`. Pure: no Android,
 * no network, so it is all unit tested.
 */
object AuthFlow {
    /** The custom scheme, registered at the central login for the listen-along client. */
    val REDIRECT_SCHEME: String = BuildConfig.AUTH_REDIRECT_SCHEME
    const val REDIRECT_PATH = "/oauth2redirect"
    val REDIRECT_URI: String get() = "$REDIRECT_SCHEME:$REDIRECT_PATH"

    /**
     * The https redirect: an Android App Link on the production server, which
     * Android hands only to the app signed with the key the server's
     * /.well-known/assetlinks.json names (no other app can catch the code, as
     * one can a custom scheme). Declared for release builds only
     * (src/release/AndroidManifest.xml); host from build.gradle.kts.
     */
    val APP_LINK_HOST: String = BuildConfig.AUTH_APP_LINK_HOST
    const val APP_LINK_PATH = "/auth/mobile/callback"
    val APP_LINK_URI: String get() = "https://$APP_LINK_HOST$APP_LINK_PATH"

    /**
     * The one place that picks the redirect for a sign-in: the App Link when
     * this build declares it ([appLinks]: release builds) and [server] is the
     * production server it is declared for (https, that host, default port, no
     * path prefix); the custom scheme otherwise: another server (self-hosted,
     * development) cannot be declared in the manifest, and debug builds
     * (`.debug`, the debug key) are never verified for the production host.
     */
    fun redirectFor(server: HttpUrl, appLinks: Boolean = BuildConfig.AUTH_APP_LINKS): String =
        if (appLinks && server.isHttps && server.host.equals(APP_LINK_HOST, ignoreCase = true) &&
            server.port == 443 && server.encodedPath == "/"
        ) APP_LINK_URI else REDIRECT_URI

    /** How long the browser half may take. Matches the server's dev codes; the IdP's codes are shorter. */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    private val json = Json { ignoreUnknownKeys = true }

    private fun randomString(random: SecureRandom, bytes: Int): String =
        ByteArray(bytes).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    /** 32 random bytes each: a 43-character verifier (RFC 7636), state and nonce. */
    fun newPending(server: HttpUrl, now: Long, random: SecureRandom = SecureRandom(), redirect: String = REDIRECT_URI): PendingSignIn =
        PendingSignIn(
            state = randomString(random, 32),
            nonce = randomString(random, 32),
            verifier = randomString(random, 32),
            server = server.toString(),
            startedAt = now,
            redirect = redirect,
        )

    /** S256: base64url(SHA-256(verifier)), no padding. */
    fun challenge(verifier: String): String =
        Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /**
     * What the Custom Tab opens. `redirect_uri` tells the server which of its
     * two allowed redirects to use (a server from before App Links ignores it
     * and uses the custom scheme, which is then what this app asked for).
     */
    fun startUrl(server: HttpUrl, pending: PendingSignIn): HttpUrl =
        server.newBuilder()
            .addPathSegments("auth/mobile/start")
            .addQueryParameter("state", pending.state)
            .addQueryParameter("nonce", pending.nonce)
            .addQueryParameter("code_challenge", challenge(pending.verifier))
            .addQueryParameter("code_challenge_method", "S256")
            .addQueryParameter("redirect_uri", pending.redirect)
            .build()

    fun encode(pending: PendingSignIn): String = json.encodeToString(PendingSignIn.serializer(), pending)

    fun decode(text: String?): PendingSignIn? =
        text?.takeIf { it.isNotBlank() }?.let { runCatching { json.decodeFromString(PendingSignIn.serializer(), it) }.getOrNull() }

    /**
     * Reads the redirect [uri] (the custom scheme or the App Link, handled
     * alike) against the sign-in that is waiting. The state must be exactly
     * the one this app made (a link from anywhere else is a forged sign-in),
     * and the sign-in no older than [MAX_AGE_MS]. Either redirect may answer:
     * a server from before App Links ignores `redirect_uri` and answers on the
     * scheme; the state is what proves the redirect belongs to this sign-in
     * (and a newer server requires the exchange to name the redirect it was started with).
     */
    fun parseRedirect(uri: String, pending: PendingSignIn?, now: Long): Redirect {
        val base = listOf(REDIRECT_URI, APP_LINK_URI).firstOrNull { uri == it || uri.startsWith("$it?") }
            ?: return Redirect.NotOurs
        val params = query(uri.removePrefix(base).removePrefix("?").substringBefore('#'))
        val state = params["state"]
        if (pending == null || state == null || state != pending.state) return Redirect.Unexpected
        if (now - pending.startedAt > MAX_AGE_MS || pending.startedAt > now + 60_000) return Redirect.Unexpected
        params["error"]?.let { return Redirect.Error(it) }
        val code = params["code"]?.takeIf { it.isNotEmpty() } ?: return Redirect.Error("invalid_request")
        return Redirect.Code(code, params["iss"], pending)
    }

    /** First value per name; a name given twice is suspicious and keeps the first. */
    private fun query(q: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        if (q.isEmpty()) return out
        for (part in q.split('&')) {
            if (part.isEmpty()) continue
            val name = urlDecode(part.substringBefore('='))
            val value = urlDecode(if ('=' in part) part.substringAfter('=') else "")
            if (name != null && value != null) out.putIfAbsent(name, value)
        }
        return out
    }

    private fun urlDecode(s: String): String? = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrNull()

    /**
     * The sentence for an `error` the browser came back with, or for a
     * refused exchange (backend/src/mobileAuth.js codes).
     */
    fun message(code: String, host: String): String = when (code) {
        "access_denied" -> "Sign-in was cancelled."
        "temporarily_unavailable", "signin_unavailable" -> "Sign-in cannot be reached right now. Try again later."
        "account_disabled" -> "Your account has been disabled."
        "registrations_closed" -> "There is no account for you on $host, and it is not taking new ones."
        "link_conflict" -> "This sign-in could not be linked to your account. Contact the administrator."
        "not_supported" -> "$host does not support signing in from the app yet."
        "dev_refused" -> "$host uses the insecure development sign-in, which only debug builds accept."
        "rate_limited" -> "Too many sign-in attempts. Wait a minute and try again."
        "unexpected" -> "That sign-in was not started here, or it took too long. Tap Sign in again."
        else -> "Sign-in did not work. Try again."
    }
}
