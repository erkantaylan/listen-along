package com.erkantaylan.listenalong.core.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.erkantaylan.listenalong.core.designsystem.Thumb
import com.erkantaylan.listenalong.core.model.CoverArt
import java.io.File

/** The covers kept next to downloads (core/storage/CoverStore), for the rows and the player. Provided by the app shell. */
class CoverSource(val saved: Set<String>, val fileFor: (String) -> File)

val LocalCovers = staticCompositionLocalOf { CoverSource(emptySet()) { File("") } }

/**
 * A song's cover in a row: the saved cover of a downloaded song (works
 * offline), else the public YouTube thumbnail; the themed placeholder while
 * it loads, when it fails, and for songs with no video. Coil decodes it at
 * the row's size (downsampled) and keeps it in its memory and disk caches.
 */
@Composable
fun SongArt(songId: String?, youtubeId: String?, modifier: Modifier = Modifier, size: Dp = 48.dp, corner: Dp = 6.dp) {
    val covers = LocalCovers.current
    val model: Any? = when {
        songId != null && songId in covers.saved -> covers.fileFor(songId)
        else -> CoverArt.thumbnailUrl(youtubeId)
    }
    Box(modifier.size(size).clip(RoundedCornerShape(corner))) {
        Thumb(size = size)
        if (model != null) {
            AsyncImage(model = model, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
        }
    }
}
