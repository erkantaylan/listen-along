package com.erkantaylan.listenalong.feature.playlists

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
            .background(if (selected) Palette.accentSubtle else Palette.field)
            .border(1.dp, if (selected) Palette.accentBorder else Palette.borderStrong, ButtonShape)
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
    viewModel: AddToPlaylistViewModel,
    onDismiss: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { viewModel.refresh() }

    if (creating) {
        NewPlaylistDialog(
            confirmLabel = "Create and add",
            onCreate = { name, visibility ->
                viewModel.createWith(name, visibility, songs)
                onDismiss()
            },
            onDismiss = { creating = false },
        )
        return
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.overlay,
        shape = CardShape,
        modifier = Modifier.dialogEdge(),
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
                        viewModel.add(playlist, songs)
                        onDismiss()
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            DialogDismiss(onDismiss)
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
