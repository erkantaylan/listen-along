package com.erkantaylan.listenalong.app

import android.content.Context
import android.content.SharedPreferences
import com.erkantaylan.listenalong.BuildConfig
import com.erkantaylan.listenalong.core.auth.AuthController
import com.erkantaylan.listenalong.core.data.AccountRepository
import com.erkantaylan.listenalong.core.data.LibraryRepository
import com.erkantaylan.listenalong.core.data.PlaylistCache
import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.data.ReportRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.data.SettingsStore
import com.erkantaylan.listenalong.core.download.DownloadQueue
import com.erkantaylan.listenalong.core.download.DownloadScheduler
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.network.Connectivity
import com.erkantaylan.listenalong.core.network.LibraryClient
import com.erkantaylan.listenalong.core.network.ListenAlongApi
import com.erkantaylan.listenalong.core.network.SessionEndedInterceptor
import com.erkantaylan.listenalong.core.network.SignInClient
import com.erkantaylan.listenalong.core.player.CarSources
import com.erkantaylan.listenalong.core.player.PlayLauncher
import com.erkantaylan.listenalong.core.player.PlayerConnection
import com.erkantaylan.listenalong.core.player.PlayerDependencies
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.FileTextStore
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.core.storage.MediaStoreAudio
import com.erkantaylan.listenalong.core.storage.PrefsTextStore
import com.erkantaylan.listenalong.core.ui.UserMessages
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.io.File

/**
 * The app's dependencies, built once per process by hand (no DI framework:
 * a dozen objects with one lifetime do not need one). It lives on the
 * Application rather than in MainActivity because the download worker and
 * the playback service need the same queue, index, settings and HTTP client
 * the screens are looking at. ViewModels get the pieces they use, never the
 * container itself (see `AppViewModels`).
 */
class AppContainer(context: Context) {
    private val app = context.applicationContext

    val settings = SettingsStore(app)
    val index = DownloadIndex(PrefsTextStore(app, "downloads", "index_v1"))
    val queue = DownloadQueue(PrefsTextStore(app, "downloads", "queue_v1"))
    val sink = MediaStoreAudio(app)
    val connectivity = Connectivity(app)
    val messages = UserMessages()

    /** Process-wide work that must outlive a screen (the sign-in's code exchange). */
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /**
     * Sign-in through the central login (core/auth/AuthController). Development
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
    fun client(): ListenAlongApi {
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
    val musicAccessPrefs: SharedPreferences = app.getSharedPreferences("music_access", Context.MODE_PRIVATE)

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
    val reports = ReportRepository(
        clientProvider = ::client,
        store = FileTextStore(File(app.filesDir, "reports/reported.json")),
    )

    val library = LibraryRepository(::client, index.entries, reports)

    val account = AccountRepository(::client)

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

    val playLauncher = PlayLauncher(player, settings.config, connectivity, ::client, ::readableDownloads)

    val playerDependencies = PlayerDependencies(
        connectivity = connectivity,
        streamHttp = streamHttp,
        car = CarSources(
            network = connectivity,
            config = settings.config,
            api = ::client,
            playlists = playlists,
            index = index,
            readableDownloads = ::readableDownloads,
        ),
    )
}
