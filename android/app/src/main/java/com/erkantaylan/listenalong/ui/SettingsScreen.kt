package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
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
import com.erkantaylan.listenalong.storage.MediaStoreAudio
import com.erkantaylan.listenalong.ui.theme.Night
import com.erkantaylan.listenalong.ui.theme.Palette
import com.erkantaylan.listenalong.ui.theme.Paper
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** One line of the connection check, good or bad. */
private data class CheckLine(val ok: Boolean, val text: String)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SettingsScreen(graph: AppGraph, snapshot: DownloadSnapshot, onMessage: (String) -> Unit) {
    val config by graph.settings.config.collectAsStateWithLifecycle()
    val dark by graph.settings.darkTheme.collectAsStateWithLifecycle()

    var url by rememberSaveable { mutableStateOf(config?.baseUrl?.let(ServerUrl::display).orEmpty()) }
    var token by rememberSaveable { mutableStateOf(config?.token.orEmpty()) }
    var checking by remember { mutableStateOf(false) }
    var lines by remember { mutableStateOf<List<CheckLine>>(emptyList()) }
    val scope = rememberCoroutineScope()

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
            try {
                val page = client.list(limit = 1)
                result += CheckLine(true, "Library reachable · ${page.total} songs")
            } catch (c: CancellationException) {
                throw c
            } catch (t: Throwable) {
                result += CheckLine(false, "Library: ${describe(t)}")
            }
            if (token.isNotBlank()) {
                try {
                    result += CheckLine(true, "Token belongs to ${client.me().name}")
                } catch (c: CancellationException) {
                    throw c
                } catch (t: Throwable) {
                    result += CheckLine(false,
                        if (t is ApiException && t.unauthorized) "Token rejected (${t.code})"
                        else "Token check failed: ${describe(t)}")
                }
            } else {
                result += CheckLine(true, "No token: library reads only")
            }
            lines = result
            checking = false
        }
    }

    Column(
        Modifier.fillMaxSize().background(Palette.bg).verticalScroll(rememberScrollState())
            .semantics { testTagsAsResourceId = true }
    ) {
        ScreenHeader("SETTINGS")

        SectionLabel("Server")
        Panel {
            FieldLabel("Address")
            TextInput(
                value = url, onValueChange = { url = it },
                placeholder = "https://listen.example.com", tag = "server-url",
                keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next,
            )
            FieldLabel("API token (optional)", Modifier.padding(top = 12.dp))
            TextInput(
                value = token, onValueChange = { token = it },
                placeholder = "Only needed if the server asks for one", tag = "api-token",
                secret = true, imeAction = ImeAction.Done, onSubmit = ::saveAndCheck,
            )
            Text(
                "Sent as \"Authorization: Bearer …\". Stored encrypted on this device. " +
                    "Browsing and downloading work without one.",
                color = Palette.textDim, fontSize = 12.sp, lineHeight = 17.sp,
                modifier = Modifier.padding(top = 8.dp),
            )
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HeaderAction(if (checking) "Checking…" else "Save and test", "save", enabled = !checking) {
                    saveAndCheck()
                }
            }
            lines.forEach { line ->
                Text(
                    (if (line.ok) "✓ " else "✗ ") + line.text,
                    color = if (line.ok) Palette.ok else Palette.danger,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }

        SectionLabel("On this device")
        Panel {
            Field("Songs saved", "${snapshot.downloaded.size}")
            Field("Space used", formatBytes(snapshot.downloaded.values.sumOf { it.bytes }))
            Field("Queued", "${snapshot.pending.size}")
            Field("Folder", MediaStoreAudio.RELATIVE_PATH)
            Box(Modifier.padding(top = 8.dp)) {
                HeaderAction("Forget files deleted elsewhere", "reconcile") {
                    scope.launch {
                        val gone = graph.downloads.reconcile()
                        onMessage(if (gone == 0) "Everything is still there" else "$gone forgotten")
                    }
                }
            }
        }

        SectionLabel("Appearance")
        Panel {
            ChipRow(listOf(true, false), dark, { if (it) "Night" else "Paper" }) { choice ->
                graph.settings.setDarkTheme(choice)
                Palette.scheme = if (choice) Night else Paper
            }
        }
        Box(Modifier.padding(bottom = 32.dp))
    }
}

@Composable
private fun FieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Palette.textDim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
         modifier = modifier.padding(bottom = 6.dp))
}

@Composable
private fun Field(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Palette.textDim, fontSize = 13.sp)
        Text(value, color = Palette.text, fontSize = 13.sp)
    }
}

private fun describe(t: Throwable): String = when (t) {
    is ApiException -> "${t.code} ${t.message}"
    else -> t.message ?: t::class.simpleName ?: "failed"
}
