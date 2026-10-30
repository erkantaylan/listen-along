package com.erkantaylan.listenalong.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** A non-2xx answer from the server, with its status and its `error` text. */
class ApiException(val code: Int, message: String) : IOException(message) {
    val unauthorized: Boolean get() = code == 401 || code == 403
}

internal val apiJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
    explicitNulls = false
}

/**
 * The listen-along library API.
 *
 * Authentication belongs here and nowhere else: every request this class
 * builds carries the bearer token when one is set, so the downloader never
 * has to know whether the server wants one. Library reads also work without.
 */
class LibraryClient(
    val baseUrl: HttpUrl,
    private val token: String?,
    private val http: OkHttpClient = defaultHttpClient,
) {

    suspend fun list(
        query: String = "",
        limit: Int = PAGE_SIZE,
        offset: Int = 0,
        sort: SortOrder = SortOrder.RECENT,
    ): LibraryPage = withContext(Dispatchers.IO) {
        val url = endpoint("api/library").newBuilder()
            .apply { if (query.isNotBlank()) addQueryParameter("q", query.trim()) }
            .addQueryParameter("limit", limit.coerceIn(1, MAX_LIMIT).toString())
            .addQueryParameter("offset", offset.coerceAtLeast(0).toString())
            .addQueryParameter("sort", sort.param)
            .build()
        getJson(url) { apiJson.decodeFromString<LibraryPage>(it) }
    }

    /**
     * Every song matching [query], fetched a page at a time. Used by "download
     * all shown", which needs the whole result set rather than what has been
     * scrolled into view so far.
     */
    suspend fun listAll(
        query: String = "",
        sort: SortOrder = SortOrder.RECENT,
        pageSize: Int = MAX_LIMIT,
    ): List<Song> {
        val all = ArrayList<Song>()
        while (true) {
            val page = list(query, pageSize, all.size, sort)
            all += page.songs
            if (page.songs.isEmpty() || all.size >= page.total) return all
        }
    }

    /** Who the token belongs to. Fails with a 401 [ApiException] for a bad token. */
    suspend fun me(): Me = withContext(Dispatchers.IO) {
        getJson(endpoint("api/me")) { apiJson.decodeFromString<Me>(it) }
    }

    fun fileRequest(songId: String): Request =
        Request.Builder()
            .url(endpoint("api/library").newBuilder()
                .addPathSegment(songId)
                .addPathSegment("file")
                .build())
            .authorized()
            .build()

    /**
     * Streams a song's audio to [block], which gets the Content-Type, the
     * Content-Length (-1 when unknown) and the body. Blocking; call it off the
     * main thread. When [job] is cancelled the call is cancelled too, so a
     * read stuck on a stalled connection gives up at once.
     */
    fun <T> streamFile(
        songId: String,
        job: Job? = null,
        block: (contentType: String?, contentLength: Long, body: InputStream) -> T,
    ): T {
        val call = http.newCall(fileRequest(songId))
        val handle = job?.invokeOnCompletion { call.cancel() }
        try {
            return call.execute().use { response ->
                response.requireSuccess()
                val body = response.body
                block(response.header("Content-Type"), body.contentLength(), body.byteStream())
            }
        } finally {
            handle?.dispose()
        }
    }

    private fun endpoint(path: String): HttpUrl =
        baseUrl.newBuilder().addPathSegments(path).build()

    private fun Request.Builder.authorized(): Request.Builder = apply {
        if (!token.isNullOrBlank()) header("Authorization", "Bearer ${token.trim()}")
    }

    private fun <T> getJson(url: HttpUrl, parse: (String) -> T): T {
        val request = Request.Builder().url(url).authorized()
            .header("Accept", "application/json").build()
        return http.newCall(request).execute().use { response ->
            response.requireSuccess()
            val text = response.body.string()
            try {
                parse(text)
            } catch (e: Exception) {
                throw IOException("Unexpected answer from ${url.encodedPath}: ${e.message}", e)
            }
        }
    }

    private fun Response.requireSuccess() {
        if (isSuccessful) return
        val raw = runCatching { body.string() }.getOrDefault("")
        val serverMessage = runCatching {
            apiJson.parseToJsonElement(raw).jsonObject["error"]?.jsonPrimitive?.content
        }.getOrNull()
        throw ApiException(code, serverMessage?.takeIf { it.isNotBlank() } ?: "HTTP $code")
    }

    companion object {
        const val PAGE_SIZE = 100
        const val MAX_LIMIT = 1000

        val defaultHttpClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build()
        }
    }
}
