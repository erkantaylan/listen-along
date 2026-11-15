package com.erkantaylan.listenalong.feature.playlists

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.model.Visibility
import com.erkantaylan.listenalong.core.network.NetworkMonitor
import com.erkantaylan.listenalong.core.ui.UserMessages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The web sidebar's filter (one at a time): the server's `isOwner` and `visibility`, never a guess. */
enum class OwnerFilter(val label: String) { ALL("All"), MINE("Mine"), PUBLIC("Public"), PRIVATE("Private") }

data class PlaylistsUi(
    val signedIn: Boolean = false,
    val playlists: List<Playlist> = emptyList(),
    val filter: OwnerFilter = OwnerFilter.ALL,
    /** The "Downloaded" chip: only playlists whose Download is on. */
    val downloadedOnly: Boolean = false,
    /** Downloaded playlists' statuses, by id (their marks). */
    val downloads: Map<String, PlaylistDownloadStatus> = emptyMap(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    /** Showing the cached list: the server could not be reached. Read-only. */
    val fromCache: Boolean = false,
    val savedAt: Long? = null,
) {
    /** The playlists the filter lets through, in the list's order (yours first). */
    val shown: List<Playlist>
        get() = playlists.filter {
            when (filter) {
                OwnerFilter.ALL -> true
                OwnerFilter.MINE -> it.isOwner
                OwnerFilter.PUBLIC -> !it.isPrivate
                OwnerFilter.PRIVATE -> it.isPrivate
            } && (!downloadedOnly || it.id in downloads)
        }
}

/**
 * The Playlists screen: the list (from [PlaylistRepository], which falls back
 * to its saved copy when the server cannot be reached; while showing that,
 * nothing can be changed) and the owner's actions on a row (rename,
 * visibility, delete, new playlist).
 */
class PlaylistsViewModel(
    private val config: StateFlow<ServerConfig>,
    private val network: NetworkMonitor,
    private val repo: PlaylistRepository,
    private val messages: UserMessages,
    statuses: StateFlow<Map<String, PlaylistDownloadStatus>> = kotlinx.coroutines.flow.MutableStateFlow(emptyMap()),
    /** After the list was loaded from the server: downloaded playlists sync too. */
    private val onRefreshed: () -> Unit = {},
) : ViewModel() {

    private val _state = MutableStateFlow(PlaylistsUi(signedIn = config.value.signedIn))
    val state: StateFlow<PlaylistsUi> = _state.asStateFlow()

    private val _opened = MutableSharedFlow<String>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    /** A playlist to open (one just created). */
    val opened: SharedFlow<String> = _opened.asSharedFlow()

    private var listJob: Job? = null

    init {
        // The repository is the source of truth: renames and removals made on
        // the playlist page show here at once.
        repo.observePlaylists().onEach { list ->
            if (_state.value.signedIn) _state.update { it.copy(playlists = list) }
        }.launchIn(viewModelScope)
        statuses.onEach { map -> _state.update { it.copy(downloads = map) } }.launchIn(viewModelScope)
        refresh(initial = true)
        config.drop(1).distinctUntilChanged().onEach {
            _state.value = PlaylistsUi(signedIn = it.signedIn, downloads = _state.value.downloads)
            refresh(initial = true)
        }.launchIn(viewModelScope)
        network.online.drop(1).filter { it }.onEach {
            if (_state.value.fromCache || _state.value.error != null) refresh(initial = false)
        }.launchIn(viewModelScope)
    }

    fun refresh(initial: Boolean = false) {
        listJob?.cancel()
        if (!config.value.signedIn) {
            _state.value = PlaylistsUi(signedIn = false)
            return
        }
        if (initial && _state.value.playlists.isEmpty()) {
            repo.cachedPlaylists()?.let { cached -> _state.update { it.copy(playlists = cached) } }
        }
        _state.update {
            it.copy(signedIn = true, loading = it.playlists.isEmpty(), refreshing = it.playlists.isNotEmpty(), error = null)
        }
        listJob = viewModelScope.launch {
            try {
                val loaded = repo.playlists()
                _state.update {
                    it.copy(playlists = loaded.value, loading = false, refreshing = false,
                            fromCache = loaded.fromCache, savedAt = loaded.savedAt, error = null)
                }
                if (!loaded.fromCache) onRefreshed()
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, refreshing = false, error = PlaylistRepository.describe(t)) }
            }
        }
    }

    fun setDownloadedOnly(on: Boolean) {
        _state.update { it.copy(downloadedOnly = on) }
    }

    /** Picking the filter that is on, or All, shows everything. */
    fun setFilter(filter: OwnerFilter) {
        _state.update { it.copy(filter = if (it.filter == filter) OwnerFilter.ALL else filter) }
    }

    fun create(name: String, visibility: Visibility) = mutate("create the playlist") {
        val created = repo.create(name, visibility)
        messages.say("Created ${created.displayName}")
        refresh()
        _opened.tryEmit(created.id)
    }

    fun rename(playlist: Playlist, name: String) = mutate("rename the playlist") {
        repo.rename(playlist.id, name)
    }

    fun toggleVisibility(playlist: Playlist) = mutate("change the visibility") {
        val updated = repo.setVisibility(playlist.id, if (playlist.isPrivate) Visibility.PUBLIC else Visibility.PRIVATE)
        messages.say(visibilityMessage(updated))
    }

    fun delete(playlist: Playlist) = mutate("delete the playlist") {
        repo.delete(playlist.id)
        messages.say("Deleted ${playlist.displayName}")
    }

    private fun mutate(what: String, block: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                block()
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                messages.say("Could not $what: ${PlaylistRepository.describe(t)}")
            }
        }
    }

    companion object {
        fun visibilityMessage(p: Playlist): String =
            if (p.isPrivate) "${p.displayName} is now private" else "${p.displayName} is now public"

        fun addedMessage(added: Int, already: Int, name: String): String = buildString {
            append(
                when (added) {
                    0 -> "Nothing added to $name"
                    1 -> "Added 1 song to $name"
                    else -> "Added $added songs to $name"
                }
            )
            if (already > 0) append(if (already == 1) " (1 already there)" else " ($already already there)")
        }
    }
}
