package com.erkantaylan.listenalong.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.api.formatDuration
import com.erkantaylan.listenalong.download.DownloadSnapshot
import com.erkantaylan.listenalong.download.Downloads
import com.erkantaylan.listenalong.download.QueuedSong
import com.erkantaylan.listenalong.storage.FileNames
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.storage.MediaStoreAudio
import com.erkantaylan.listenalong.ui.theme.Palette
import kotlinx.coroutines.launch

/** Downloaded songs, newest first is not useful for music: artist, then title. */
internal fun sortedForDevice(songs: Collection<LocalSong>, query: String): List<LocalSong> {
    val needle = query.trim().lowercase()
    return songs
        .filter {
            needle.isEmpty() || it.title.lowercase().contains(needle) ||
                it.artist.lowercase().contains(needle) || it.displayName.lowercase().contains(needle)
        }
        .sortedWith(compareBy<LocalSong>({ it.artist.lowercase() }, { it.title.lowercase() }))
}

@OptIn(ExperimentalComposeUiApi::class, ExperimentalMaterial3Api::class)
@Composable
fun OnDeviceScreen(
    snapshot: DownloadSnapshot,
    downloads: Downloads,
    onOpen: (LocalSong) -> Unit,
    onMessage: (String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<LocalSong?>(null) }
    val scope = rememberCoroutineScope()

    BackHandler(enabled = query.isNotEmpty()) { query = "" }

    val songs = remember(snapshot.downloaded, query) { sortedForDevice(snapshot.downloaded.values, query) }
    val totalBytes = snapshot.downloaded.values.sumOf { it.bytes }

    Column(Modifier.fillMaxSize().background(Palette.bg).semantics { testTagsAsResourceId = true }) {
        ScreenHeader("ON DEVICE") {
            Text(
                "${snapshot.downloaded.size} · ${formatBytes(totalBytes)}",
                color = Palette.textDim, fontSize = 12.sp,
            )
        }

        TextInput(
            value = query,
            onValueChange = { query = it },
            placeholder = "Filter downloaded songs",
            tag = "filter",
            modifier = Modifier.padding(horizontal = 16.dp).padding(bottom = 10.dp),
        )

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    val gone = downloads.reconcile()
                    refreshing = false
                    if (gone > 0) onMessage("$gone deleted outside the app — forgotten")
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
                if (snapshot.pending.isNotEmpty()) {
                    item(key = "downloading-header") {
                        Row(
                            Modifier.fillMaxWidth().padding(end = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) { SectionLabel("Downloading · ${snapshot.pending.size}") }
                            HeaderAction("Cancel all", "cancel-all") { downloads.cancelAll() }
                        }
                    }
                    items(snapshot.pending, key = { "q-${it.id}" }) { song ->
                        PendingRow(song, snapshot) { downloads.cancel(song.id) }
                    }
                    item(key = "saved-header") { SectionLabel("Saved") }
                }

                if (songs.isEmpty()) {
                    item(key = "empty") {
                        Text(
                            when {
                                query.isNotBlank() -> "Nothing matches."
                                else -> "Nothing downloaded yet.\nTap a song in Library to save it here."
                            },
                            color = Palette.textDim, fontSize = 13.sp, textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(32.dp),
                        )
                    }
                }
                items(songs, key = { it.songId }) { song ->
                    LocalRow(song, onTap = { onOpen(song) }, onLongPress = { deleting = song })
                }
                if (songs.isNotEmpty()) {
                    item(key = "where") {
                        Text(
                            "Saved in ${MediaStoreAudio.RELATIVE_PATH} · long-press to delete",
                            color = Palette.textDim, fontSize = 11.sp, textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(16.dp),
                        )
                    }
                }
            }
        }
    }

    deleting?.let { song ->
        ConfirmDialog(
            title = "Delete from the device?",
            text = "\"${song.displayName}\" will be deleted from ${MediaStoreAudio.RELATIVE_PATH}. " +
                "It stays in the library and can be downloaded again.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = null
                scope.launch {
                    val removed = downloads.delete(song)
                    onMessage(if (removed) "Deleted" else "Forgotten (the file could not be deleted by this app)")
                }
            },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun PendingRow(song: QueuedSong, snapshot: DownloadSnapshot, onCancel: () -> Unit) {
    val progress = snapshot.progress[song.id]
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.panel)
            .border(1.dp, Palette.border, RoundedCornerShape(10.dp))
            .combinedClickable(onClick = onCancel)
            .padding(12.dp),
    ) {
        Text(FileNames.baseName(song.artist, song.title), color = Palette.text, fontSize = 14.sp,
             maxLines = 2, overflow = TextOverflow.Ellipsis)
        val label = when {
            progress == null -> "queued · tap to cancel"
            progress.total > 0 -> "${progress.bytesRead * 100 / progress.total}% of " +
                "${formatBytes(progress.total)} · tap to cancel"
            else -> "${formatBytes(progress.bytesRead)} · tap to cancel"
        }
        Text(label, color = Palette.accent, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
        if (progress != null) {
            val mod = Modifier.fillMaxWidth().padding(top = 6.dp)
            if (progress.total > 0) {
                LinearProgressIndicator(
                    progress = { (progress.bytesRead.toFloat() / progress.total).coerceIn(0f, 1f) },
                    color = Palette.accent, trackColor = Palette.panel2,
                    drawStopIndicator = {}, gapSize = 0.dp, modifier = mod,
                )
            } else {
                LinearProgressIndicator(color = Palette.accent, trackColor = Palette.panel2, modifier = mod)
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LocalRow(song: LocalSong, onTap: () -> Unit, onLongPress: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 8.dp)
            .testTag("local:${song.songId}")
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.panel)
            .border(1.dp, Palette.border, RoundedCornerShape(10.dp))
            .combinedClickable(onClick = onTap, onLongClick = onLongPress)
            .padding(12.dp),
    ) {
        Text(song.title.ifBlank { song.displayName }, color = Palette.text, fontSize = 15.sp, lineHeight = 21.sp)
        if (song.artist.isNotBlank()) {
            Text(song.artist, color = Palette.textDim, fontSize = 13.sp, modifier = Modifier.padding(top = 2.dp))
        }
        Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            val ext = song.displayName.substringAfterLast('.', "").uppercase()
            Text(ext, color = Palette.ok, fontSize = 11.sp)
            formatDuration(song.durationSec).takeIf { it.isNotEmpty() }?.let {
                MetaSeparator(); Text(it, color = Palette.textDim, fontSize = 11.sp)
            }
            MetaSeparator()
            Text(formatBytes(song.bytes), color = Palette.textDim, fontSize = 11.sp)
            MetaSeparator()
            Text("tap to play", color = Palette.ok, fontSize = 11.sp)
        }
    }
}

fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(java.util.Locale.US, "%.0f KB", bytes / 1024.0)
    bytes < 1024L * 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
    else -> String.format(java.util.Locale.US, "%.2f GB", bytes / 1024.0 / 1024.0 / 1024.0)
}
