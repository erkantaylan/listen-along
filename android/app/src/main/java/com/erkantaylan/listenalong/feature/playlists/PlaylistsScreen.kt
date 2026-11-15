package com.erkantaylan.listenalong.feature.playlists

import com.erkantaylan.listenalong.core.designsystem.CoverTile
import com.erkantaylan.listenalong.core.designsystem.Dimens
import com.erkantaylan.listenalong.core.designsystem.EqualizerIcon
import com.erkantaylan.listenalong.core.designsystem.Segment
import com.erkantaylan.listenalong.core.designsystem.SegmentedControl
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.graphics.Color
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
/** Which playlist dialog is open, if any. */
internal sealed interface PlaylistDialog {
    data class Rename(val playlist: Playlist) : PlaylistDialog
    data class Delete(val playlist: Playlist) : PlaylistDialog
    data class Download(val playlist: Playlist, val plan: BulkPlan) : PlaylistDialog
}

/** The Playlists tab: every playlist you can see, yours first; tapping one opens it. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PlaylistsScreen(
    viewModel: PlaylistsViewModel,
    online: Boolean,
    nowPlaying: NowPlaying,
    actions: AppActions,
    onOpenPlaylist: (String) -> Unit,
) {
    var dialog by remember { mutableStateOf<PlaylistDialog?>(null) }
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(viewModel) { viewModel.opened.collect { onOpenPlaylist(it) } }

    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        PlaylistList(viewModel, online, nowPlaying, actions, onNew = { creating = true }, onOpen = onOpenPlaylist, onDialog = { dialog = it })
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
    PlaylistDialogHost(
        dialog,
        onDismiss = { dialog = null },
        onRename = viewModel::rename,
        onDelete = viewModel::delete,
        onDownload = { _ -> },
    )
}

/** Rename, delete and "Download playlist" confirmations, shared by the list and a playlist's page. */
@Composable
internal fun PlaylistDialogHost(
    dialog: PlaylistDialog?,
    onDismiss: () -> Unit,
    onRename: (Playlist, String) -> Unit,
    onDelete: (Playlist) -> Unit,
    onDownload: (BulkPlan) -> Unit,
) {
    when (val d = dialog) {
        null -> Unit
        is PlaylistDialog.Rename -> TextPromptDialog(
            title = "Rename playlist",
            initial = d.playlist.name.orEmpty(),
            placeholder = "Playlist name",
            confirmLabel = "Rename",
            onConfirm = { onDismiss(); onRename(d.playlist, it) },
            onDismiss = onDismiss,
        )
        is PlaylistDialog.Delete -> ConfirmDialog(
            title = "Delete playlist?",
            text = "\"${d.playlist.displayName}\" and its song list will be deleted for everyone. " +
                "The songs stay in the library, and downloaded files stay on this device.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = { onDismiss(); onDelete(d.playlist) },
            onDismiss = onDismiss,
        )
        is PlaylistDialog.Download -> {
            val plan = d.plan
            if (plan.count == 0) {
                ConfirmDialog(
                    title = "Already downloaded",
                    text = "All ${plan.alreadyHave} songs of \"${d.playlist.displayName}\" are on this device or queued.",
                    confirmLabel = "OK", onConfirm = onDismiss, onDismiss = onDismiss,
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
                    onConfirm = { onDismiss(); onDownload(plan) },
                    onDismiss = onDismiss,
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
    nowPlaying: NowPlaying,
    actions: AppActions,
    onNew: () -> Unit,
    onOpen: (String) -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val readOnly = state.fromCache || !online
    Column(Modifier.fillMaxSize()) {
        AppTopBar(
            title = "Playlists",
            subtitle = if (state.playlists.isNotEmpty()) {
                { Text("${state.playlists.size} playlists", color = Palette.fg3, fontSize = 12.sp) }
            } else null,
        ) {
            if (state.signedIn) {
                IconAction(AppIcons.Add, "New playlist", tag = "new-playlist", enabled = !readOnly, onClick = onNew)
            }
        }
        if (!state.signedIn) {
            SignInNeeded(actions, "Playlists")
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
                val shown = state.shown
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp)) {
                    item(key = "filters") {
                        SegmentedControl(
                            segments = OwnerFilter.entries.map { Segment(it.label, "filter:${it.name.lowercase()}") },
                            selected = state.filter.ordinal,
                            onSelect = { viewModel.setFilter(OwnerFilter.entries[it]) },
                            fill = true,
                            modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                        )
                    }
                    if (state.error != null) {
                        item(key = "error") {
                            Alert(state.error!!, AlertKind.DANGER, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp))
                        }
                    }
                    if (shown.isEmpty()) {
                        item(key = "none") {
                            EmptyState(
                                when (state.filter) {
                                    OwnerFilter.MINE -> "You have no playlists"
                                    OwnerFilter.PRIVATE -> "You have no private playlists"
                                    OwnerFilter.PUBLIC -> "No public playlists"
                                    OwnerFilter.ALL -> "No playlists"
                                },
                                icon = AppIcons.QueueMusic,
                            ) { SecondaryButton("Show all", { viewModel.setFilter(OwnerFilter.ALL) }, tag = "show-all") }
                        }
                    }
                    items(shown, key = { p -> p.id }) { playlist ->
                        PlaylistRow(playlist, readOnly, playingFrom = nowPlaying.context,
                                    playing = nowPlaying.isPlaying,
                                    onOpen = { onOpen(playlist.id) },
                                    onToggleVisibility = { viewModel.toggleVisibility(playlist) },
                                    onDialog = onDialog)
                    }
                }
            }
        }
    }
}

/**
 * A playlist in the list (the web sidebar's row): its cover of initials,
 * the name over a muted line (a lock on private ones, owner, songs), ⋮.
 * Separate rounded rows, no dividers. The playlist playing now has the
 * accent tint, the equaliser and an accent title, never an edge.
 */
@Composable
internal fun PlaylistRow(
    playlist: Playlist,
    readOnly: Boolean,
    playingFrom: String?,
    playing: Boolean,
    onOpen: () -> Unit,
    onToggleVisibility: () -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
    meta: List<String> = listOfNotNull(
        playlist.ownerLine,
        if (playlist.songCount == 1) "1 song" else "${playlist.songCount} songs",
        playlist.userCount.takeIf { it > 0 }?.let { "$it listening" },
    ),
    metaLeading: (@Composable () -> Unit)? = null,
    menu: Boolean = true,
) {
    val current = playingFrom != null && playingFrom == playlist.displayName
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .clip(RoundedCornerShape(Dimens.controlRadius))
            .background(
                when {
                    current -> Palette.accentSubtle
                    pressed -> Palette.pressed
                    else -> Color.Transparent
                }
            )
            .clickable(interactionSource = interaction, indication = null, onClick = onOpen)
            .heightIn(min = 64.dp)
            .padding(start = 8.dp, top = 8.dp, bottom = 8.dp)
            .testTag("playlist:${playlist.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CoverTile(playlist.id, playlist.displayName, size = 48.dp)
        Column(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (current) {
                    EqualizerIcon(playing)
                    Spacer(Modifier.width(6.dp))
                }
                Text(playlist.displayName, color = if (current) Palette.accentFgStrong else Palette.fg, fontSize = 15.sp,
                     fontWeight = if (current) FontWeight.SemiBold else FontWeight.Medium,
                     maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (metaLeading != null) {
                    metaLeading()
                    Spacer(Modifier.width(5.dp))
                }
                if (playlist.isPrivate) {
                    Icon(AppIcons.Lock, contentDescription = "Private", tint = Palette.fg3,
                         modifier = Modifier.size(13.dp).testTag("private-badge"))
                    Spacer(Modifier.width(4.dp))
                }
                Text(meta.joinToString(" · "), color = Palette.fg3, fontSize = 13.sp, maxLines = 1,
                     overflow = TextOverflow.Ellipsis)
            }
        }
        if (menu) PlaylistMenu(playlist, readOnly, onToggleVisibility, onDialog)
    }
}

/** ⋮ menu: rename, visibility and delete (owner only — the server decides). Nothing to offer: no ⋮. */
@Composable
internal fun PlaylistMenu(
    playlist: Playlist,
    readOnly: Boolean,
    onToggleVisibility: () -> Unit,
    onDialog: (PlaylistDialog) -> Unit,
    extra: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
) {
    if (!playlist.canManage && extra == null) return
    var open by remember { mutableStateOf(false) }
    Box {
        IconAction(AppIcons.More, "Playlist actions", tag = "menu:playlist:${playlist.id}") { open = true }
        AppDropdownMenu(open, onDismissRequest = { open = false }) {
            extra?.invoke { open = false }
            if (playlist.canManage) {
                MenuEntry("Rename", AppIcons.Edit, "menu-rename", enabled = !readOnly) {
                    open = false; onDialog(PlaylistDialog.Rename(playlist))
                }
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

@Composable
internal fun OfflineAlert(text: String) {
    Alert(text, AlertKind.WARNING, icon = AppIcons.CloudOff,
          modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp))
}

internal fun ago(savedAt: Long?): String =
    if (savedAt == null) "earlier"
    else DateUtils.getRelativeTimeSpanString(savedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
