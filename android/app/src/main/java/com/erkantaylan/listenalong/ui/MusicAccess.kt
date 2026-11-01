package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Media-read access: what is known about it, and how to ask. Provided by MainActivity. */
class MusicAccessUi(
    val granted: Boolean,
    val offerPrompt: Boolean,
    val request: () -> Unit,
    val dismiss: () -> Unit,
)

val LocalMusicAccess = staticCompositionLocalOf {
    MusicAccessUi(granted = true, offerPrompt = false, request = {}, dismiss = {})
}

/** Offers access when nothing is downloaded yet, which is also how a reinstall looks. */
@Composable
fun MusicAccessPrompt(modifier: Modifier = Modifier) {
    val access = LocalMusicAccess.current
    if (!access.offerPrompt) return
    Alert(
        "Songs in Music/ListenAlong from an earlier install? Allow music access so the app recognises them instead of downloading them again.",
        AlertKind.INFO, modifier = modifier,
        icon = AppIcons.Download,
        action = {
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                QuietButton("Allow", access.request, tag = "music-access-allow")
                QuietButton("Not now", access.dismiss, accent = false, tag = "music-access-dismiss")
            }
        },
    )
}

/** Says why songs found earlier stream or cannot be opened once access was taken back. */
@Composable
fun MusicAccessOffNotice(reclaimed: Int, modifier: Modifier = Modifier) {
    val access = LocalMusicAccess.current
    if (access.granted || reclaimed == 0) return
    Alert(
        "Music access is off: $reclaimed songs from an earlier install cannot be read here, so they stream when online.",
        AlertKind.WARNING, modifier = modifier,
        action = { QuietButton("Allow", access.request, tag = "music-access-allow") },
    )
}
