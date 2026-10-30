package com.erkantaylan.listenalong.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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
        /** Only songs someone marked as broken (`?reported=1`). */
        reported: Boolean = false,
    ): LibraryPage = withContext(Dispatchers.IO) {
        val url = endpoint("api/library").newBuilder()
            .apply { if (query.isNotBlank()) addQueryParameter("q", query.trim()) }
            .apply { if (reported) addQueryParameter("reported", "1") }
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
        reported: Boolean = false,
    ): List<Song> {
        val all = ArrayList<Song>()
        while (true) {
            val page = list(query, pageSize, all.size, sort, reported)
            all += page.songs
            if (page.songs.isEmpty() || all.size >= page.total) return all
        }
    }

    /** Who the token belongs to. Fails with a 401 [ApiException] for a bad token. */
    suspend fun me(): Me = withContext(Dispatchers.IO) {
        getJson(endpoint("api/me")) { apiJson.decodeFromString<Me>(it) }
    }

    // --- "Mark as broken — needs replacement" --------------------------------
    // backend/src/libraryRoutes.js: one open report per user per song;
    // reporting again updates the reason. Only your own report can be withdrawn.

    /** Marks [songId] as broken, or updates the reason of your report. [reason] may be blank. */
    suspend fun report(songId: String, reason: String?): ReportResult = withContext(Dispatchers.IO) {
        val body = buildJsonObject { reason?.trim()?.takeIf { it.isNotEmpty() }?.let { put("reason", it) } }
        sendJson("POST", reportUrl(songId), body) { apiJson.decodeFromString<ReportResult>(it) }
    }

    /** Withdraws your own report. A 404 [ApiException] when you had none. */
    suspend fun unmark(songId: String) = withContext(Dispatchers.IO) {
        sendJson("DELETE", reportUrl(songId), null) { }
    }

    private fun reportUrl(songId: String): HttpUrl =
        endpoint("api/library").newBuilder().addPathSegment(songId).addPathSegment("report").build()

    // --- Playlists -----------------------------------------------------------
    // Server side: the playlist routes in backend/src/index.js. A playlist the
    // caller cannot see answers 404 (never 403); errors are { error, code }.

    /** Every public playlist plus the token owner's private ones. */
    suspend fun playlists(): List<Playlist> = withContext(Dispatchers.IO) {
        getJson(endpoint("api/playlists")) { apiJson.decodeFromString<PlaylistList>(it).playlists }
    }

    /** One playlist and its songs, in play order. */
    suspend fun playlistSongs(id: String): PlaylistSongs = withContext(Dispatchers.IO) {
        getJson(playlistUrl(id, "songs")) { apiJson.decodeFromString<PlaylistSongs>(it) }
    }

    suspend fun createPlaylist(name: String, visibility: Visibility): Playlist = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("name", name.trim())
            put("visibility", visibility.param)
        }
        sendJson("POST", endpoint("api/playlists"), body) { apiJson.decodeFromString<Playlist>(it) }
    }

    /** Rename (anyone who can see it) and/or change visibility (owner only). */
    suspend fun updatePlaylist(id: String, name: String? = null, visibility: Visibility? = null): Playlist =
        withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                if (name != null) put("name", name.trim())
                if (visibility != null) put("visibility", visibility.param)
            }
            sendJson("PATCH", playlistUrl(id), body) { apiJson.decodeFromString<Playlist>(it) }
        }

    suspend fun deletePlaylist(id: String) = withContext(Dispatchers.IO) {
        sendJson("DELETE", playlistUrl(id), null) { }
    }

    /** Adds library songs by id. Songs already in the playlist are skipped by the server. */
    suspend fun addToPlaylist(id: String, libraryIds: List<String>): AddSongsResult = withContext(Dispatchers.IO) {
        val body = JsonObject(mapOf("songs" to JsonArray(libraryIds.map(::JsonPrimitive))))
        sendJson("POST", playlistUrl(id, "songs"), body) { apiJson.decodeFromString<AddSongsResult>(it) }
    }

    /** Removes one entry (by its entry id) from a playlist. */
    suspend fun removeFromPlaylist(id: String, entryId: String) = withContext(Dispatchers.IO) {
        sendJson("DELETE", playlistUrl(id, "songs", entryId), null) { }
    }

    /** Moves an entry to [position] (1-based) and returns the new order. */
    suspend fun moveInPlaylist(id: String, entryId: String, position: Int): List<PlaylistEntry> =
        withContext(Dispatchers.IO) {
            val body = buildJsonObject { put("position", position) }
            sendJson("POST", playlistUrl(id, "songs", entryId, "move"), body) {
                apiJson.decodeFromString<PlaylistSongs>(it).songs
            }
        }

    private fun playlistUrl(id: String, vararg rest: String): HttpUrl =
        endpoint("api/playlists").newBuilder()
            .addPathSegment(id)
            .apply { rest.forEach { addPathSegment(it) } }
            .build()

    /** The URL [fileRequest] fetches; what the player streams. */
    fun fileUrl(songId: String): HttpUrl =
        endpoint("api/library").newBuilder().addPathSegment(songId).addPathSegment("file").build()

    fun fileRequest(songId: String): Request =
        Request.Builder()
            .url(fileUrl(songId))
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

    private fun <T> sendJson(method: String, url: HttpUrl, body: JsonObject?, parse: (String) -> T): T {
        val requestBody = body?.toString()?.toRequestBody(JSON_TYPE)
        val request = Request.Builder().url(url).authorized()
            .header("Accept", "application/json")
            .method(method, requestBody)
            .build()
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
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

        val defaultHttpClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .build()
        }
    }
}
