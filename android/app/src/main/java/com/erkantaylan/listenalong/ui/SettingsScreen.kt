package com.erkantaylan.listenalong.ui

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
import com.erkantaylan.listenalong.AppGraph
import com.erkantaylan.listenalong.AppInfo
import com.erkantaylan.listenalong.BuildConfig
import com.erkantaylan.listenalong.R
import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.ServerUrl
import com.erkantaylan.listenalong.auth.SignInUi
import com.erkantaylan.listenalong.download.DownloadSnapshot
import com.erkantaylan.listenalong.settings.SettingsStore
import com.erkantaylan.listenalong.storage.MediaStoreAudio
import com.erkantaylan.listenalong.ui.theme.Palette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** One line of the connection check, good or bad. */
private data class CheckLine(val ok: Boolean, val text: String)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SettingsScreen(graph: AppGraph, snapshot: DownloadSnapshot, actions: AppActions) {
    val config by graph.settings.config.collectAsStateWithLifecycle()
    val overridden by graph.settings.overridden.collectAsStateWithLifecycle()
    val signIn by graph.auth.ui.collectAsStateWithLifecycle()

    var url by rememberSaveable { mutableStateOf(ServerUrl.display(config.baseUrl)) }
    var serverNote by remember { mutableStateOf<CheckLine?>(null) }
    var checking by remember { mutableStateOf(false) }
    var lines by remember { mutableStateOf<List<CheckLine>>(emptyList()) }
    val scope = rememberCoroutineScope()

    // The config can change under us (the debug override): show what is in force.
    LaunchedEffect(config.baseUrl) { url = ServerUrl.display(config.baseUrl) }
    LaunchedEffect(config.signedIn) { lines = emptyList() }

    fun saveServer() {
        val normalized = ServerUrl.normalize(url)
        if (normalized == null) {
            serverNote = CheckLine(false, "That is not a usable address.")
            return
        }
        url = ServerUrl.display(normalized)
        val wasSignedIn = config.signedIn
        val changed = graph.settings.saveServer(normalized)
        serverNote = CheckLine(true, if (changed && wasSignedIn) "Saved. Sign in again on this server." else "Saved.")
    }

    fun testConnection() {
        val client = graph.client()
        checking = true
        lines = emptyList()
        scope.launch {
            val result = mutableListOf<CheckLine>()
            try {
                val me = client.me()
                val status = me.user?.status
                result += CheckLine(status != "pending",
                    "Signed in as ${me.name.ifBlank { "your account" }}" +
                        if (status == "pending") " (waiting for approval)" else "")
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                result += CheckLine(false,
                    if (t is ApiException && t.sessionEnded) "The session has ended: sign in again"
                    else "Account check failed: ${describe(t)}")
            }
            try {
                val page = client.list(limit = 1)
                result += CheckLine(true, "Library reachable · ${page.total} songs")
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                result += CheckLine(false, "Library: ${describe(t)}")
            }
            lines = result
            checking = false
        }
    }

    Column(
        Modifier.fillMaxSize().background(Palette.page).semantics { testTagsAsResourceId = true }
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
                        SecondaryButton(if (checking) "Testing…" else "Test connection", ::testConnection,
                                        enabled = !checking, tag = "test-connection")
                        SecondaryButton("Sign out", graph.auth::signOut, outlined = true, tag = "sign-out")
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
                                SecondaryButton("Cancel", graph.auth::cancel, outlined = true, tag = "sign-in-cancel")
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
                    SecondaryButton("Find songs already in the folder", {
                        scope.launch {
                            val found = graph.downloads.reclaim(force = true)
                            actions.message(if (found == 0) "No new songs found in the folder" else "$found songs found in the folder")
                        }
                    }, tag = "reclaim")
                }
                Box(Modifier.padding(top = 8.dp)) {
                    SecondaryButton("Forget files deleted elsewhere", {
                        scope.launch {
                            val gone = graph.downloads.reconcile()
                            actions.message(if (gone == 0) "Everything is still there" else "$gone forgotten")
                        }
                    }, tag = "reconcile")
                }
            }

            Spacer(Modifier.height(12.dp))
            Card(title = stringResource(R.string.about_title)) {
                Field(stringResource(R.string.about_version), AppInfo.versionLabel(BuildConfig.VERSION_NAME))
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

private fun describe(t: Throwable): String = when (t) {
    is ApiException -> "${t.code} ${t.message}"
    else -> t.message ?: t::class.simpleName ?: "failed"
}
