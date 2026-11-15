package com.erkantaylan.listenalong.app

import com.erkantaylan.listenalong.core.designsystem.AppIcons
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.core.designsystem.Dimens
import com.erkantaylan.listenalong.core.designsystem.Palette
import com.erkantaylan.listenalong.core.designsystem.QuietButton
import com.erkantaylan.listenalong.core.designsystem.Panel
import com.erkantaylan.listenalong.core.designsystem.TextSizes
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role

/** The bottom tabs and the route each opens (a tab's whole back stack counts as that tab). */
enum class Tab(val label: String, val icon: ImageVector, val tag: String, val route: Any) {
    LIBRARY("Library", AppIcons.Library, "tab:library", LibraryRoute),
    PLAYLISTS("Playlists", AppIcons.QueueMusic, "tab:playlists", PlaylistsGraph),
    DEVICE("On device", AppIcons.Phone, "tab:device", OnDeviceRoute),
    SETTINGS("Settings", AppIcons.Tune, "tab:settings", SettingsRoute),
}

/**
 * The web's app shell in its phone form: rounded panels floating on the page
 * colour with a gap between them and around the edge (DESIGN.md "App
 * shell"). The page panel holds the screen; under it the player bar (when
 * something is loaded) and the row of places, here the bottom tabs.
 */
@Composable
fun AppShell(
    selected: Tab,
    onSelect: (Tab) -> Unit,
    badge: (Tab) -> String? = { null },
    miniPlayer: (@Composable () -> Unit)? = null,
    /** A dismissible notice over the page (a newer app version). */
    notice: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().background(Palette.page).padding(Dimens.gap),
        verticalArrangement = Arrangement.spacedBy(Dimens.gap),
    ) {
        notice?.invoke()
        Panel(Modifier.weight(1f).fillMaxWidth()) { content() }
        miniPlayer?.invoke()
        Panel(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Tab.entries.forEach { tab ->
                    TabButton(tab, tab == selected, badge(tab), Modifier.weight(1f)) { onSelect(tab) }
                }
            }
        }
    }
}

/**
 * A place in the row (the web's `#app-places`): icon over a label; the place
 * on screen is the accent tint with accent text, never an underline or a bar.
 */
@Composable
private fun TabButton(tab: Tab, active: Boolean, badge: String?, modifier: Modifier, onClick: () -> Unit) {
    val tint = if (active) Palette.accentFgStrong else Palette.fg3
    val shape = RoundedCornerShape(Dimens.controlRadius)
    Column(
        modifier
            .testTag(tab.tag)
            .clip(shape)
            .background(if (active) Palette.accentSubtle else Palette.surface)
            .selectable(selected = active, role = Role.Tab, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
    ) {
        Box(contentAlignment = Alignment.TopEnd) {
            Icon(tab.icon, contentDescription = null, tint = tint, modifier = Modifier.padding(horizontal = 10.dp).size(22.dp))
            if (badge != null) {
                Text(
                    badge, color = Palette.onAccent, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Palette.accent)
                        .padding(horizontal = 5.dp),
                )
            }
        }
        Text(tab.label, color = tint, fontSize = TextSizes.xs, maxLines = 1,
             fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium)
    }
}

/**
 * "Version X.Y.Z is available": an info-tinted panel above the page, never a
 * dialog and never forced. Download opens the release in the browser; Later
 * hides that version for a few days.
 */
@Composable
fun UpdateBanner(version: String, onDownload: () -> Unit, onLater: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Dimens.panelRadius)).background(Palette.infoSubtle)
            .border(1.dp, Palette.infoBorder, RoundedCornerShape(Dimens.panelRadius))
            .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp)
            .testTag("update-banner"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(AppIcons.Download, contentDescription = null, tint = Palette.info, modifier = Modifier.size(20.dp))
        Text("Version $version is available", color = Palette.fg, fontSize = 14.sp,
             modifier = Modifier.weight(1f).padding(horizontal = 10.dp))
        QuietButton("Later", onLater, accent = false, tag = "update-later")
        QuietButton("Download", onDownload, tag = "update-download")
    }
}
