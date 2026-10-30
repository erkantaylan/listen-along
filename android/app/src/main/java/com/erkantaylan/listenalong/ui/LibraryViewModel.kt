package com.erkantaylan.listenalong.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.AppGraph
import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.api.SortOrder
import com.erkantaylan.listenalong.download.BulkPlan
import com.erkantaylan.listenalong.download.DownloadSnapshot
import com.erkantaylan.listenalong.playlists.PlaylistRepository
import com.erkantaylan.listenalong.storage.LocalSong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

sealed interface BulkUi {
    data object Preparing : BulkUi
    data class Ready(val plan: BulkPlan) : BulkUi
    data class Error(val message: String) : BulkUi
}

data class LibraryUiState(
    /** False until an API token is set: the server refuses the library without one. */
    val hasToken: Boolean = false,
    val query: String = "",
    val sort: SortOrder = SortOrder.RECENT,
    val songs: List<Song> = emptyList(),
    val total: Int = 0,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
    /**
     * The server could not be reached: [songs] are the songs on the device,
     * filtered and sorted here, and nothing that needs the server is offered.
     */
    val offline: Boolean = false,
    val bulk: BulkUi? = null,
) {
    val canLoadMore: Boolean get() = !offline && !loading && !loadingMore && error == null && songs.size < total
}

/** A downloaded song as a library song, for the offline library and for playing. */
fun LocalSong.toSong(): Song = Song(
    id = songId,
    title = title.ifBlank { displayName.substringBeforeLast('.') },
    artist = artist,
    durationRaw = durationSec?.toDouble(),
)

/** The offline library: what is on the device, searched and sorted like the server would. */
internal fun offlineLibrary(local: Collection<LocalSong>, query: String, sort: SortOrder): List<Song> {
    val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val hits = local.filter { song ->
        val hay = "${song.title} ${song.artist} ${song.displayName}".lowercase()
        words.all { it in hay }
    }
    val sorted = when (sort) {
        SortOrder.RECENT -> hits.sortedByDescending { it.savedAt }
        SortOrder.TITLE -> hits.sortedWith(compareBy({ it.title.lowercase() }, { it.artist.lowercase() }))
        SortOrder.ARTIST -> hits.sortedWith(compareBy({ it.artist.lowercase() }, { it.title.lowercase() }))
    }
    return sorted.map { it.toSong() }
}

/**
 * The cloud library: server-side search and sort, fetched a page at a time as
 * you scroll. Download state comes from [AppGraph.downloads], shared with the
 * On device tab and the worker. With no connection it shows the downloaded
 * songs instead, and reloads from the server when the connection is back.
 */
class LibraryViewModel(private val graph: AppGraph) : ViewModel() {

    private val _state = MutableStateFlow(LibraryUiState(hasToken = graph.settings.config.value.hasToken))
    val state: StateFlow<LibraryUiState> = _state.asStateFlow()

    val downloads: StateFlow<DownloadSnapshot> =
        graph.downloads.snapshots.stateIn(viewModelScope, SharingStarted.Eagerly, graph.downloads.snapshot())

    private var searchDebounce: Job? = null
    private var loadJob: Job? = null
    private var bulkJob: Job? = null
    /** Bumped on every reload, so a late "load more" for an old query is dropped. */
    private var generation = 0

    init {
        reload(initial = true)
        // A new server (or token) in Settings: start over.
        graph.settings.config
            .drop(1)
            .distinctUntilChanged()
            .onEach { config ->
                _state.update { it.copy(hasToken = config.hasToken, songs = emptyList(), total = 0) }
                reload(initial = true)
            }
            .launchIn(viewModelScope)
        // Back online after showing the offline list: fetch the real library.
        graph.connectivity.online
            .drop(1)
            .filter { it && _state.value.offline }
            .onEach { reload(initial = false) }
            .launchIn(viewModelScope)
        // Offline, the list is the downloads: keep it in step with them.
        graph.index.entries
            .drop(1)
            .filter { _state.value.offline }
            .onEach { local -> _state.update { it.copy(songs = offlineLibrary(local.values, it.query, it.sort)).withTotal() } }
            .launchIn(viewModelScope)
    }

    private fun LibraryUiState.withTotal() = copy(total = songs.size)

    fun onQueryChange(query: String) {
        _state.update { it.copy(query = query) }
        searchDebounce?.cancel()
        searchDebounce = viewModelScope.launch {
            delay(350)
            reload(initial = true)
        }
    }

    fun onSortChange(sort: SortOrder) {
        if (sort == _state.value.sort) return
        _state.update { it.copy(sort = sort) }
        reload(initial = true)
    }

    fun clearQuery() = onQueryChange("")

    fun refresh() = reload(initial = false)

    fun loadMore() {
        val current = _state.value
        if (!current.canLoadMore) return
        val client = graph.client()
        val gen = generation
        _state.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            try {
                val page = client.list(current.query, LibraryClient.PAGE_SIZE, current.songs.size, current.sort)
                if (gen != generation) return@launch
                _state.update {
                    it.copy(
                        songs = (it.songs + page.songs).distinctBy { s -> s.id },
                        total = page.total,
                        loadingMore = false,
                    )
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                if (gen == generation) _state.update { it.copy(loadingMore = false, error = describe(t)) }
            }
        }
    }

    fun download(song: Song) {
        graph.downloads.enqueue(listOf(song))
    }

    fun cancel(song: Song) = graph.downloads.cancel(song.id)

    /**
     * Every song of the current search, for "play all": the pages loaded so
     * far are enough to start, the rest of the result is not fetched.
     */
    fun currentSongs(): List<Song> = _state.value.songs

    /** Works out what "download all shown" would fetch, for the confirm dialog. */
    fun prepareBulk() {
        val client = graph.client()
        val current = _state.value
        bulkJob?.cancel()
        _state.update { it.copy(bulk = BulkUi.Preparing) }
        bulkJob = viewModelScope.launch {
            try {
                val all = client.listAll(current.query, current.sort)
                val plan = BulkPlan.of(all, graph.downloads.snapshot())
                _state.update { it.copy(bulk = BulkUi.Ready(plan)) }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                _state.update { it.copy(bulk = BulkUi.Error(describe(t))) }
            }
        }
    }

    /** Returns how many were queued. */
    fun confirmBulk(): Int {
        val plan = (_state.value.bulk as? BulkUi.Ready)?.plan ?: return 0
        _state.update { it.copy(bulk = null) }
        return graph.downloads.enqueue(plan.toDownload)
    }

    fun dismissBulk() {
        bulkJob?.cancel()
        _state.update { it.copy(bulk = null) }
    }

    private fun reload(initial: Boolean) {
        searchDebounce?.takeIf { !initial }?.cancel()
        loadJob?.cancel()
        val gen = ++generation
        val config = graph.settings.config.value
        if (!config.hasToken) {
            _state.update {
                it.copy(hasToken = false, loading = false, refreshing = false, error = null, offline = false,
                        songs = emptyList(), total = 0)
            }
            return
        }
        val client = graph.client()
        _state.update {
            it.copy(hasToken = true, loading = initial && it.songs.isEmpty(), refreshing = !initial || it.songs.isNotEmpty(),
                    loadingMore = false, error = null)
        }
        val (query, sort) = _state.value.let { it.query to it.sort }
        loadJob = viewModelScope.launch {
            try {
                val page = client.list(query, LibraryClient.PAGE_SIZE, 0, sort)
                if (gen != generation) return@launch
                _state.update {
                    it.copy(songs = page.songs, total = page.total, loading = false, refreshing = false, offline = false)
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                if (gen != generation) return@launch
                if (t is IOException && PlaylistRepository.canFallBack(t)) {
                    val local = offlineLibrary(graph.index.entries.value.values, query, sort)
                    _state.update {
                        it.copy(songs = local, total = local.size, loading = false, refreshing = false,
                                offline = true, error = null)
                    }
                } else {
                    _state.update {
                        it.copy(loading = false, refreshing = false, error = describe(t), offline = false)
                    }
                }
            }
        }
    }

    private fun describe(t: Throwable): String = when {
        t is ApiException && t.unauthorized -> "The server rejected the API token (${t.code}). Check it in Settings."
        t is ApiException && t.code == 503 -> "The server's library is unavailable (no database)."
        t is ApiException -> "Server error ${t.code}: ${t.message}"
        else -> t.message ?: t::class.simpleName ?: "Unknown error"
    }
}
