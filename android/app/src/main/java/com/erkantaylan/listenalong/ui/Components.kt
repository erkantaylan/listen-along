package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.material3.OutlinedButton
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

/** `.btn-text.theme-secondary.btn-icon`: grey icon, accent tint when [active]. */
@Composable
fun IconAction(
    icon: ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    tag: String? = null,
    enabled: Boolean = true,
    active: Boolean = false,
    tint: Color = if (active) Palette.accentFg else Palette.fg3,
    size: Dp = 40.dp,
    iconSize: Dp = 22.dp,
    onClick: () -> Unit,
) {
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.size(size).let { if (tag != null) it.testTag(tag) else it },
        colors = IconButtonDefaults.iconButtonColors(
            containerColor = if (active) Palette.accentSubtle else Color.Transparent,
            contentColor = tint,
            disabledContentColor = Palette.fg4.copy(alpha = 0.6f),
        ),
    ) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(iconSize))
    }
}

/** `.btn-solid.theme-primary`: the one primary action in a view. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    tag: String? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Palette.accent, contentColor = Palette.onAccent,
            disabledContainerColor = Palette.accent.copy(alpha = 0.45f),
            disabledContentColor = Palette.onAccent.copy(alpha = 0.6f),
        ),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        modifier = modifier.heightIn(min = 40.dp).let { if (tag != null) it.testTag(tag) else it },
    ) { ButtonContent(text, icon) }
}

/** `.btn` (neutral grey). */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    tag: String? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Palette.secondary, contentColor = Palette.fg,
            disabledContainerColor = Palette.secondarySubtle, disabledContentColor = Palette.fg4,
        ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        modifier = modifier.heightIn(min = 40.dp).let { if (tag != null) it.testTag(tag) else it },
    ) { ButtonContent(text, icon) }
}

/** `.btn-outline.theme-danger`. */
@Composable
fun DangerButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    OutlinedButton(
        onClick = onClick,
        shape = ButtonShape,
        border = BorderStroke(1.dp, Palette.dangerSolid),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.danger),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        modifier = modifier.heightIn(min = 40.dp),
    ) { ButtonContent(text, icon) }
}

/** `.btn-text.theme-secondary` / theme-primary: a quiet text button. */
@Composable
fun QuietButton(text: String, onClick: () -> Unit, accent: Boolean = true, tag: String? = null, enabled: Boolean = true) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        shape = ButtonShape,
        modifier = if (tag != null) Modifier.testTag(tag) else Modifier,
        colors = ButtonDefaults.textButtonColors(
            contentColor = if (accent) Palette.accentFg else Palette.secondaryFg,
            disabledContentColor = Palette.fg4,
        ),
    ) { Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelLarge) }
}

@Composable
private fun ButtonContent(text: String, icon: ImageVector?) {
    if (icon != null) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
    }
    Text(text, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, maxLines = 1)
}

/** `.badge.badge-subtle.theme-secondary` (or theme-primary when [accent]). */
@Composable
fun SubtleBadge(text: String, icon: ImageVector? = null, accent: Boolean = false, tag: String? = null) {
    val fg = if (accent) Palette.accentFg else Palette.secondaryFg
    Row(
        Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (accent) Palette.accentSubtle else Palette.secondarySubtle)
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

/** `.app-thumb`: a 3rem grey square with a music note (the web's placeholder cover). */
@Composable
fun Thumb(modifier: Modifier = Modifier, size: Dp = 44.dp, playing: Boolean = false) {
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(6.dp))
            .background(if (playing) Palette.accent else Palette.bg2),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (playing) AppIcons.Play else AppIcons.MusicNote,
            contentDescription = null,
            tint = if (playing) Palette.onAccent else Palette.fg4,
            modifier = Modifier.size(size * 0.5f),
        )
    }
}

/**
 * One `li.list-group-item` inside a list group drawn row by row (so it works
 * in a LazyColumn): the first and last rows round the group's corners and a
 * hairline separates the rows. [current] is `.is-playing`: accent tint plus a
 * 3px accent edge on the left.
 */
@Composable
fun ListGroupItem(
    index: Int,
    count: Int,
    modifier: Modifier = Modifier,
    current: Boolean = false,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val top = if (index == 0) 12.dp else 0.dp
    val bottom = if (index == count - 1) 12.dp else 0.dp
    val shape = RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(shape)) {
        if (index > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.border))
        Row(
            Modifier
                .fillMaxWidth()
                .background(if (current) Palette.accentSubtle else Palette.surface)
                .let {
                    if (onClick != null || onLongClick != null) {
                        it.combinedClickableCompat(onClick ?: {}, onLongClick)
                    } else it
                }
                .heightIn(min = 60.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (current) Box(Modifier.width(3.dp).height(60.dp).background(Palette.accent))
            Row(
                Modifier.weight(1f).padding(start = if (current) 9.dp else 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = content,
            )
        }
    }
}

@Composable
private fun Modifier.combinedClickableCompat(onClick: () -> Unit, onLongClick: (() -> Unit)?): Modifier =
    combinedClickable(onClick = onClick, onLongClick = onLongClick)

/** Title and a muted line under it, truncated, filling the row's free width. */
@Composable
fun RowScope.TitleAndMeta(title: String, meta: String, titleColor: Color = Palette.fg, extra: (@Composable () -> Unit)? = null) {
    Column(Modifier.weight(1f).padding(start = 12.dp, end = 4.dp)) {
        Text(title, color = titleColor, fontSize = 15.sp, lineHeight = 20.sp, maxLines = 1,
             overflow = TextOverflow.Ellipsis)
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

/** `.form-control`: surface fill, border, accent border when focused. */
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
            .background(Palette.surface)
            .border(1.dp, if (focused) Palette.accent else Palette.border, ButtonShape)
            .padding(start = 12.dp, end = if (trailing != null) 2.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leadingIcon != null) {
            Icon(leadingIcon, contentDescription = null, tint = Palette.fg4, modifier = Modifier.size(20.dp))
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

/** `.card` with an optional `.card-header` (h6). */
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
                 modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp))
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
    val (bg, fg) = when (kind) {
        AlertKind.INFO -> Palette.accentSubtle to Palette.accentFg
        AlertKind.WARNING -> Color(0xFF433B2A) to Palette.warning
        AlertKind.DANGER -> Color(0xFF4A3232) to Palette.danger
        AlertKind.SUCCESS -> Color(0xFF2F4237) to Palette.success
    }
    Row(
        modifier.fillMaxWidth().clip(ButtonShape).background(bg).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, color = fg, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
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
        containerColor = Palette.surface,
        titleContentColor = Palette.fg,
        textContentColor = Palette.fg2,
        shape = CardShape,
        title = { Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = { Text(text, fontSize = 14.sp, lineHeight = 20.sp) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("dialog:confirm")) {
                Text(confirmLabel, color = if (destructive) Palette.danger else Palette.accentFg,
                     fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = if (showCancel) {
            {
                TextButton(onClick = onDismiss, modifier = Modifier.testTag("dialog:dismiss")) {
                    Text("Cancel", color = Palette.fg3)
                }
            }
        } else null,
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
        containerColor = Palette.surface,
        titleContentColor = Palette.fg,
        shape = CardShape,
        title = { Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                TextInput(text, { text = it.take(50) }, placeholder, tag = "dialog:text",
                          imeAction = ImeAction.Done, onSubmit = { if (text.isNotBlank()) onConfirm(text.trim()) })
                extra?.invoke()
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text.trim()) }, enabled = text.isNotBlank(),
                       modifier = Modifier.testTag("dialog:confirm")) {
                Text(confirmLabel, color = if (text.isNotBlank()) Palette.accentFg else Palette.fg4,
                     fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("dialog:dismiss")) {
                Text("Cancel", color = Palette.fg3)
            }
        },
    )
}

/** A thin vertical rule, for separating icon groups. */
@Composable
fun VRule() {
    Box(Modifier.width(1.dp).fillMaxHeight().background(Palette.border))
}
