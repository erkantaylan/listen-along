package com.erkantaylan.listenalong.core.player

import com.erkantaylan.listenalong.core.data.PlaylistRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.network.Connectivity
import com.erkantaylan.listenalong.core.network.ListenAlongApi
import com.erkantaylan.listenalong.core.network.NetworkMonitor
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.LocalSong
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient

/**
 * What the player service needs from the process: the Application provides
 * it (the service is an Android entry point and cannot be handed its
 * dependencies), so core never depends on the app module's container.
 */
interface PlayerHost {
    val playerDependencies: PlayerDependencies
}

class PlayerDependencies(
    val connectivity: Connectivity,
    /** Streams with the session added for the configured server only. */
    val streamHttp: OkHttpClient,
    val car: CarSources,
)

/** Where Android Auto's lists come from: the same repositories as the app's screens. */
class CarSources(
    val network: NetworkMonitor,
    val config: StateFlow<ServerConfig>,
    val api: () -> ListenAlongApi,
    val playlists: PlaylistRepository,
    val index: DownloadIndex,
    /** Downloaded songs this app can read right now (an earlier install's files need music access). */
    val readableDownloads: () -> Map<String, LocalSong>,
    /** The saved cover of a downloaded song, as a content:// URI. */
    val coverUri: (String) -> android.net.Uri? = { null },
    /** Lets a car app read a cover URI ([coverUri]'s FileProvider is not exported). */
    val grantRead: (packageName: String, uri: android.net.Uri) -> Unit = { _, _ -> },
    /** The downloaded playlists (Download on): listed first, marked downloaded, there offline. */
    val downloadedPlaylists: () -> Set<String> = { emptySet() },
)
