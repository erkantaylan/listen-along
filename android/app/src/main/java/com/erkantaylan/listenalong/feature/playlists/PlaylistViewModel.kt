package com.erkantaylan.listenalong.feature.playlists

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.Loaded
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.download.BulkPlan
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.data.PlaylistDownloads
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.PlaylistEntry
import com.erkantaylan.listenalong.core.model.PlaylistSongs
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.Visibility
import com.erkantaylan.listenalong.core.network.ApiException
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
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class PlaylistDetailUi(
    val id: String,
    val playlist: Playlist? = null,
    val entries: List<PlaylistEntry> = emptyList(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    val fromCache: Boolean = false,
    val savedAt: Long? = null,
    /** The playlist is gone (deleted, or made private by someone else). */
    val gone: Boolean = false,
    /** Edit mode: drag handles and remove buttons; tapping a row does not play. */
    val editing: Boolean = false,
    /** Removed, not yet sent: the Undo snackbar is showing. Not in [entries]. */
    val pending: PlaylistEdits.PendingRemoval? = null,
    /** A drag in progress (edit mode). */
    val drag: PlaylistEdits.Drag? = null,
) {
    val songs: List<Song> get() = entries.mapNotNull { it.toSong() }
    val edits: PlaylistEdits get() = PlaylistEdits(entries, pending, drag)
}

/**
 * One playlist's page: its songs (from [PlaylistRepository], the saved copy
 * when the server cannot be reached: read-only then), edit mode (drag to
 * reorder, remove with Undo) and the owner's actions. Edits apply locally
 * first ([PlaylistEdits]) and reach the server one call at a time.
 */
class PlaylistViewModel(
    val playlistId: String,
    private val network: NetworkMonitor,
    private val repo: PlaylistRepository,
    private val downloads: Downloads,
    private val messages: UserMessages,
    private val playlistDownloads: PlaylistDownloads,
    statuses: StateFlow<Map<String, PlaylistDownloadStatus>>,
) : ViewModel() {

    /** The Download switch and what it is doing (downloaded, n of m, waiting for Wi-Fi…). */
    val download: StateFlow<PlaylistDownloadStatus> = statuses.map { it[playlistId] ?: PlaylistDownloadStatus.Off }
        .stateIn(viewModelScope, SharingStarted.Eagerly, statuses.value[playlistId] ?: PlaylistDownloadStatus.Off)

    private val _state = MutableStateFlow(initial())
    val state: StateFlow<PlaylistDetailUi> = _state.asStateFlow()

    private val _closed = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    /** The playlist was deleted here: leave the page. */
    val closed: SharedFlow<Unit> = _closed.asSharedFlow()

    /** Every song's download state (the row buttons, "n of m on device"). */
    val downloadState: StateFlow<DownloadSnapshot> =
        downloads.snapshots.stateIn(viewModelScope, SharingStarted.Eagerly, downloads.snapshot())

    private var detailJob: Job? = null

    /** Song-list edits reach the server one at a time, in order. */
    private val editLock = Mutex()
    private var editsInFlight = 0

    init {
        refresh()
        network.online.drop(1).filter { it }.onEach {
            _state.value.takeIf { d -> d.fromCache || d.error != null }?.let { refresh() }
        }.launchIn(viewModelScope)
    }

    private fun initial(): PlaylistDetailUi {
        val known = repo.cachedPlaylists()?.firstOrNull { it.id == playlistId }
        val cached = repo.cachedSongs(playlistId)
        return PlaylistDetailUi(
            id = playlistId,
            playlist = cached?.playlist ?: known,
            entries = cached?.songs.orEmpty(),
            loading = cached == null,
        )
    }

    fun refresh() {
        val current = _state.value
        // Mid-edit, the local list is the truth; Done syncs with the server.
        if (current.editing || editsInFlight > 0) return
        detailJob?.cancel()
        _state.update { it.copy(refreshing = it.entries.isNotEmpty(), error = null) }
        detailJob = viewModelScope.launch {
            try {
                apply(repo.songs(playlistId))
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                val gone = t is ApiException && t.code == 404
                _state.update { it.copy(loading = false, refreshing = false, error = PlaylistRepository.describe(t), gone = gone) }
                // A downloaded playlist that is gone is shown as unavailable; its files stay.
                if (gone && playlistDownloads.isDownloaded(playlistId)) {
                    viewModelScope.launch { runCatching { playlistDownloads.sync() } }
                }
            }
        }
    }

    /**
     * "Download" on: every song of the playlist is downloaded and kept in
     * step with the server (core/data/PlaylistDownloads).
     */
    fun startDownload() {
        val p = _state.value.playlist ?: return
        viewModelScope.launch {
            try {
                playlistDownloads.enable(p, PlaylistSongs(p, _state.value.entries).takeIf { !_state.value.fromCache })
            } catch (c: kotlinx.coroutines.CancellationException) {
                throw c
            } catch (e: Exception) {
                // Who is signed in could not be told (offline with a session from an older version).
                messages.say(e.message ?: "Could not turn Download on")
            }
        }
    }

    /** "Download" off; [removeFiles]: also delete the files playlist sync saved for it (the user's own stay). */
    fun stopDownload(removeFiles: Boolean) {
        viewModelScope.launch {
            val removed = playlistDownloads.disable(playlistId, removeFiles)
            messages.say(
                when {
                    !removeFiles -> "Download turned off — the songs stay on this device"
                    removed == 0 -> "Download turned off"
                    removed == 1 -> "Download turned off — 1 song removed"
                    else -> "Download turned off — $removed songs removed"
                }
            )
        }
    }

    /** A failed playlist download: try its songs again. */
    fun retryDownload() {
        viewModelScope.launch { runCatching { playlistDownloads.sync() } }
    }

    private fun apply(loaded: Loaded<PlaylistSongs>) {
        _state.update {
            it.copy(
                playlist = loaded.value.playlist ?: it.playlist,
                entries = loaded.value.songs,
                loading = false, refreshing = false,
                fromCache = loaded.fromCache, savedAt = loaded.savedAt,
                error = null,
            )
        }
        // A downloaded playlist follows what was just loaded: songs added since download now.
        if (!loaded.fromCache && playlistDownloads.isDownloaded(playlistId)) {
            viewModelScope.launch { runCatching { playlistDownloads.sync(mapOf(playlistId to loaded.value)) } }
        }
    }

    // --- The owner's actions --------------------------------------------------

    fun rename(name: String) = mutate("rename the playlist") {
        val updated = repo.rename(playlistId, name)
        _state.update { it.copy(playlist = updated) }
    }

    fun toggleVisibility() = mutate("change the visibility") {
        val p = _state.value.playlist ?: return@mutate
        val updated = repo.setVisibility(playlistId, if (p.isPrivate) Visibility.PUBLIC else Visibility.PRIVATE)
        _state.update { it.copy(playlist = updated) }
        messages.say(PlaylistsViewModel.visibilityMessage(updated))
    }

    fun delete() = mutate("delete the playlist") {
        val p = _state.value.playlist
        repo.delete(playlistId)
        messages.say("Deleted ${p?.displayName ?: "the playlist"}")
        _closed.tryEmit(Unit)
    }

    /** What "Download playlist" would fetch, for its confirm dialog. */
    fun downloadPlan(): BulkPlan = BulkPlan.of(_state.value.songs, downloads.snapshot())

    /** Queues the plan's songs (and makes the ones already here the user's own). Returns how many were added. */
    fun download(plan: BulkPlan): Int = downloads.enqueue(plan.all)

    fun downloadSong(song: Song) {
        downloads.enqueue(listOf(song))
    }

    fun cancelDownload(song: Song) = downloads.cancel(song.id)

    // --- Editing the song list ------------------------------------------------
    // Local first (PlaylistEdits), then the server, one call at a time. While
    // editing, the server's answers are not applied (the list on screen is
    // ahead of them); leaving edit mode reloads the playlist.

    fun startEditing() {
        val d = _state.value
        if (d.playlist?.editable != true || d.fromCache) return
        _state.update { it.copy(editing = true) }
    }

    fun finishEditing() {
        commitPendingRemoval()
        _state.update { it.copy(editing = false, drag = null) }
        if (editsInFlight == 0) refresh()
    }

    /** Removes an entry at once; the Undo snackbar can bring it back until it is committed. */
    fun remove(entry: PlaylistEntry) {
        val (next, previous) = _state.value.edits.remove(entry.entryId)
        _state.update { it.copy(entries = next.entries, pending = next.pending) }
        previous?.let(::sendRemoval)
    }

    fun undoRemove() {
        val next = _state.value.edits.undo()
        _state.update { it.copy(entries = next.entries, pending = null) }
    }

    /** The Undo snackbar timed out (or editing ended, or the page closes): send the pending removal. */
    fun commitPendingRemoval(entryId: String? = null) {
        val d = _state.value
        if (d.pending == null || (entryId != null && d.pending.entry.entryId != entryId)) return
        val (next, pending) = d.edits.commitPending()
        _state.update { it.copy(pending = next.pending) }
        pending?.let(::sendRemoval)
    }

    fun startDrag(entryId: String) {
        commitPendingRemoval()
        _state.update { d -> d.copy(drag = d.edits.startDrag(entryId).drag) }
    }

    fun dragOver(targetId: String) {
        _state.update { d -> d.copy(entries = d.edits.dragOver(targetId).entries) }
    }

    fun endDrag() {
        val (next, move) = _state.value.edits.endDrag()
        _state.update { it.copy(drag = next.drag) }
        if (move != null) sendEdit("move the song") { repo.move(playlistId, move.entryId, move.position) }
    }

    /** One step up (-1) or down (+1): TalkBack's "Move up" / "Move down" in edit mode. */
    fun moveBy(entry: PlaylistEntry, delta: Int) {
        val d = _state.value
        val from = d.entries.indexOfFirst { it.entryId == entry.entryId }
        val target = d.entries.getOrNull(from + delta) ?: return
        startDrag(entry.entryId)
        dragOver(target.entryId)
        endDrag()
    }

    private fun sendRemoval(p: PlaylistEdits.PendingRemoval) {
        sendEdit("remove the song") { repo.remove(playlistId, p.entry.entryId) }
    }

    private fun sendEdit(what: String, block: suspend () -> Unit) {
        editsInFlight++
        viewModelScope.launch {
            var failed = false
            try {
                editLock.withLock { block() }
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                failed = true
                messages.say("Could not $what: ${PlaylistRepository.describe(t)}")
            } finally {
                editsInFlight--
            }
            val d = _state.value
            if (failed) {
                // The list on screen is wrong now: start over from the server's.
                _state.update { it.copy(pending = null, drag = null) }
                forceRefresh()
            } else if (editsInFlight == 0 && !d.editing && d.pending == null) {
                refresh()
            }
        }
    }

    private fun forceRefresh() {
        val wasEditing = _state.value.editing
        _state.update { it.copy(editing = false) }
        if (editsInFlight == 0) refresh()
        if (wasEditing) _state.update { it.copy(editing = true) }
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

    override fun onCleared() {
        // Leaving the page sends a removal still waiting for its Undo to time
        // out. The view model's scope is gone, so it runs on its own.
        val pending = _state.value.pending ?: return
        @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
        kotlinx.coroutines.GlobalScope.launch {
            runCatching { repo.remove(playlistId, pending.entry.entryId) }
                .onFailure { messages.say("Could not remove the song: ${PlaylistRepository.describe(it)}") }
        }
    }
}
