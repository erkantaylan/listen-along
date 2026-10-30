package com.erkantaylan.listenalong

import android.Manifest
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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.erkantaylan.listenalong.open.ExternalPlayer
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.ui.AppShell
import com.erkantaylan.listenalong.ui.LibraryScreen
import com.erkantaylan.listenalong.ui.LibraryViewModel
import com.erkantaylan.listenalong.ui.OnDeviceScreen
import com.erkantaylan.listenalong.ui.SettingsScreen
import com.erkantaylan.listenalong.ui.Tab
import com.erkantaylan.listenalong.ui.theme.ListenAlongTheme
import com.erkantaylan.listenalong.ui.theme.Night
import com.erkantaylan.listenalong.ui.theme.Palette
import com.erkantaylan.listenalong.ui.theme.Paper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val graph = (application as ListenAlongApp).graph
        // Before the first frame, so the app never flashes the other theme.
        Palette.scheme = if (graph.settings.darkTheme.value) Night else Paper

        setContent {
            ListenAlongTheme {
                // Insets handled once, here, as in kitaplik: every screen draws
                // inside the safe area and the tab bar sits above the system
                // navigation buttons.
                Box(Modifier.fillMaxSize().background(Palette.bg).safeDrawingPadding()) {
                    val scope = rememberCoroutineScope()
                    val firstTab = if (graph.settings.config.value == null) Tab.SETTINGS else Tab.LIBRARY
                    var tab by rememberSaveable { mutableStateOf(firstTab) }
                    val snapshot by graph.downloads.snapshots
                        .collectAsStateWithLifecycle(graph.downloads.snapshot())
                    val libraryVm: LibraryViewModel = viewModel(
                        factory = viewModelFactory { initializer { LibraryViewModel(graph) } },
                    )

                    // Files deleted in a file manager or another player while
                    // we were away disappear from On device on return.
                    LifecycleResumeEffect(Unit) {
                        scope.launch { graph.downloads.reconcile() }
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
                    // Asked for the first time a download starts, not at
                    // launch: notifications to show progress, and storage on
                    // Android 9 and older, which has no MediaStore RELATIVE_PATH.
                    val beforeDownload: () -> Unit = {
                        val wanted = buildList {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                add(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                                add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            }
                        }.filter {
                            ContextCompat.checkSelfPermission(this@MainActivity, it) !=
                                PackageManager.PERMISSION_GRANTED
                        }
                        if (wanted.isNotEmpty() && !askedPermissions) {
                            askedPermissions = true
                            permissionLauncher.launch(wanted.toTypedArray())
                        }
                    }

                    val open: (LocalSong) -> Unit = { song ->
                        scope.launch {
                            val present = withContext(Dispatchers.IO) {
                                runCatching { graph.sink.exists(song.uri) }.getOrDefault(true)
                            }
                            if (!present) {
                                graph.index.remove(song.songId)
                                toast("That file was deleted outside the app; tap it in Library to get it again")
                                return@launch
                            }
                            val result = ExternalPlayer.open(this@MainActivity, song)
                            if (result is ExternalPlayer.Result.NoHandler) {
                                toast("No app installed that plays ${result.mimeType}")
                            }
                        }
                    }

                    BackHandler(enabled = tab != Tab.LIBRARY) { tab = Tab.LIBRARY }

                    AppShell(
                        selected = tab,
                        onSelect = { tab = it },
                        badge = { t ->
                            if (t == Tab.DEVICE && snapshot.pending.isNotEmpty()) "${snapshot.pending.size}" else null
                        },
                    ) {
                        when (tab) {
                            Tab.LIBRARY -> LibraryScreen(
                                viewModel = libraryVm,
                                onOpen = open,
                                onBeforeDownload = beforeDownload,
                                onQueued = { n -> toast(if (n == 1) "1 song queued" else "$n songs queued") },
                                onGoToSettings = { tab = Tab.SETTINGS },
                            )
                            Tab.DEVICE -> OnDeviceScreen(
                                snapshot = snapshot,
                                downloads = graph.downloads,
                                onOpen = open,
                                onMessage = ::toast,
                            )
                            Tab.SETTINGS -> SettingsScreen(graph, snapshot, onMessage = ::toast)
                        }
                    }
                }
            }
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
}
