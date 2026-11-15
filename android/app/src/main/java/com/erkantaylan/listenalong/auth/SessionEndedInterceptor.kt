package com.erkantaylan.listenalong.auth

import okhttp3.Interceptor
import okhttp3.Response

/**
 * Tells [onEnded] which session token the server just refused with a 401.
 * Only a definite 401 counts: a 5xx, a 403 (pending account, CLI-only route)
 * or no answer at all (offline, timeout) never signs anyone out, so
 * downloaded songs keep playing with no connection. Add it AFTER an
 * interceptor that sets the Authorization header, so it sees the header.
 */
class SessionEndedInterceptor(private val onEnded: (token: String) -> Unit) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val response = chain.proceed(request)
        if (response.code == 401) {
            val header = request.header("Authorization")
            if (header != null && header.startsWith("Bearer ", ignoreCase = true)) {
                val token = header.substring(7).trim()
                if (token.isNotEmpty()) onEnded(token)
            }
        }
        return response
    }
}
