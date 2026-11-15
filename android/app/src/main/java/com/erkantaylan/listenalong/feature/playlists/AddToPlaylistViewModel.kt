package com.erkantaylan.listenalong.feature.playlists

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.Visibility
import com.erkantaylan.listenalong.core.ui.UserMessages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AddToPlaylistUi(
    val playlists: List<Playlist> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * "Add to playlist" from any song (Library, a playlist, On device): the
 * playlists you can see, fetched afresh when the dialog opens, and "New
 * playlist", which creates one with the songs already in it.
 */
class AddToPlaylistViewModel(
    private val repo: PlaylistRepository,
    private val messages: UserMessages,
) : ViewModel() {

    private val _state = MutableStateFlow(AddToPlaylistUi())
    val state: StateFlow<AddToPlaylistUi> = _state.asStateFlow()

    init {
        repo.observePlaylists().onEach { list -> _state.update { it.copy(playlists = list) } }.launchIn(viewModelScope)
    }

    fun refresh() {
        _state.update { it.copy(loading = it.playlists.isEmpty(), error = null) }
        viewModelScope.launch {
            try {
                repo.playlists()
                _state.update { it.copy(loading = false) }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = PlaylistRepository.describe(t)) }
            }
        }
    }

    fun add(playlist: Playlist, songs: List<Song>) = mutate("add to the playlist") {
        val result = repo.add(playlist.id, songs.map { it.id })
        messages.say(PlaylistsViewModel.addedMessage(result.summary.added, result.summary.alreadyInPlaylist, playlist.displayName))
    }

    fun createWith(name: String, visibility: Visibility, songs: List<Song>) = mutate("create the playlist") {
        val created = repo.create(name, visibility)
        val result = repo.add(created.id, songs.map { it.id })
        messages.say(PlaylistsViewModel.addedMessage(result.summary.added, result.summary.alreadyInPlaylist, created.displayName))
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
}
