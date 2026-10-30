package com.erkantaylan.listenalong.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.AppGraph
import com.erkantaylan.listenalong.api.Playlist
import com.erkantaylan.listenalong.api.PlaylistEntry
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.api.Visibility
import com.erkantaylan.listenalong.playlists.Loaded
import com.erkantaylan.listenalong.playlists.PlaylistRepository
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

data class PlaylistsUi(
    val hasToken: Boolean = false,
    val playlists: List<Playlist> = emptyList(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    /** Showing the cached list: the server could not be reached. Read-only. */
    val fromCache: Boolean = false,
    val savedAt: Long? = null,
)

data class PlaylistDetailUi(
    val id: String,
    val playlist: Playlist? = null,
    val entries: List<PlaylistEntry> = emptyList(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    val fromCache: Boolean = false,
    val savedAt: Long? = null,
    /** A change is on its way to the server; the list ignores more until it lands. */
    val busy: Boolean = false,
    /** The playlist is gone (deleted, or made private by someone else). */
    val gone: Boolean = false,
) {
    val songs: List<Song> get() = entries.mapNotNull { it.toSong() }
}

/**
 * The Playlists tab: the list, and the one playlist that is open. All server
 * work goes through [PlaylistRepository], which falls back to the cached copy
 * when the server cannot be reached; while showing a cached copy nothing can
 * be changed (the screens hide or disable the editing actions).
 */
class PlaylistsViewModel(private val graph: AppGraph) : ViewModel() {

    private val repo get() = graph.playlists

    private val _list = MutableStateFlow(PlaylistsUi(hasToken = graph.settings.config.value.hasToken))
    val list: StateFlow<PlaylistsUi> = _list.asStateFlow()

    private val _detail = MutableStateFlow<PlaylistDetailUi?>(null)
    val detail: StateFlow<PlaylistDetailUi?> = _detail.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    /** Server errors and confirmations, shown as toasts. */
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private var listJob: Job? = null
    private var detailJob: Job? = null

    init {
        refresh(initial = true)
        graph.settings.config.drop(1).distinctUntilChanged().onEach {
            _detail.value = null
            _list.value = PlaylistsUi(hasToken = it.hasToken)
            refresh(initial = true)
        }.launchIn(viewModelScope)
        graph.connectivity.online.drop(1).filter { it }.onEach {
            if (_list.value.fromCache || _list.value.error != null) refresh(initial = false)
            _detail.value?.takeIf { d -> d.fromCache || d.error != null }?.let { refreshDetail() }
        }.launchIn(viewModelScope)
    }

    fun refresh(initial: Boolean = false) {
        listJob?.cancel()
        if (!graph.settings.config.value.hasToken) {
            _list.value = PlaylistsUi(hasToken = false)
            return
        }
        if (initial && _list.value.playlists.isEmpty()) {
            repo.cachedPlaylists()?.let { cached -> _list.update { it.copy(playlists = cached) } }
        }
        _list.update {
            it.copy(hasToken = true, loading = it.playlists.isEmpty(), refreshing = it.playlists.isNotEmpty(), error = null)
        }
        listJob = viewModelScope.launch {
            try {
                val loaded = repo.playlists()
                _list.update {
                    it.copy(playlists = loaded.value, loading = false, refreshing = false,
                            fromCache = loaded.fromCache, savedAt = loaded.savedAt, error = null)
                }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                _list.update { it.copy(loading = false, refreshing = false, error = PlaylistRepository.describe(t)) }
            }
        }
    }

    fun open(id: String) {
        val known = _list.value.playlists.firstOrNull { it.id == id }
        val cached = repo.cachedSongs(id)
        _detail.value = PlaylistDetailUi(
            id = id,
            playlist = cached?.playlist ?: known,
            entries = cached?.songs.orEmpty(),
            loading = cached == null,
        )
        refreshDetail()
    }

    fun close() {
        detailJob?.cancel()
        _detail.value = null
    }

    fun refreshDetail() {
        val id = _detail.value?.id ?: return
        detailJob?.cancel()
        _detail.update { it?.copy(refreshing = it.entries.isNotEmpty(), error = null) }
        detailJob = viewModelScope.launch {
            try {
                applyDetail(id, repo.songs(id))
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                val gone = t is com.erkantaylan.listenalong.api.ApiException && t.code == 404
                _detail.update {
                    if (it?.id != id) it
                    else it.copy(loading = false, refreshing = false, error = PlaylistRepository.describe(t), gone = gone)
                }
                if (gone) removeFromList(id)
            }
        }
    }

    private fun applyDetail(id: String, loaded: Loaded<com.erkantaylan.listenalong.api.PlaylistSongs>) {
        _detail.update {
            if (it?.id != id) it
            else it.copy(
                playlist = loaded.value.playlist ?: it.playlist,
                entries = loaded.value.songs,
                loading = false, refreshing = false, busy = false,
                fromCache = loaded.fromCache, savedAt = loaded.savedAt,
                error = null,
            )
        }
        loaded.value.playlist?.let { fresh -> replaceInList(fresh) }
    }

    fun create(name: String, visibility: Visibility, thenAdd: List<Song> = emptyList(), openAfter: Boolean = true) =
        mutate("create the playlist") {
            val created = repo.create(name, visibility)
            if (thenAdd.isNotEmpty()) {
                val result = repo.add(created.id, thenAdd.map { it.id })
                say(addedMessage(result.summary.added, result.summary.alreadyInPlaylist, created.displayName))
            } else {
                say("Created ${created.displayName}")
            }
            refresh()
            if (openAfter) open(created.id)
        }

    fun rename(playlist: Playlist, name: String) = mutate("rename the playlist") {
        val updated = repo.rename(playlist.id, name)
        replaceInList(updated)
        _detail.update { if (it?.id == updated.id) it.copy(playlist = updated) else it }
    }

    fun toggleVisibility(playlist: Playlist) = mutate("change the visibility") {
        val target = if (playlist.isPrivate) Visibility.PUBLIC else Visibility.PRIVATE
        val updated = repo.setVisibility(playlist.id, target)
        replaceInList(updated)
        _detail.update { if (it?.id == updated.id) it.copy(playlist = updated) else it }
        say(if (updated.isPrivate) "${updated.displayName} is now private" else "${updated.displayName} is now public")
    }

    fun delete(playlist: Playlist) = mutate("delete the playlist") {
        repo.delete(playlist.id)
        removeFromList(playlist.id)
        if (_detail.value?.id == playlist.id) close()
        say("Deleted ${playlist.displayName}")
    }

    fun addSongs(playlist: Playlist, songs: List<Song>) = mutate("add to the playlist") {
        val result = repo.add(playlist.id, songs.map { it.id })
        say(addedMessage(result.summary.added, result.summary.alreadyInPlaylist, playlist.displayName))
        replaceInList(playlist.copy(songCount = result.songCount))
        if (_detail.value?.id == playlist.id) refreshDetail()
    }

    fun remove(entry: PlaylistEntry) {
        val id = _detail.value?.id ?: return
        // Gone from the screen at once; the server's answer replaces the list.
        _detail.update { it?.copy(entries = it.entries.filterNot { e -> e.entryId == entry.entryId }, busy = true) }
        mutate("remove the song", onError = { refreshDetail() }) {
            applyDetail(id, repo.remove(id, entry.entryId))
            _list.value.playlists.firstOrNull { it.id == id }?.let { replaceInList(it.copy(songCount = it.songCount - 1)) }
        }
    }

    /** Moves an entry one place up ([delta] = -1) or down (+1). */
    fun move(entry: PlaylistEntry, delta: Int) {
        val current = _detail.value ?: return
        if (current.busy) return
        val from = current.entries.indexOfFirst { it.entryId == entry.entryId }
        val to = from + delta
        if (from < 0 || to !in current.entries.indices) return
        val reordered = current.entries.toMutableList().apply { add(to, removeAt(from)) }
        _detail.update { it?.copy(entries = reordered, busy = true) }
        mutate("move the song", onError = { refreshDetail() }) {
            applyDetail(current.id, repo.move(current.id, entry.entryId, to + 1))
        }
    }

    private fun mutate(what: String, onError: () -> Unit = {}, block: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                block()
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                _detail.update { it?.copy(busy = false) }
                say("Could not $what: ${PlaylistRepository.describe(t)}")
                onError()
            }
        }
    }

    private fun replaceInList(playlist: Playlist) {
        _list.update { ui -> ui.copy(playlists = ui.playlists.map { if (it.id == playlist.id) playlist else it }) }
    }

    private fun removeFromList(id: String) {
        _list.update { ui -> ui.copy(playlists = ui.playlists.filterNot { it.id == id }) }
    }

    private fun say(text: String) {
        _messages.tryEmit(text)
    }

    companion object {
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
