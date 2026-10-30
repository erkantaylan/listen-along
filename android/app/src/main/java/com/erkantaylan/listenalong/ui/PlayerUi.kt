package com.erkantaylan.listenalong.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import com.erkantaylan.listenalong.api.formatDuration
import com.erkantaylan.listenalong.player.NowPlaying
import com.erkantaylan.listenalong.player.PlayerConnection
import com.erkantaylan.listenalong.ui.theme.Palette
import kotlinx.coroutines.delay

/** The player's position, refreshed twice a second while [visible]. */
@Composable
private fun rememberPosition(player: PlayerConnection, now: NowPlaying): Long {
    var position by remember { mutableLongStateOf(player.positionMs()) }
    LaunchedEffect(now.songId, now.isPlaying) {
        while (true) {
            position = player.positionMs()
            if (!now.isPlaying) break
            delay(500)
        }
    }
    return position
}

@Composable
private fun rememberArtwork(bytes: ByteArray?): ImageBitmap? = remember(bytes) {
    bytes?.let { runCatching { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }.getOrNull() }
}

@Composable
private fun Cover(now: NowPlaying, size: Dp, corner: Dp) {
    val art = rememberArtwork(now.artwork)
    if (art != null) {
        Image(art, contentDescription = null, contentScale = ContentScale.Crop,
              modifier = Modifier.size(size).clip(RoundedCornerShape(corner)))
    } else {
        Box(Modifier.size(size).clip(RoundedCornerShape(corner)).background(Palette.bg2), contentAlignment = Alignment.Center) {
            Icon(AppIcons.MusicNote, contentDescription = null, tint = Palette.fg4, modifier = Modifier.size(size * 0.45f))
        }
    }
}

/** "artist · context" (the web bar's second line). */
private fun secondLine(now: NowPlaying): String =
    listOfNotNull(now.artist.takeIf { it.isNotBlank() }, now.context).joinToString(" · ")

/** The web's play button: a solid accent pill/circle. */
@Composable
private fun PlayPill(now: NowPlaying, size: Dp, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(size).testTag("player:toggle"),
        colors = IconButtonDefaults.iconButtonColors(containerColor = Palette.accent, contentColor = Palette.onAccent),
        shape = CircleShape,
    ) {
        Icon(if (now.isPlaying) AppIcons.Pause else AppIcons.Play,
             contentDescription = if (now.isPlaying) "Pause" else "Play", modifier = Modifier.size(size * 0.55f))
    }
}

/**
 * The persistent bar above the tabs (the web's `#player-bar` in its slim,
 * phone form): a thin progress line, cover, title / "artist · context",
 * play/pause and next. Tapping it opens the full player.
 */
@Composable
fun MiniPlayer(now: NowPlaying, player: PlayerConnection, onOpen: () -> Unit) {
    val position = rememberPosition(player, now)
    Column(Modifier.fillMaxWidth().background(Palette.surface).testTag("mini-player")) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.border))
        val fraction = if (now.durationMs > 0) (position.toFloat() / now.durationMs).coerceIn(0f, 1f) else 0f
        LinearProgressIndicator(
            progress = { fraction }, color = Palette.accentFg, trackColor = Palette.bg2,
            drawStopIndicator = {}, gapSize = 0.dp, modifier = Modifier.fillMaxWidth().height(2.dp),
        )
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Cover(now, 44.dp, 6.dp)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(now.title.ifBlank { "Untitled" }, color = Palette.fg, fontSize = 15.sp, maxLines = 1,
                     overflow = TextOverflow.Ellipsis)
                Text(secondLine(now), color = Palette.fg3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconAction(AppIcons.Previous, "Previous", tag = "mini:previous", onClick = player::previous)
            PlayPill(now, 40.dp, player::togglePlay)
            IconAction(AppIcons.Next, "Next", tag = "mini:next", enabled = now.hasNext, onClick = player::next)
        }
    }
}

/** Full-screen player: big cover, title, seek bar with times, and every control. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FullPlayer(now: NowPlaying, player: PlayerConnection, onClose: () -> Unit) {
    val position = rememberPosition(player, now)
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    var sheet by remember { mutableStateOf(false) }
    val song = remember(now.songId, now.title, now.artist) {
        now.songId?.let { com.erkantaylan.listenalong.api.Song(id = it, title = now.title, artist = now.artist) }
    }
    val reports = song?.let { LocalReports.current[it.id] }.orEmpty()

    Column(
        Modifier.fillMaxSize().background(Palette.page).testTag("full-player"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AppTopBar(
            title = "Now playing",
            subtitle = now.context?.let { { Text("from $it", color = Palette.fg3, fontSize = 12.sp, maxLines = 1) } },
            onBack = onClose,
        ) {
            if (song != null) IconAction(AppIcons.More, "Song actions", tag = "player:menu") { sheet = true }
        }
        Column(
            Modifier.weight(1f).widthIn(max = 520.dp).padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Box(
                Modifier.fillMaxWidth(0.86f).aspectRatio(1f)
                    .combinedClickable(onClick = {}, onLongClick = { if (song != null) sheet = true },
                                       onLongClickLabel = "Song actions"),
                contentAlignment = Alignment.Center,
            ) {
                val art = rememberArtwork(now.artwork)
                if (art != null) {
                    Image(art, contentDescription = null, contentScale = ContentScale.Crop,
                          modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)))
                } else {
                    Box(Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(Palette.surface),
                        contentAlignment = Alignment.Center) {
                        Icon(AppIcons.MusicNote, contentDescription = null, tint = Palette.fg4, modifier = Modifier.size(96.dp))
                    }
                }
            }
            Spacer(Modifier.height(28.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(now.title.ifBlank { "Untitled" }, color = Palette.fg, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                     textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis,
                     modifier = Modifier.weight(1f, fill = false).testTag("player:title")
                         .combinedClickable(onClick = {}, onLongClick = { if (song != null) sheet = true },
                                            onLongClickLabel = "Song actions"))
                if (song != null) ReportIcon(song, reports, size = 32.dp)
            }
            if (now.artist.isNotBlank()) {
                Text(now.artist, color = Palette.fg3, fontSize = 15.sp, textAlign = TextAlign.Center, maxLines = 1,
                     overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            }
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (now.local) SubtleBadge("On device", AppIcons.DownloadDone, accent = false)
                else SubtleBadge("Streaming", AppIcons.Public, accent = false)
                if (now.queueSize > 1) SubtleBadge("${now.index + 1} of ${now.queueSize}")
            }

            Spacer(Modifier.height(20.dp))
            val duration = now.durationMs.coerceAtLeast(0)
            val shown = if (dragging) dragValue else if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
            Slider(
                value = shown,
                onValueChange = { dragging = true; dragValue = it },
                onValueChangeFinished = {
                    if (duration > 0) player.seekTo((dragValue * duration).toLong())
                    dragging = false
                },
                enabled = duration > 0,
                colors = SliderDefaults.colors(
                    thumbColor = Palette.accentFg,
                    activeTrackColor = Palette.accent,
                    inactiveTrackColor = Palette.bg3,
                    disabledThumbColor = Palette.fg4,
                    disabledInactiveTrackColor = Palette.bg2,
                ),
                modifier = Modifier.fillMaxWidth().testTag("player:seek"),
            )
            Row(Modifier.fillMaxWidth()) {
                val at = if (dragging) (dragValue * duration).toLong() else position
                Text(formatDuration((at / 1000).toInt()), color = Palette.fg4, fontSize = 12.sp)
                Spacer(Modifier.weight(1f))
                Text(if (duration > 0) formatDuration((duration / 1000).toInt()) else if (now.buffering) "loading…" else "",
                     color = Palette.fg4, fontSize = 12.sp)
            }

            Spacer(Modifier.height(16.dp))
            Row(
                Modifier.fillMaxWidth().heightIn(min = 72.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconAction(AppIcons.Shuffle, if (now.shuffle) "Shuffle on" else "Shuffle off", tag = "player:shuffle",
                           active = now.shuffle, size = 48.dp, iconSize = 24.dp, onClick = player::toggleShuffle)
                IconAction(AppIcons.Previous, "Previous", tag = "player:previous", tint = Palette.fg2,
                           size = 56.dp, iconSize = 32.dp, onClick = player::previous)
                PlayPill(now, 72.dp, player::togglePlay)
                IconAction(AppIcons.Next, "Next", tag = "player:next", tint = Palette.fg2, enabled = now.hasNext,
                           size = 56.dp, iconSize = 32.dp, onClick = player::next)
                IconAction(
                    if (now.repeatMode == Player.REPEAT_MODE_ONE) AppIcons.RepeatOne else AppIcons.Repeat,
                    when (now.repeatMode) {
                        Player.REPEAT_MODE_ALL -> "Repeat all"
                        Player.REPEAT_MODE_ONE -> "Repeat one"
                        else -> "Repeat off"
                    },
                    tag = "player:repeat",
                    active = now.repeatMode != Player.REPEAT_MODE_OFF,
                    size = 48.dp, iconSize = 24.dp, onClick = player::cycleRepeat,
                )
            }
            Spacer(Modifier.height(24.dp))
        }
    }
    if (sheet && song != null) {
        SongActionsSheet(now.title, now.artist.takeIf { it.isNotBlank() }, onDismiss = { sheet = false }) { dismiss ->
            ReportMenuEntries(song, dismiss)
        }
    }
}
