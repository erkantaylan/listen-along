package com.erkantaylan.listenalong

import android.app.Application
import android.content.Context
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.download.DownloadQueue
import com.erkantaylan.listenalong.download.DownloadScheduler
import com.erkantaylan.listenalong.download.Downloads
import com.erkantaylan.listenalong.net.Connectivity
import com.erkantaylan.listenalong.player.PlayerConnection
import com.erkantaylan.listenalong.playlists.PlaylistCache
import com.erkantaylan.listenalong.playlists.PlaylistRepository
import com.erkantaylan.listenalong.settings.ServerConfig
import com.erkantaylan.listenalong.settings.SettingsStore
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.FileTextStore
import com.erkantaylan.listenalong.storage.MediaStoreAudio
import com.erkantaylan.listenalong.storage.PrefsTextStore
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.io.File

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
 * worker and the playback service need the same queue, index, settings and
 * HTTP client the screens are looking at.
 */
class AppGraph(context: Context) {
    private val app = context.applicationContext

    val settings = SettingsStore(app)
    val index = DownloadIndex(PrefsTextStore(app, "downloads", "index_v1"))
    val queue = DownloadQueue(PrefsTextStore(app, "downloads", "queue_v1"))
    val sink = MediaStoreAudio(app)
    val connectivity = Connectivity(app)

    @Volatile private var cached: Pair<ServerConfig, LibraryClient>? = null

    /** A client for the server in Settings (the default one when nothing was saved). */
    fun client(): LibraryClient {
        val config = settings.config.value
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

    private val cacheDir = File(app.filesDir, "playlist-cache")

    val playlists = PlaylistRepository(
        clientProvider = ::client,
        cache = PlaylistCache(
            listStore = FileTextStore(File(cacheDir, "playlists.json")),
            songsStore = { id -> FileTextStore(File(cacheDir, "songs-$id.json")) },
            forget = { id -> File(cacheDir, "songs-$id.json").delete() },
        ),
    )

    /**
     * The HTTP client the player streams with. The token is read per request,
     * so a token changed in Settings applies to the next song at once, and it
     * is only ever sent to the configured server, never to a redirect target
     * or a cover-art host.
     */
    val streamHttp: OkHttpClient = LibraryClient.defaultHttpClient.newBuilder()
        .addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val config = settings.config.value
            val sameServer = request.url.host == config.baseUrl.host && request.url.port == config.baseUrl.port
            if (sameServer && config.hasToken && request.header("Authorization") == null) {
                chain.proceed(request.newBuilder().header("Authorization", "Bearer ${config.token!!.trim()}").build())
            } else {
                chain.proceed(request)
            }
        })
        .build()

    val player = PlayerConnection(app)
}
