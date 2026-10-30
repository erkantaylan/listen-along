package com.erkantaylan.listenalong.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * The web app's palette (frontend/theme.css, DESIGN.md "Palette"), one to one.
 * Dark only: soft greys (never black), muted text, and one muted slate-blue
 * accent. There is no light scheme and no toggle, exactly as on the web.
 *
 * Use these names, never literal colours. DESIGN.md's "Android" section maps
 * each one to its CSS token and to the Material 3 role it fills.
 */
object Palette {
    /** `--app-page-bg`: behind everything. */
    val page = Color(0xFF232528)
    /** `--bs-bg-body`: the raised surface (cards, list groups, bars, inputs). */
    val surface = Color(0xFF2C2F33)
    /** `--bs-bg-1` … `--bs-bg-4`: subtle fills and hover/pressed states. */
    val bg1 = Color(0xFF33363A)
    val bg2 = Color(0xFF3A3D42)
    val bg3 = Color(0xFF42464B)
    val bg4 = Color(0xFF4C5056)

    /** `--bs-fg-body`: body text. */
    val fg = Color(0xFFE3E6E9)
    /** `--bs-fg-2`: secondary text. */
    val fg2 = Color(0xFFBFC4C9)
    /** `--bs-fg-3`: muted text (bylines, counts). */
    val fg3 = Color(0xFFA1A8AE)
    /** `--bs-fg-4`: faint (icons, timestamps, placeholders). */
    val fg4 = Color(0xFF7F868D)

    /** `--bs-border-color`. */
    val border = Color(0xFF3F4348)

    /** `--bs-primary-bg`: solid accent (the one primary button, the play pill). */
    val accent = Color(0xFF557799)
    /** `--bs-primary-fg`: accent text, links, active icons. */
    val accentFg = Color(0xFF9DB8D6)
    /** `--bs-primary-bg-subtle`: accent tint (current row, active toggle). */
    val accentSubtle = Color(0xFF34404D)
    /** `--bs-primary-contrast`: text on the solid accent. */
    val onAccent = Color(0xFFFFFFFF)

    /** `--bs-secondary-bg` / `-bg-subtle` / `-fg`: grey buttons and subtle badges. */
    val secondary = Color(0xFF42464B)
    val secondarySubtle = Color(0xFF383B40)
    val secondaryFg = Color(0xFFAEB4BA)

    /** Status only: `--bs-danger-bg` / `--bs-success-bg` and readable text tints of them. */
    val dangerSolid = Color(0xFFB35A57)
    val danger = Color(0xFFE39A97)
    val successSolid = Color(0xFF4B8F68)
    val success = Color(0xFF8CC7A3)
    val warning = Color(0xFFE0BE6E)

    /** `--app-backdrop` behind dialogs. */
    val backdrop = Color(0x8C0A0B0C)
}

private val colors = darkColorScheme(
    primary = Palette.accent,
    onPrimary = Palette.onAccent,
    primaryContainer = Palette.accentSubtle,
    onPrimaryContainer = Palette.accentFg,
    inversePrimary = Palette.accentFg,
    secondary = Palette.secondary,
    onSecondary = Palette.fg,
    secondaryContainer = Palette.secondarySubtle,
    onSecondaryContainer = Palette.fg,
    tertiary = Palette.accentFg,
    onTertiary = Palette.page,
    background = Palette.page,
    onBackground = Palette.fg,
    surface = Palette.surface,
    onSurface = Palette.fg,
    surfaceVariant = Palette.bg1,
    onSurfaceVariant = Palette.fg3,
    surfaceTint = Palette.surface,
    surfaceBright = Palette.bg2,
    surfaceDim = Palette.page,
    surfaceContainerLowest = Palette.page,
    surfaceContainerLow = Palette.surface,
    surfaceContainer = Palette.surface,
    surfaceContainerHigh = Palette.bg1,
    surfaceContainerHighest = Palette.bg2,
    inverseSurface = Palette.fg,
    inverseOnSurface = Palette.page,
    outline = Palette.border,
    outlineVariant = Palette.bg1,
    error = Palette.danger,
    onError = Palette.page,
    errorContainer = Palette.dangerSolid,
    onErrorContainer = Palette.fg,
    scrim = Palette.backdrop,
)

/**
 * The system font (Roboto here; the web uses the platform's system stack) at
 * the web's sizes: 16sp body, small headings, `fs-sm` (14sp) and `fs-xs`
 * (12sp) for secondary information. No display sizes.
 */
private val typography = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 26.sp),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp),
    titleSmall = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, lineHeight = 20.sp),
    labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, lineHeight = 16.sp),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, lineHeight = 14.sp),
)

@Composable
fun ListenAlongTheme(content: @Composable () -> Unit) {
    // Light system-bar icons always: the app is dark only.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = false
                isAppearanceLightNavigationBars = false
            }
        }
    }
    MaterialTheme(colorScheme = colors, typography = typography, content = content)
}
