package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.api.formatDuration
import com.erkantaylan.listenalong.download.DownloadState
import com.erkantaylan.listenalong.ui.theme.Palette

/**
 * A song in any list: cover placeholder, title, a muted line (artist ·
 * duration · download status), then the download button and a ⋮ menu.
 * Tapping the row plays; the current song gets the `.is-playing` treatment.
 */
@Composable
fun SongRow(
    index: Int,
    count: Int,
    tag: String,
    title: String,
    artist: String,
    durationSec: Int?,
    download: DownloadState?,
    current: Boolean,
    enabled: Boolean = true,
    extraMeta: String? = null,
    onClick: (() -> Unit)?,
    onDownload: (() -> Unit)? = null,
    onCancelDownload: (() -> Unit)? = null,
    menu: (@Composable ColumnScope.(dismiss: () -> Unit) -> Unit)? = null,
) {
    ListGroupItem(index, count, modifier = Modifier.testTag(tag), current = current, onClick = onClick) {
        Thumb(playing = current)
        val meta = listOfNotNull(
            artist.takeIf { it.isNotBlank() && it != "Unknown" },
            formatDuration(durationSec).takeIf { it.isNotEmpty() },
            extraMeta,
        ).joinToString(" · ")
        TitleAndMeta(
            title = title.ifBlank { "Untitled" },
            meta = meta,
            titleColor = when {
                !enabled -> Palette.fg4
                current -> Palette.accentFg
                else -> Palette.fg
            },
            extra = download?.let { state -> { DownloadLine(state) } },
        )
        if (download != null) DownloadButton(download, onDownload, onCancelDownload)
        if (menu != null) RowMenu(tag, menu)
    }
}

/** Only says something while it matters: queued, a percentage, or why it failed. */
@Composable
private fun DownloadLine(state: DownloadState) {
    val (text, color) = when (state) {
        is DownloadState.Queued -> "Queued for download" to Palette.accentFg
        is DownloadState.InProgress -> (state.fraction?.let { "Downloading ${(it * 100).toInt()}%" } ?: "Downloading…") to Palette.accentFg
        is DownloadState.Failed -> "Download failed: ${state.message}" to Palette.danger
        else -> return
    }
    Text(text, color = color, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/**
 * Not downloaded: a download icon. Queued or downloading: a spinner/ring
 * (tap to cancel). On the device: a green check, which is just a label.
 */
@Composable
fun DownloadButton(state: DownloadState, onDownload: (() -> Unit)?, onCancel: (() -> Unit)?) {
    when (state) {
        is DownloadState.Absent -> if (onDownload != null) {
            IconAction(AppIcons.Download, "Download", tag = "download", onClick = onDownload)
        }
        is DownloadState.Failed -> if (onDownload != null) {
            IconAction(AppIcons.Download, "Retry download", tag = "download", tint = Palette.danger, onClick = onDownload)
        }
        is DownloadState.Queued, is DownloadState.InProgress -> {
            val fraction = (state as? DownloadState.InProgress)?.fraction
            IconButton(onClick = { onCancel?.invoke() }, modifier = Modifier.size(40.dp).testTag("cancel-download")) {
                Box(contentAlignment = Alignment.Center) {
                    if (fraction != null) {
                        CircularProgressIndicator(
                            progress = { fraction }, color = Palette.accentFg, trackColor = Palette.bg3,
                            strokeWidth = 2.5.dp, modifier = Modifier.size(22.dp),
                        )
                    } else {
                        CircularProgressIndicator(color = Palette.accentFg, trackColor = Palette.bg3,
                                                  strokeWidth = 2.5.dp, modifier = Modifier.size(22.dp))
                    }
                    Icon(AppIcons.Close, contentDescription = "Cancel download", tint = Palette.fg3,
                         modifier = Modifier.size(11.dp))
                }
            }
        }
        is DownloadState.Done -> Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(AppIcons.DownloadDone, contentDescription = "On this device", tint = Palette.success,
                 modifier = Modifier.size(20.dp).testTag("downloaded"))
        }
    }
}

@Composable
private fun RowMenu(tag: String, content: @Composable ColumnScope.(dismiss: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconAction(AppIcons.More, "More actions", tag = "menu:$tag") { open = true }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = Palette.bg1,
            shape = ButtonShape,
        ) { content { open = false } }
    }
}

/** One entry of a row's ⋮ menu. */
@Composable
fun MenuEntry(
    text: String,
    icon: ImageVector,
    tag: String,
    destructive: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val color = if (destructive) Palette.danger else Palette.fg
    DropdownMenuItem(
        text = { Text(text, fontSize = 15.sp) },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp)) },
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.testTag(tag),
        colors = MenuDefaults.itemColors(
            textColor = color, leadingIconColor = if (destructive) Palette.danger else Palette.fg3,
            disabledTextColor = Palette.fg4, disabledLeadingIconColor = Palette.fg4,
        ),
    )
}

/** A row of the play-all controls above a list: Play (primary), Shuffle, extra. */
@Composable
fun PlayAllBar(
    playEnabled: Boolean,
    onPlay: () -> Unit,
    onShuffle: () -> Unit,
    modifier: Modifier = Modifier,
    trailing: @Composable () -> Unit = {},
) {
    Row(modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        PrimaryButton("Play", onPlay, icon = AppIcons.Play, enabled = playEnabled, tag = "play-all")
        Box(Modifier.padding(start = 8.dp)) {
            SecondaryButton("Shuffle", onShuffle, icon = AppIcons.Shuffle, enabled = playEnabled, tag = "shuffle-all")
        }
        Box(Modifier.weight(1f))
        trailing()
    }
}
