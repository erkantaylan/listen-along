package com.erkantaylan.listenalong.feature.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.LibraryLoad
import com.erkantaylan.listenalong.core.data.LibraryRepository
import com.erkantaylan.listenalong.core.data.ReportRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.download.BulkPlan
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SortOrder
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.NetworkMonitor
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

sealed interface BulkUi {
    data object Preparing : BulkUi
    data class Ready(val plan: BulkPlan) : BulkUi
    data class Error(val message: String) : BulkUi
}

data class LibraryUiState(
    /** False until signed in: the server refuses the library without a session. */
    val signedIn: Boolean = false,
    val query: String = "",
    val sort: SortOrder = SortOrder.RECENT,
    /** The "Broken" filter: only songs someone marked as needing replacement. */
    val brokenOnly: Boolean = false,
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

/**
 * The Library screen: server-side search and sort, fetched a page at a time
 * as you scroll ([LibraryRepository]). Download state comes from [Downloads],
 * shared with On device and the worker. With no connection it shows the
 * downloaded songs instead, and reloads from the server when the connection
 * is back.
 */
class LibraryViewModel(
    private val config: StateFlow<ServerConfig>,
    private val network: NetworkMonitor,
    private val library: LibraryRepository,
    private val downloads: Downloads,
    private val reports: ReportRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LibraryUiState(signedIn = config.value.signedIn))
    val state: StateFlow<LibraryUiState> = _state.asStateFlow()

    val downloadState: StateFlow<DownloadSnapshot> =
        downloads.snapshots.stateIn(viewModelScope, SharingStarted.Eagerly, downloads.snapshot())

    private var searchDebounce: Job? = null
    private var loadJob: Job? = null
    private var bulkJob: Job? = null
    /** Bumped on every reload, so a late "load more" for an old query is dropped. */
    private var generation = 0

    init {
        reload(initial = true)
        // Another server, or signed in / out: start over.
        config
            .drop(1)
            .distinctUntilChanged()
            .onEach { c ->
                _state.update { it.copy(signedIn = c.signedIn, songs = emptyList(), total = 0) }
                reload(initial = true)
            }
            .launchIn(viewModelScope)
        // Back online after showing the offline list: fetch the real library.
        network.online
            .drop(1)
            .filter { it && _state.value.offline }
            .onEach { reload(initial = false) }
            .launchIn(viewModelScope)
        // Offline, the list is the downloads: keep it in step with them.
        library.local
            .drop(1)
            .filter { _state.value.offline }
            .onEach { _ -> _state.update { it.copy(songs = library.offline(it.query, it.sort, it.brokenOnly)).withTotal() } }
            .launchIn(viewModelScope)
    }

    private fun LibraryUiState.withTotal() = copy(total = songs.size)

    fun onBrokenOnlyChange(brokenOnly: Boolean) {
        if (brokenOnly == _state.value.brokenOnly) return
        _state.update { it.copy(brokenOnly = brokenOnly, songs = emptyList(), total = 0) }
        reload(initial = true)
    }

    fun onQueryChange(query: String) {
        _state.update { it.copy(query = query) }
        searchDebounce?.cancel()
        searchDebounce = viewModelScope.launch {
            delay(SEARCH_DEBOUNCE_MS)
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
        val gen = generation
        _state.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            try {
                val page = library.nextPage(current.query, current.songs.size, current.sort, current.brokenOnly)
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

    /** Queues one song. Returns how many were added (0 when it is already here or queued). */
    fun download(song: Song): Int = downloads.enqueue(listOf(song))

    fun cancel(song: Song) = downloads.cancel(song.id)

    /** Works out what "download all shown" would fetch, for the confirm dialog. */
    fun prepareBulk() {
        val current = _state.value
        bulkJob?.cancel()
        _state.update { it.copy(bulk = BulkUi.Preparing) }
        bulkJob = viewModelScope.launch {
            try {
                val all = library.all(current.query, current.sort, current.brokenOnly)
                val plan = BulkPlan.of(all, downloads.snapshot())
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
        return downloads.enqueue(plan.all)
    }

    fun dismissBulk() {
        bulkJob?.cancel()
        _state.update { it.copy(bulk = null) }
    }

    private fun reload(initial: Boolean) {
        searchDebounce?.takeIf { !initial }?.cancel()
        loadJob?.cancel()
        val gen = ++generation
        if (!config.value.signedIn) {
            _state.update {
                it.copy(signedIn = false, loading = false, refreshing = false, error = null, offline = false,
                        songs = emptyList(), total = 0)
            }
            return
        }
        _state.update {
            it.copy(signedIn = true, loading = initial && it.songs.isEmpty(), refreshing = !initial || it.songs.isNotEmpty(),
                    loadingMore = false, error = null)
        }
        val (query, sort) = _state.value.let { it.query to it.sort }
        val brokenOnly = _state.value.brokenOnly
        // The broken-song list behind the icons in every tab, refreshed with the library.
        viewModelScope.launch { runCatching { reports.refresh() } }
        loadJob = viewModelScope.launch {
            try {
                val load = library.firstPage(query, sort, brokenOnly)
                if (gen != generation) return@launch
                _state.update {
                    when (load) {
                        is LibraryLoad.Online -> it.copy(songs = load.page.songs, total = load.page.total, loading = false,
                                                         refreshing = false, offline = false)
                        is LibraryLoad.Offline -> it.copy(songs = load.songs, total = load.songs.size, loading = false,
                                                          refreshing = false, offline = true, error = null)
                    }
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                if (gen != generation) return@launch
                _state.update { it.copy(loading = false, refreshing = false, error = describe(t), offline = false) }
            }
        }
    }

    companion object {
        const val SEARCH_DEBOUNCE_MS = 350L

        fun describe(t: Throwable): String = when {
            t is ApiException && t.sessionEnded -> "Signed out: sign in again in Settings."
            t is ApiException && t.code == 403 -> t.message ?: "Not allowed (403)"
            t is ApiException && t.code == 503 -> "The server's library is unavailable (no database)."
            t is ApiException -> "Server error ${t.code}: ${t.message}"
            else -> t.message ?: t::class.simpleName ?: "Unknown error"
        }
    }
}
