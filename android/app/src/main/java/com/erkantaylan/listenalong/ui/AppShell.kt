package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.background
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
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.ui.theme.Palette

enum class Tab(val label: String, val icon: ImageVector, val tag: String) {
    LIBRARY("Library", AppIcons.Library, "tab:library"),
    PLAYLISTS("Playlists", AppIcons.QueueMusic, "tab:playlists"),
    DEVICE("On device", AppIcons.Phone, "tab:device"),
    SETTINGS("Settings", AppIcons.Tune, "tab:settings"),
}

/** What screens can ask of the app, so they need not know about the activity. */
class AppActions(
    /** Play [songs] from [index]; [context] is the "from" label. [shuffle] plays them shuffled. */
    val play: (songs: List<Song>, index: Int, context: String, shuffle: Boolean) -> Unit,
    val addToPlaylist: (List<Song>) -> Unit,
    /** Asks for the notification (and on old Androids storage) permission before the first download. */
    val beforeDownload: () -> Unit,
    val queued: (Int) -> Unit,
    val message: (String) -> Unit,
    val openSettings: () -> Unit,
    /** The web profile page, where API tokens are made. */
    val openProfile: () -> Unit,
    val openExternal: (LocalSong) -> Unit,
    /** "music.etaylan.com", for hints. */
    val serverName: () -> String,
)

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
                    .padding(horizontal = 16.dp, vertical = 3.dp),
            ) {
                Icon(tab.icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
            }
            if (badge != null) {
                Text(
                    badge, color = Palette.onAccent, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Palette.accent)
                        .padding(horizontal = 5.dp),
                )
            }
        }
        Text(tab.label, color = tint, fontSize = 12.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
    }
}

