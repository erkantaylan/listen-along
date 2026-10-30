package com.erkantaylan.listenalong

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.erkantaylan.listenalong.api.ServerUrl
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.open.ExternalPlayer
import com.erkantaylan.listenalong.player.PlayQueue
import com.erkantaylan.listenalong.settings.SettingsStore
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.ui.AddToPlaylistDialog
import com.erkantaylan.listenalong.ui.AppActions
import com.erkantaylan.listenalong.ui.AppShell
import com.erkantaylan.listenalong.ui.FullPlayer
import com.erkantaylan.listenalong.ui.LibraryScreen
import com.erkantaylan.listenalong.ui.LibraryViewModel
import com.erkantaylan.listenalong.ui.MiniPlayer
import com.erkantaylan.listenalong.ui.OnDeviceScreen
import com.erkantaylan.listenalong.ui.PlaylistsScreen
import com.erkantaylan.listenalong.ui.PlaylistsViewModel
import com.erkantaylan.listenalong.ui.SettingsScreen
import com.erkantaylan.listenalong.ui.Tab
import com.erkantaylan.listenalong.ui.theme.ListenAlongTheme
import com.erkantaylan.listenalong.api.SongReport
import com.erkantaylan.listenalong.playlists.PlaylistRepository
import com.erkantaylan.listenalong.ui.LocalOnline
import com.erkantaylan.listenalong.ui.LocalReportActions
import com.erkantaylan.listenalong.ui.LocalReports
import com.erkantaylan.listenalong.ui.ReportActions
import com.erkantaylan.listenalong.ui.ReportDetailsDialog
import com.erkantaylan.listenalong.ui.ReportDialog
import androidx.compose.runtime.CompositionLocalProvider
import com.erkantaylan.listenalong.ui.theme.Palette
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
class MainActivity : ComponentActivity() {

    private val graph get() = (application as ListenAlongApp).graph

    /** Set by the media notification (tap opens the full player). */
    private var openPlayerRequest by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        applyDebugOverride(intent)
        openPlayerRequest = intent?.getBooleanExtra(EXTRA_OPEN_PLAYER, false) == true

        setContent {
            ListenAlongTheme {
                // Insets handled once, here: every screen draws inside the
                // safe area and the tab bar sits above the system navigation.
                // Test tags double as resource ids, so uiautomator (and adb
                // scripts) can find every tab, row and button.
                Box(
                    Modifier.fillMaxSize().background(Palette.page).safeDrawingPadding()
                        .semantics { testTagsAsResourceId = true }
                ) {
                    Content()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyDebugOverride(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_PLAYER, false)) openPlayerRequest = true
    }

    override fun onStart() {
        super.onStart()
        graph.player.connect()
    }

    /**
     * Debug builds only: `adb shell am start ... --es server http://localhost:8091 --es token devtoken`
     * points this process at another server without saving it (dev.sh --stub
     * does this), so testing never overwrites the phone's real settings.
     */
    private fun applyDebugOverride(intent: Intent?) {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val server = intent?.getStringExtra(EXTRA_DEBUG_SERVER) ?: return
        if (!debuggable) return
        val url = ServerUrl.normalize(server) ?: return
        graph.settings.overrideForSession(url, intent.getStringExtra(EXTRA_DEBUG_TOKEN))
    }

    @androidx.compose.runtime.Composable
    private fun Content() {
        val graph = graph
        val scope = rememberCoroutineScope()
        val config by graph.settings.config.collectAsStateWithLifecycle()
        val firstTab = if (config.hasToken) Tab.LIBRARY else Tab.SETTINGS
        var tab by rememberSaveable { mutableStateOf(firstTab) }
        var showPlayer by rememberSaveable { mutableStateOf(false) }
        var addingToPlaylist by remember { mutableStateOf<List<Song>?>(null) }
        // "Mark as broken": the dialog being shown (song + your report when editing), and the details popup.
        var reporting by remember { mutableStateOf<Pair<Song, SongReport?>?>(null) }
        var reportBusy by remember { mutableStateOf(false) }
        var reportError by remember { mutableStateOf<String?>(null) }
        var reportDetails by remember { mutableStateOf<Pair<Song, List<SongReport>>?>(null) }
        val reports by graph.reports.reports.collectAsStateWithLifecycle()

        val snapshot by graph.downloads.snapshots.collectAsStateWithLifecycle(graph.downloads.snapshot())
        val nowPlaying by graph.player.state.collectAsStateWithLifecycle()
        val online by graph.connectivity.online.collectAsStateWithLifecycle()
        val libraryVm: LibraryViewModel = viewModel(factory = viewModelFactory { initializer { LibraryViewModel(graph) } })
        val playlistsVm: PlaylistsViewModel =
            viewModel(factory = viewModelFactory { initializer { PlaylistsViewModel(graph) } })

        LaunchedEffect(openPlayerRequest) {
            if (openPlayerRequest) {
                if (!graph.player.state.value.isEmpty) showPlayer = true
                openPlayerRequest = false
            }
        }
        LaunchedEffect(Unit) { playlistsVm.messages.collect { toast(it) } }
        LaunchedEffect(Unit) { graph.player.errors.collect { toast(it) } }
        if (nowPlaying.isEmpty && showPlayer) showPlayer = false

        // Files deleted in a file manager or another player while we were
        // away disappear from On device on return.
        // The broken-song list: the saved copy for this server at once, then the server's.
        LaunchedEffect(config) {
            graph.reports.loadSaved()
            if (config.hasToken) runCatching { graph.reports.refresh() }
        }
        LaunchedEffect(online) {
            if (online && config.hasToken) runCatching { graph.reports.refresh() }
        }

        LifecycleResumeEffect(Unit) {
            scope.launch { graph.downloads.reconcile() }
            if (graph.settings.config.value.hasToken) scope.launch { runCatching { graph.reports.refresh() } }
            onPauseOrDispose { }
        }

        var askedPermissions by remember { mutableStateOf(false) }
        val permissionLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { granted ->
            if (granted[Manifest.permission.WRITE_EXTERNAL_STORAGE] == false) {
                toast("Without storage access, songs cannot be saved on this Android version")
            }
        }
        // Asked the first time a download or playback starts, not at launch:
        // notifications (download progress, the player's controls), and
        // storage on Android 9 and older, which has no MediaStore RELATIVE_PATH.
        val askPermissions: (Boolean) -> Unit = { forDownload ->
            val wanted = buildList {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
                if (forDownload && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }.filter {
                ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED
            }
            if (wanted.isNotEmpty() && !askedPermissions) {
                askedPermissions = true
                permissionLauncher.launch(wanted.toTypedArray())
            }
        }

        val openExternal: (LocalSong) -> Unit = { song ->
            scope.launch {
                val present = withContext(Dispatchers.IO) {
                    runCatching { graph.sink.exists(song.uri) }.getOrDefault(true)
                }
                if (!present) {
                    graph.index.remove(song.songId)
                    toast("That file was deleted outside the app; download it again from Library")
                    return@launch
                }
                val result = ExternalPlayer.open(this@MainActivity, song)
                if (result is ExternalPlayer.Result.NoHandler) toast("No app installed that plays ${result.mimeType}")
            }
        }

        val actions = remember {
            AppActions(
                play = { songs, index, context, shuffle ->
                    val client = graph.client()
                    val queue = PlayQueue.build(
                        songs = songs,
                        startIndex = index,
                        downloaded = graph.index.entries.value,
                        streamUrl = if (graph.settings.config.value.hasToken) { id -> client.fileUrl(id).toString() } else null,
                        online = graph.connectivity.online.value,
                    )
                    when {
                        queue.entries.isEmpty() -> toast(
                            if (!graph.connectivity.online.value) "Offline, and none of these songs are on this device"
                            else "Nothing to play — add an API token in Settings"
                        )
                        else -> {
                            askPermissions(false)
                            graph.player.play(queue, context, shuffle)
                            if (queue.skipped > 0) {
                                toast("Offline: playing the ${queue.entries.size} songs on this device, ${queue.skipped} skipped")
                            }
                        }
                    }
                },
                addToPlaylist = { songs -> addingToPlaylist = songs },
                beforeDownload = { askPermissions(true) },
                queued = { n -> toast(if (n == 1) "1 song queued" else "$n songs queued") },
                message = ::toast,
                openSettings = { tab = Tab.SETTINGS },
                openProfile = {
                    val url = SettingsStore.profileUrl(graph.settings.config.value.baseUrl)
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
                        .onFailure { toast("No browser to open $url") }
                },
                openExternal = openExternal,
                serverName = { graph.settings.config.value.baseUrl.host },
            )
        }

        val reportActions = remember {
            ReportActions(
                mark = { song -> reportError = null; reportBusy = false; reporting = song to null },
                edit = { song, mine -> reportError = null; reportBusy = false; reporting = song to mine },
                unmark = { song ->
                    scope.launch {
                        try {
                            graph.reports.unmark(song.id)
                            toast("Unmarked: no longer reported by you")
                        } catch (c: kotlinx.coroutines.CancellationException) {
                            throw c
                        } catch (t: Throwable) {
                            toast("Could not unmark: ${PlaylistRepository.describe(t)}")
                        }
                    }
                },
                details = { song, list -> reportDetails = song to list },
            )
        }

        BackHandler(enabled = !showPlayer && tab != Tab.LIBRARY) { tab = Tab.LIBRARY }

        CompositionLocalProvider(
            LocalReports provides reports,
            LocalOnline provides online,
            LocalReportActions provides reportActions,
        ) {
        Box(Modifier.fillMaxSize()) {
            AppShell(
                selected = tab,
                onSelect = { tab = it },
                badge = { t -> if (t == Tab.DEVICE && snapshot.pending.isNotEmpty()) "${snapshot.pending.size}" else null },
                miniPlayer = if (!nowPlaying.isEmpty) {
                    { MiniPlayer(nowPlaying, graph.player, onOpen = { showPlayer = true }) }
                } else null,
            ) {
                when (tab) {
                    Tab.LIBRARY -> LibraryScreen(libraryVm, nowPlaying, actions)
                    Tab.PLAYLISTS -> PlaylistsScreen(playlistsVm, snapshot, graph.downloads, online, nowPlaying, actions)
                    Tab.DEVICE -> OnDeviceScreen(snapshot, graph.downloads, nowPlaying, actions, online)
                    Tab.SETTINGS -> SettingsScreen(graph, snapshot, actions)
                }
            }

            AnimatedVisibility(
                visible = showPlayer && !nowPlaying.isEmpty,
                enter = slideInVertically { it },
                exit = slideOutVertically { it },
            ) {
                BackHandler { showPlayer = false }
                FullPlayer(nowPlaying, graph.player, onClose = { showPlayer = false })
            }
        }

        addingToPlaylist?.let { songs ->
            AddToPlaylistDialog(songs, playlistsVm, onDismiss = { addingToPlaylist = null })
        }

        reporting?.let { (song, current) ->
            ReportDialog(
                song = song,
                current = current,
                busy = reportBusy,
                error = reportError,
                onSubmit = { reason ->
                    reportBusy = true
                    reportError = null
                    scope.launch {
                        try {
                            val updated = graph.reports.mark(song.id, reason)
                            reporting = null
                            toast(if (updated) "Report updated" else "Marked \u201c${song.title.ifBlank { "song" }}\u201d as broken")
                        } catch (c: kotlinx.coroutines.CancellationException) {
                            throw c
                        } catch (t: Throwable) {
                            reportError = "Could not mark it: ${PlaylistRepository.describe(t)}"
                        } finally {
                            reportBusy = false
                        }
                    }
                },
                onDismiss = { reporting = null },
            )
        }
        reportDetails?.let { (song, list) ->
            // Live: if a report is withdrawn while it is open, show what is left.
            val live = reports[song.id] ?: list
            ReportDetailsDialog(song, live, onDismiss = { reportDetails = null })
        }
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    companion object {
        const val EXTRA_OPEN_PLAYER = "open_player"
        const val EXTRA_DEBUG_SERVER = "server"
        const val EXTRA_DEBUG_TOKEN = "token"
    }
}
