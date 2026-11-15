package com.erkantaylan.listenalong.feature.downloads

import com.erkantaylan.listenalong.core.designsystem.IconAction
import com.erkantaylan.listenalong.core.designsystem.CardShape
import com.erkantaylan.listenalong.core.designsystem.CoverTile
import com.erkantaylan.listenalong.core.designsystem.Dimens
import com.erkantaylan.listenalong.core.designsystem.QuietButton
import com.erkantaylan.listenalong.core.designsystem.SecondaryButton
import com.erkantaylan.listenalong.core.designsystem.dialogEdge
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.ui.PlaylistDownloadLine
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
    onOpenPlaylist: (String) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var deleting by remember { mutableStateOf<LocalSong?>(null) }
    var forgetting by remember { mutableStateOf<DeviceListPlaylist?>(null) }
    val snapshot = state.snapshot
    val query = state.query

    BackHandler(enabled = query.isNotEmpty()) { viewModel.onQueryChange("") }

    val songs = state.songs
    val asSongs = remember(songs) { state.asSongs }
    val totalBytes = state.totalBytes

    Column(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        AppTopBar(
            title = "On device",
            subtitle = {
                Text("${snapshot.downloaded.size} songs · ${formatBytes(totalBytes)}", color = Palette.fg3, fontSize = 12.sp)
            },
        )

        TextInput(
            value = query,
            onValueChange = viewModel::onQueryChange,
            placeholder = "Filter downloads",
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
                }

                // Downloaded playlists first, as Spotify's Downloaded shelf; then the songs downloaded on their own.
                if (state.playlists.isNotEmpty()) {
                    item(key = "playlists-header") { SectionHeading("Downloaded playlists — ${state.playlists.size}") }
                    items(state.playlists, key = { "p-${it.id}" }) { p ->
                        DevicePlaylistRow(
                            p,
                            onOpen = { if (p.status !is PlaylistDownloadStatus.Unavailable) onOpenPlaylist(p.id) else forgetting = p },
                            onForget = { forgetting = p },
                        )
                    }
                    item(key = "songs-header") {
                        SectionHeading(if (songs.isEmpty()) "Songs" else "Songs — ${songs.size}")
                    }
                }

                if (songs.isEmpty() && state.playlists.isEmpty()) {
                    item(key = "empty") {
                        EmptyState(
                            title = if (query.isNotBlank()) "Nothing matches." else "Nothing downloaded yet",
                            body = if (query.isNotBlank()) null
                                   else "Use the download button on a song or a playlist. Downloaded songs play with no connection.",
                            icon = if (query.isNotBlank()) AppIcons.Search else AppIcons.Download,
                        )
                    }
                } else if (state.allSongs.isNotEmpty()) {
                    item(key = "play-all") {
                        // Play / Shuffle everything on the phone, playlists' songs included.
                        val all = state.allAsSongs
                        PlayAllBar(
                            playEnabled = true,
                            onPlay = { actions.play(all, 0, "On device", false) },
                            onShuffle = { actions.play(all, 0, "On device", true) },
                        ) {
                            Text("${all.size} songs", color = Palette.fg3, fontSize = 12.sp, modifier = Modifier.padding(end = 4.dp))
                        }
                    }
                    if (songs.isEmpty()) {
                        item(key = "no-own-songs") {
                            Text(
                                "Every song here belongs to a downloaded playlist.",
                                color = Palette.fg3, fontSize = 13.sp,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
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
                        currentPlaying = nowPlaying.isPlaying,
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
                if (state.allSongs.isNotEmpty()) {
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
                "It stays in the library and can be downloaded again." +
                viewModel.playlistsHolding(song.songId).takeIf { it.isNotEmpty() }?.let {
                    "\n\nIt is in the downloaded playlist ${it.joinToString { n -> "\u201c$n\u201d" }}, which will download it again. " +
                        "Turn that playlist's Download off to keep it off the phone."
                }.orEmpty(),
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                deleting = null
                viewModel.delete(song, actions.deleteWithConsent)
            },
            onDismiss = { deleting = null },
        )
    }
    forgetting?.let { p ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { forgetting = null },
            containerColor = Palette.overlay,
            titleContentColor = Palette.fg,
            textContentColor = Palette.fg2,
            shape = CardShape,
            modifier = Modifier.dialogEdge(),
            title = { Text("Stop downloading \u201c${p.name}\u201d?", fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
            text = {
                Text(
                    (if (p.status is PlaylistDownloadStatus.Unavailable)
                        "This playlist was deleted or made private, so it is no longer synced. Its songs are still on this phone. "
                    else "New songs of this playlist will no longer be downloaded. ") +
                        "Remove the songs it downloaded too? Songs you downloaded yourself, and songs another downloaded playlist holds, stay.",
                    fontSize = 14.sp, lineHeight = 20.sp,
                )
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton("Keep songs", { forgetting = null; viewModel.forget(p.id, removeFiles = false) }, tag = "stop-keep", compact = true)
                    DangerButton("Remove", { forgetting = null; viewModel.forget(p.id, removeFiles = true) }, tag = "stop-remove", compact = true, solid = true)
                }
            },
            dismissButton = { QuietButton("Cancel", { forgetting = null }, accent = false, tag = "dialog:dismiss") },
        )
    }
}

/** A downloaded playlist: its cover, its name, what its download is doing (Spotify's Downloaded list). */
@Composable
private fun DevicePlaylistRow(p: DeviceListPlaylist, onOpen: () -> Unit, onForget: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(RoundedCornerShape(Dimens.controlRadius))
            .clickable(onClick = onOpen)
            .heightIn(min = 64.dp)
            .padding(start = 8.dp, top = 8.dp, bottom = 8.dp)
            .testTag("device-playlist:${p.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CoverTile(p.id, p.name, size = 48.dp, modifier = Modifier.alpha(if (p.status is PlaylistDownloadStatus.Unavailable) 0.5f else 1f))
        Column(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
            Text(p.name, color = Palette.fg, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                 overflow = TextOverflow.Ellipsis)
            PlaylistDownloadLine(p.status)
        }
        IconAction(AppIcons.More, "Download actions for ${p.name}", tag = "menu:device-playlist:${p.id}", onClick = onForget)
    }
}
