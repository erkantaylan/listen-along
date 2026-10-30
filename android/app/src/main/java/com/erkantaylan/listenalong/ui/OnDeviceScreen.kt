package com.erkantaylan.listenalong.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.download.DownloadSnapshot
import com.erkantaylan.listenalong.download.Downloads
import com.erkantaylan.listenalong.player.NowPlaying
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
    nowPlaying: NowPlaying,
    actions: AppActions,
    online: Boolean,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<LocalSong?>(null) }
    val scope = rememberCoroutineScope()

    BackHandler(enabled = query.isNotEmpty()) { query = "" }

    val songs = remember(snapshot.downloaded, query) { sortedForDevice(snapshot.downloaded.values, query) }
    val asSongs = remember(songs) { songs.map { it.toSong() } }
    val totalBytes = snapshot.downloaded.values.sumOf { it.bytes }

    Column(Modifier.fillMaxSize().background(Palette.page).semantics { testTagsAsResourceId = true }) {
        AppTopBar(
            title = "On device",
            subtitle = {
                Text("${snapshot.downloaded.size} songs · ${formatBytes(totalBytes)}", color = Palette.fg3, fontSize = 12.sp)
            },
        )

        TextInput(
            value = query,
            onValueChange = { query = it },
            placeholder = "Filter downloaded songs",
            tag = "filter",
            leadingIcon = AppIcons.Search,
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp),
        )

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch {
                    val gone = downloads.reconcile()
                    refreshing = false
                    if (gone > 0) actions.message("$gone deleted outside the app — forgotten")
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                if (snapshot.pending.isNotEmpty()) {
                    item(key = "downloading-header") {
                        SectionHeading("Downloading — ${snapshot.pending.size}") {
                            QuietButton("Cancel all", { downloads.cancelAll() }, accent = false, tag = "cancel-all")
                        }
                    }
                    itemsIndexed(snapshot.pending, key = { _, s -> "q-${s.id}" }) { i, song ->
                        SongRow(
                            index = i, count = snapshot.pending.size, tag = "pending:${song.id}",
                            title = song.title.ifBlank { FileNames.baseName(song.artist, song.title) },
                            artist = song.artist, durationSec = song.durationSec,
                            download = snapshot.stateOf(song.id), current = false,
                            onClick = null,
                            onCancelDownload = { downloads.cancel(song.id) },
                        )
                    }
                    item(key = "saved-header") { SectionHeading("Saved — ${snapshot.downloaded.size}") }
                }

                if (songs.isEmpty()) {
                    item(key = "empty") {
                        EmptyState(
                            title = if (query.isNotBlank()) "Nothing matches." else "Nothing downloaded yet",
                            body = if (query.isNotBlank()) null
                                   else "Use the download button on a song or a playlist. Downloaded songs play with no connection.",
                            icon = if (query.isNotBlank()) AppIcons.Search else AppIcons.Download,
                        )
                    }
                } else {
                    item(key = "play-all") {
                        PlayAllBar(
                            playEnabled = true,
                            onPlay = { actions.play(asSongs, 0, "On device", false) },
                            onShuffle = { actions.play(asSongs, 0, "On device", true) },
                        )
                    }
                }
                itemsIndexed(songs, key = { _, s -> s.songId }) { i, song ->
                    SongRow(
                        index = i, count = songs.size, tag = "local:${song.songId}",
                        title = song.title.ifBlank { song.displayName },
                        artist = song.artist,
                        durationSec = song.durationSec,
                        download = null,
                        current = nowPlaying.songId == song.songId,
                        extraMeta = "${song.displayName.substringAfterLast('.', "").uppercase()} · ${formatBytes(song.bytes)}",
                        onClick = { actions.play(asSongs, i, "On device", false) },
                    ) { dismiss ->
                        MenuEntry("Add to playlist", AppIcons.PlaylistAdd, "menu-add-to-playlist", enabled = online) {
                            dismiss(); actions.addToPlaylist(listOf(song.toSong()))
                        }
                        MenuEntry("Open in another app", AppIcons.OpenInNew, "menu-open") {
                            dismiss(); actions.openExternal(song)
                        }
                        MenuEntry("Delete from device", AppIcons.Delete, "menu-delete", destructive = true) {
                            dismiss(); deleting = song
                        }
                    }
                }
                if (songs.isNotEmpty()) {
                    item(key = "where") {
                        Text(
                            "Saved as plain audio files in ${MediaStoreAudio.RELATIVE_PATH}",
                            color = Palette.fg4, fontSize = 12.sp, textAlign = TextAlign.Center,
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
                    actions.message(if (removed) "Deleted" else "Forgotten (the file could not be deleted by this app)")
                }
            },
            onDismiss = { deleting = null },
        )
    }
}

fun formatBytes(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> String.format(java.util.Locale.US, "%.0f KB", bytes / 1024.0)
    bytes < 1024L * 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
    else -> String.format(java.util.Locale.US, "%.2f GB", bytes / 1024.0 / 1024.0 / 1024.0)
}
