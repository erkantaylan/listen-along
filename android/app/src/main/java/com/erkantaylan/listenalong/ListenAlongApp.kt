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
import com.erkantaylan.listenalong.reports.ReportStore
import com.erkantaylan.listenalong.settings.ServerConfig
import com.erkantaylan.listenalong.settings.SettingsStore
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.FileTextStore
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.storage.MediaStoreAudio
import com.erkantaylan.listenalong.storage.PrefsTextStore
import com.erkantaylan.listenalong.api.SignInClient
import com.erkantaylan.listenalong.auth.AuthController
import com.erkantaylan.listenalong.auth.SessionEndedInterceptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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

    /** Process-wide work that must outlive a screen (the sign-in's code exchange). */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /**
     * Sign-in through the central login (auth/AuthController). Development
     * servers' sessions (INSECURE_DEV_LOGIN) are accepted by debug builds only;
     * release builds come back on the https App Link from the production
     * server (AuthFlow.redirectFor).
     */
    val auth = AuthController(
        sessions = settings,
        pendingStore = settings.pendingSignIn,
        apiFor = { base -> SignInClient(base) },
        allowDevSignIn = BuildConfig.DEBUG,
        scope = appScope,
        appLinks = BuildConfig.AUTH_APP_LINKS,
    )

    /**
     * Every API call goes through this: a 401 for the session in force signs
     * the app out (back to "Sign in"); nothing else does, so offline is not
     * signed out.
     */
    private val apiHttp: OkHttpClient = LibraryClient.defaultHttpClient.newBuilder()
        .addInterceptor(SessionEndedInterceptor(auth::sessionEnded))
        .build()

    @Volatile private var cached: Pair<ServerConfig, LibraryClient>? = null

    /** A client for the server in Settings (the default one when nothing was saved). */
    fun client(): LibraryClient {
        val config = settings.config.value
        cached?.let { (forConfig, client) -> if (forConfig == config) return client }
        return LibraryClient(config.baseUrl, config.token, apiHttp).also { cached = config to it }
    }

    val downloads = Downloads(
        queue = queue,
        index = index,
        sink = sink,
        clientProvider = ::client,
        kick = { DownloadScheduler.kick(app) },
    )

    /** Downloaded songs this app can read right now; with no media access, an earlier install's files stream instead. */
    fun readableDownloads(): Map<String, LocalSong> {
        val all = index.entries.value
        return if (sink.canSeeAllFiles) all else all.filterValues { !it.reclaimed }
    }

    /** "Not now" on the music access notice, and whether the system dialog was ever declined. */
    val musicAccessPrefs: android.content.SharedPreferences =
        app.getSharedPreferences("music_access", Context.MODE_PRIVATE)

    private val cacheDir = File(app.filesDir, "playlist-cache")

    val playlists = PlaylistRepository(
        clientProvider = ::client,
        cache = PlaylistCache(
            listStore = FileTextStore(File(cacheDir, "playlists.json")),
            songsStore = { id -> FileTextStore(File(cacheDir, "songs-$id.json")) },
            forget = { id -> File(cacheDir, "songs-$id.json").delete() },
        ),
    )

    /** Songs marked as broken, for the warning icons everywhere (saved for offline). */
    val reports = ReportStore(
        clientProvider = ::client,
        store = FileTextStore(File(app.filesDir, "reports/reported.json")),
    )

    /**
     * The HTTP client the player streams with. The session is read per
     * request, so signing in again applies to the next song at once, and it
     * is only ever sent to the configured server, never to a redirect target
     * or a cover-art host. A 401 here signs out too (the interceptor after
     * the one that adds the header, so it sees it).
     */
    val streamHttp: OkHttpClient = LibraryClient.defaultHttpClient.newBuilder()
        .addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val config = settings.config.value
            val sameServer = request.url.host == config.baseUrl.host && request.url.port == config.baseUrl.port
            if (sameServer && config.signedIn && request.header("Authorization") == null) {
                chain.proceed(request.newBuilder().header("Authorization", "Bearer ${config.token!!.trim()}").build())
            } else {
                chain.proceed(request)
            }
        })
        .addInterceptor(SessionEndedInterceptor(auth::sessionEnded))
        .build()

    val player = PlayerConnection(app)
}
