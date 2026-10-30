package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke

/**
 * Hand-drawn navigation glyphs, as in kitaplik: three shapes do not justify an
 * icon library, and these share the interface's stroke weight.
 */

private const val VIEWPORT = 24f

enum class NavShape { CLOUD, DOWNLOADED, SETTINGS }

@Composable
fun NavIcon(shape: NavShape, tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val scale = size.minDimension / VIEWPORT
        val stroke = Stroke(width = 1.9f * scale, cap = StrokeCap.Round)
        fun path(block: Path.((Float, Float) -> Offset) -> Unit) =
            Path().apply { block { x, y -> Offset(x * scale, y * scale) } }

        when (shape) {
            NavShape.CLOUD -> drawPath(path { p ->
                moveTo(p(6.5f, 17.5f).x, p(6.5f, 17.5f).y)
                cubicTo(p(3f, 17.5f).x, p(3f, 17.5f).y, p(3f, 11.5f).x, p(3f, 11.5f).y,
                        p(7.5f, 11.2f).x, p(7.5f, 11.2f).y)
                cubicTo(p(8.5f, 6f).x, p(8.5f, 6f).y, p(16f, 5.5f).x, p(16f, 5.5f).y,
                        p(16.6f, 11f).x, p(16.6f, 11f).y)
                cubicTo(p(21f, 11f).x, p(21f, 11f).y, p(21.5f, 17.5f).x, p(21.5f, 17.5f).y,
                        p(17f, 17.5f).x, p(17f, 17.5f).y)
                close()
            }, tint, style = stroke)

            NavShape.DOWNLOADED -> {
                // Arrow descending into a tray.
                drawPath(path { p ->
                    moveTo(p(12f, 3.5f).x, p(12f, 3.5f).y); lineTo(p(12f, 14f).x, p(12f, 14f).y)
                }, tint, style = stroke)
                drawPath(path { p ->
                    moveTo(p(7.5f, 9.8f).x, p(7.5f, 9.8f).y)
                    lineTo(p(12f, 14.3f).x, p(12f, 14.3f).y)
                    lineTo(p(16.5f, 9.8f).x, p(16.5f, 9.8f).y)
                }, tint, style = stroke)
                drawPath(path { p ->
                    moveTo(p(4.5f, 18.5f).x, p(4.5f, 18.5f).y); lineTo(p(19.5f, 18.5f).x, p(19.5f, 18.5f).y)
                }, tint, style = stroke)
            }

            NavShape.SETTINGS -> {
                // Three sliders: reads as "settings" without a gear's detail.
                listOf(6.5f, 12f, 17.5f).forEachIndexed { i, y ->
                    drawPath(path { p ->
                        moveTo(p(4f, y).x, p(4f, y).y); lineTo(p(20f, y).x, p(20f, y).y)
                    }, tint, style = stroke)
                    val knobX = listOf(15f, 8.5f, 13f)[i]
                    drawCircle(tint, radius = 2.4f * scale, center = Offset(knobX * scale, y * scale))
                }
            }
        }
    }
}
