package com.erkantaylan.listenalong.auth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Tells [onEnded] which session token the server just refused. Only a 401
 * whose JSON body says `code: "SESSION_ENDED"` counts (backend userAuth.js
 * `refusal`, the server's one answer for an unknown, expired, signed-out or
 * banned app session). A bare 401 (admin routes, an older server), a 401
 * `AUTH_REQUIRED`, a 403, a 5xx, a redirect or no answer at all (offline,
 * timeout) never signs anyone out, so downloaded songs keep playing. Add it
 * AFTER an interceptor that sets the Authorization header, so it sees it.
 */
class SessionEndedInterceptor(private val onEnded: (token: String) -> Unit) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)
        if (response.code == 401) {
            val header = request.header("Authorization")
            if (header != null && header.startsWith("Bearer ", ignoreCase = true)) {
                val token = header.substring(7).trim()
                if (token.isNotEmpty() && isSessionEnded(response)) onEnded(token)
            }
        }
        return response
    }

    private fun isSessionEnded(response: Response): Boolean = runCatching {
        // peekBody leaves the body for the caller (its `error` text).
        val text = response.peekBody(PEEK_BYTES).string()
        Json.parseToJsonElement(text).jsonObject["code"]?.jsonPrimitive?.content == SESSION_ENDED
    }.getOrDefault(false)

    companion object {
        const val SESSION_ENDED = "SESSION_ENDED"
        private const val PEEK_BYTES = 4096L
    }
}
