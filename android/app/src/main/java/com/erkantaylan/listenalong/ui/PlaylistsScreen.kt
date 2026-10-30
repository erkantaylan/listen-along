package com.erkantaylan.listenalong.ui

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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.erkantaylan.listenalong.api.Playlist
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.api.Visibility
import com.erkantaylan.listenalong.download.BulkPlan
import com.erkantaylan.listenalong.download.DownloadSnapshot
import com.erkantaylan.listenalong.download.DownloadState
import com.erkantaylan.listenalong.download.Downloads
import com.erkantaylan.listenalong.download.formatMb
import com.erkantaylan.listenalong.player.NowPlaying
import com.erkantaylan.listenalong.ui.theme.Palette

/** Which playlist dialog is open, if any. */
private sealed interface PlaylistDialog {
    data class Rename(val playlist: Playlist) : PlaylistDialog
    data class Delete(val playlist: Playlist) : PlaylistDialog
    data class Download(val playlist: Playlist, val plan: BulkPlan) : PlaylistDialog
}

@OptIn(ExperimentalComposeUiApi::class, ExperimentalMaterial3Api::class)
@Composable
fun PlaylistsScreen(
    viewModel: PlaylistsViewModel,
    snapshot: DownloadSnapshot,
    downloads: Downloads,
    online: Boolean,
    nowPlaying: NowPlaying,
    actions: AppActions,
) {
    val detail by viewModel.detail.collectAsStateWithLifecycle()
    var dialog by remember { mutableStateOf<PlaylistDialog?>(null) }
    var creating by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(Palette.page).semantics { testTagsAsResourceId = true }) {
        val open = detail
        if (open == null) {
            PlaylistList(viewModel, online, onNew = { creating = true }, onDialog = { dialog = it })
        } else {
            BackHandler { if (open.editing) viewModel.finishEditing() else viewModel.close() }
            PlaylistDetail(open, viewModel, snapshot, downloads, online, nowPlaying, actions, onDialog = { dialog = it })
        }
    }

    if (creating) {
        NewPlaylistDialog(
            onCreate = { name, visibility ->
                creating = false
                viewModel.create(name, visibility)
            },
            onDismiss = { creating = false },
        )
    }

    when (val d = dialog) {
        null -> Unit
        is PlaylistDialog.Rename -> TextPromptDialog(
            title = "Rename playlist",
            initial = d.playlist.name.orEmpty(),
            placeholder = "Playlist name",
            confirmLabel = "Rename",
            onConfirm = { dialog = null; viewModel.rename(d.playlist, it) },
            onDismiss = { dialog = null },
        )
        is PlaylistDialog.Delete -> ConfirmDialog(
            title = "Delete playlist?",
            text = "\"${d.playlist.displayName}\" and its song list will be deleted for everyone. " +
                "The songs stay in the library, and downloaded files stay on this device.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = { dialog = null; viewModel.delete(d.playlist) },
            onDismiss = { dialog = null },
        )
        is PlaylistDialog.Download -> {
            val plan = d.plan
            if (plan.count == 0) {
                ConfirmDialog(
                    title = "Already downloaded",
                    text = "All ${plan.alreadyHave} songs of \"${d.playlist.displayName}\" are on this device or queued.",
                    confirmLabel = "OK", onConfirm = { dialog = null }, onDismiss = { dialog = null },
                    showCancel = false,
                )
            } else {
                ConfirmDialog(
                    title = "Download playlist",
                    text = buildString {
                        append("Download ${plan.count} song${if (plan.count == 1) "" else "s"} of ")
                        append("\"${d.playlist.displayName}\"? About ${formatMb(plan.estimatedMb)}.")
                        if (plan.alreadyHave > 0) append("\n\n${plan.alreadyHave} already on the device or queued are skipped.")
                        append("\n\nThey then play with no connection.")
                    },
                    confirmLabel = "Download ${plan.count}",
                    onConfirm = {
                        dialog = null
                        actions.beforeDownload()
                        actions.queued(downloads.enqueue(plan.toDownload))
                    },
                    onDismiss = { dialog = null },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistList(
    viewModel: PlaylistsViewModel,
    online: Boolean,
    onNew: () -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
) {
    val state by viewModel.list.collectAsStateWithLifecycle()
    val readOnly = state.fromCache || !online
    Column(Modifier.fillMaxSize()) {
        AppTopBar(
            title = "Playlists",
            subtitle = if (state.playlists.isNotEmpty()) {
                { Text("${state.playlists.size} playlists", color = Palette.fg3, fontSize = 12.sp) }
            } else null,
        ) {
            if (state.hasToken) {
                IconAction(AppIcons.Add, "New playlist", tag = "new-playlist", enabled = !readOnly, onClick = onNew)
            }
        }
        if (!state.hasToken) {
            TokenNeededSimple()
            return@Column
        }
        if (state.fromCache) {
            OfflineAlert("Offline — the list as of ${ago(state.savedAt)}. Changes need a connection.")
        }
        when {
            state.loading -> Centre { CircularProgressIndicator(color = Palette.accentFg) }
            state.error != null && state.playlists.isEmpty() -> EmptyState(
                "Cannot load playlists", state.error, AppIcons.CloudOff,
            ) { SecondaryButton("Retry", { viewModel.refresh() }, tag = "retry") }
            state.playlists.isEmpty() -> EmptyState(
                "No playlists yet",
                "Make one here, or on the web. Public playlists from everyone show up here too.",
                AppIcons.QueueMusic,
            ) { PrimaryButton("New playlist", onNew, icon = AppIcons.Add, enabled = !readOnly) }
            else -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = { viewModel.refresh() },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 12.dp, bottom = 16.dp)) {
                    if (state.error != null) {
                        item(key = "error") {
                            Alert(state.error!!, AlertKind.DANGER, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp))
                        }
                    }
                    itemsIndexed(state.playlists, key = { _, p -> p.id }) { i, playlist ->
                        PlaylistRow(i, state.playlists.size, playlist, readOnly,
                                    onOpen = { viewModel.open(playlist.id) },
                                    onToggleVisibility = { viewModel.toggleVisibility(playlist) },
                                    onDialog = onDialog)
                    }
                }
            }
        }
    }
}

@Composable
private fun PlaylistRow(
    index: Int,
    count: Int,
    playlist: Playlist,
    readOnly: Boolean,
    onOpen: () -> Unit,
    onToggleVisibility: () -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
) {
    ListGroupItem(index, count, modifier = Modifier.testTag("playlist:${playlist.id}"), onClick = onOpen) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(6.dp)).background(Palette.bg2), contentAlignment = Alignment.Center) {
            Icon(AppIcons.QueueMusic, contentDescription = null, tint = Palette.fg3, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(playlist.displayName, color = Palette.fg, fontSize = 15.sp, maxLines = 1,
                     overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (playlist.isPrivate) {
                    Spacer(Modifier.width(6.dp))
                    SubtleBadge("Private", AppIcons.Lock, tag = "private-badge")
                }
            }
            Text(
                listOfNotNull(
                    playlist.ownerLine,
                    if (playlist.songCount == 1) "1 song" else "${playlist.songCount} songs",
                    playlist.userCount.takeIf { it > 0 }?.let { "$it listening" },
                ).joinToString(" · "),
                color = Palette.fg3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        PlaylistMenu(playlist, readOnly, onToggleVisibility, onDialog)
    }
}

/** ⋮ menu: rename (anyone who can see it), visibility and delete (owner only — the server decides). */
@Composable
private fun PlaylistMenu(
    playlist: Playlist,
    readOnly: Boolean,
    onToggleVisibility: () -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
    extra: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconAction(AppIcons.More, "Playlist actions", tag = "menu:playlist:${playlist.id}") { open = true }
        DropdownMenu(open, onDismissRequest = { open = false }, containerColor = Palette.bg1, shape = ButtonShape) {
            extra?.invoke { open = false }
            MenuEntry("Rename", AppIcons.Edit, "menu-rename", enabled = !readOnly) {
                open = false; onDialog(PlaylistDialog.Rename(playlist))
            }
            if (playlist.canManage) {
                MenuEntry(
                    if (playlist.isPrivate) "Make public" else "Make private",
                    if (playlist.isPrivate) AppIcons.Public else AppIcons.Lock,
                    "menu-visibility", enabled = !readOnly,
                ) { open = false; onToggleVisibility() }
                MenuEntry("Delete", AppIcons.Delete, "menu-delete", destructive = true, enabled = !readOnly) {
                    open = false; onDialog(PlaylistDialog.Delete(playlist))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistDetail(
    state: PlaylistDetailUi,
    viewModel: PlaylistsViewModel,
    snapshot: DownloadSnapshot,
    downloads: Downloads,
    online: Boolean,
    nowPlaying: NowPlaying,
    actions: AppActions,
    onDialog: (PlaylistDialog) -> Unit,
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
            onBack = if (editing) null else ({ viewModel.close() }),
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
                            listOf(playlist.ownerLine,
                                   if (state.entries.size == 1) "1 song" else "${state.entries.size} songs").joinToString(" · "),
                            color = Palette.fg3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            } else null,
        ) {
            if (editing) {
                QuietButton("Done", { viewModel.finishEditing() }, tag = "edit-done")
            } else if (playlist != null) {
                if (canEdit && state.entries.isNotEmpty()) {
                    QuietButton("Edit", { viewModel.startEditing() }, tag = "edit-playlist")
                }
                IconAction(AppIcons.Download, "Download playlist", tag = "download-playlist",
                           enabled = songs.isNotEmpty() && online) {
                    onDialog(PlaylistDialog.Download(playlist, BulkPlan.of(songs, snapshot)))
                }
                PlaylistMenu(playlist, readOnly, { viewModel.toggleVisibility(playlist) }, onDialog)
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
                            Text(
                                if (onDevice == songs.size && songs.isNotEmpty()) "All on device" else "$onDevice of ${songs.size} on device",
                                color = if (onDevice == songs.size && songs.isNotEmpty()) Palette.success else Palette.fg3,
                                fontSize = 12.sp, modifier = Modifier.padding(end = 4.dp).testTag("on-device-count"),
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
                                { actions.beforeDownload(); downloads.enqueue(listOf(song)) }
                            } else null,
                            onCancelDownload = { song?.let { downloads.cancel(it.id) } },
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
            ) { SecondaryButton("Back to playlists", { viewModel.close() }) }
            state.loading -> Centre { CircularProgressIndicator(color = Palette.accentFg) }
            state.error != null && state.entries.isEmpty() -> EmptyState(
                "Cannot load this playlist", state.error, AppIcons.CloudOff,
            ) { SecondaryButton("Retry", { viewModel.refreshDetail() }, tag = "retry") }
            state.entries.isEmpty() -> EmptyState(
                "This playlist is empty",
                "Add songs from the Library tab with ⋮ → Add to playlist.",
                AppIcons.QueueMusic,
            )
            editing -> list()
            else -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = { viewModel.refreshDetail() },
                modifier = Modifier.fillMaxSize(),
            ) { list() }
        }
    }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp)) { data ->
            Snackbar(
                data,
                containerColor = Palette.bg2,
                contentColor = Palette.fg,
                actionColor = Palette.accentFg,
                shape = ButtonShape,
                modifier = Modifier.testTag("snackbar"),
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
    entry: com.erkantaylan.listenalong.api.PlaylistEntry,
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
        ListGroupItem(index, count, current = dragging) {
            Box(handle.size(40.dp).testTag("drag:${entry.entryId}"), contentAlignment = Alignment.Center) {
                Icon(AppIcons.DragHandle, contentDescription = "Drag to reorder", tint = Palette.fg3, modifier = Modifier.size(22.dp))
            }
            TitleAndMeta(
                title = entry.cleanTitle.ifBlank { "Untitled" },
                meta = listOfNotNull(
                    entry.artist?.takeIf { it.isNotBlank() && it != "Unknown" },
                    com.erkantaylan.listenalong.api.formatDuration(entry.durationRaw?.let { Math.round(it).toInt() }).takeIf { it.isNotEmpty() },
                ).joinToString(" · "),
            )
            IconAction(AppIcons.RemoveCircle, "Remove ${entry.cleanTitle.ifBlank { "song" }} from playlist",
                       tag = "remove:${entry.entryId}", tint = Palette.danger, onClick = onRemove)
        }
    }
}

@Composable
private fun OfflineAlert(text: String) {
    Alert(text, AlertKind.WARNING, icon = AppIcons.CloudOff,
          modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp))
}

@Composable
private fun TokenNeededSimple() {
    EmptyState(
        title = "Connect your account",
        body = "Playlists need an API token. Add one in Settings.",
        icon = AppIcons.Lock,
    )
}

private fun ago(savedAt: Long?): String =
    if (savedAt == null) "earlier"
    else DateUtils.getRelativeTimeSpanString(savedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

/** New playlist: a name and the web's Public/Private choice with its one-line hint. */
@Composable
fun NewPlaylistDialog(onCreate: (String, Visibility) -> Unit, onDismiss: () -> Unit, confirmLabel: String = "Create") {
    var visibility by remember { mutableStateOf(Visibility.PUBLIC) }
    TextPromptDialog(
        title = "New playlist",
        initial = "",
        placeholder = "Playlist name",
        confirmLabel = confirmLabel,
        onConfirm = { onCreate(it, visibility) },
        onDismiss = onDismiss,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VisibilityChoice("Public", AppIcons.Public, visibility == Visibility.PUBLIC) { visibility = Visibility.PUBLIC }
                VisibilityChoice("Private", AppIcons.Lock, visibility == Visibility.PRIVATE) { visibility = Visibility.PRIVATE }
            }
            Text(
                if (visibility == Visibility.PUBLIC) "Everyone signed in can see and add to it."
                else "Only you can see it.",
                color = Palette.fg3, fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun VisibilityChoice(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(ButtonShape)
            .background(if (selected) Palette.accentSubtle else Palette.surface)
            .border(1.dp, if (selected) Palette.accent else Palette.border, ButtonShape)
            .clickable(onClick = onClick)
            .heightIn(min = 36.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("visibility:${text.lowercase()}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (selected) Palette.accentFg else Palette.fg3, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(text, color = if (selected) Palette.accentFg else Palette.fg2, fontSize = 14.sp)
    }
}

/**
 * "Add to playlist" from any song: the playlists you can see (anyone who can
 * see a playlist can add to it), plus "New playlist" which creates one with
 * the song already in it.
 */
@Composable
fun AddToPlaylistDialog(
    songs: List<Song>,
    viewModel: PlaylistsViewModel,
    onDismiss: () -> Unit,
) {
    val state by viewModel.list.collectAsStateWithLifecycle()
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { viewModel.refresh() }

    if (creating) {
        NewPlaylistDialog(
            confirmLabel = "Create and add",
            onCreate = { name, visibility ->
                viewModel.create(name, visibility, thenAdd = songs, openAfter = false)
                onDismiss()
            },
            onDismiss = { creating = false },
        )
        return
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.surface,
        shape = CardShape,
        title = {
            Text(
                if (songs.size == 1) "Add \"${songs[0].title.ifBlank { "Untitled" }}\" to…" else "Add ${songs.size} songs to…",
                color = Palette.fg, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        },
        text = {
            LazyColumn(Modifier.heightIn(max = 380.dp)) {
                item(key = "new") {
                    PickerRow(AppIcons.Add, "New playlist", null, accent = true, tag = "pick:new") { creating = true }
                }
                if (state.loading && state.playlists.isEmpty()) {
                    item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Palette.accentFg, strokeWidth = 2.dp)
                        }
                    }
                }
                state.error?.let { error ->
                    item(key = "error") { Text(error, color = Palette.danger, fontSize = 13.sp, modifier = Modifier.padding(8.dp)) }
                }
                itemsIndexed(state.playlists, key = { _, p -> p.id }) { _, playlist ->
                    PickerRow(
                        if (playlist.isPrivate) AppIcons.Lock else AppIcons.QueueMusic,
                        playlist.displayName,
                        listOf(playlist.ownerLine, "${playlist.songCount} songs").joinToString(" · "),
                        tag = "pick:${playlist.id}",
                    ) {
                        viewModel.addSongs(playlist, songs)
                        onDismiss()
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("dialog:dismiss")) { Text("Cancel", color = Palette.fg3) }
        },
    )
}

@Composable
private fun PickerRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    meta: String?,
    accent: Boolean = false,
    tag: String,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clip(ButtonShape).clickable(onClick = onClick).heightIn(min = 52.dp)
            .padding(horizontal = 8.dp, vertical = 6.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (accent) Palette.accentFg else Palette.fg3, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(title, color = if (accent) Palette.accentFg else Palette.fg, fontSize = 15.sp, maxLines = 1,
                 overflow = TextOverflow.Ellipsis)
            if (meta != null) Text(meta, color = Palette.fg3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
