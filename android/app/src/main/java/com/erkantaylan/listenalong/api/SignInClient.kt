package com.erkantaylan.listenalong.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import com.erkantaylan.listenalong.auth.SignInApi
import java.io.IOException

/** `POST /auth/mobile/exchange` → the app's session (backend/src/mobileAuth.js). */
@Serializable
data class SessionGrant(
    val token: String,
    @SerialName("token_type") val tokenType: String = "Bearer",
    /** `central` (the central login) or `dev` (a development server's INSECURE_DEV_LOGIN). */
    val mode: String = "central",
    @SerialName("expires_at") val expiresAt: Long? = null,
    val user: SessionUser? = null,
)

@Serializable
data class SessionUser(val id: String, val name: String? = null, val status: String? = null)

/**
 * The server refused the sign-in. [code] is the server's (`signin_failed`,
 * `account_disabled`, `registrations_closed`, `link_conflict`,
 * `signin_unavailable`, `invalid_request`), or `not_supported` (a server
 * without app sign-in) / `rate_limited`. Network failures are plain
 * [IOException]s instead.
 */
class SignInException(val code: String, val status: Int, message: String) : Exception(message)

/** The three sign-in calls; everything else goes through [LibraryClient]. */
class SignInClient(
    val baseUrl: HttpUrl,
    private val http: OkHttpClient = LibraryClient.defaultHttpClient,
) : SignInApi {
    /**
     * Swaps the authorization code for a session. [previousToken], when the
     * app still holds one, is sent along so the server ends it.
     */
    override suspend fun exchange(
        code: String,
        state: String,
        verifier: String,
        nonce: String,
        iss: String?,
        previousToken: String?,
        redirectUri: String,
    ): SessionGrant = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("code", code)
            put("state", state)
            put("code_verifier", verifier)
            put("nonce", nonce)
            if (iss != null) put("iss", iss)
            put("redirect_uri", redirectUri)
        }
        val request = Request.Builder()
            .url(baseUrl.newBuilder().addPathSegments("auth/mobile/exchange").build())
            .header("Accept", "application/json")
            .apply { if (!previousToken.isNullOrBlank()) header("Authorization", "Bearer $previousToken") }
            .post(body.toString().toRequestBody(JSON_TYPE))
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) throw refusal(response.code, text)
            val grant = try {
                apiJson.decodeFromString<SessionGrant>(text)
            } catch (e: Exception) {
                throw IOException("Unexpected answer from the sign-in: ${e.message}", e)
            }
            if (grant.token.isBlank()) throw IOException("The server sent no session")
            grant
        }
    }

    /** Ends the session on the server. Throws on a network failure; the caller forgets it anyway. */
    override suspend fun logout(token: String): Unit = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(baseUrl.newBuilder().addPathSegments("auth/mobile/logout").build())
            .header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null))
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw ApiException(response.code, "Sign-out answered ${response.code}")
        }
    }

    private fun refusal(status: Int, text: String): Exception {
        val obj = runCatching { apiJson.parseToJsonElement(text).jsonObject }.getOrNull()
        val code = obj?.get("code")?.jsonPrimitive?.content
        val message = obj?.get("error")?.jsonPrimitive?.content ?: "HTTP $status"
        return when {
            status == 429 -> SignInException("rate_limited", status, message)
            status == 404 && code == null -> SignInException("not_supported", status, message)
            status >= 500 && code == null -> IOException("Sign-in answered $status")
            else -> SignInException(code ?: "signin_failed", status, message)
        }
    }

    companion object {
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
