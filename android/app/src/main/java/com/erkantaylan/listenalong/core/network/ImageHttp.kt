package com.erkantaylan.listenalong.core.network

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The HTTP client for cover images (YouTube thumbnails, a third-party host).
 * Built from scratch, never from the API's client: it has NO interceptor, so
 * the session (`Authorization: Bearer lam_…`) can never be sent with an
 * image request. ImageHttpTest checks that it stays so.
 */
object ImageHttp {
    /** Covers are small; give up quickly rather than hold a list row's slot. */
    fun newClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    /** The largest cover the app keeps (hqdefault is ~20-40 KB; anything far bigger is not a thumbnail). */
    const val MAX_BYTES = 2L * 1024 * 1024

    /** Fetches [url]'s bytes, or null on a 4xx (no such thumbnail). Throws on a network error or a 5xx. Blocking. */
    fun fetch(client: OkHttpClient, url: String): ByteArray? {
        val request = Request.Builder().url(url).header("Accept", "image/*").build()
        client.newCall(request).execute().use { response ->
            if (response.code in 400..499) return null
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body
            val length = body.contentLength()
            if (length > MAX_BYTES) return null
            val source = body.source()
            // request(n) is true when n bytes arrived: more than the cap means it is no thumbnail.
            if (source.request(MAX_BYTES + 1)) return null
            val bytes = source.buffer.readByteArray()
            return bytes.takeIf { it.isNotEmpty() }
        }
    }
}
