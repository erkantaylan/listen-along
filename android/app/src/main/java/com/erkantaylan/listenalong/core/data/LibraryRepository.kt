package com.erkantaylan.listenalong.core.data

import com.erkantaylan.listenalong.core.domain.offlineLibrary
import com.erkantaylan.listenalong.core.model.LibraryPage
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SortOrder
import com.erkantaylan.listenalong.core.network.ApiProvider
import com.erkantaylan.listenalong.core.network.LibraryClient
import com.erkantaylan.listenalong.core.storage.LocalSong
import kotlinx.coroutines.flow.StateFlow
import java.io.IOException

/** The first page of a library search: the server's, or the songs on the phone when it cannot be reached. */
sealed interface LibraryLoad {
    data class Online(val page: LibraryPage) : LibraryLoad
    data class Offline(val songs: List<Song>) : LibraryLoad
}

/**
 * The music library: the server's (searched, sorted and paged there) and,
 * when the server cannot be reached, the downloaded songs searched and sorted
 * the same way. Every page that comes back refreshes the broken-song reports
 * it carries ([ReportRepository.absorb]).
 */
class LibraryRepository(
    private val api: ApiProvider,
    /** What is on the phone (the download index), for the offline fallback. */
    val local: StateFlow<Map<String, LocalSong>>,
    private val reports: ReportRepository,
) {
    /**
     * The first page. A network error or a 5xx falls back to the downloads
     * ([LibraryLoad.Offline]); a 4xx (an ended session, 403) is thrown.
     */
    suspend fun firstPage(query: String, sort: SortOrder, brokenOnly: Boolean): LibraryLoad {
        val client = api() ?: return LibraryLoad.Offline(offline(query, sort, brokenOnly))
        return try {
            LibraryLoad.Online(page(client.let { it }, query, 0, sort, brokenOnly))
        } catch (e: IOException) {
            if (!PlaylistRepository.canFallBack(e)) throw e
            LibraryLoad.Offline(offline(query, sort, brokenOnly))
        }
    }

    /** The page after the first [offset] songs. Throws on any failure. */
    suspend fun nextPage(query: String, offset: Int, sort: SortOrder, brokenOnly: Boolean): LibraryPage {
        val client = api() ?: throw IOException("No server set — see Settings")
        return page(client, query, offset, sort, brokenOnly)
    }

    /** Every song of a search, for "download all shown". */
    suspend fun all(query: String, sort: SortOrder, brokenOnly: Boolean): List<Song> {
        val client = api() ?: throw IOException("No server set — see Settings")
        return client.listAll(query, sort, LibraryClient.MAX_LIMIT, brokenOnly)
    }

    /** The downloaded songs matching a search (the Broken filter: the saved report list). */
    fun offline(query: String, sort: SortOrder, brokenOnly: Boolean): List<Song> =
        offlineLibrary(local.value.values, query, sort, if (brokenOnly) reports.reports.value.keys else null)

    private suspend fun page(
        client: com.erkantaylan.listenalong.core.network.ListenAlongApi,
        query: String,
        offset: Int,
        sort: SortOrder,
        brokenOnly: Boolean,
    ): LibraryPage {
        val page = client.list(query, LibraryClient.PAGE_SIZE, offset, sort, brokenOnly)
        reports.absorb(page.songs)
        return page
    }
}
