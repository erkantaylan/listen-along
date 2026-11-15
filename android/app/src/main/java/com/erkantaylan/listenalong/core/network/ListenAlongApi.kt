package com.erkantaylan.listenalong.core.network

import com.erkantaylan.listenalong.core.model.AddSongsResult
import com.erkantaylan.listenalong.core.model.LibraryPage
import com.erkantaylan.listenalong.core.model.Me
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.PlaylistEntry
import com.erkantaylan.listenalong.core.model.PlaylistSongs
import com.erkantaylan.listenalong.core.model.ReportResult
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SortOrder
import com.erkantaylan.listenalong.core.model.Visibility
import kotlinx.coroutines.Job
import okhttp3.HttpUrl
import java.io.InputStream

/**
 * Everything the app asks the listen-along server, in one place. The only
 * implementation is [LibraryClient] (OkHttp); every path, query parameter and
 * JSON field name the app sends lives there, so renaming one on the wire is a
 * change to that one file. Repositories depend on this interface, so their
 * tests use a fake.
 *
 * Failures are [java.io.IOException]s: an [ApiException] when the server
 * answered with an error status (its `code` tells 404 from 5xx), anything
 * else when it could not be reached.
 */
interface ListenAlongApi {
    /** The server's base URL, with a trailing slash. Also the key of everything saved per server. */
    val baseUrl: HttpUrl

    suspend fun list(
        query: String = "",
        limit: Int = LibraryClient.PAGE_SIZE,
        offset: Int = 0,
        sort: SortOrder = SortOrder.RECENT,
        reported: Boolean = false,
    ): LibraryPage

    suspend fun listAll(
        query: String = "",
        sort: SortOrder = SortOrder.RECENT,
        pageSize: Int = LibraryClient.MAX_LIMIT,
        reported: Boolean = false,
    ): List<Song>

    suspend fun me(): Me

    suspend fun report(songId: String, reason: String?): ReportResult

    suspend fun unmark(songId: String)

    suspend fun playlists(): List<Playlist>

    suspend fun playlistSongs(id: String): PlaylistSongs

    suspend fun createPlaylist(name: String, visibility: Visibility): Playlist

    suspend fun updatePlaylist(id: String, name: String? = null, visibility: Visibility? = null): Playlist

    suspend fun deletePlaylist(id: String)

    suspend fun addToPlaylist(id: String, libraryIds: List<String>): AddSongsResult

    suspend fun removeFromPlaylist(id: String, entryId: String)

    suspend fun moveInPlaylist(id: String, entryId: String, position: Int): List<PlaylistEntry>

    /** The newest Android release (the update notice). */
    suspend fun appLatest(): com.erkantaylan.listenalong.core.model.AppLatest

    /** The URL the player streams a song from (the session is added by the stream's HTTP client). */
    fun fileUrl(songId: String): HttpUrl

    /** Streams a song's bytes to [block]; blocking, call it off the main thread. */
    fun <T> streamFile(
        songId: String,
        job: Job? = null,
        block: (contentType: String?, contentLength: Long, body: InputStream) -> T,
    ): T
}

/** The client for the server in force, or null when there is none. */
typealias ApiProvider = () -> ListenAlongApi?
