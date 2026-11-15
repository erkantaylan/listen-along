package com.erkantaylan.listenalong.core.designsystem

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * The web's controls that have no Material twin: the joined segmented control
 * for exclusive views (`.app-seg`), chips for real filters, the playlist cover
 * of initials (`.playlist-avatar.cover-N`), the equaliser of the playing row
 * and the downloaded mark. No accent edges: a selected or active thing is a
 * background tint (DESIGN.md "No accent edges").
 */

/** One cell of a [SegmentedControl]. */
data class Segment(val label: String, val tag: String, val icon: ImageVector? = null, val count: Int? = null, val countTone: BadgeTone = BadgeTone.NEUTRAL)

/**
 * `.app-seg`: views that exclude each other (All songs / Broken). One
 * `borderStrong` outline with control corners, the cells touching with a 1dp
 * divider of the same colour, the current one the accent tint with semibold
 * strong accent text. Never an underline, never separate pills. [fill]
 * shares the width equally (the web's `.app-seg-fill`); otherwise it is as
 * wide as its labels and scrolls sideways inside its outline when too wide.
 */
@Composable
fun SegmentedControl(
    segments: List<Segment>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    fill: Boolean = false,
) {
    val shape = RoundedCornerShape(Dimens.controlRadius)
    Row(
        modifier
            .let { if (fill) it.fillMaxWidth() else it }
            .height(IntrinsicSize.Min)
            .clip(shape)
            .border(1.dp, Palette.borderStrong, shape)
            .let { if (fill) it else it.horizontalScroll(rememberScrollState()) },
    ) {
        segments.forEachIndexed { i, segment ->
            if (i > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.borderStrong))
            SegmentCell(segment, i == selected, if (fill) Modifier.weight(1f) else Modifier) { onSelect(i) }
        }
    }
}

@Composable
private fun SegmentCell(segment: Segment, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        modifier
            .background(
                when {
                    active -> Palette.accentSubtle
                    pressed -> Palette.pressed
                    else -> Color.Transparent
                }
            )
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .semantics { this.selected = active; role = Role.Tab }
            .heightIn(min = Dimens.touchTarget)
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .testTag(segment.tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (segment.icon != null) {
            Icon(segment.icon, contentDescription = null, tint = if (active) Palette.accentFgStrong else Palette.fg2,
                 modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(
            segment.label,
            color = if (active) Palette.accentFgStrong else Palette.fg2,
            fontSize = TextSizes.sm,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 2,
            textAlign = TextAlign.Center,
        )
        if (segment.count != null) {
            Spacer(Modifier.width(6.dp))
            SubtleBadge("${segment.count}", tone = segment.countTone)
        }
    }
}

/**
 * A chip for a real filter you could combine with others ("Downloaded"):
 * a pill with a strong outline; on = the accent tint, an accent outline and a
 * check. 32dp tall with a 48dp touch target.
 */
@Composable
fun FilterChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    tag: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
) {
    val shape = CircleShape
    Box(
        modifier
            .heightIn(min = Dimens.touchTarget)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)
            .semantics { this.selected = selected; role = Role.Checkbox }
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier
                .clip(shape)
                .background(if (selected) Palette.accentSubtle else Color.Transparent)
                .border(1.dp, if (selected) Palette.accentBorder else Palette.borderStrong, shape)
                .heightIn(min = 32.dp)
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val lead = if (selected) AppIcons.Check else icon
            if (lead != null) {
                Icon(lead, contentDescription = null, tint = if (selected) Palette.accentFgStrong else Palette.fg2,
                     modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(label, color = if (selected) Palette.accentFgStrong else Palette.fg2, fontSize = TextSizes.sm,
                 fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
        }
    }
}

/**
 * `.playlist-avatar.cover-N`: a rounded square of the playlist's initials
 * on its cover colour (the same as on the web), `fg` bold text. Never an image.
 */
@Composable
fun CoverTile(id: String, name: String?, size: Dp = 48.dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).clip(RoundedCornerShape(Dimens.controlRadius)).background(Palette.coverFor(id)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            PlaylistCover.initials(name),
            color = Palette.fg,
            fontWeight = FontWeight.Bold,
            fontSize = (size.value * 0.32f).sp,
            maxLines = 1,
            overflow = TextOverflow.Clip,
        )
    }
}

/** The playing row's equaliser: three bars in the accent text colour, moving while [playing]. */
@Composable
fun EqualizerIcon(playing: Boolean, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    val transition = rememberInfiniteTransition(label = "eq")
    val phases = listOf(0, 180, 360).map { delay ->
        if (playing) transition.animateFloat(
            initialValue = 0.3f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(520, delayMillis = delay), RepeatMode.Reverse),
            label = "bar",
        ).value else 0.55f
    }
    Canvas(modifier.size(size).semantics { contentDescription = if (playing) "Playing" else "Paused" }) {
        val gap = this.size.width / 7
        val bar = (this.size.width - gap * 2) / 3
        phases.forEachIndexed { i, h ->
            val height = this.size.height * h
            drawRoundRect(
                Palette.accentFg,
                topLeft = Offset(i * (bar + gap), this.size.height - height),
                size = Size(bar, height),
                cornerRadius = CornerRadius(bar / 3),
            )
        }
    }
}

/** What a song or playlist's downloaded mark says. */
sealed interface DownloadMark {
    data object Downloaded : DownloadMark
    /** Downloading; [fraction] null while unknown. */
    data class Progress(val fraction: Float?) : DownloadMark
    /** Wanted but held back (no Wi-Fi, offline, paused): a faint ring. */
    data object Waiting : DownloadMark
}

/**
 * Spotify's downloaded mark: a small filled circle with a down arrow in the
 * success colour, next to a subtitle; a progress ring while downloading.
 * Decorative next to a text that says the same, so no TalkBack label by default.
 */
@Composable
fun DownloadMarkIcon(mark: DownloadMark, modifier: Modifier = Modifier, size: Dp = 16.dp, label: String? = null) {
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    when (mark) {
        DownloadMark.Downloaded ->
            Icon(AppIcons.DownloadedCircle, contentDescription = null, tint = Palette.success,
                 modifier = modifier.size(size).then(described).testTag("downloaded-mark"))
        is DownloadMark.Progress -> Box(modifier.size(size).then(described).testTag("downloading-mark"), contentAlignment = Alignment.Center) {
            if (mark.fraction != null) {
                CircularProgressIndicator(progress = { mark.fraction }, color = Palette.accentFg, trackColor = Palette.bg4,
                                          strokeWidth = 2.dp, modifier = Modifier.fillMaxSize())
            } else {
                CircularProgressIndicator(color = Palette.accentFg, trackColor = Palette.bg4, strokeWidth = 2.dp,
                                          modifier = Modifier.fillMaxSize())
            }
        }
        DownloadMark.Waiting ->
            Icon(AppIcons.DownloadCircleOutline, contentDescription = null, tint = Palette.fg4,
                 modifier = modifier.size(size).then(described).testTag("waiting-mark"))
    }
}

/** A muted meta line made of parts with " · " between them, an optional leading mark. */
@Composable
fun MetaLine(
    parts: List<String>,
    modifier: Modifier = Modifier,
    color: Color = Palette.fg3,
    leading: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(6.dp))
        }
        Text(parts.filter { it.isNotBlank() }.joinToString(" · "), color = color, fontSize = 13.sp, lineHeight = 18.sp,
             maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A column of rows with no outline (the web sidebar's separate rounded rows). */
@Composable
fun RowGroup(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().padding(horizontal = Dimens.space3), verticalArrangement = Arrangement.spacedBy(2.dp)) { content() }
}
