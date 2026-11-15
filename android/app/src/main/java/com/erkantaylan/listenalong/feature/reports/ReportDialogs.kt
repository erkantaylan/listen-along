package com.erkantaylan.listenalong.feature.reports

import com.erkantaylan.listenalong.core.designsystem.dialogEdge
import com.erkantaylan.listenalong.core.designsystem.Alert
import com.erkantaylan.listenalong.core.designsystem.AlertKind
import com.erkantaylan.listenalong.core.designsystem.AppIcons
import com.erkantaylan.listenalong.core.designsystem.ButtonShape
import com.erkantaylan.listenalong.core.designsystem.CardShape
import com.erkantaylan.listenalong.core.designsystem.DialogConfirm
import com.erkantaylan.listenalong.core.designsystem.DialogDismiss
import com.erkantaylan.listenalong.core.designsystem.IconAction
import com.erkantaylan.listenalong.core.designsystem.TextInput
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SongReport
import com.erkantaylan.listenalong.core.data.ReportReasons
import com.erkantaylan.listenalong.core.designsystem.Palette

/*
 * "Mark as broken — needs replacement", as on the web (frontend/song-reports.js):
 * the song menu's report entries, the warning icon after a reported song's
 * title, its details dialog, and the mark / edit dialog. The menu itself is
 * the row's ⋮ dropdown or, on a long-press, a bottom sheet with the same items.
 */

/** Who marked a song as broken, why and when (the web's popover). */
@Composable
fun ReportDetailsDialog(song: Song, reports: List<SongReport>, onDismiss: () -> Unit) {
    val n = reports.size
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.overlay,
        shape = CardShape,
        modifier = Modifier.dialogEdge().testTag("report-details"),
        title = {
            Column {
                Text("Needs replacement · $n ${if (n == 1) "report" else "reports"}", color = Palette.fg,
                     fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(song.title.ifBlank { "Untitled" } + (song.artist.takeIf { it.isNotBlank() && it != "Unknown" }?.let { " — $it" } ?: ""),
                     color = Palette.fg3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        },
        text = {
            LazyColumn(Modifier.heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(reports, key = { it.id }) { r ->
                    Column(Modifier.semantics(mergeDescendants = true) {}) {
                        Text(r.reason?.takeIf { it.isNotBlank() } ?: "No reason given",
                             color = if (r.reason.isNullOrBlank()) Palette.fg3 else Palette.fg, fontSize = 15.sp)
                        val time = ReportReasons.relative(r.updatedAt ?: r.createdAt)
                        Text(ReportReasons.who(r) + if (time.isNotEmpty()) ", $time" else "",
                             color = Palette.fg4, fontSize = 13.sp)
                    }
                }
                item(key = "hint") {
                    Text("The warning goes away for everyone when someone replaces the song's audio.",
                         color = Palette.fg4, fontSize = 12.sp, lineHeight = 16.sp)
                }
            }
        },
        confirmButton = {
            DialogDismiss(onDismiss, text = "Close", tag = "dialog:confirm")
        },
    )
}

/**
 * "Mark as broken" / "Edit your report": optional reason from the presets or
 * typed (≤ 200 characters). [busy] while the request runs; [error] if it failed.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReportDialog(
    song: Song,
    current: SongReport?,
    busy: Boolean,
    error: String?,
    onSubmit: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var reason by remember { mutableStateOf(current?.reason.orEmpty()) }
    val editing = current != null
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.overlay,
        shape = CardShape,
        modifier = Modifier.dialogEdge().testTag("report-dialog"),
        title = { Text(if (editing) "Edit your report" else "Mark as broken", color = Palette.fg, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "${song.title.ifBlank { "This song" }}${song.artist.takeIf { it.isNotBlank() && it != "Unknown" }?.let { " — $it" } ?: ""} " +
                        "gets a warning icon for everyone until someone replaces its audio.",
                    color = Palette.fg3, fontSize = 14.sp, lineHeight = 20.sp,
                )
                Text("What is wrong? (optional)", color = Palette.fg2, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ReportReasons.PRESETS.forEach { preset ->
                        val on = reason.trim() == preset
                        ReasonChip(preset, on) { reason = if (on) "" else preset }
                    }
                }
                TextInput(
                    value = reason,
                    onValueChange = { reason = it.take(ReportReasons.MAX) },
                    placeholder = "Or describe it…",
                    tag = "report-reason",
                )
                Text("${reason.length}/${ReportReasons.MAX}", color = Palette.fg4, fontSize = 12.sp,
                     textAlign = TextAlign.End, modifier = Modifier.fillMaxWidth())
                if (error != null) Alert(error, AlertKind.DANGER)
            }
        },
        confirmButton = {
            DialogConfirm(if (busy) "Saving…" else if (editing) "Update" else "Mark as broken",
                          { onSubmit(reason) }, enabled = !busy)
        },
        dismissButton = {
            DialogDismiss(onDismiss)
        },
    )
}

/** A preset reason: `.btn.btn-sm`, accent-tinted when chosen. */
@Composable
private fun ReasonChip(text: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(ButtonShape)
            .background(if (selected) Palette.accentSubtle else Palette.tonal)
            .border(1.dp, if (selected) Palette.accentBorder else Palette.borderStrong, ButtonShape)
            .clickable(onClick = onClick)
            .semantics { role = Role.Checkbox; this.selected = selected; contentDescription = text }
            .heightIn(min = 36.dp)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag("reason:$text"),
    ) {
        Text(text, color = if (selected) Palette.accentFg else Palette.fg, fontSize = 14.sp)
    }
}
