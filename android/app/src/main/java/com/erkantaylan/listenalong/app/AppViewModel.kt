package com.erkantaylan.listenalong.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.data.AppUpdates
import com.erkantaylan.listenalong.core.data.UpdateNotice
import com.erkantaylan.listenalong.core.data.ReportRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SongReport
import com.erkantaylan.listenalong.core.network.NetworkMonitor
import com.erkantaylan.listenalong.core.ui.UserMessages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** "Mark as broken" (or edit your report): the song, your current report, and the dialog's progress. */
data class ReportDialogUi(
    val song: Song,
    val current: SongReport? = null,
    val busy: Boolean = false,
    val error: String? = null,
)

/**
 * The app shell's state, shared by every screen: the connection, the
 * broken-song reports behind the warning icons, the downloads badge, and
 * the report dialogs. Also keeps the saved copies fresh: at start, when the
 * server or the session changes, on resume and when the connection returns.
 */
class AppViewModel(
    val config: StateFlow<ServerConfig>,
    network: NetworkMonitor,
    private val reports: ReportRepository,
    private val downloads: Downloads,
    private val messages: UserMessages,
    /** Saves the covers of downloaded songs that have none yet (core/download/CoverSync); quiet offline. */
    private val syncCovers: suspend () -> Unit = {},
    private val updates: AppUpdates? = null,
) : ViewModel() {

    /** "Version X.Y.Z is available" (Download / Later), or null. */
    val update: StateFlow<UpdateNotice?> = updates?.notice ?: MutableStateFlow(null)

    fun updateLater() {
        updates?.later()
    }

    private fun checkForUpdate() {
        val u = updates ?: return
        viewModelScope.launch { runCatching { u.checkOnOpen(config.value.signedIn, online.value) } }
    }

    val online: StateFlow<Boolean> = network.online
    val reportMap: StateFlow<Map<String, List<SongReport>>> = reports.reports

    /** How many songs are waiting to download (the On device tab's badge). */
    val pendingDownloads: StateFlow<Int> = downloads.snapshots.map { it.pending.size }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, downloads.snapshot().pending.size)

    /** Whether anything is downloaded (the music access notice is offered only before). */
    val hasDownloads: StateFlow<Boolean> = downloads.snapshots.map { it.downloaded.isNotEmpty() }.distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.Eagerly, downloads.snapshot().downloaded.isNotEmpty())

    private val _reportDialog = MutableStateFlow<ReportDialogUi?>(null)
    val reportDialog: StateFlow<ReportDialogUi?> = _reportDialog.asStateFlow()

    private val _reportDetails = MutableStateFlow<Pair<Song, List<SongReport>>?>(null)
    /** The song whose reports are listed (the warning icon's popup), with its list when it was opened. */
    val reportDetails: StateFlow<Pair<Song, List<SongReport>>?> = _reportDetails.asStateFlow()

    init {
        // The broken-song list: the saved copy for this server at once, then the
        // server's. Another server has another library: compare the folder afresh.
        config.onEach { c ->
            reports.loadSaved()
            if (c.signedIn) {
                runCatching { reports.refresh() }
                foundInFolder(downloads.reclaim(force = true))
                runCatching { syncCovers() }
            }
        }.launchIn(viewModelScope)
        checkForUpdate()
        network.online.drop(1).onEach { online ->
            if (online && config.value.signedIn) {
                runCatching { reports.refresh() }
                runCatching { syncCovers() }
            }
        }.launchIn(viewModelScope)
    }

    /**
     * Back in the app: files deleted in a file manager or another player
     * disappear, files in the folder are recognised ([musicAccessJustGranted]:
     * compare them all again), and reports made elsewhere show up.
     */
    fun onResume(musicAccessJustGranted: Boolean) {
        checkForUpdate()
        viewModelScope.launch {
            downloads.reconcile()
            if (config.value.signedIn) foundInFolder(downloads.reclaim(force = musicAccessJustGranted))
        }
        if (config.value.signedIn) viewModelScope.launch { runCatching { reports.refresh() } }
    }

    /** Music access was just granted: everything in the folder is compared again. */
    fun musicAccessGranted() {
        viewModelScope.launch { foundInFolder(downloads.reclaim(force = true), announceNone = true) }
    }

    private fun foundInFolder(found: Int, announceNone: Boolean = false) {
        when {
            found > 0 -> messages.say(if (found == 1) "1 song found in Music/ListenAlong" else "$found songs found in Music/ListenAlong")
            announceNone -> messages.say("No new songs found in the folder")
        }
    }

    // --- Broken-song reports ------------------------------------------------

    fun markBroken(song: Song) {
        _reportDialog.value = ReportDialogUi(song)
    }

    fun editReport(song: Song, mine: SongReport) {
        _reportDialog.value = ReportDialogUi(song, mine)
    }

    fun dismissReport() {
        _reportDialog.value = null
    }

    fun submitReport(reason: String?) {
        val dialog = _reportDialog.value ?: return
        _reportDialog.update { it?.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val updated = reports.mark(dialog.song.id, reason)
                _reportDialog.value = null
                messages.say(if (updated) "Report updated" else "Marked “${dialog.song.title.ifBlank { "song" }}” as broken")
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                _reportDialog.update { it?.copy(busy = false, error = "Could not mark it: ${PlaylistRepository.describe(t)}") }
            }
        }
    }

    fun unmark(song: Song) {
        viewModelScope.launch {
            try {
                reports.unmark(song.id)
                messages.say("Unmarked: no longer reported by you")
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                messages.say("Could not unmark: ${PlaylistRepository.describe(t)}")
            }
        }
    }

    fun showReportDetails(song: Song, reports: List<SongReport>) {
        _reportDetails.value = song to reports
    }

    fun hideReportDetails() {
        _reportDetails.value = null
    }
}
