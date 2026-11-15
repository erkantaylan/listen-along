package com.erkantaylan.listenalong.app

import android.content.Context
import android.content.SharedPreferences
import com.erkantaylan.listenalong.BuildConfig
import com.erkantaylan.listenalong.core.auth.AuthController
import com.erkantaylan.listenalong.core.data.AccountRepository
import com.erkantaylan.listenalong.core.data.AppUpdates
import com.erkantaylan.listenalong.core.domain.UpdateRules
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
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import coil3.ImageLoader
import coil3.serviceLoaderEnabled
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import com.erkantaylan.listenalong.core.download.CoverSync
import com.erkantaylan.listenalong.core.network.ImageHttp
import com.erkantaylan.listenalong.core.storage.CoverStore
import kotlinx.coroutines.launch
import com.erkantaylan.listenalong.core.data.PlaylistDownloads
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.domain.PlaylistSyncPlanner
import com.erkantaylan.listenalong.core.data.SyncClock
import com.erkantaylan.listenalong.core.model.PlaylistSongs
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import okio.Path.Companion.toOkioPath

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

    /**
     * Cover images come from a third-party host (YouTube's thumbnails): their
     * own client, built from scratch so it can never carry the session.
     */
    val imageHttp: OkHttpClient = ImageHttp.newClient()

    /** Coil: covers decoded at the size they are drawn, 64 MB on disk, 15% of the heap in memory. */
    val imageLoader: ImageLoader = ImageLoader.Builder(app)
        .serviceLoaderEnabled(false)
        .components { add(OkHttpNetworkFetcherFactory(callFactory = { imageHttp })) }
        .diskCache {
            DiskCache.Builder().directory(File(app.cacheDir, "image_cache").toOkioPath())
                .maxSizeBytes(64L * 1024 * 1024).build()
        }
        .memoryCache { MemoryCache.Builder().maxSizePercent(app, 0.15).build() }
        .build()

    /** The covers of downloaded songs, kept for offline (app-private, not in Music/ListenAlong). */
    val covers = CoverStore(File(app.filesDir, "covers"))

    val coverSync = CoverSync(index, covers, ::client, fetch = { url -> ImageHttp.fetch(imageHttp, url) })

    /** A saved cover as a content:// URI (the FileProvider in the manifest), for the notification and the car. */
    fun coverUri(songId: String): Uri? =
        if (!covers.has(songId)) null
        else runCatching { FileProvider.getUriForFile(app, "${app.packageName}.covers", covers.file(songId)) }.getOrNull()

    val downloads = Downloads(
        queue = queue,
        index = index,
        sink = sink,
        clientProvider = ::client,
        kick = { DownloadScheduler.kick(app) },
        onSaved = { coverSync.fetchFor(it) },
        mayFetchAuto = { PlaylistSyncPlanner.mayDownload(connectivity.network.value, settings.sync.value) },
        waitForNetwork = { DownloadScheduler.waitForNetwork(app, settings.sync.value.allowMetered) },
        onMissing = { playlistDownloads.markMissing(it) },
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

    /** Downloaded playlists and their sync (core/data/PlaylistDownloads). */
    val playlistDownloads: PlaylistDownloads by lazy {
        PlaylistDownloads(
            store = PrefsTextStore(app, "downloads", "playlists_v1"),
            api = ::client,
            repo = playlists,
            downloads = downloads,
            prefs = settings,
            network = { connectivity.network.value },
            now = SyncClock::now,
            schedule = { enabled, allowMetered -> DownloadScheduler.schedulePlaylistSync(app, enabled, allowMetered) },
            account = { settings.config.value.let { if (it.signedIn) it.userId else null } },
            learnAccount = ::learnAccount,
            corruptStore = PrefsTextStore(app, "downloads", "playlists_unreadable"),
            onDetached = { gone ->
                messages.say(
                    if (gone.size == 1) "\"${gone[0].name}\" is no longer synced: its songs stay on the phone as your downloads"
                    else "${gone.size} downloaded playlists are no longer synced: their songs stay on the phone as your downloads"
                )
            },
        )
    }

    /**
     * The signed-in account's id, asked from the server for a session saved
     * before the app kept it (downloaded playlists are saved per account).
     */
    private suspend fun learnAccount(): String? {
        val config = settings.config.value
        if (!config.signedIn) return null
        config.userId?.let { return it }
        val id = client().me().user?.id?.takeIf { it.isNotBlank() } ?: return null
        settings.rememberAccount(config.token!!, id)
        return settings.config.value.userId
    }

    /** Every downloaded playlist's status (the marks on rows, On device, a playlist's header). */
    val playlistStatuses: StateFlow<Map<String, PlaylistDownloadStatus>> by lazy {
        playlistDownloads.statuses(downloads.snapshots, connectivity.network)
            .stateIn(appScope, SharingStarted.Eagerly, emptyMap())
    }

    /**
     * Asks for a playlist sync (quietly: offline or signed out it does
     * nothing). [fresh]: song lists just fetched by a screen.
     */
    fun requestSync(fresh: Map<String, PlaylistSongs> = emptyMap()) {
        if (!settings.config.value.signedIn) return
        appScope.launch { runCatching { playlistDownloads.sync(fresh) } }
    }

    val account = AccountRepository(::client)

    /** The update notice (never forced; never in debug or "-dev" builds unless asked). */
    val appUpdates = AppUpdates(
        api = ::client,
        store = PrefsTextStore(app, "settings", "update_dismissed"),
        installedVersion = BuildConfig.VERSION_NAME,
        devBuild = UpdateRules.isDevBuild(BuildConfig.VERSION_NAME, BuildConfig.DEBUG),
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

    val player = PlayerConnection(app, ::coverUri)

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
            coverUri = ::coverUri,
            grantRead = { pkg, uri -> app.grantUriPermission(pkg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) },
            downloadedPlaylists = { playlistDownloads.playlists.value.filter { !it.unavailable }.mapTo(HashSet()) { it.id } },
        ),
    )

    init {
        appScope.launch(Dispatchers.IO) {
            covers.load()
            // A song's cover goes with its download.
            index.entries.collect { covers.retainOnly(it.keys) }
        }
        // Playlist sync: at start, after a server or sign-in change, when the connection returns.
        settings.config.onEach {
            playlistDownloads.reload()
            requestSync()
        }.launchIn(appScope)
        connectivity.online.drop(1).filter { it }.onEach { requestSync() }.launchIn(appScope)
        // The network settings: the background sync's constraints follow, waiting downloads re-check.
        settings.sync.drop(1).onEach {
            playlistDownloads.reload()
            if (queue.pending.value.isNotEmpty()) DownloadScheduler.kick(app)
        }.launchIn(appScope)
        // Moving to a network sync may use (Wi-Fi again): the waiting downloads go.
        connectivity.network.drop(1).filter { PlaylistSyncPlanner.mayDownload(it, settings.sync.value) }
            .onEach { if (queue.pending.value.any { q -> !q.manual }) DownloadScheduler.kick(app) }
            .launchIn(appScope)
    }
}
