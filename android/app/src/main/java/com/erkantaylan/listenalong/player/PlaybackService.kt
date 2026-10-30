package com.erkantaylan.listenalong.player

import android.app.PendingIntent
import android.content.Intent
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.erkantaylan.listenalong.ListenAlongApp
import com.erkantaylan.listenalong.MainActivity
import com.erkantaylan.listenalong.R

/**
 * The one player. ExoPlayer inside a MediaSessionService, so playback goes on
 * with the app in the background, and Media3 provides the media notification,
 * lock-screen and Bluetooth/headset controls from the session.
 *
 * - Audio focus: handled by ExoPlayer (`handleAudioFocus = true`): another
 *   app's playback or a call pauses us, a short notification ducks us.
 * - Headphones unplugged / Bluetooth gone: `setHandleAudioBecomingNoisy`
 *   pauses.
 * - Sources: downloaded songs are MediaStore content:// URIs; everything else
 *   is `/api/library/:id/file`, fetched through the app's OkHttp client, whose
 *   interceptor adds `Authorization: Bearer <token>` for the configured
 *   server only. Range requests make seeking in a stream cheap.
 *
 * The UI talks to this through a MediaController ([PlayerConnection]), never
 * directly.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val graph = (application as ListenAlongApp).graph
        val dataSource = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(graph.streamHttp))
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
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
                Log.w(TAG, "Playback error on item ${player.currentMediaItemIndex}: ${error.errorCodeName}", error)
                if (player.hasNextMediaItem()) {
                    player.seekToNextMediaItem()
                    player.prepare()
                }
            }
        })

        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_PLAYER, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .build()

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this).build().apply {
                setSmallIcon(R.drawable.ic_stat_music)
            }
        )
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Swiped away from recents: keep playing if it is playing, otherwise go. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    private companion object {
        const val TAG = "PlaybackService"
    }
}
