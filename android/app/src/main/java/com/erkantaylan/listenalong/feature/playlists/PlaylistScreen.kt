package com.erkantaylan.listenalong.feature.playlists

import com.erkantaylan.listenalong.core.designsystem.DangerButton
import com.erkantaylan.listenalong.core.designsystem.Dimens
import com.erkantaylan.listenalong.core.designsystem.QuietButton
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.ui.PlaylistDownloadLine
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import com.erkantaylan.listenalong.core.designsystem.CoverTile
import com.erkantaylan.listenalong.core.designsystem.ButtonShape
import com.erkantaylan.listenalong.core.designsystem.CardShape
import com.erkantaylan.listenalong.core.designsystem.DialogDismiss
import com.erkantaylan.listenalong.core.ui.PlayAllBar
import com.erkantaylan.listenalong.core.ui.SongRow
import com.erkantaylan.listenalong.core.designsystem.TitleAndMeta
import com.erkantaylan.listenalong.core.designsystem.dialogEdge
import com.erkantaylan.listenalong.core.designsystem.dragHandle
import com.erkantaylan.listenalong.core.designsystem.longPressDrag
import com.erkantaylan.listenalong.core.ui.AppActions
import com.erkantaylan.listenalong.core.designsystem.Alert
import com.erkantaylan.listenalong.core.designsystem.AlertKind
import com.erkantaylan.listenalong.core.designsystem.AppDropdownMenu
import com.erkantaylan.listenalong.core.designsystem.AppIcons
import com.erkantaylan.listenalong.core.designsystem.AppTopBar
import com.erkantaylan.listenalong.core.designsystem.Centre
import com.erkantaylan.listenalong.core.designsystem.ConfirmDialog
import com.erkantaylan.listenalong.core.designsystem.EmptyState
import com.erkantaylan.listenalong.core.designsystem.IconAction
import com.erkantaylan.listenalong.core.designsystem.ListGroupItem
import com.erkantaylan.listenalong.core.designsystem.PrimaryButton
import com.erkantaylan.listenalong.core.designsystem.SecondaryButton
import com.erkantaylan.listenalong.core.designsystem.SubtleBadge
import com.erkantaylan.listenalong.core.designsystem.TextPromptDialog
import com.erkantaylan.listenalong.core.designsystem.rememberReorderState
import com.erkantaylan.listenalong.core.ui.MenuEntry
import com.erkantaylan.listenalong.feature.library.SignInNeeded
import android.text.format.DateUtils
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.zIndex
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.Visibility
import com.erkantaylan.listenalong.core.download.BulkPlan
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.DownloadState
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.download.formatMb
import com.erkantaylan.listenalong.core.player.NowPlaying
import com.erkantaylan.listenalong.core.designsystem.Palette

import kotlinx.coroutines.flow.StateFlow
/** One playlist's page: its songs, Play / Shuffle, edit mode, and the owner's actions. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PlaylistScreen(
    viewModel: PlaylistViewModel,
    online: Boolean,
    nowPlaying: NowPlaying,
    actions: AppActions,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snapshot by viewModel.downloadState.collectAsStateWithLifecycle()
    val download by viewModel.download.collectAsStateWithLifecycle()
    var dialog by remember { mutableStateOf<PlaylistDialog?>(null) }
    var stopping by remember { mutableStateOf(false) }
    LaunchedEffect(viewModel) { viewModel.closed.collect { onBack() } }
    // Back in edit mode leaves edit mode; otherwise it leaves the page.
    BackHandler(enabled = state.editing) { viewModel.finishEditing() }

    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        PlaylistDetail(
            state, viewModel, snapshot, online, nowPlaying, actions, onBack, onDialog = { dialog = it },
            download = download,
            onStartDownload = { actions.beforeDownload(); viewModel.startDownload() },
            onStopDownload = { stopping = true },
        )
    }
    if (stopping) {
        StopDownloadDialog(
            name = state.playlist?.displayName ?: "this playlist",
            onKeep = { stopping = false; viewModel.stopDownload(removeFiles = false) },
            onRemove = { stopping = false; viewModel.stopDownload(removeFiles = true) },
            onDismiss = { stopping = false },
        )
    }
    PlaylistDialogHost(
        dialog,
        onDismiss = { dialog = null },
        onRename = { _, name -> viewModel.rename(name) },
        onDelete = { viewModel.delete() },
        onDownload = { plan -> actions.beforeDownload(); actions.queued(viewModel.download(plan)) },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistDetail(
    state: PlaylistDetailUi,
    viewModel: PlaylistViewModel,
    snapshot: DownloadSnapshot,
    online: Boolean,
    nowPlaying: NowPlaying,
    actions: AppActions,
    onBack: () -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
    download: PlaylistDownloadStatus,
    onStartDownload: () -> Unit,
    onStopDownload: () -> Unit,
) {
    val playlist = state.playlist
    val readOnly = state.fromCache || !online
    val songs = state.songs
    val label = playlist?.displayName ?: "Playlist"
    val onDevice = songs.count { snapshot.downloaded.containsKey(it.id) }
    val canEdit = playlist?.editable == true && !readOnly
    val editing = state.editing
    val snackbar = remember { SnackbarHostState() }
    val listState = rememberLazyListState()
    val entryIds = remember(state.entries) { state.entries.mapTo(HashSet()) { it.entryId } }
    val reorder = rememberReorderState(
        listState,
        isDraggable = { it is String && it in entryIds },
        onStart = viewModel::startDrag,
        onOver = viewModel::dragOver,
        onEnd = viewModel::endDrag,
    )

    // Going offline mid-edit: the changes so far are sent (or fail), editing ends.
    LaunchedEffect(canEdit) { if (!canEdit && editing) viewModel.finishEditing() }

    // Removed: "Undo" for a while, then it is sent to the server.
    val pending = state.pending
    LaunchedEffect(pending?.entry?.entryId) {
        if (pending == null) return@LaunchedEffect
        val result = snackbar.showSnackbar(
            message = "Removed \"${pending.entry.cleanTitle.ifBlank { "song" }}\"",
            actionLabel = "Undo",
            duration = SnackbarDuration.Long,
        )
        if (result == SnackbarResult.ActionPerformed) viewModel.undoRemove()
        else viewModel.commitPendingRemoval(pending.entry.entryId)
    }

    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        AppTopBar(
            title = playlist?.displayName ?: "Playlist",
            onBack = if (editing) null else onBack,
            leading = if (!editing && playlist != null) { { CoverTile(playlist.id, playlist.displayName, size = 40.dp) } } else null,
            subtitle = if (editing) {
                { Text("Drag to reorder · ⊖ removes", color = Palette.fg3, fontSize = 12.sp, maxLines = 1) }
            } else if (playlist != null) {
                {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (playlist.isPrivate) {
                            SubtleBadge("Private", AppIcons.Lock)
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(
                            listOfNotNull(
                                playlist.ownerLine,
                                if (state.entries.size == 1) "1 song" else "${state.entries.size} songs",
                                totalLength(state.entries),
                            ).joinToString(" · "),
                            color = Palette.fg3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            } else null,
        ) {
            if (editing) {
                PrimaryButton("Done", { viewModel.finishEditing() }, tag = "edit-done", compact = true,
                              modifier = Modifier.padding(end = 8.dp))
            } else if (playlist != null) {
                if (canEdit && state.entries.isNotEmpty()) {
                    SecondaryButton("Edit", { viewModel.startEditing() }, tag = "edit-playlist", compact = true,
                                    modifier = Modifier.padding(end = 4.dp))
                }
                PlaylistMenu(playlist, readOnly, { viewModel.toggleVisibility() }, onDialog) { dismiss ->
                    val on = download != PlaylistDownloadStatus.Off
                    MenuEntry(
                        if (on) "Stop downloading" else "Download",
                        if (on) AppIcons.DownloadCircleOutline else AppIcons.DownloadedCircle,
                        "menu-download-playlist",
                        enabled = on || songs.isNotEmpty(),
                    ) {
                        dismiss()
                        if (on) onStopDownload() else onStartDownload()
                    }
                }
            }
        }

        if (state.fromCache) {
            OfflineAlert("Offline — saved copy from ${ago(state.savedAt)}. Changes need a connection.")
        }

        val list: @Composable () -> Unit = {
            LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 16.dp)) {
                if (!editing) {
                    item(key = "play-all") {
                        PlayAllBar(
                            playEnabled = songs.isNotEmpty(),
                            onPlay = { actions.play(songs, 0, label, false) },
                            onShuffle = { actions.play(songs, 0, label, true) },
                        ) {
                            if (download == PlaylistDownloadStatus.Off) {
                                Text(
                                    if (onDevice == songs.size && songs.isNotEmpty()) "All on device" else "$onDevice of ${songs.size} on device",
                                    color = if (onDevice == songs.size && songs.isNotEmpty()) Palette.success else Palette.fg3,
                                    fontSize = 12.sp, modifier = Modifier.padding(end = 4.dp).testTag("on-device-count"),
                                )
                            }
                        }
                    }
                    if (playlist != null) {
                        item(key = "download-switch") {
                            DownloadSwitchRow(
                                status = download,
                                enabled = download != PlaylistDownloadStatus.Off || songs.isNotEmpty(),
                                onChange = { on -> if (on) onStartDownload() else onStopDownload() },
                                onRetry = viewModel::retryDownload,
                            )
                        }
                    }
                } else {
                    item(key = "edit-top") { Spacer(Modifier.height(12.dp)) }
                }
                if (state.error != null) {
                    item(key = "error") {
                        Alert(state.error, AlertKind.DANGER, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp))
                    }
                }
                itemsIndexed(state.entries, key = { _, e -> e.entryId }) { i, entry ->
                    if (editing) {
                        val dragging = reorder.draggingKey == entry.entryId
                        EditableEntryRow(
                            index = i,
                            count = state.entries.size,
                            entry = entry,
                            dragging = dragging,
                            modifier = Modifier
                                .then(if (dragging) Modifier.zIndex(1f) else Modifier.animateItem())
                                .graphicsLayer { translationY = reorder.translationOf(entry.entryId) }
                                .longPressDrag(reorder, entry.entryId),
                            handle = Modifier.dragHandle(reorder, entry.entryId),
                            onMoveUp = if (i > 0) ({ viewModel.moveBy(entry, -1) }) else null,
                            onMoveDown = if (i < state.entries.size - 1) ({ viewModel.moveBy(entry, +1) }) else null,
                            onRemove = { viewModel.remove(entry) },
                        )
                    } else {
                        val song = entry.toSong()
                        val download = song?.let { snapshot.stateOf(it.id) }
                        val playable = song != null && (online || download is DownloadState.Done)
                        SongRow(
                            index = i,
                            count = state.entries.size,
                            tag = "entry:${entry.entryId}",
                            title = entry.cleanTitle,
                            artist = entry.artist.orEmpty(),
                            durationSec = entry.durationRaw?.let { Math.round(it).toInt() },
                            download = download,
                            current = song != null && nowPlaying.songId == song.id,
                            currentPlaying = nowPlaying.isPlaying,
                            enabled = playable,
                            extraMeta = when {
                                song == null -> "not in the library"
                                !playable -> "not on this device"
                                else -> null
                            },
                            onClick = if (playable) {
                                {
                                    // Play the playlist from this song. [songs] leaves out entries
                                    // with no library song, so count only those before this one.
                                    actions.play(songs, state.entries.take(i).count { it.playable }, label, false)
                                }
                            } else null,
                            onDownload = if (song != null && online) {
                                { actions.beforeDownload(); viewModel.downloadSong(song) }
                            } else null,
                            onCancelDownload = { song?.let { viewModel.cancelDownload(it) } },
                            reportSong = song,
                            reportable = true,
                        ) { dismiss ->
                            if (song != null && download is DownloadState.Done) {
                                MenuEntry("Open in another app", AppIcons.OpenInNew, "menu-open") {
                                    dismiss(); actions.openExternal(download.local)
                                }
                            }
                            if (song != null) {
                                MenuEntry("Add to another playlist", AppIcons.PlaylistAdd, "menu-add-to-playlist", enabled = !readOnly) {
                                    dismiss(); actions.addToPlaylist(listOf(song))
                                }
                            }
                            if (canEdit) {
                                MenuEntry("Remove from playlist", AppIcons.Delete, "menu-remove", destructive = true) {
                                    dismiss(); viewModel.remove(entry)
                                }
                            }
                        }
                    }
                }
            }
        }

        when {
            state.gone -> EmptyState(
                "Playlist not found",
                "It was deleted, or it is private now.",
                AppIcons.QueueMusic,
            ) { SecondaryButton("Back to playlists", onBack) }
            state.loading -> Centre { CircularProgressIndicator(color = Palette.accentFg) }
            state.error != null && state.entries.isEmpty() -> EmptyState(
                "Cannot load this playlist", state.error, AppIcons.CloudOff,
            ) { SecondaryButton("Retry", { viewModel.refresh() }, tag = "retry") }
            state.entries.isEmpty() -> EmptyState(
                "This playlist is empty",
                "Add songs from the Library tab with ⋮ → Add to playlist.",
                AppIcons.QueueMusic,
            )
            editing -> list()
            else -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = { viewModel.refresh() },
                modifier = Modifier.fillMaxSize(),
            ) { list() }
        }
    }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp)) { data ->
            Snackbar(
                data,
                containerColor = Palette.overlay,
                contentColor = Palette.fg,
                actionColor = Palette.accentFg,
                shape = ButtonShape,
                modifier = Modifier.border(1.dp, Palette.borderStrong, ButtonShape).testTag("snackbar"),
            )
        }
    }
}

/**
 * A playlist entry in edit mode: drag handle, title, remove button. Rows
 * stay put when tapped; long-press-drag works on the whole row too. TalkBack
 * gets "Move up" / "Move down" actions instead of dragging.
 */
@Composable
private fun EditableEntryRow(
    index: Int,
    count: Int,
    entry: com.erkantaylan.listenalong.core.model.PlaylistEntry,
    dragging: Boolean,
    modifier: Modifier,
    handle: Modifier,
    onMoveUp: (() -> Unit)?,
    onMoveDown: (() -> Unit)?,
    onRemove: () -> Unit,
) {
    val moves = listOfNotNull(
        onMoveUp?.let { CustomAccessibilityAction("Move up") { it(); true } },
        onMoveDown?.let { CustomAccessibilityAction("Move down") { it(); true } },
    )
    Box(
        modifier
            .shadow(if (dragging) 8.dp else 0.dp, CardShape)
            .semantics { customActions = moves }
            .testTag("edit-entry:${entry.entryId}")
    ) {
        ListGroupItem(index, count, lifted = dragging) {
            Box(handle.size(40.dp).testTag("drag:${entry.entryId}"), contentAlignment = Alignment.Center) {
                Icon(AppIcons.DragHandle, contentDescription = "Drag to reorder", tint = Palette.fg4, modifier = Modifier.size(22.dp))
            }
            TitleAndMeta(
                title = entry.cleanTitle.ifBlank { "Untitled" },
                meta = listOfNotNull(
                    entry.artist?.takeIf { it.isNotBlank() && it != "Unknown" },
                    com.erkantaylan.listenalong.core.model.formatDuration(entry.durationRaw?.let { Math.round(it).toInt() }).takeIf { it.isNotEmpty() },
                ).joinToString(" · "),
            )
            IconAction(AppIcons.RemoveCircle, "Remove ${entry.cleanTitle.ifBlank { "song" }} from playlist",
                       tag = "remove:${entry.entryId}", tint = Palette.danger, onClick = onRemove)
        }
    }
}

/** The web's stats in the header's muted line: "48 min", "1 h 12 min", "35 sec"; null when no entry has a length. */
internal fun totalLength(entries: List<com.erkantaylan.listenalong.core.model.PlaylistEntry>): String? {
    val known = entries.mapNotNull { it.durationRaw }.filter { it > 0 }
    if (known.isEmpty()) return null
    val seconds = known.sum().toLong()
    val text = when {
        seconds < 60 -> "$seconds sec"
        seconds < 3600 -> "${Math.round(seconds / 60.0)} min"
        else -> "${seconds / 3600} h ${Math.round((seconds % 3600) / 60.0)} min"
    }
    return if (known.size < entries.count { it.playable }) "about $text" else text
}

/**
 * The playlist's Download switch (Spotify's): on = every song is downloaded
 * and kept in step with the server; its status under the label.
 */
@Composable
private fun DownloadSwitchRow(
    status: PlaylistDownloadStatus,
    enabled: Boolean,
    onChange: (Boolean) -> Unit,
    onRetry: () -> Unit,
) {
    val on = status != PlaylistDownloadStatus.Off
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(Dimens.controlRadius))
            .clickable(enabled = enabled) { onChange(!on) }
            .heightIn(min = 56.dp).padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = "Download"
                stateDescription = if (on) "On" else "Off"
            }
            .testTag("download-switch-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (on) AppIcons.DownloadedCircle else AppIcons.DownloadCircleOutline, contentDescription = null,
            tint = if (on) Palette.success else Palette.fg2, modifier = Modifier.size(26.dp),
        )
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text("Download", color = Palette.fg, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            if (on) PlaylistDownloadLine(status) else {
                Text("Keeps every song on this phone, and the ones added later", color = Palette.fg3, fontSize = 13.sp,
                     maxLines = 2)
            }
        }
        if (status is PlaylistDownloadStatus.Failed) {
            QuietButton("Retry", onRetry, tag = "download-retry")
        }
        Switch(
            checked = on,
            onCheckedChange = onChange,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Palette.onAccent,
                checkedTrackColor = Palette.accent,
                checkedBorderColor = Palette.accent,
                uncheckedThumbColor = Palette.fg3,
                uncheckedTrackColor = Palette.field,
                uncheckedBorderColor = Palette.borderStrong,
            ),
            modifier = Modifier.testTag("download-switch"),
        )
    }
}

/** Turning Download off: keep the songs (they become yours) or remove the ones it downloaded. */
@Composable
private fun StopDownloadDialog(name: String, onKeep: () -> Unit, onRemove: () -> Unit, onDismiss: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.overlay,
        titleContentColor = Palette.fg,
        textContentColor = Palette.fg2,
        shape = CardShape,
        modifier = Modifier.dialogEdge(),
        title = { Text("Stop downloading \u201c$name\u201d?", fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            Text(
                "New songs of this playlist will no longer be downloaded. Remove the songs it downloaded too? " +
                    "Songs you downloaded yourself, and songs another downloaded playlist holds, stay.",
                fontSize = 14.sp, lineHeight = 20.sp,
            )
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Keep songs", onKeep, tag = "stop-keep", compact = true)
                DangerButton("Remove", onRemove, tag = "stop-remove", compact = true, solid = true)
            }
        },
        dismissButton = { QuietButton("Cancel", onDismiss, accent = false, tag = "dialog:dismiss") },
    )
}
