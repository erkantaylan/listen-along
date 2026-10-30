package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.ui.theme.Palette

/*
 * The handful of building blocks every screen is made of, each one a
 * stand-in for the Bootstrap component the web app uses (DESIGN.md
 * "Components and when to use them"): navbar, list group, buttons, icon
 * buttons, subtle badges, form controls, alerts, empty states, dialogs.
 */

/** Bootstrap's radii: buttons and inputs .5rem, cards and list groups .75rem. */
val ButtonShape = RoundedCornerShape(8.dp)
val CardShape = RoundedCornerShape(12.dp)

@Composable
fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier =
    clickable(
        interactionSource = remember { MutableInteractionSource() },
        indication = null,
        onClick = onClick,
    )

/** `nav.navbar.app-navbar`: back button or nothing, a small title, actions on the right. */
@Composable
fun AppTopBar(
    title: String,
    subtitle: (@Composable () -> Unit)? = null,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Column(Modifier.fillMaxWidth().background(Palette.surface)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = if (onBack == null) 16.dp else 4.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) IconAction(AppIcons.Back, "Back", onClick = onBack, tag = "back")
            Column(Modifier.weight(1f).padding(vertical = 8.dp, horizontal = if (onBack != null) 4.dp else 0.dp)) {
                Text(title, style = androidx.compose.material3.MaterialTheme.typography.titleMedium,
                     color = Palette.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.invoke()
            }
            actions()
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.border))
    }
}

/**
 * `.btn-text.theme-secondary.btn-icon` (tertiary): no fill, `fg2` icon, a grey
 * `pressed` fill while pressed. [active] is the toggled state: accent tint,
 * accent icon and a thin accent border.
 */
@Composable
fun IconAction(
    icon: ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    tag: String? = null,
    enabled: Boolean = true,
    active: Boolean = false,
    tint: Color = if (active) Palette.accentFg else Palette.fg2,
    size: Dp = 40.dp,
    iconSize: Dp = 22.dp,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    IconButton(
        onClick = onClick,
        enabled = enabled,
        interactionSource = interaction,
        modifier = modifier.size(size)
            .let { if (active) it.border(1.dp, Palette.accentBorder, CircleShape) else it }
            .let { if (tag != null) it.testTag(tag) else it },
        colors = IconButtonDefaults.iconButtonColors(
            containerColor = when {
                active -> Palette.accentSubtle
                pressed -> Palette.pressed
                else -> Color.Transparent
            },
            contentColor = if (pressed && !active && tint == Palette.fg2) Palette.fg else tint,
            disabledContentColor = Palette.fg4.copy(alpha = 0.55f),
        ),
    ) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(iconSize))
    }
}

/** Button height and padding: [compact] for top bars and dialogs. */
private fun buttonPadding(compact: Boolean) =
    if (compact) PaddingValues(horizontal = 12.dp, vertical = 4.dp) else PaddingValues(horizontal = 16.dp, vertical = 8.dp)
private fun Modifier.buttonSize(compact: Boolean) = heightIn(min = if (compact) 36.dp else 40.dp)

/** Disabled, every tier: flat `hover` fill, `fg4` label, subtle border, 70% alpha. */
private val DisabledBorder = BorderStroke(1.dp, Palette.borderSubtle)

/** `.btn-solid.theme-primary`: the one primary action in a view (accent fill, dark semibold label). */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    tag: String? = null,
    compact: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        interactionSource = interaction,
        border = if (enabled) null else DisabledBorder,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (pressed) Palette.accentPressed else Palette.accent,
            contentColor = Palette.onAccent,
            disabledContainerColor = Palette.hover,
            disabledContentColor = Palette.fg4,
        ),
        contentPadding = buttonPadding(compact),
        modifier = modifier.buttonSize(compact).alpha(if (enabled) 1f else 0.7f)
            .let { if (tag != null) it.testTag(tag) else it },
    ) { ButtonContent(text, icon, FontWeight.SemiBold) }
}

/**
 * `.btn` (secondary, tonal): `tonal` fill with a strong border. [outlined] is
 * `.btn-outline.theme-secondary`: the same border, no fill.
 */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    tag: String? = null,
    compact: Boolean = false,
    outlined: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        interactionSource = interaction,
        border = if (!enabled) DisabledBorder else BorderStroke(1.dp, if (pressed) Palette.borderHover else Palette.borderStrong),
        colors = ButtonDefaults.buttonColors(
            containerColor = when {
                pressed -> Palette.tonalHover
                outlined -> Color.Transparent
                else -> Palette.tonal
            },
            contentColor = Palette.fg,
            disabledContainerColor = Palette.hover,
            disabledContentColor = Palette.fg4,
        ),
        contentPadding = buttonPadding(compact),
        modifier = modifier.buttonSize(compact).alpha(if (enabled) 1f else 0.7f)
            .let { if (tag != null) it.testTag(tag) else it },
    ) { ButtonContent(text, icon) }
}

/**
 * `.btn-outline.theme-danger`: red label and border, red tint while pressed,
 * for anything that deletes, removes or revokes. [solid] is
 * `.btn-solid.theme-danger`, only for the confirm step of a destructive dialog.
 */
@Composable
fun DangerButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    tag: String? = null,
    compact: Boolean = false,
    solid: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        interactionSource = interaction,
        border = when {
            !enabled -> DisabledBorder
            solid -> null
            else -> BorderStroke(1.dp, Palette.dangerBorder)
        },
        colors = ButtonDefaults.buttonColors(
            containerColor = when {
                solid -> if (pressed) Palette.dangerBorder else Palette.dangerSolid
                pressed -> Palette.dangerSubtle
                else -> Color.Transparent
            },
            contentColor = if (solid) Palette.onSolid else Palette.danger,
            disabledContainerColor = Palette.hover,
            disabledContentColor = Palette.fg4,
        ),
        contentPadding = buttonPadding(compact),
        modifier = modifier.buttonSize(compact).alpha(if (enabled) 1f else 0.7f)
            .let { if (tag != null) it.testTag(tag) else it },
    ) { ButtonContent(text, icon, if (solid) FontWeight.SemiBold else FontWeight.Medium) }
}

/** `.btn-text.theme-secondary` / theme-primary: a quiet text button (small links like "Dismiss"). */
@Composable
fun QuietButton(text: String, onClick: () -> Unit, accent: Boolean = true, tag: String? = null, enabled: Boolean = true) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        interactionSource = interaction,
        modifier = if (tag != null) Modifier.testTag(tag) else Modifier,
        colors = ButtonDefaults.textButtonColors(
            containerColor = if (pressed) Palette.pressed else Color.Transparent,
            contentColor = if (accent) Palette.accentFg else Palette.fg2,
            disabledContentColor = Palette.fg4.copy(alpha = 0.55f),
        ),
    ) { Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelLarge) }
}

@Composable
private fun ButtonContent(text: String, icon: ImageVector?, weight: FontWeight = FontWeight.Medium) {
    if (icon != null) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
    }
    Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = weight, maxLines = 1)
}

/** `.badge-subtle.theme-*`: what a badge says decides its tone. */
enum class BadgeTone { NEUTRAL, ACCENT, WARNING, SUCCESS, DANGER }

/**
 * `.badge.badge-subtle.theme-*`: tinted fill plus a matching hairline border.
 * Neutral (counts, "Private") grey; downloading / unread accent; "Broken"
 * warning; done success; failed danger.
 */
@Composable
fun SubtleBadge(text: String, icon: ImageVector? = null, tone: BadgeTone = BadgeTone.NEUTRAL, tag: String? = null) {
    val (bg, edge, fg) = when (tone) {
        BadgeTone.NEUTRAL -> Triple(Palette.bg3, Palette.bg4, Palette.fg2)
        BadgeTone.ACCENT -> Triple(Palette.accentSubtle, Palette.accentBorder, Palette.accentFg)
        BadgeTone.WARNING -> Triple(Palette.warningSubtle, Palette.warningBorder, Palette.warning)
        BadgeTone.SUCCESS -> Triple(Palette.successSubtle, Palette.successBorder, Palette.success)
        BadgeTone.DANGER -> Triple(Palette.dangerSubtle, Palette.dangerBorder, Palette.danger)
    }
    val shape = RoundedCornerShape(6.dp)
    Row(
        Modifier
            .clip(shape)
            .background(bg)
            .border(1.dp, edge, shape)
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .let { if (tag != null) it.testTag(tag) else it },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(3.dp))
        }
        Text(text, color = fg, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, lineHeight = 14.sp)
    }
}

/** `.app-thumb`: a grey square with a music note (the web's placeholder cover). */
@Composable
fun Thumb(modifier: Modifier = Modifier, size: Dp = 44.dp, playing: Boolean = false) {
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(6.dp))
            .background(if (playing) Palette.accent else Palette.bg3),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (playing) AppIcons.Play else AppIcons.MusicNote,
            contentDescription = null,
            tint = if (playing) Palette.onAccent else Palette.fg3,
            modifier = Modifier.size(size * 0.5f),
        )
    }
}

/**
 * One `li.list-group-item` inside a list group drawn row by row (so it works
 * in a LazyColumn). The group has a 1dp `border` outline (each row draws its
 * share of it: the first and last rows round the corners) and the same colour
 * divides the rows. Row states, all distinguishable:
 *  - pressed: grey `pressed` fill;
 *  - [current] (`.is-playing`): accent tint plus a 3dp accent edge on the left
 *    (the caller colours the title `accentFgStrong`);
 *  - [lifted] (being dragged in edit mode): `pressed` fill (the caller adds the shadow).
 */
@Composable
fun ListGroupItem(
    index: Int,
    count: Int,
    modifier: Modifier = Modifier,
    current: Boolean = false,
    lifted: Boolean = false,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val first = index == 0
    val last = index == count - 1
    val top = if (first) 12.dp else 0.dp
    val bottom = if (last) 12.dp else 0.dp
    val shape = RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Column(
        modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(shape)
            .drawWithContent {
                drawContent()
                // This row's slice of the group's rounded outline: extend the
                // stroked rectangle past the edges that continue into a
                // neighbouring row, so only the sides (and our own end) show.
                val sw = 1.dp.toPx()
                val r = 12.dp.toPx()
                val y0 = if (first) sw / 2 else -r - sw
                val y1 = if (last) size.height - sw / 2 else size.height + r + sw
                drawRoundRect(
                    Palette.border,
                    topLeft = Offset(sw / 2, y0),
                    size = Size(size.width - sw, y1 - y0),
                    cornerRadius = CornerRadius(r - sw / 2),
                    style = Stroke(sw),
                )
            },
    ) {
        if (index > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.border))
        Row(
            Modifier
                .fillMaxWidth()
                .background(
                    when {
                        current -> Palette.accentSubtle
                        lifted || pressed -> Palette.pressed
                        else -> Palette.surface
                    }
                )
                .let {
                    if (current) it.drawBehind { drawRect(Palette.accent, size = Size(3.dp.toPx(), size.height)) } else it
                }
                .let {
                    if (onClick != null || onLongClick != null) {
                        it.combinedClickable(
                            interactionSource = interaction,
                            indication = null,
                            onClick = onClick ?: {},
                            onLongClick = onLongClick,
                            onLongClickLabel = if (onLongClick != null) "Song actions" else null,
                        )
                    } else it
                }
                .heightIn(min = 60.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f).padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = content,
            )
        }
    }
}

/** Title and a muted line under it, truncated, filling the row's free width. */
@Composable
fun RowScope.TitleAndMeta(
    title: String,
    meta: String,
    titleColor: Color = Palette.fg,
    extra: (@Composable () -> Unit)? = null,
    /** Right after the title (the broken-song icon). */
    titleTrailing: (@Composable () -> Unit)? = null,
) {
    Column(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = titleColor, fontSize = 15.sp, lineHeight = 20.sp, maxLines = 1,
                 overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            titleTrailing?.invoke()
        }
        if (meta.isNotEmpty()) {
            Text(meta, color = Palette.fg3, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 1,
                 overflow = TextOverflow.Ellipsis)
        }
        extra?.invoke()
    }
}

/** Small uppercase heading over a list (the people panel's "Online — n"). */
@Composable
fun SectionHeading(text: String, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(
        modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 16.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text.uppercase(), color = Palette.fg3, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
             letterSpacing = 0.8.sp, modifier = Modifier.weight(1f))
        trailing()
    }
}

/** `.form-control`: a sunken `field` well, strong border, 2dp accent border when focused. */
@Composable
fun TextInput(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    tag: String,
    modifier: Modifier = Modifier,
    secret: Boolean = false,
    leadingIcon: ImageVector? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Default,
    onSubmit: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    var focused by remember { mutableStateOf(false) }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clip(ButtonShape)
            .background(Palette.field)
            .border(if (focused) 2.dp else 1.dp, if (focused) Palette.accent else Palette.borderStrong, ButtonShape)
            .padding(start = 12.dp, end = if (trailing != null) 2.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leadingIcon != null) {
            Icon(leadingIcon, contentDescription = null, tint = Palette.fg3, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
        }
        Box(Modifier.weight(1f).padding(vertical = 10.dp)) {
            if (value.isEmpty()) {
                Text(placeholder, color = Palette.fg4, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = TextStyle(color = Palette.fg, fontSize = 15.sp),
                cursorBrush = SolidColor(Palette.accentFg),
                visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(
                    keyboardType = keyboardType,
                    imeAction = imeAction,
                    autoCorrectEnabled = false,
                ),
                keyboardActions = KeyboardActions(onAny = { onSubmit?.invoke() }),
                modifier = Modifier.fillMaxWidth().testTag(tag).onFocusChanged { focused = it.isFocused },
            )
        }
        trailing?.invoke()
    }
}

/** `.form-label`. */
@Composable
fun FieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, color = Palette.fg2, fontSize = 14.sp, fontWeight = FontWeight.Medium,
         modifier = modifier.padding(bottom = 6.dp))
}

/** `.card` (surface, `border` outline) with an optional `.card-header` (h6) on `raised`. */
@Composable
fun Card(modifier: Modifier = Modifier, title: String? = null, content: @Composable () -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .clip(CardShape)
            .background(Palette.surface)
            .border(1.dp, Palette.border, CardShape),
    ) {
        if (title != null) {
            Text(title, color = Palette.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                 modifier = Modifier.fillMaxWidth().background(Palette.raised)
                     .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp))
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.border))
        }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) { content() }
    }
}

enum class AlertKind { INFO, WARNING, DANGER, SUCCESS }

/** `.alert.theme-*`: a tinted box with a one-line notice. */
@Composable
fun Alert(text: String, kind: AlertKind = AlertKind.INFO, modifier: Modifier = Modifier,
          icon: ImageVector? = null, action: (@Composable () -> Unit)? = null) {
    val (bg, edge, fg) = when (kind) {
        AlertKind.INFO -> Triple(Palette.infoSubtle, Palette.infoBorder, Palette.info)
        AlertKind.WARNING -> Triple(Palette.warningSubtle, Palette.warningBorder, Palette.warning)
        AlertKind.DANGER -> Triple(Palette.dangerSubtle, Palette.dangerBorder, Palette.danger)
        AlertKind.SUCCESS -> Triple(Palette.successSubtle, Palette.successBorder, Palette.success)
    }
    Row(
        modifier.fillMaxWidth().clip(ButtonShape).background(bg).border(1.dp, edge, ButtonShape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, color = Palette.fg, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

/** `li.list-group-item.app-empty`: a faint icon, one line, an optional action. */
@Composable
fun EmptyState(
    title: String,
    body: String? = null,
    icon: ImageVector = AppIcons.MusicNote,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, contentDescription = null, tint = Palette.fg4, modifier = Modifier.size(36.dp))
        Text(title, color = Palette.fg2, fontSize = 15.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
        if (body != null) {
            Text(body, color = Palette.fg3, fontSize = 13.sp, lineHeight = 18.sp, textAlign = TextAlign.Center)
        }
        if (action != null) Box(Modifier.padding(top = 6.dp)) { action() }
    }
}

@Composable
fun Centre(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { content() }
}

@Composable
fun MetaSeparator() {
    Text("·", color = Palette.fg4, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 5.dp))
}

/*
 * Overlays (dialogs, bottom sheets, menus, snackbars): `overlay` fill with a
 * 1dp `borderStrong` edge, the web's `.app-modal-card` / `.menu`.
 */

/** The edge every dialog gets (pass as the `AlertDialog` modifier). */
fun Modifier.dialogEdge(): Modifier = border(1.dp, Palette.borderStrong, CardShape)

/** A dialog's main action: primary, or solid danger when it deletes something. */
@Composable
fun DialogConfirm(text: String, onClick: () -> Unit, enabled: Boolean = true, destructive: Boolean = false) {
    if (destructive) DangerButton(text, onClick, enabled = enabled, tag = "dialog:confirm", compact = true, solid = true)
    else PrimaryButton(text, onClick, enabled = enabled, tag = "dialog:confirm", compact = true)
}

/** A dialog's Cancel / Close: secondary (tonal). */
@Composable
fun DialogDismiss(onClick: () -> Unit, text: String = "Cancel", tag: String = "dialog:dismiss") {
    SecondaryButton(text, onClick, tag = tag, compact = true)
}

/** `.menu`: a dropdown on `overlay` with a strong edge. */
@Composable
fun AppDropdownMenu(expanded: Boolean, onDismissRequest: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        containerColor = Palette.overlay,
        shape = ButtonShape,
        border = BorderStroke(1.dp, Palette.borderStrong),
        shadowElevation = 8.dp,
        content = content,
    )
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = false,
    showCancel: Boolean = true,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.overlay,
        titleContentColor = Palette.fg,
        textContentColor = Palette.fg2,
        shape = CardShape,
        modifier = Modifier.dialogEdge(),
        title = { Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = { Text(text, fontSize = 14.sp, lineHeight = 20.sp) },
        confirmButton = { DialogConfirm(confirmLabel, onConfirm, destructive = destructive) },
        dismissButton = if (showCancel) { { DialogDismiss(onDismiss) } } else null,
    )
}

/** A dialog with one text field (new playlist, rename). */
@Composable
fun TextPromptDialog(
    title: String,
    initial: String,
    placeholder: String,
    confirmLabel: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
    extra: (@Composable () -> Unit)? = null,
) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.overlay,
        titleContentColor = Palette.fg,
        shape = CardShape,
        modifier = Modifier.dialogEdge(),
        title = { Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TextInput(text, { text = it.take(50) }, placeholder, tag = "dialog:text",
                          imeAction = ImeAction.Done, onSubmit = { if (text.isNotBlank()) onConfirm(text.trim()) })
                extra?.invoke()
            }
        },
        confirmButton = { DialogConfirm(confirmLabel, { onConfirm(text.trim()) }, enabled = text.isNotBlank()) },
        dismissButton = { DialogDismiss(onDismiss) },
    )
}

/** A thin vertical rule, for separating icon groups. */
@Composable
fun VRule() {
    Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.border))
}
