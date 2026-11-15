package com.erkantaylan.listenalong

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import com.erkantaylan.listenalong.app.AppContainer
import com.erkantaylan.listenalong.core.download.DownloadScheduler
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.download.DownloadsHost
import com.erkantaylan.listenalong.core.player.PlayerDependencies
import com.erkantaylan.listenalong.core.player.PlayerHost

/**
 * Builds the [AppContainer] once per process and hands the Android entry
 * points (the player service, the download worker) what they need.
 */
class ListenAlongApp : Application(), PlayerHost, DownloadsHost, SingletonImageLoader.Factory {

    lateinit var container: AppContainer
        private set

    override val playerDependencies: PlayerDependencies get() = container.playerDependencies
    override val downloads: Downloads get() = container.downloads

    override suspend fun syncPlaylists() {
        if (container.settings.config.value.signedIn) container.playlistDownloads.sync()
    }

    /** Every AsyncImage uses the container's loader (its own HTTP client, no session). */
    override fun newImageLoader(context: PlatformContext): ImageLoader = container.imageLoader

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // Anything left queued from last time resumes as soon as the app runs.
        if (container.downloads.queue.pending.value.isNotEmpty()) DownloadScheduler.kick(this)
    }
}
