package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.ui.theme.Palette

enum class Tab(val label: String, val shape: NavShape, val tag: String) {
    LIBRARY("Library", NavShape.CLOUD, "tab:library"),
    DEVICE("On device", NavShape.DOWNLOADED, "tab:device"),
    SETTINGS("Settings", NavShape.SETTINGS, "tab:settings"),
}

/** Content above, tab bar below. */
@Composable
fun AppShell(
    selected: Tab,
    onSelect: (Tab) -> Unit,
    badge: (Tab) -> String? = { null },
    content: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Palette.bg)) {
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        Column(Modifier.fillMaxWidth().background(Palette.panel)) {
            Box(Modifier.fillMaxWidth().size(1.dp).background(Palette.border))
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                Tab.entries.forEach { tab ->
                    TabButton(tab, tab == selected, badge(tab)) { onSelect(tab) }
                }
            }
        }
    }
}

@Composable
private fun TabButton(tab: Tab, active: Boolean, badge: String?, onClick: () -> Unit) {
    val tint = if (active) Palette.accent else Palette.textDim
    Column(
        Modifier
            .testTag(tab.tag)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 14.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        NavIcon(tab.shape, tint, Modifier.size(23.dp))
        Text(
            if (badge != null) "${tab.label} · $badge" else tab.label,
            color = tint,
            fontSize = 10.5.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
            letterSpacing = 0.2.sp,
        )
    }
}
