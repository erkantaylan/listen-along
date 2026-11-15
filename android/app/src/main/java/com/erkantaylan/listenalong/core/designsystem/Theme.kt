package com.erkantaylan.listenalong.core.designsystem

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * The web app's palette (frontend/theme.css, DESIGN.md "Palette"), one to one.
 * Dark only: soft greys (never black), muted text, and one cornflower-blue
 * accent used as a fill with dark text. There is no light scheme and no toggle, exactly as on the web.
 *
 * Use these names, never literal colours. DESIGN.md's "Android" section maps
 * each one to its CSS token and to the Material 3 role it fills.
 */
object Palette {
    // --- Elevation: page < surface < raised < overlay (each step lighter). ---
    /** `--app-page-bg`: behind everything. */
    val page = Color(0xFF1D1F22)
    /** `--app-surface`: cards, list groups, top bar, tab bar. */
    val surface = Color(0xFF2A2D31)
    /** `--app-raised`: the mini player, card headers. */
    val raised = Color(0xFF33373C)
    /** `--app-overlay`: menus, bottom sheets, dialogs, snackbars. */
    val overlay = Color(0xFF3B4046)
    /** `--app-field-bg`: the sunken well of text fields. */
    val field = Color(0xFF222528)
    /** `--app-btn-tonal` / `-hover`: secondary (tonal) button fill. */
    val tonal = Color(0xFF41464D)
    val tonalHover = Color(0xFF4B5158)
    /** `--bs-bg-1` / `--bs-bg-2`: row hover / pressed fill (also the disabled fill). */
    val hover = Color(0xFF32363B)
    val pressed = Color(0xFF3A3E44)
    /** `--bs-bg-3` / `--bs-bg-4`: neutral badge fill / its border, placeholder covers. */
    val bg3 = Color(0xFF444950)
    val bg4 = Color(0xFF52575E)

    // --- Text ---
    /** `--app-text`: body text. */
    val fg = Color(0xFFE8EAED)
    /** `--app-text-secondary`: secondary text, icon buttons. */
    val fg2 = Color(0xFFC3C8CE)
    /** `--app-text-muted`: meta lines, hints, times. */
    val fg3 = Color(0xFFA4ABB3)
    /** `--app-text-faint`: placeholders, drag handles, disabled. */
    val fg4 = Color(0xFF8F969E)

    // --- Borders ---
    /** `--app-border-subtle`: dividers inside a component. */
    val borderSubtle = Color(0xFF3D4147)
    /** `--app-border`: outline of cards, list groups, bars. */
    val border = Color(0xFF50565D)
    /** `--app-border-strong`: text fields, secondary buttons, overlays (3:1). */
    val borderStrong = Color(0xFF737A83)
    /** `--app-border-hover`. */
    val borderHover = Color(0xFF8C939C)

    // --- Accent (cornflower blue), used as a fill with dark text. ---
    /** `--app-accent`: primary buttons, the play pill, seek fill. */
    val accent = Color(0xFF7CACEE)
    val accentHover = Color(0xFF97BDF2)
    val accentPressed = Color(0xFF6A9DE3)
    /** `--app-on-accent`: text and icons on the accent fill (dark). */
    val onAccent = Color(0xFF0E1B2C)
    /** `--app-accent-text`: links, toggled icons. */
    val accentFg = Color(0xFF8FBAF2)
    /** `--app-accent-text-strong`: the playing title. */
    val accentFgStrong = Color(0xFFB9D3F7)
    /** `--app-accent-subtle`: playing row, toggled icon buttons, chosen chips. */
    val accentSubtle = Color(0xFF2B3A4F)
    /** `--app-accent-border`: toggled icon / chosen chip border. */
    val accentBorder = Color(0xFF5D84B8)
    /** `--app-focus`: focus indication. */
    val focus = Color(0xFF9CC2F5)

    // --- Status ---
    val danger = Color(0xFFF2938D)
    val dangerSolid = Color(0xFFC9443E)
    val dangerSubtle = Color(0xFF4A2B2B)
    val dangerBorder = Color(0xFFC06560)
    val success = Color(0xFF6CC893)
    val successSolid = Color(0xFF2B7F50)
    val successSubtle = Color(0xFF24402F)
    val successBorder = Color(0xFF4F9A6F)
    val warning = Color(0xFFF0C060)
    val warningSolid = Color(0xFFE5B23C)
    val warningSubtle = Color(0xFF47391C)
    val warningBorder = Color(0xFFA8873A)
    val info = Color(0xFF6EC6DC)
    val infoSolid = Color(0xFF2B7F93)
    val infoSubtle = Color(0xFF1F3D45)
    val infoBorder = Color(0xFF4B98AB)
    /** White text on the solid danger / success fills. */
    val onSolid = Color(0xFFFFFFFF)

    /** `--app-backdrop` behind dialogs and sheets. */
    val backdrop = Color(0x990A0B0C)

    // --- Placeholder covers (`--app-cover-1` … `-6`): a playlist's initials sit on one, picked by
    // PlaylistCover.index(id) exactly as the web does, so a playlist has the same colour everywhere.
    // `fg` on each is >= 4.61:1.
    val cover1 = Color(0xFF49699A)
    val cover2 = Color(0xFF795B9A)
    val cover3 = Color(0xFF34716E)
    val cover4 = Color(0xFF895E41)
    val cover5 = Color(0xFF8A4D6B)
    val cover6 = Color(0xFF4E713F)
    val covers = listOf(cover1, cover2, cover3, cover4, cover5, cover6)

    /** The cover colour for a playlist id (1-based index from [PlaylistCover.index]). */
    fun coverFor(id: String?): Color = covers[PlaylistCover.index(id) - 1]
}

/**
 * The web's shell and spacing tokens. Bootstrap 6's fine spacing scale
 * (`1` = 4dp … `7` = 24dp), the gap between the app's rounded panels on a
 * phone (`--app-gap`, 0.375rem below 768px) and the radii.
 */
object Dimens {
    val space1 = 4.dp
    val space2 = 6.dp
    val space3 = 8.dp
    val space4 = 12.dp
    val space5 = 16.dp
    val space6 = 20.dp
    val space7 = 24.dp

    /** `--app-gap` on phones: between and around the shell's panels. */
    val gap = 6.dp
    /** `--app-panel-radius`: a shell panel, a card. */
    val panelRadius = 12.dp
    /** `--bs-radius-5`: buttons, inputs, the segmented control, covers. */
    val controlRadius = 8.dp
    /** Badges. */
    val badgeRadius = 6.dp
    /** The smallest touch target anywhere. */
    val touchTarget = 48.dp
}

/** The web's font sizes: `fs-xs` 12, `fs-sm` 14, `fs-md` 16 (body), `fs-lg` 18 (page titles), `fs-xl` 24. */
object TextSizes {
    val xs = 12.sp
    val sm = 14.sp
    val md = 16.sp
    val lg = 18.sp
    val xl = 24.sp
}

private val colors = darkColorScheme(
    primary = Palette.accent,
    onPrimary = Palette.onAccent,
    primaryContainer = Palette.accentSubtle,
    onPrimaryContainer = Palette.accentFg,
    inversePrimary = Palette.accentFg,
    secondary = Palette.fg2,
    onSecondary = Palette.page,
    secondaryContainer = Palette.tonal,
    onSecondaryContainer = Palette.fg,
    tertiary = Palette.accentFg,
    onTertiary = Palette.page,
    background = Palette.page,
    onBackground = Palette.fg,
    surface = Palette.surface,
    onSurface = Palette.fg,
    surfaceVariant = Palette.raised,
    onSurfaceVariant = Palette.fg3,
    surfaceTint = Palette.surface,
    surfaceBright = Palette.overlay,
    surfaceDim = Palette.page,
    surfaceContainerLowest = Palette.page,
    surfaceContainerLow = Palette.surface,
    surfaceContainer = Palette.surface,
    surfaceContainerHigh = Palette.raised,
    surfaceContainerHighest = Palette.overlay,
    inverseSurface = Palette.fg,
    inverseOnSurface = Palette.page,
    outline = Palette.borderStrong,
    outlineVariant = Palette.borderSubtle,
    error = Palette.danger,
    onError = Palette.onSolid,
    errorContainer = Palette.dangerSubtle,
    onErrorContainer = Palette.danger,
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
