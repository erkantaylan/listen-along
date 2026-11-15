package com.erkantaylan.listenalong.core.ui

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

/** Song id → open reports (ReportRepository), for every list and the player. */
val LocalReports = compositionLocalOf<Map<String, List<SongReport>>> { emptyMap() }

/** Whether the server can be reached; marking needs it. */
val LocalOnline = compositionLocalOf { true }

/** What the report entries and the icon ask of the app (MainActivity hosts the dialogs). */
class ReportActions(
    val mark: (Song) -> Unit,
    val edit: (Song, SongReport) -> Unit,
    val unmark: (Song) -> Unit,
    val details: (Song, List<SongReport>) -> Unit,
)

val LocalReportActions = staticCompositionLocalOf<ReportActions?> { null }

/** The muted warning tint of the broken icon. */
private val WarningMuted get() = Palette.warning.copy(alpha = 0.85f)

/** The bottom sheet's shape (its edge follows it). */
private val SheetShape = androidx.compose.foundation.shape.RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)

/**
 * The small warning icon after a reported song's title. A real button:
 * tapping it shows who marked it and why. Nothing when there are no reports.
 */
@Composable
fun ReportIcon(song: Song, reports: List<SongReport>, size: androidx.compose.ui.unit.Dp = 28.dp) {
    if (reports.isEmpty()) return
    val actions = LocalReportActions.current
    IconAction(
        AppIcons.Warning,
        "${ReportReasons.summary(reports.size)}. Show details",
        tag = "broken:${song.id}",
        tint = WarningMuted,
        size = size,
        iconSize = size * 0.6f,
    ) { actions?.details?.invoke(song, reports) }
}

/**
 * The song menu's report entries: "Mark as broken", or for your own report
 * "Edit broken report…" and "Unmark broken". [song] is null for a playlist
 * entry that is not in the library (nothing to report). Disabled offline.
 */
@Composable
fun ReportMenuEntries(song: Song?, dismiss: () -> Unit) {
    val actions = LocalReportActions.current ?: return
    val online = LocalOnline.current
    if (song == null) {
        MenuEntry("Not in the library yet", AppIcons.Warning, "menu-report-unavailable",
                  description = "It can be reported once it is uploaded", enabled = false) {}
        return
    }
    val reports = LocalReports.current[song.id].orEmpty()
    val mine = reports.firstOrNull { it.mine }
    val offlineNote = if (!online) "Needs a connection" else null
    if (mine != null) {
        MenuEntry("Edit broken report…", AppIcons.Edit, "menu-report-edit",
                  description = offlineNote ?: mine.reason ?: "No reason given", enabled = online) {
            dismiss(); actions.edit(song, mine)
        }
        MenuEntry("Unmark broken", AppIcons.Cancel, "menu-report-unmark", description = offlineNote, enabled = online) {
            dismiss(); actions.unmark(song)
        }
    } else {
        val already = reports.size.takeIf { it > 0 }?.let { "Already reported by $it ${if (it == 1) "person" else "people"}" }
        MenuEntry("Mark as broken", AppIcons.Warning, "menu-report",
                  description = offlineNote ?: already, enabled = online) {
            dismiss(); actions.mark(song)
        }
    }
}

/** The long-press menu: a bottom sheet with the song's name and its menu entries. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SongActionsSheet(
    title: String,
    subtitle: String?,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.(dismiss: () -> Unit) -> Unit,
) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        containerColor = Palette.overlay,
        scrimColor = Palette.backdrop,
        shape = SheetShape,
        modifier = Modifier.border(1.dp, Palette.borderStrong, SheetShape).testTag("song-sheet"),
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            Text(title.ifBlank { "Untitled" }, color = Palette.fg, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                 maxLines = 2, overflow = TextOverflow.Ellipsis,
                 modifier = Modifier.padding(horizontal = 20.dp))
            if (!subtitle.isNullOrBlank()) {
                Text(subtitle, color = Palette.fg3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                     modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp))
            }
            HorizontalDivider(color = Palette.borderSubtle, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
            Column(Modifier.padding(horizontal = 8.dp)) { content(onDismiss) }
        }
    }
}
