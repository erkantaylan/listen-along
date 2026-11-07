package com.erkantaylan.listenalong.player

import android.os.Bundle
import androidx.core.net.toUri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata

/**
 * The player's MediaItems for queue entries, the same whether the app's
 * screens or Android Auto started playback.
 */
object MediaItems {
    const val EXTRA_CONTEXT = "listenalong.context"
    const val EXTRA_LOCAL = "listenalong.local"

    fun forEntry(entry: QueueEntry, contextLabel: String): MediaItem {
        val song = entry.song
        val local = entry.source is PlaySource.Local
        val metadata = MediaMetadata.Builder()
            .setTitle(song.title.ifBlank { "Untitled" })
            .setArtist(song.artist.takeIf { it.isNotBlank() && it != "Unknown" })
            .setAlbumTitle(song.album)
            .setIsBrowsable(false)
            .setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .apply {
                // The notification's (and the car's) cover for a stream; a
                // downloaded file's own embedded art is preferred when the
                // player finds it.
                thumbnailUrl(song.youtubeId)?.takeIf { !local }?.let { setArtworkUri(it.toUri()) }
            }
            .setExtras(Bundle().apply {
                putString(EXTRA_CONTEXT, contextLabel)
                putBoolean(EXTRA_LOCAL, local)
            })
            .build()
        // No setMimeType, on purpose: the library is mixed (AAC m4a and Ogg
        // Opus, plus legacy mp3 / webm / ogg) and the URI has no extension.
        // ExoPlayer sniffs the container (a stream's Content-Type is its
        // hint), so a type set here could only be wrong for some songs.
        return MediaItem.Builder()
            .setMediaId(song.id)
            .setUri(entry.source.uri)
            .setMediaMetadata(metadata)
            .build()
    }

    /**
     * Whether the item plays from a file on the phone (works with no
     * connection). Decided by the URI the player will open, which is what
     * matters, with the flag set by [forEntry] as the fallback.
     */
    fun isLocal(item: MediaItem?): Boolean {
        item ?: return false
        val scheme = item.localConfiguration?.uri?.scheme
        if (scheme != null) return scheme == "content" || scheme == "file"
        return item.mediaMetadata.extras?.getBoolean(EXTRA_LOCAL) ?: false
    }

    fun thumbnailUrl(youtubeId: String?): String? =
        youtubeId?.takeIf { it.isNotBlank() }?.let { "https://i.ytimg.com/vi/$it/hqdefault.jpg" }
}
