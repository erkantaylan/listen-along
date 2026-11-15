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
import com.erkantaylan.listenalong.core.designsystem.Palette

/** The bottom tabs and the route each opens (a tab's whole back stack counts as that tab). */
enum class Tab(val label: String, val icon: ImageVector, val tag: String, val route: Any) {
    LIBRARY("Library", AppIcons.Library, "tab:library", LibraryRoute),
    PLAYLISTS("Playlists", AppIcons.QueueMusic, "tab:playlists", PlaylistsGraph),
    DEVICE("On device", AppIcons.Phone, "tab:device", OnDeviceRoute),
    SETTINGS("Settings", AppIcons.Tune, "tab:settings", SettingsRoute),
}

/** Content above, then the mini player (when something is loaded), then the tabs. */
@Composable
fun AppShell(
    selected: Tab,
    onSelect: (Tab) -> Unit,
    badge: (Tab) -> String? = { null },
    miniPlayer: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.page)) {
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        miniPlayer?.invoke()
        Column(Modifier.fillMaxWidth().background(Palette.surface)) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.border))
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                Tab.entries.forEach { tab ->
                    TabButton(tab, tab == selected, badge(tab), Modifier.weight(1f)) { onSelect(tab) }
                }
            }
        }
    }
}

/** A bottom tab: icon in an accent-tinted pill when active (the web's active toggle), label under it. */
@Composable
private fun TabButton(tab: Tab, active: Boolean, badge: String?, modifier: Modifier, onClick: () -> Unit) {
    val tint = if (active) Palette.accentFg else Palette.fg3
    Column(
        modifier.testTag(tab.tag).clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(contentAlignment = Alignment.TopEnd) {
            Box(
                Modifier.clip(RoundedCornerShape(14.dp))
                    .background(if (active) Palette.accentSubtle else Palette.surface)
                    .border(1.dp, if (active) Palette.accentBorder else Palette.surface, RoundedCornerShape(14.dp))
                    .padding(horizontal = 16.dp, vertical = 3.dp),
            ) {
                Icon(tab.icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
            }
            if (badge != null) {
                Text(
                    badge, color = Palette.onAccent, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Palette.accent)
                        .border(1.dp, Palette.surface, RoundedCornerShape(8.dp))
                        .padding(horizontal = 5.dp),
                )
            }
        }
        Text(tab.label, color = tint, fontSize = 12.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
    }
}

