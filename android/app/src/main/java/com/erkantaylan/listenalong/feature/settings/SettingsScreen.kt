package com.erkantaylan.listenalong.feature.settings

import com.erkantaylan.listenalong.core.data.UpdateCheck
import com.erkantaylan.listenalong.core.designsystem.SwitchRow
import com.erkantaylan.listenalong.core.designsystem.Alert
import com.erkantaylan.listenalong.core.designsystem.AlertKind
import com.erkantaylan.listenalong.core.designsystem.AppIcons
import com.erkantaylan.listenalong.core.designsystem.AppTopBar
import com.erkantaylan.listenalong.core.designsystem.Card
import com.erkantaylan.listenalong.core.designsystem.FieldLabel
import com.erkantaylan.listenalong.core.ui.LocalMusicAccess
import com.erkantaylan.listenalong.core.designsystem.PrimaryButton
import com.erkantaylan.listenalong.core.designsystem.SecondaryButton
import com.erkantaylan.listenalong.core.designsystem.TextInput
import com.erkantaylan.listenalong.core.model.formatBytes
import com.erkantaylan.listenalong.core.ui.AppActions
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.erkantaylan.listenalong.app.AppInfo
import com.erkantaylan.listenalong.BuildConfig
import com.erkantaylan.listenalong.R
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.ServerUrl
import com.erkantaylan.listenalong.core.auth.SignInUi
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.data.SettingsStore
import com.erkantaylan.listenalong.core.storage.MediaStoreAudio
import com.erkantaylan.listenalong.core.designsystem.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SettingsScreen(viewModel: SettingsViewModel, actions: AppActions) {
    val config by viewModel.config.collectAsStateWithLifecycle()
    val overridden by viewModel.overridden.collectAsStateWithLifecycle()
    val signIn by viewModel.signIn.collectAsStateWithLifecycle()
    val snapshot by viewModel.storage.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val serverNote by viewModel.serverNote.collectAsStateWithLifecycle()
    val sync by viewModel.sync.collectAsStateWithLifecycle()
    val checking = connection.checking
    val lines = connection.lines

    var url by rememberSaveable { mutableStateOf(ServerUrl.display(config.baseUrl)) }

    // The config can change under us (the debug override): show what is in force.
    LaunchedEffect(config.baseUrl) { url = ServerUrl.display(config.baseUrl) }

    fun saveServer() {
        viewModel.saveServer(url)?.let { url = it }
    }

    Column(
        Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }
    ) {
        AppTopBar("Settings")
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 12.dp)) {
            if (overridden) {
                Alert(
                    "Debug: this session uses ${ServerUrl.display(config.baseUrl)} (from dev.sh). " +
                        "Your saved server and sign-in are unchanged; restart the app to go back to them.",
                    AlertKind.WARNING, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                )
            }

            Card(title = "Account") {
                val idle = signIn as? SignInUi.Idle
                if (config.signedIn) {
                    Text("Signed in as ${config.userName ?: "your account"}", color = Palette.fg, fontSize = 16.sp,
                         modifier = Modifier.testTag("signed-in-as"))
                    Text(
                        "On ${config.baseUrl.host}. The app keeps only a session of its own, stored encrypted on " +
                            "this device; it ends when you sign out, after 30 days, or when the server ends it.",
                        color = Palette.fg3, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.padding(top = 4.dp),
                    )
                    idle?.message?.let {
                        Alert(it, if (idle.error) AlertKind.DANGER else AlertKind.INFO, Modifier.padding(top = 10.dp))
                    }
                    Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        SecondaryButton(if (checking) "Testing…" else "Test connection", viewModel::testConnection,
                                        enabled = !checking, tag = "test-connection")
                        SecondaryButton("Sign out", viewModel::signOut, outlined = true, tag = "sign-out")
                    }
                    lines.forEach { line ->
                        Text(
                            (if (line.ok) "✓ " else "✗ ") + line.text,
                            color = if (line.ok) Palette.success else Palette.danger,
                            fontSize = 14.sp,
                            modifier = Modifier.padding(top = 8.dp).testTag(if (line.ok) "check-ok" else "check-fail"),
                        )
                    }
                } else {
                    Text(
                        "Sign in with your listen-along account. The sign-in page of ${config.baseUrl.host} opens " +
                            "in the browser and sends you back here.",
                        color = Palette.fg2, fontSize = 14.sp, lineHeight = 21.sp,
                    )
                    idle?.message?.let {
                        Alert(it, if (idle.error) AlertKind.DANGER else AlertKind.INFO, Modifier.padding(top = 10.dp))
                    }
                    Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        when (signIn) {
                            SignInUi.InBrowser -> {
                                PrimaryButton("Waiting for the browser…", {}, enabled = false, tag = "sign-in")
                                SecondaryButton("Cancel", viewModel::cancelSignIn, outlined = true, tag = "sign-in-cancel")
                            }
                            SignInUi.Exchanging -> PrimaryButton("Signing in…", {}, enabled = false, tag = "sign-in")
                            is SignInUi.Idle -> PrimaryButton("Sign in", actions.signIn, icon = AppIcons.Lock, tag = "sign-in")
                        }
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            Card(title = "Server") {
                FieldLabel("Address")
                TextInput(
                    value = url, onValueChange = { url = it },
                    placeholder = SettingsStore.DEFAULT_SERVER, tag = "server-url",
                    keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done, onSubmit = ::saveServer,
                )
                Text(
                    "A sign-in belongs to its server: another address needs signing in again.",
                    color = Palette.fg3, fontSize = 12.sp, lineHeight = 17.sp,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    SecondaryButton("Save", ::saveServer, tag = "save-server")
                }
                serverNote?.let { line ->
                    Text(
                        (if (line.ok) "✓ " else "✗ ") + line.text,
                        color = if (line.ok) Palette.success else Palette.danger,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }

            Spacer(Modifier.height(12.dp))
            Card(title = "Downloaded playlists") {
                Text(
                    "Turn Download on for a playlist (on its page) to keep all its songs on this phone. " +
                        "Songs added to it later, by anyone, download by themselves: when the app opens, when you " +
                        "refresh, when the connection returns, and every 6 hours in the background.",
                    color = Palette.fg3, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.padding(bottom = 6.dp),
                )
                SwitchRow(
                    "Download over mobile data",
                    if (sync.allowMetered) "On: playlists also download on mobile data (never while roaming or with Data Saver on)."
                    else "Off: playlists download on Wi-Fi only. Songs you download yourself still use any connection.",
                    sync.allowMetered, viewModel::setAllowMetered, tag = "setting-mobile-data",
                )
                SwitchRow(
                    "Remove downloads of songs removed from a playlist",
                    if (sync.removeUnlisted) "On: when a song leaves a downloaded playlist, its file is removed too — only if the app " +
                        "downloaded it for that playlist, no other downloaded playlist holds it, and you did not download it yourself. " +
                        "A playlist that suddenly loses more than half of its songs waits a day first."
                    else "Off: songs removed from a playlist stay on this phone.",
                    sync.removeUnlisted, viewModel::setRemoveUnlisted, tag = "setting-remove-unlisted",
                )
            }

            Spacer(Modifier.height(12.dp))
            Card(title = "On this device") {
                Field("Songs saved", "${snapshot.downloaded.size}")
                Field("Space used", formatBytes(snapshot.downloaded.values.sumOf { it.bytes }))
                Field("Queued", "${snapshot.pending.size}")
                Field("Folder", MediaStoreAudio.RELATIVE_PATH)
                val access = LocalMusicAccess.current
                Field("Music access", if (access.granted) "On" else "Off")
                if (!access.granted) {
                    Text(
                        "Needed to recognise songs an earlier install left in the folder.",
                        color = Palette.fg3, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp),
                    )
                    Box(Modifier.padding(top = 8.dp)) {
                        SecondaryButton("Allow music access", access.request, tag = "music-access")
                    }
                }
                Box(Modifier.padding(top = 8.dp)) {
                    SecondaryButton("Find songs already in the folder", viewModel::findInFolder, tag = "reclaim")
                }
                Box(Modifier.padding(top = 8.dp)) {
                    SecondaryButton("Forget files deleted elsewhere", viewModel::forgetDeleted, tag = "reconcile")
                }
            }

            Spacer(Modifier.height(12.dp))
            Card(title = stringResource(R.string.about_title)) {
                Field(stringResource(R.string.about_version), AppInfo.versionLabel(BuildConfig.VERSION_NAME))
                val check by viewModel.updateCheck.collectAsStateWithLifecycle()
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    SecondaryButton(
                        if (check == UpdateCheckUi.Checking) "Checking…" else "Check for updates",
                        viewModel::checkForUpdates, enabled = check != UpdateCheckUi.Checking, tag = "check-updates",
                    )
                }
                (check as? UpdateCheckUi.Done)?.result?.let { r ->
                    Text(
                        when (r) {
                            UpdateCheck.UpToDate -> "You're up to date."
                            is UpdateCheck.Available -> "Version ${r.notice.version} is available: see the notice at the top."
                            UpdateCheck.Failed -> "Couldn't check right now. Try again when you're online."
                        },
                        color = when (r) {
                            UpdateCheck.UpToDate -> Palette.success
                            is UpdateCheck.Available -> Palette.accentFg
                            UpdateCheck.Failed -> Palette.fg3
                        },
                        fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp).testTag("update-result"),
                    )
                }
                Box(Modifier.padding(top = 8.dp)) {
                    SecondaryButton(stringResource(R.string.about_source), actions.openSource,
                                    icon = AppIcons.GitHub, tag = "open-source")
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Field(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Palette.fg3, fontSize = 14.sp)
        Text(value, color = Palette.fg, fontSize = 14.sp)
    }
}
