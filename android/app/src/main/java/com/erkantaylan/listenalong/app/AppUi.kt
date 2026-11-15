package com.erkantaylan.listenalong.app

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.erkantaylan.listenalong.core.auth.AuthEvent
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.player.PlayOutcome
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.core.ui.AppActions
import com.erkantaylan.listenalong.core.ui.CoverSource
import com.erkantaylan.listenalong.core.ui.LocalCovers
import com.erkantaylan.listenalong.core.ui.LocalMusicAccess
import com.erkantaylan.listenalong.core.ui.LocalOnline
import com.erkantaylan.listenalong.core.ui.LocalReportActions
import com.erkantaylan.listenalong.core.ui.LocalReports
import com.erkantaylan.listenalong.core.ui.MusicAccessUi
import com.erkantaylan.listenalong.core.ui.ReportActions
import com.erkantaylan.listenalong.feature.downloads.OnDeviceScreen
import com.erkantaylan.listenalong.feature.library.LibraryScreen
import com.erkantaylan.listenalong.feature.player.FullPlayer
import com.erkantaylan.listenalong.feature.player.MiniPlayer
import com.erkantaylan.listenalong.feature.playlists.AddToPlaylistDialog
import com.erkantaylan.listenalong.feature.playlists.PlaylistScreen
import com.erkantaylan.listenalong.feature.playlists.PlaylistsScreen
import com.erkantaylan.listenalong.feature.reports.ReportDetailsDialog
import com.erkantaylan.listenalong.feature.reports.ReportDialog
import com.erkantaylan.listenalong.feature.settings.SettingsScreen

/** What only the activity can do: the browser, other apps, permission prompts, toasts. */
interface PlatformActions {
    fun toast(text: String)
    /** Opens the central login's sign-in page in a Custom Tab (core/auth/AuthController). */
    fun signIn()
    fun openSource()
    fun openExternal(song: LocalSong)
    /** Deleting a file an earlier install created: asks the system for the user's consent. */
    fun deleteWithConsent(song: LocalSong)
    /** Notifications (and storage on Android 9 and older) before the first playback or download. */
    fun askPermissions(forDownload: Boolean)
    /** A web page in the browser (the update's download). */
    fun openUrl(url: String)
}

/** Music access (READ_MEDIA_AUDIO) as the activity knows it, and how to ask. */
class MusicAccessState(
    val granted: Boolean,
    val promptDismissed: Boolean,
    val request: () -> Unit,
    val dismiss: () -> Unit,
)

/**
 * The whole app below the activity: the navigation host inside the shell
 * (bottom tabs, mini player), the full player over it, and the app-wide
 * dialogs (add to playlist, broken-song reports).
 */
@Composable
fun AppUi(
    container: AppContainer,
    appVm: AppViewModel,
    platform: PlatformActions,
    music: MusicAccessState,
    openPlayerRequest: Boolean,
    onOpenPlayerHandled: () -> Unit,
) {
    val hasDownloads by appVm.hasDownloads.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val config by appVm.config.collectAsStateWithLifecycle()
    val online by appVm.online.collectAsStateWithLifecycle()
    val reports by appVm.reportMap.collectAsStateWithLifecycle()
    val pending by appVm.pendingDownloads.collectAsStateWithLifecycle()
    val nowPlaying by container.player.state.collectAsStateWithLifecycle()
    val reportDialog by appVm.reportDialog.collectAsStateWithLifecycle()
    val reportDetails by appVm.reportDetails.collectAsStateWithLifecycle()
    val savedCovers by container.covers.known.collectAsStateWithLifecycle()
    val update by appVm.update.collectAsStateWithLifecycle()
    var showPlayer by rememberSaveable { mutableStateOf(false) }
    var addingToPlaylist by remember { mutableStateOf<List<Song>?>(null) }
    // Signed out at the first start: Settings, where "Sign in" is (Back still goes to the Library).
    var routedAtStart by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (!routedAtStart) {
            routedAtStart = true
            if (!config.signedIn) nav.selectTab(Tab.SETTINGS)
        }
    }
    LaunchedEffect(openPlayerRequest) {
        if (openPlayerRequest) {
            if (!container.player.state.value.isEmpty) showPlayer = true
            onOpenPlayerHandled()
        }
    }
    LaunchedEffect(Unit) { container.messages.messages.collect { platform.toast(it) } }
    LaunchedEffect(Unit) { container.player.errors.collect { platform.toast(it) } }
    LaunchedEffect(Unit) {
        container.auth.events.collect { event ->
            when (event) {
                is AuthEvent.SignedIn -> {
                    nav.selectTab(Tab.LIBRARY)
                    platform.toast(event.name?.let { "Signed in as $it" } ?: "Signed in")
                }
                AuthEvent.SessionEnded -> platform.toast("Your session ended. Sign in again in Settings.")
            }
        }
    }
    if (nowPlaying.isEmpty && showPlayer) showPlayer = false

    val actions = remember {
        AppActions(
            play = { songs, index, context, shuffle ->
                when (val outcome = container.playLauncher.play(songs, index, context, shuffle)) {
                    is PlayOutcome.Nothing -> platform.toast(
                        if (outcome.offline) "Offline, and none of these songs are on this device"
                        else "Nothing to play — sign in first (Settings)"
                    )
                    is PlayOutcome.Started -> {
                        platform.askPermissions(false)
                        if (outcome.skipped > 0) {
                            platform.toast("Offline: playing the ${outcome.count} songs on this device, ${outcome.skipped} skipped")
                        }
                    }
                }
            },
            addToPlaylist = { songs -> addingToPlaylist = songs },
            beforeDownload = { platform.askPermissions(true) },
            queued = { n -> platform.toast(if (n == 1) "1 song queued" else "$n songs queued") },
            message = platform::toast,
            openSettings = { nav.selectTab(Tab.SETTINGS) },
            signIn = platform::signIn,
            openSource = platform::openSource,
            openExternal = platform::openExternal,
            deleteWithConsent = platform::deleteWithConsent,
            serverName = { container.settings.config.value.baseUrl.host },
        )
    }
    val reportActions = remember {
        ReportActions(
            mark = appVm::markBroken,
            edit = appVm::editReport,
            unmark = appVm::unmark,
            details = appVm::showReportDetails,
        )
    }

    val backStack by nav.currentBackStackEntryAsState()
    val selected = Tab.entries.firstOrNull { tab ->
        backStack?.destination?.hierarchy?.any { it.hasRoute(tab.route::class) } == true
    } ?: Tab.LIBRARY

    CompositionLocalProvider(
        LocalReports provides reports,
        LocalOnline provides online,
        LocalReportActions provides reportActions,
        LocalCovers provides CoverSource(savedCovers, container.covers::file),
        LocalMusicAccess provides MusicAccessUi(
            granted = music.granted,
            // Worth asking only when nothing is known to be here and a server can match files.
            offerPrompt = !music.granted && !music.promptDismissed && config.signedIn && !hasDownloads,
            request = music.request,
            dismiss = music.dismiss,
        ),
    ) {
        Box(Modifier.fillMaxSize()) {
            AppShell(
                selected = selected,
                onSelect = { nav.selectTab(it) },
                badge = { t -> if (t == Tab.DEVICE && pending > 0) "$pending" else null },
                notice = update?.let { u ->
                    {
                        UpdateBanner(u.version, onDownload = { platform.openUrl(u.downloadUrl) }, onLater = appVm::updateLater)
                    }
                },
                miniPlayer = if (!nowPlaying.isEmpty) {
                    { MiniPlayer(nowPlaying, container.player, onOpen = { showPlayer = true }) }
                } else null,
            ) {
                NavHost(nav, startDestination = LibraryRoute) {
                    composable<LibraryRoute> {
                        LibraryScreen(viewModel(factory = AppViewModels.library(container)), nowPlaying, actions)
                    }
                    navigation<PlaylistsGraph>(startDestination = PlaylistsRoute) {
                        composable<PlaylistsRoute> {
                            PlaylistsScreen(
                                viewModel(factory = AppViewModels.playlists(container)), online, nowPlaying, actions,
                                onOpenPlaylist = { id -> nav.navigate(PlaylistRoute(id)) },
                            )
                        }
                        composable<PlaylistRoute> { entry ->
                            val id = entry.toRoute<PlaylistRoute>().id
                            PlaylistScreen(
                                viewModel(factory = AppViewModels.playlist(container, id)), online, nowPlaying, actions,
                                onBack = { nav.popBackStack() },
                            )
                        }
                    }
                    composable<OnDeviceRoute> {
                        OnDeviceScreen(
                            viewModel(factory = AppViewModels.onDevice(container)), nowPlaying, actions, online,
                            onOpenPlaylist = { id ->
                                nav.selectTab(Tab.PLAYLISTS)
                                nav.navigate(PlaylistRoute(id))
                            },
                        )
                    }
                    composable<SettingsRoute> {
                        SettingsScreen(viewModel(factory = AppViewModels.settings(container)), actions)
                    }
                }
            }

            AnimatedVisibility(
                visible = showPlayer && !nowPlaying.isEmpty,
                enter = slideInVertically { it },
                exit = slideOutVertically { it },
            ) {
                BackHandler { showPlayer = false }
                FullPlayer(nowPlaying, container.player, onClose = { showPlayer = false })
            }
        }

        addingToPlaylist?.let { songs ->
            AddToPlaylistDialog(songs, viewModel(factory = AppViewModels.addToPlaylist(container)), onDismiss = { addingToPlaylist = null })
        }
        reportDialog?.let { d ->
            ReportDialog(
                song = d.song,
                current = d.current,
                busy = d.busy,
                error = d.error,
                onSubmit = appVm::submitReport,
                onDismiss = appVm::dismissReport,
            )
        }
        reportDetails?.let { (song, list) ->
            // Live: if a report is withdrawn while it is open, show what is left.
            ReportDetailsDialog(song, reports[song.id] ?: list, onDismiss = appVm::hideReportDetails)
        }
    }
}

/**
 * A bottom tab: its own back stack is kept (a playlist stays open when you
 * come back to Playlists), and Back from any tab returns to the Library.
 */
private fun NavHostController.selectTab(tab: Tab) {
    navigate(tab.route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
