package com.erkantaylan.listenalong.ui

import android.content.ClipboardManager
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.erkantaylan.listenalong.AppGraph
import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.ServerUrl
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
    val context = LocalContext.current

    var url by rememberSaveable { mutableStateOf(ServerUrl.display(config.baseUrl)) }
    var token by rememberSaveable { mutableStateOf(config.token.orEmpty()) }
    var checking by remember { mutableStateOf(false) }
    var lines by remember { mutableStateOf<List<CheckLine>>(emptyList()) }
    val scope = rememberCoroutineScope()

    // The config can change under us (the debug override): show what is in force.
    LaunchedEffect(config) {
        url = ServerUrl.display(config.baseUrl)
        token = config.token.orEmpty()
    }

    fun saveAndCheck() {
        val normalized = ServerUrl.normalize(url)
        if (normalized == null) {
            lines = listOf(CheckLine(false, "That is not a usable address."))
            return
        }
        url = ServerUrl.display(normalized)
        graph.settings.save(normalized, token)
        val client = LibraryClient(normalized, token.trim().ifEmpty { null })
        checking = true
        lines = emptyList()
        scope.launch {
            val result = mutableListOf<CheckLine>()
            if (token.isNotBlank()) {
                try {
                    result += CheckLine(true, "Signed in as ${client.me().name}")
                } catch (c: CancellationException) {
                    throw c
                } catch (t: Throwable) {
                    result += CheckLine(false,
                        if (t is ApiException && t.unauthorized) "Token rejected (${t.code}) — create a new one on your profile"
                        else "Token check failed: ${describe(t)}")
                }
            } else {
                result += CheckLine(false, "No token: the library and playlists need one")
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
                        "Your saved server is unchanged; restart the app to go back to it.",
                    AlertKind.WARNING, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                )
            }

            if (!config.hasToken) {
                Card(Modifier.padding(bottom = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(AppIcons.Lock, contentDescription = null, tint = Palette.accentFg, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Connect your account", color = Palette.fg, fontSize = 16.sp)
                    }
                    Text(
                        "1. Open your profile at ${config.baseUrl.host} and create a token under \"CLI tokens\".\n" +
                            "2. Copy it, come back, and paste it below.\n3. Tap Save and test.",
                        color = Palette.fg2, fontSize = 14.sp, lineHeight = 21.sp,
                        modifier = Modifier.padding(top = 8.dp, bottom = 12.dp),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton("Open my profile", actions.openProfile, icon = AppIcons.OpenInNew, tag = "open-profile")
                    }
                }
            }

            Card(title = "Server") {
                FieldLabel("Address")
                TextInput(
                    value = url, onValueChange = { url = it },
                    placeholder = SettingsStore.DEFAULT_SERVER, tag = "server-url",
                    keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next,
                )
                FieldLabel("API token", Modifier.padding(top = 14.dp))
                TextInput(
                    value = token, onValueChange = { token = it },
                    placeholder = "Paste the token from your profile", tag = "api-token",
                    secret = true, imeAction = ImeAction.Done, onSubmit = ::saveAndCheck,
                    trailing = {
                        SecondaryButton("Paste", {
                            val clip = context.getSystemService(ClipboardManager::class.java)
                            val text = clip?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
                                ?.coerceToText(context)?.toString()?.trim()
                            if (text.isNullOrEmpty()) actions.message("The clipboard is empty") else token = text
                        }, tag = "paste-token", compact = true, modifier = Modifier.padding(end = 4.dp))
                    },
                )
                Text(
                    "Sent as \"Authorization: Bearer …\" and stored encrypted on this device. " +
                        "Create or revoke tokens on your profile page.",
                    color = Palette.fg3, fontSize = 12.sp, lineHeight = 17.sp,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    PrimaryButton(if (checking) "Checking…" else "Save and test", ::saveAndCheck,
                                  enabled = !checking, tag = "save")
                    if (config.hasToken) SecondaryButton("Profile", actions.openProfile, icon = AppIcons.OpenInNew,
                                                         tag = "open-profile-small", outlined = true)
                }
                lines.forEach { line ->
                    Text(
                        (if (line.ok) "✓ " else "✗ ") + line.text,
                        color = if (line.ok) Palette.success else Palette.danger,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(top = 8.dp).testTag(if (line.ok) "check-ok" else "check-fail"),
                    )
                }
            }

            Spacer(Modifier.height(12.dp))
            Card(title = "On this device") {
                Field("Songs saved", "${snapshot.downloaded.size}")
                Field("Space used", formatBytes(snapshot.downloaded.values.sumOf { it.bytes }))
                Field("Queued", "${snapshot.pending.size}")
                Field("Folder", MediaStoreAudio.RELATIVE_PATH)
                Box(Modifier.padding(top = 8.dp)) {
                    SecondaryButton("Forget files deleted elsewhere", {
                        scope.launch {
                            val gone = graph.downloads.reconcile()
                            actions.message(if (gone == 0) "Everything is still there" else "$gone forgotten")
                        }
                    }, tag = "reconcile")
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
