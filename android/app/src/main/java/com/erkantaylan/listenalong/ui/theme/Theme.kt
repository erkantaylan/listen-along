package com.erkantaylan.listenalong.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * The kitaplik palette, trimmed to what this app draws: a warm near-black
 * night scheme (about 11:1 rather than the glaring 21:1 of white on black)
 * and a cream paper scheme for daylight.
 */
data class Scheme(
    val dark: Boolean,
    val bg: Color,
    val panel: Color,
    val panel2: Color,
    val border: Color,
    val text: Color,
    val textDim: Color,
    val accent: Color,
    val danger: Color,
    /** "On device". */
    val ok: Color,
    /** Behind a chosen chip. */
    val selected: Color,
)

val Night = Scheme(
    dark = true,
    bg = Color(0xFF1C1A16),
    panel = Color(0xFF24211B),
    panel2 = Color(0xFF2E2A22),
    border = Color(0xFF383126),
    text = Color(0xFFD8CFB8),
    textDim = Color(0xFFA2977E),
    accent = Color(0xFFD99E5A),
    danger = Color(0xFFCE7F6B),
    ok = Color(0xFF9BBE92),
    selected = Color(0xFF4A3B22),
)

val Paper = Scheme(
    dark = false,
    bg = Color(0xFFF7F2E4),
    panel = Color(0xFFEFE8D6),
    panel2 = Color(0xFFE5DCC5),
    border = Color(0xFFD6CCB2),
    text = Color(0xFF2B2620),
    textDim = Color(0xFF6D6353),
    accent = Color(0xFF9C6520),
    danger = Color(0xFF9E3D28),
    ok = Color(0xFF3F5C39),
    selected = Color(0xFFE4D7B4),
)

/**
 * The colours in force. Snapshot state rather than a CompositionLocal, as in
 * kitaplik: every call site reads `Palette.something`, and switching scheme
 * recomposes whatever read it.
 */
object Palette {
    var scheme by mutableStateOf(Night)

    val dark: Boolean get() = scheme.dark
    val bg: Color get() = scheme.bg
    val panel: Color get() = scheme.panel
    val panel2: Color get() = scheme.panel2
    val border: Color get() = scheme.border
    val text: Color get() = scheme.text
    val textDim: Color get() = scheme.textDim
    val accent: Color get() = scheme.accent
    val danger: Color get() = scheme.danger
    val ok: Color get() = scheme.ok
    val selected: Color get() = scheme.selected
}

@Composable
fun ListenAlongTheme(content: @Composable () -> Unit) {
    val scheme = Palette.scheme
    val colors = if (scheme.dark) {
        darkColorScheme(
            primary = scheme.accent,
            background = scheme.bg,
            surface = scheme.panel,
            surfaceVariant = scheme.panel2,
            surfaceContainerHigh = scheme.panel,
            onPrimary = scheme.bg,
            onBackground = scheme.text,
            onSurface = scheme.text,
            onSurfaceVariant = scheme.textDim,
            outline = scheme.border,
            error = scheme.danger,
        )
    } else {
        lightColorScheme(
            primary = scheme.accent,
            background = scheme.bg,
            surface = scheme.panel,
            surfaceVariant = scheme.panel2,
            surfaceContainerHigh = scheme.panel,
            onPrimary = scheme.bg,
            onBackground = scheme.text,
            onSurface = scheme.text,
            onSurfaceVariant = scheme.textDim,
            outline = scheme.border,
            error = scheme.danger,
        )
    }

    // The system bars draw over the app's ground: on paper their icons have
    // to go dark or they vanish into the cream.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !scheme.dark
                isAppearanceLightNavigationBars = !scheme.dark
            }
        }
    }

    MaterialTheme(colorScheme = colors, content = content)
}
