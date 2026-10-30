package com.erkantaylan.listenalong.playlists

import com.erkantaylan.listenalong.api.AddSongsResult
import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.Playlist
import com.erkantaylan.listenalong.api.PlaylistSongs
import com.erkantaylan.listenalong.api.Visibility
import com.erkantaylan.listenalong.storage.TextStore
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException

/**
 * The last list of playlists and the last song list of every playlist that
 * was opened, so Playlists still works (read-only) with no connection.
 *
 * Each record carries the server it came from: pointing the app at another
 * server (or the stub) must not show the first server's playlists.
 */
class PlaylistCache(
    private val listStore: TextStore,
    /** A store for one playlist's songs; the real one is a file per playlist. */
    private val songsStore: (playlistId: String) -> TextStore,
    private val forget: (playlistId: String) -> Unit = {},
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Serializable
    private data class ListRecord(val server: String, val savedAt: Long, val playlists: List<Playlist>)

    @Serializable
    private data class SongsRecord(val server: String, val savedAt: Long, val songs: PlaylistSongs)

    data class Cached<T>(val value: T, val savedAt: Long)

    fun playlists(server: String): Cached<List<Playlist>>? = read<ListRecord>(listStore)
        ?.takeIf { it.server == server }
        ?.let { Cached(it.playlists, it.savedAt) }

    fun putPlaylists(server: String, playlists: List<Playlist>, now: Long) =
        listStore.write(json.encodeToString(ListRecord(server, now, playlists)))

    fun songs(server: String, playlistId: String): Cached<PlaylistSongs>? =
        read<SongsRecord>(songsStore(safeId(playlistId)))
            ?.takeIf { it.server == server }
            ?.let { Cached(it.songs, it.savedAt) }

    fun putSongs(server: String, playlistId: String, songs: PlaylistSongs, now: Long) =
        songsStore(safeId(playlistId)).write(json.encodeToString(SongsRecord(server, now, songs)))

    fun remove(server: String, playlistId: String) {
        forget(safeId(playlistId))
        playlists(server)?.let { cached ->
            putPlaylists(server, cached.value.filterNot { it.id == playlistId }, cached.savedAt)
        }
    }

    private inline fun <reified T> read(store: TextStore): T? =
        store.read()?.let { raw -> runCatching { json.decodeFromString<T>(raw) }.getOrNull() }

    companion object {
        /** Playlist ids are UUIDs; anything else is reduced to a safe file name. */
        fun safeId(id: String): String = id.replace(Regex("[^A-Za-z0-9_-]"), "_").take(80)
    }
}

/** Something loaded from the server, or from the cache when the server could not be reached. */
data class Loaded<T>(
    val value: T,
    /** True when this is the cached copy (the request failed). */
    val fromCache: Boolean = false,
    /** When the cached copy was saved; null for fresh data. */
    val savedAt: Long? = null,
    /** Why the server could not be used, when [fromCache]. */
    val error: String? = null,
)

/**
 * Playlists, from the server when it answers and from [PlaylistCache] when it
 * does not. Every successful read refreshes the cache; every change made here
 * updates it too, so what you saw last is what you get offline.
 *
 * Which failures fall back to the cache: a network error or a 5xx (the server
 * is unreachable or broken right now). A 4xx is an answer, not an outage — a
 * bad token, a playlist that was deleted or made private — and is passed on.
 */
class PlaylistRepository(
    private val clientProvider: () -> LibraryClient?,
    private val cache: PlaylistCache,
    private val now: () -> Long = System::currentTimeMillis,
) {

    private fun client(): LibraryClient = clientProvider() ?: throw IOException("No server set — see Settings")

    private fun server(client: LibraryClient): String = client.baseUrl.toString()

    suspend fun playlists(): Loaded<List<Playlist>> {
        val client = client()
        val server = server(client)
        return try {
            val fresh = sorted(client.playlists())
            cache.putPlaylists(server, fresh, now())
            Loaded(fresh)
        } catch (e: IOException) {
            if (!canFallBack(e)) throw e
            val cached = cache.playlists(server) ?: throw e
            Loaded(cached.value, fromCache = true, savedAt = cached.savedAt, error = describe(e))
        }
    }

    /** The cached list alone, without asking the server (for instant first paint). */
    fun cachedPlaylists(): List<Playlist>? = clientProvider()?.let { cache.playlists(server(it))?.value }

    fun cachedSongs(playlistId: String): PlaylistSongs? =
        clientProvider()?.let { cache.songs(server(it), playlistId)?.value }

    suspend fun songs(playlistId: String): Loaded<PlaylistSongs> {
        val client = client()
        val server = server(client)
        return try {
            val fresh = client.playlistSongs(playlistId)
            cache.putSongs(server, playlistId, fresh, now())
            Loaded(fresh)
        } catch (e: ApiException) {
            if (e.code == 404) cache.remove(server, playlistId)
            if (!canFallBack(e)) throw e
            cached(server, playlistId, e)
        } catch (e: IOException) {
            cached(server, playlistId, e)
        }
    }

    private fun cached(server: String, playlistId: String, e: IOException): Loaded<PlaylistSongs> {
        val cached = cache.songs(server, playlistId) ?: throw e
        return Loaded(cached.value, fromCache = true, savedAt = cached.savedAt, error = describe(e))
    }

    suspend fun create(name: String, visibility: Visibility): Playlist {
        val client = client()
        val created = client.createPlaylist(name, visibility)
        refreshListQuietly(client)
        return created
    }

    suspend fun rename(playlistId: String, name: String): Playlist =
        updated(client().updatePlaylist(playlistId, name = name))

    suspend fun setVisibility(playlistId: String, visibility: Visibility): Playlist =
        updated(client().updatePlaylist(playlistId, visibility = visibility))

    suspend fun delete(playlistId: String) {
        val client = client()
        client.deletePlaylist(playlistId)
        cache.remove(server(client), playlistId)
    }

    suspend fun add(playlistId: String, libraryIds: List<String>): AddSongsResult {
        val client = client()
        val result = client.addToPlaylist(playlistId, libraryIds)
        // The new entry ids only come with a fresh read.
        runQuietly { songs(playlistId) }
        refreshListQuietly(client)
        return result
    }

    suspend fun remove(playlistId: String, entryId: String): Loaded<PlaylistSongs> {
        client().removeFromPlaylist(playlistId, entryId)
        return songs(playlistId)
    }

    /** Moves [entryId] to [position] (1-based) and returns the playlist in its new order. */
    suspend fun move(playlistId: String, entryId: String, position: Int): Loaded<PlaylistSongs> {
        val client = client()
        val order = client.moveInPlaylist(playlistId, entryId, position)
        val server = server(client)
        val previous = cache.songs(server, playlistId)?.value
        val next = PlaylistSongs(previous?.playlist, order)
        cache.putSongs(server, playlistId, next, now())
        return Loaded(next)
    }

    private suspend fun updated(playlist: Playlist): Playlist {
        val client = client()
        val server = server(client)
        cache.playlists(server)?.let { cached ->
            putList(server, cached.value.map { if (it.id == playlist.id) playlist else it })
        }
        cache.songs(server, playlist.id)?.let { cached ->
            cache.putSongs(server, playlist.id, cached.value.copy(playlist = playlist), cached.savedAt)
        }
        return playlist
    }

    private fun putList(server: String, list: List<Playlist>) = cache.putPlaylists(server, sorted(list), now())

    private suspend fun refreshListQuietly(client: LibraryClient) = runQuietly {
        putList(server(client), client.playlists())
    }

    private suspend fun runQuietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (c: CancellationException) {
            throw c
        } catch (_: Exception) {
        }
    }

    companion object {
        fun canFallBack(e: IOException): Boolean = e !is ApiException || e.code >= 500

        /** Yours first, then the rest; each group by name. */
        fun sorted(list: List<Playlist>): List<Playlist> =
            list.sortedWith(compareBy<Playlist>({ !it.isOwner }, { it.displayName.lowercase() }))

        fun describe(t: Throwable): String = when {
            t is ApiException && t.unauthorized -> "The server rejected the API token (${t.code})"
            t is ApiException -> t.message ?: "HTTP ${t.code}"
            else -> t.message ?: t::class.simpleName ?: "Network error"
        }
    }
}
