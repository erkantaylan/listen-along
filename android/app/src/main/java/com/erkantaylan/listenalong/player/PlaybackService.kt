package com.erkantaylan.listenalong.player

import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.erkantaylan.listenalong.ListenAlongApp
import com.erkantaylan.listenalong.MainActivity
import com.erkantaylan.listenalong.R
import com.erkantaylan.listenalong.net.Connectivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

/**
 * The one player. ExoPlayer inside a MediaLibraryService, so playback goes on
 * with the app in the background, Media3 provides the media notification,
 * lock-screen and Bluetooth/headset controls from the session, and Android
 * Auto can browse and play the library ([CarLibrary]).
 *
 * - Audio focus: handled by ExoPlayer (`handleAudioFocus = true`): another
 *   app's playback or a call pauses us, a short notification ducks us.
 * - Headphones unplugged / Bluetooth gone: `setHandleAudioBecomingNoisy`
 *   pauses.
 * - Sources: downloaded songs are MediaStore content:// URIs; everything else
 *   is `/api/library/:id/file`, fetched through the app's OkHttp client, whose
 *   interceptor adds `Authorization: Bearer <token>` for the configured
 *   server only. Range requests make seeking in a stream cheap.
 * - Controls: previous / next, never seek back / forward ([CarLibrary.onConnectAsync]).
 * - No connection: streamed entries are skipped, not waited on (see
 *   [skipStreamsIfOffline]); a stream that fails because the server cannot be
 *   reached tells [Connectivity], and the queue goes on with the downloads.
 *
 * The UI talks to this through a MediaController ([PlayerConnection]), never
 * directly.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {

    private var session: MediaLibrarySession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var connectivity: Connectivity

    /** The item index before the last transition, to tell "previous" from "next". */
    private var lastIndex = C.INDEX_UNSET

    override fun onCreate() {
        super.onCreate()
        val graph = (application as ListenAlongApp).graph
        connectivity = graph.connectivity
        val dataSource = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(graph.streamHttp))
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(dataSource).setLoadErrorHandlingPolicy(OfflineAwareRetries(connectivity)),
            )
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        player.addListener(object : Player.Listener {
            // One song that cannot be played (deleted file, a 404, the
            // connection dropped mid-stream) must not stop the whole queue.
            override fun onPlayerError(error: PlaybackException) {
                val index = player.currentMediaItemIndex
                val stream = !MediaItems.isLocal(player.currentMediaItem)
                val status = (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode
                Log.w(TAG, "Playback error on item $index (${if (stream) "stream" else "file"}): ${error.errorCodeName}", error)
                if (stream && PlayQueue.meansUnreachable(error.errorCode, status)) {
                    connectivity.reportServerUnreachable()
                }
                val target = nextIndex(player, index, forward = true, onlyLocal = !connectivity.online.value)
                if (target != C.INDEX_UNSET) {
                    player.seekTo(target, 0L)
                    player.prepare()
                }
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val previous = lastIndex
                lastIndex = player.currentMediaItemIndex
                if (mediaItem == null || reason == Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) return
                skipStreamsIfOffline(player, cameFrom = previous)
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                when (playbackState) {
                    // The buffer ran out (or a stream is starting) with no connection: move on now
                    // rather than wait for the read to time out.
                    Player.STATE_BUFFERING -> skipStreamsIfOffline(player, cameFrom = C.INDEX_UNSET)
                    Player.STATE_READY -> if (!MediaItems.isLocal(player.currentMediaItem)) connectivity.reportServerReachable()
                }
            }
        })

        // The connection went away: a stream that is still waiting for data
        // will not get it; go to the next downloaded song.
        connectivity.online.drop(1).onEach { online ->
            if (!online && player.playbackState != Player.STATE_READY) skipStreamsIfOffline(player, C.INDEX_UNSET)
        }.launchIn(scope)

        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_PLAYER, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val library = MediaLibrarySession.Builder(this, player, CarLibrary(graph, scope, packageName))
            .setSessionActivity(openApp)
            .build()
        session = library

        // The car's "On device" list follows downloads and deletions.
        graph.index.entries.drop(1).onEach {
            library.notifyChildrenChanged(CarNode.Songs(CarList.Device).id, it.size, null)
        }.launchIn(scope)

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply {
                setSmallIcon(R.drawable.ic_stat_music)
            }
        )
    }

    /**
     * When the server cannot be reached and the current entry streams, jump to
     * the nearest downloaded entry in the direction the user was going
     * (backwards after "previous"), or pause when there is none.
     */
    private fun skipStreamsIfOffline(player: Player, cameFrom: Int) {
        if (connectivity.online.value || player.mediaItemCount == 0) return
        if (MediaItems.isLocal(player.currentMediaItem)) return
        val index = player.currentMediaItemIndex
        val backwards = cameFrom != C.INDEX_UNSET && previousIndexOf(player, cameFrom) == index
        var target = nextIndex(player, index, forward = !backwards, onlyLocal = true)
        // "Previous" with nothing downloaded before: the next downloaded song instead.
        if (target == C.INDEX_UNSET && backwards) target = nextIndex(player, index, forward = true, onlyLocal = true)
        if (target != C.INDEX_UNSET) {
            Log.i(TAG, "Offline: skipping streamed item $index for downloaded item $target")
            player.seekTo(target, 0L)
            if (player.playbackState == Player.STATE_IDLE) player.prepare()
        } else {
            Log.i(TAG, "Offline: no downloaded song to go to from item $index")
            player.pause()
        }
    }

    /** The next index in play order (shuffle and repeat included), optionally downloaded entries only. */
    private fun nextIndex(player: Player, from: Int, forward: Boolean, onlyLocal: Boolean): Int {
        val timeline = player.currentTimeline
        if (timeline.isEmpty || from == C.INDEX_UNSET) return C.INDEX_UNSET
        val step: (Int) -> Int = { i ->
            if (forward) timeline.getNextWindowIndex(i, player.repeatModeForSkipping(), player.shuffleModeEnabled)
            else timeline.getPreviousWindowIndex(i, player.repeatModeForSkipping(), player.shuffleModeEnabled)
        }
        val found = PlayQueue.nextPlayable(from, player.mediaItemCount, step) { i ->
            !onlyLocal || MediaItems.isLocal(player.getMediaItemAt(i))
        }
        return if (found < 0) C.INDEX_UNSET else found
    }

    private fun previousIndexOf(player: Player, index: Int): Int {
        val timeline = player.currentTimeline
        if (timeline.isEmpty || index >= timeline.windowCount) return C.INDEX_UNSET
        return timeline.getPreviousWindowIndex(index, player.repeatModeForSkipping(), player.shuffleModeEnabled)
    }

    /** As the player's own next / previous: repeat-one walks the list as if repeat were off. */
    private fun Player.repeatModeForSkipping(): Int =
        if (repeatMode == Player.REPEAT_MODE_ONE) Player.REPEAT_MODE_OFF else repeatMode

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    /** Swiped away from recents: keep playing if it is playing, otherwise go. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    /**
     * ExoPlayer retries a failed load a few times with growing pauses, which is
     * right for a blip but means a minute of silence per song when there is no
     * connection at all. Offline, give up at once so the queue moves on.
     */
    private class OfflineAwareRetries(private val connectivity: Connectivity) : DefaultLoadErrorHandlingPolicy() {
        override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
            if (!connectivity.online.value) C.TIME_UNSET else super.getRetryDelayMsFor(loadErrorInfo)
    }

    private companion object {
        const val TAG = "PlaybackService"
    }
}
