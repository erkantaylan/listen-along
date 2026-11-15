package com.erkantaylan.listenalong.feature.player

import com.erkantaylan.listenalong.core.designsystem.AppIcons
import com.erkantaylan.listenalong.core.designsystem.Dimens
import com.erkantaylan.listenalong.core.designsystem.AppTopBar
import com.erkantaylan.listenalong.core.designsystem.BadgeTone
import com.erkantaylan.listenalong.core.designsystem.IconAction
import com.erkantaylan.listenalong.core.designsystem.SubtleBadge
import com.erkantaylan.listenalong.core.ui.LocalReports
import com.erkantaylan.listenalong.core.ui.ReportIcon
import com.erkantaylan.listenalong.core.ui.ReportMenuEntries
import com.erkantaylan.listenalong.core.ui.SongActionsSheet
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import coil3.compose.AsyncImage
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
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import com.erkantaylan.listenalong.core.model.formatDuration
import com.erkantaylan.listenalong.core.player.NowPlaying
import com.erkantaylan.listenalong.core.player.PlayerControls
import com.erkantaylan.listenalong.core.designsystem.Palette
import kotlinx.coroutines.delay

/** The player's position, refreshed twice a second while [visible]. */
@Composable
private fun rememberPosition(player: PlayerControls, now: NowPlaying): Long {
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

/**
 * The playing song's cover: the picture embedded in the file when the player
 * found one, else the item's cover (the saved one of a downloaded song, or
 * the public thumbnail) through the image loader, over the placeholder.
 */
@Composable
private fun Cover(now: NowPlaying, size: Dp, corner: Dp) {
    val art = rememberArtwork(now.artwork)
    if (art != null) {
        Image(art, contentDescription = null, contentScale = ContentScale.Crop,
              modifier = Modifier.size(size).clip(RoundedCornerShape(corner)))
    } else {
        Box(Modifier.size(size).clip(RoundedCornerShape(corner)).background(Palette.pressed), contentAlignment = Alignment.Center) {
            Icon(AppIcons.MusicNote, contentDescription = null, tint = Palette.fg4, modifier = Modifier.size(size * 0.45f))
            if (now.artworkUri != null) {
                AsyncImage(model = now.artworkUri, contentDescription = null, contentScale = ContentScale.Crop,
                           modifier = Modifier.size(size))
            }
        }
    }
}

/** "artist · context" (the web bar's second line). */
private fun secondLine(now: NowPlaying): String =
    listOfNotNull(now.artist.takeIf { it.isNotBlank() }, now.context).joinToString(" · ")

/** The web's play button: the primary accent pill (dark icon), darker while pressed. */
@Composable
private fun PlayPill(now: NowPlaying, size: Dp, onClick: () -> Unit) {
    val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    IconButton(
        onClick = onClick,
        interactionSource = interaction,
        modifier = Modifier.size(size).testTag("player:toggle"),
        colors = IconButtonDefaults.iconButtonColors(
            containerColor = if (pressed) Palette.accentPressed else Palette.accent,
            contentColor = Palette.onAccent,
        ),
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
fun MiniPlayer(now: NowPlaying, player: PlayerControls, onOpen: () -> Unit) {
    val position = rememberPosition(player, now)
    // The web's player bar on a phone: a rounded raised panel a gap above the
    // tabs, the song and the transport on one row, a thin seek line under it.
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Dimens.panelRadius)).background(Palette.raised).testTag("mini-player")) {
        val fraction = if (now.durationMs > 0) (position.toFloat() / now.durationMs).coerceIn(0f, 1f) else 0f
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 8.dp, end = 4.dp, top = 8.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Cover(now, 44.dp, 6.dp)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(now.title.ifBlank { "Untitled" }, color = Palette.fg, fontSize = 15.sp, maxLines = 1,
                     overflow = TextOverflow.Ellipsis)
                Text(secondLine(now), color = Palette.fg3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconAction(AppIcons.Previous, "Previous", tag = "mini:previous", size = 48.dp, onClick = player::previous)
            PlayPill(now, 46.dp, player::togglePlay)
            IconAction(AppIcons.Next, "Next", tag = "mini:next", enabled = now.hasNext, size = 48.dp, onClick = player::next)
        }
        LinearProgressIndicator(
            progress = { fraction }, color = Palette.accent, trackColor = Palette.bg4,
            drawStopIndicator = {}, gapSize = 0.dp,
            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp).height(3.dp).clip(RoundedCornerShape(2.dp)),
        )
    }
}

/** Full-screen player: big cover, title, seek bar with times, and every control. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FullPlayer(now: NowPlaying, player: PlayerControls, onClose: () -> Unit) {
    val position = rememberPosition(player, now)
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    var sheet by remember { mutableStateOf(false) }
    val song = remember(now.songId, now.title, now.artist) {
        now.songId?.let { com.erkantaylan.listenalong.core.model.Song(id = it, title = now.title, artist = now.artist) }
    }
    val reports = song?.let { LocalReports.current[it.id] }.orEmpty()

    // A full-screen page panel over the shell, on the page colour like every panel.
    Column(
        Modifier.fillMaxSize().background(Palette.page).padding(Dimens.gap).clip(RoundedCornerShape(Dimens.panelRadius))
            .background(Palette.surface).testTag("full-player"),
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
                    Box(Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)).background(Palette.surface)
                            .border(1.dp, Palette.border, RoundedCornerShape(12.dp)),
                        contentAlignment = Alignment.Center) {
                        Icon(AppIcons.MusicNote, contentDescription = null, tint = Palette.fg4, modifier = Modifier.size(96.dp))
                        if (now.artworkUri != null) {
                            AsyncImage(model = now.artworkUri, contentDescription = null, contentScale = ContentScale.Crop,
                                       modifier = Modifier.fillMaxSize().testTag("player:cover"))
                        }
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
                if (now.local) SubtleBadge("On device", AppIcons.DownloadDone, tone = BadgeTone.SUCCESS)
                else SubtleBadge("Streaming", AppIcons.Public)
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
                // The web's `.form-range`: a thin track filled with the accent and a round accent thumb.
                thumb = {
                    Box(Modifier.size(18.dp).clip(CircleShape).background(if (duration > 0) Palette.accent else Palette.fg4))
                },
                track = { state ->
                    val f = if (state.valueRange.endInclusive > state.valueRange.start)
                        ((state.value - state.valueRange.start) / (state.valueRange.endInclusive - state.valueRange.start)).coerceIn(0f, 1f)
                    else 0f
                    Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Palette.bg4)) {
                        Box(Modifier.fillMaxWidth(f).height(4.dp).background(Palette.accent))
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("player:seek"),
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
                PlayPill(now, 76.dp, player::togglePlay)
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
