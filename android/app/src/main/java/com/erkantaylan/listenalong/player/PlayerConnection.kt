package com.erkantaylan.listenalong.player

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the mini player, the full player and the "playing" rows show. */
data class NowPlaying(
    val songId: String? = null,
    val title: String = "",
    val artist: String = "",
    /** Where the queue came from: "Library", "On device", or a playlist name. */
    val context: String? = null,
    val isPlaying: Boolean = false,
    val buffering: Boolean = false,
    val durationMs: Long = 0,
    val index: Int = 0,
    val queueSize: Int = 0,
    val hasNext: Boolean = false,
    val hasPrevious: Boolean = false,
    val shuffle: Boolean = false,
    val repeatMode: Int = Player.REPEAT_MODE_OFF,
    /** Playing from the downloaded file rather than streaming. */
    val local: Boolean = false,
    /** Cover art embedded in the file, once the player has read it. */
    val artwork: ByteArray? = null,
) {
    val isEmpty: Boolean get() = songId == null
}

/**
 * The app's handle on [PlaybackService]: a MediaController, plus the state
 * the screens draw from. One per process (it lives in AppGraph), connected on
 * first use. Commands sent before the controller is ready are run as soon as
 * it is.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlayerConnection(private val context: Context) {

    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val pending = ArrayList<(MediaController) -> Unit>()

    private val _state = MutableStateFlow(NowPlaying())
    val state: StateFlow<NowPlaying> = _state.asStateFlow()

    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 4, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    /** One message per song that failed to play (the service skips it). */
    val errors: SharedFlow<String> = _errors.asSharedFlow()

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = publish(player)

        override fun onPlayerError(error: PlaybackException) {
            val title = controller?.mediaMetadata?.title?.toString().orEmpty().ifBlank { "this song" }
            _errors.tryEmit("Could not play $title: ${describe(error)}")
        }
    }

    fun connect() {
        if (future != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val f = MediaController.Builder(context, token).buildAsync()
        future = f
        f.addListener({
            val c = runCatching { f.get() }.getOrNull()
            if (c == null) {
                future = null
                return@addListener
            }
            controller = c
            c.addListener(listener)
            publish(c)
            val queued = pending.toList()
            pending.clear()
            queued.forEach { it(c) }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun withController(block: (MediaController) -> Unit) {
        val c = controller
        if (c != null) block(c) else {
            pending += block
            connect()
        }
    }

    /**
     * Replaces the queue with [queue] and starts playing at its start index.
     * [shuffle] (the "Shuffle" button) turns shuffle on and starts at a random
     * song; otherwise the shuffle setting is left as it is.
     */
    fun play(queue: BuiltQueue, contextLabel: String, shuffle: Boolean = false) {
        if (queue.entries.isEmpty()) return
        val items = queue.entries.map { mediaItem(it, contextLabel) }
        val start = if (shuffle) items.indices.random() else queue.startIndex
        withController { c ->
            if (shuffle) c.shuffleModeEnabled = true
            c.setMediaItems(items, start, 0L)
            c.prepare()
            c.play()
        }
    }

    fun togglePlay() = withController { c ->
        if (c.isPlaying) c.pause() else {
            if (c.playbackState == Player.STATE_IDLE) c.prepare()
            if (c.playbackState == Player.STATE_ENDED) c.seekTo(c.currentMediaItemIndex, 0)
            c.play()
        }
    }

    fun next() = withController { it.seekToNext() }

    /** Back to the start of the song, or to the previous one in its first seconds. */
    fun previous() = withController { it.seekToPrevious() }

    fun seekTo(positionMs: Long) = withController { it.seekTo(positionMs) }

    fun toggleShuffle() = withController { it.shuffleModeEnabled = !it.shuffleModeEnabled }

    /** Off → all → one → off, like the web's repeat button. */
    fun cycleRepeat() = withController {
        it.repeatMode = when (it.repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    fun stop() = withController {
        it.stop()
        it.clearMediaItems()
    }

    /** Current position; polled by the screens while they show a seek bar. */
    fun positionMs(): Long = controller?.currentPosition ?: 0L

    fun bufferedMs(): Long = controller?.bufferedPosition ?: 0L

    private fun publish(player: Player) {
        val item = player.currentMediaItem
        if (item == null) {
            _state.value = NowPlaying(shuffle = player.shuffleModeEnabled, repeatMode = player.repeatMode)
            return
        }
        val meta = player.mediaMetadata
        val extras = item.mediaMetadata.extras
        _state.value = NowPlaying(
            songId = item.mediaId,
            title = (meta.title ?: item.mediaMetadata.title)?.toString().orEmpty(),
            artist = (meta.artist ?: item.mediaMetadata.artist)?.toString().orEmpty(),
            context = extras?.getString(EXTRA_CONTEXT),
            isPlaying = player.isPlaying,
            buffering = player.playbackState == Player.STATE_BUFFERING,
            durationMs = player.duration.takeIf { it > 0 } ?: 0L,
            index = player.currentMediaItemIndex,
            queueSize = player.mediaItemCount,
            hasNext = player.hasNextMediaItem(),
            hasPrevious = player.hasPreviousMediaItem(),
            shuffle = player.shuffleModeEnabled,
            repeatMode = player.repeatMode,
            local = extras?.getBoolean(EXTRA_LOCAL) ?: false,
            artwork = meta.artworkData,
        )
    }

    private fun mediaItem(entry: QueueEntry, contextLabel: String): MediaItem {
        val song = entry.song
        val local = entry.source is PlaySource.Local
        val metadata = MediaMetadata.Builder()
            .setTitle(song.title.ifBlank { "Untitled" })
            .setArtist(song.artist.takeIf { it.isNotBlank() && it != "Unknown" })
            .setAlbumTitle(song.album)
            .apply {
                // The notification's cover for a stream; a downloaded file's
                // own embedded art is preferred when the player finds it.
                song.youtubeId?.takeIf { !local }?.let { setArtworkUri("https://i.ytimg.com/vi/$it/hqdefault.jpg".toUri()) }
            }
            .setExtras(Bundle().apply {
                putString(EXTRA_CONTEXT, contextLabel)
                putBoolean(EXTRA_LOCAL, local)
            })
            .build()
        return MediaItem.Builder()
            .setMediaId(song.id)
            .setUri(entry.source.uri)
            .setMediaMetadata(metadata)
            .build()
    }

    private fun describe(error: PlaybackException): String = when (error.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "no connection"
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> {
            val code = (error.cause as? androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException)?.responseCode
            when (code) {
                401, 403 -> "the server rejected the API token"
                404 -> "not on the server any more"
                null -> "server error"
                else -> "server error $code"
            }
        }
        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "the downloaded file is gone"
        else -> error.errorCodeName.removePrefix("ERROR_CODE_").lowercase().replace('_', ' ')
    }

    companion object {
        private const val EXTRA_CONTEXT = "listenalong.context"
        private const val EXTRA_LOCAL = "listenalong.local"
    }
}
