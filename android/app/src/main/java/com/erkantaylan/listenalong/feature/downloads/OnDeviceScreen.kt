package com.erkantaylan.listenalong.feature.downloads

import com.erkantaylan.listenalong.core.model.formatBytes
import com.erkantaylan.listenalong.core.domain.toSong
import com.erkantaylan.listenalong.core.ui.AppActions
import com.erkantaylan.listenalong.core.designsystem.AppIcons
import com.erkantaylan.listenalong.core.designsystem.AppTopBar
import com.erkantaylan.listenalong.core.designsystem.ConfirmDialog
import com.erkantaylan.listenalong.core.designsystem.DangerButton
import com.erkantaylan.listenalong.core.designsystem.EmptyState
import com.erkantaylan.listenalong.core.designsystem.SectionHeading
import com.erkantaylan.listenalong.core.designsystem.TextInput
import com.erkantaylan.listenalong.core.ui.MenuEntry
import com.erkantaylan.listenalong.core.ui.MusicAccessOffNotice
import com.erkantaylan.listenalong.core.ui.MusicAccessPrompt
import com.erkantaylan.listenalong.core.ui.PlayAllBar
import com.erkantaylan.listenalong.core.ui.SongRow
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.player.NowPlaying
import com.erkantaylan.listenalong.core.storage.FileNames
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.core.storage.MediaStoreAudio
import com.erkantaylan.listenalong.core.designsystem.Palette
import kotlinx.coroutines.launch

@OptIn(ExperimentalComposeUiApi::class, ExperimentalMaterial3Api::class)
@Composable
fun OnDeviceScreen(
    viewModel: OnDeviceViewModel,
    nowPlaying: NowPlaying,
    actions: AppActions,
    online: Boolean,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var deleting by remember { mutableStateOf<LocalSong?>(null) }
    val snapshot = state.snapshot
    val query = state.query

    BackHandler(enabled = query.isNotEmpty()) { viewModel.onQueryChange("") }

    val songs = state.songs
    val asSongs = remember(songs) { state.asSongs }
    val totalBytes = state.totalBytes

    Column(Modifier.fillMaxSize().background(Palette.page).semantics { testTagsAsResourceId = true }) {
        AppTopBar(
            title = "On device",
            subtitle = {
                Text("${snapshot.downloaded.size} songs · ${formatBytes(totalBytes)}", color = Palette.fg3, fontSize = 12.sp)
            },
        )

        TextInput(
            value = query,
            onValueChange = viewModel::onQueryChange,
            placeholder = "Filter downloaded songs",
            tag = "filter",
            leadingIcon = AppIcons.Search,
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp),
        )

        MusicAccessPrompt(Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp))
        MusicAccessOffNotice(
            state.reclaimedCount,
            Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
        )

        PullToRefreshBox(
            isRefreshing = state.refreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                if (snapshot.pending.isNotEmpty()) {
                    item(key = "downloading-header") {
                        SectionHeading("Downloading — ${snapshot.pending.size}") {
                            DangerButton("Cancel all", viewModel::cancelAll, tag = "cancel-all", compact = true)
                        }
                    }
                    itemsIndexed(snapshot.pending, key = { _, s -> "q-${s.id}" }) { i, song ->
                        SongRow(
                            index = i, count = snapshot.pending.size, tag = "pending:${song.id}",
                            title = song.title.ifBlank { FileNames.baseName(song.artist, song.title) },
                            artist = song.artist, durationSec = song.durationSec,
                            download = snapshot.stateOf(song.id), current = false,
                            onClick = null,
                            onCancelDownload = { viewModel.cancel(song.id) },
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
                        reportSong = asSongs[i],
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
                viewModel.delete(song, actions.deleteWithConsent)
            },
            onDismiss = { deleting = null },
        )
    }
}
