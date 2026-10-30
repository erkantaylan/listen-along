package com.erkantaylan.listenalong

import android.app.Application
import android.content.Context
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.download.DownloadQueue
import com.erkantaylan.listenalong.download.DownloadScheduler
import com.erkantaylan.listenalong.download.Downloads
import com.erkantaylan.listenalong.settings.ServerConfig
import com.erkantaylan.listenalong.settings.SettingsStore
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.MediaStoreAudio
import com.erkantaylan.listenalong.storage.PrefsTextStore

class ListenAlongApp : Application() {

    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        // Anything left queued from last time resumes as soon as the app runs.
        if (graph.downloads.queue.pending.value.isNotEmpty()) DownloadScheduler.kick(this)
    }
}

/**
 * Everything with a process-wide lifetime. It lives on the Application rather
 * than in MainActivity (where kitaplik builds its graph) because the download
 * worker needs the same queue and index the screens are looking at.
 */
class AppGraph(context: Context) {
    private val app = context.applicationContext

    val settings = SettingsStore(app)
    val index = DownloadIndex(PrefsTextStore(app, "downloads", "index_v1"))
    val queue = DownloadQueue(PrefsTextStore(app, "downloads", "queue_v1"))
    val sink = MediaStoreAudio(app)

    @Volatile private var cached: Pair<ServerConfig, LibraryClient>? = null

    /** A client for the server in Settings, or null when none is set. */
    fun client(): LibraryClient? {
        val config = settings.config.value ?: return null
        cached?.let { (forConfig, client) -> if (forConfig == config) return client }
        return LibraryClient(config.baseUrl, config.token).also { cached = config to it }
    }

    val downloads = Downloads(
        queue = queue,
        index = index,
        sink = sink,
        clientProvider = ::client,
        kick = { DownloadScheduler.kick(app) },
    )
}
