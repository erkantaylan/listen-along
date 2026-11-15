package com.erkantaylan.listenalong.core.player

import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.network.ListenAlongApi
import com.erkantaylan.listenalong.core.network.NetworkMonitor
import com.erkantaylan.listenalong.core.storage.LocalSong
import kotlinx.coroutines.flow.StateFlow

/** What happened when a list was asked to play. */
sealed interface PlayOutcome {
    /** Playing; [skipped] songs were left out (offline, not on the phone). */
    data class Started(val count: Int, val skipped: Int) : PlayOutcome

    /** Nothing in the list can play: offline and none downloaded, or signed out. */
    data class Nothing(val offline: Boolean) : PlayOutcome
}

/**
 * "Play these songs from that one": builds the queue with the app's rules
 * ([PlayQueue.build]: downloaded songs from the file, the rest streamed,
 * offline only the downloaded ones) and hands it to the player.
 */
class PlayLauncher(
    private val player: PlayerConnection,
    private val config: StateFlow<ServerConfig>,
    private val network: NetworkMonitor,
    private val api: () -> ListenAlongApi,
    private val readableDownloads: () -> Map<String, LocalSong>,
) {
    fun play(songs: List<Song>, index: Int, context: String, shuffle: Boolean): PlayOutcome {
        val client = api()
        val online = network.online.value
        val queue = PlayQueue.build(
            songs = songs,
            startIndex = index,
            downloaded = readableDownloads(),
            streamUrl = if (config.value.signedIn) { id -> client.fileUrl(id).toString() } else null,
            online = online,
        )
        if (queue.entries.isEmpty()) return PlayOutcome.Nothing(offline = !online)
        player.play(queue, context, shuffle)
        return PlayOutcome.Started(queue.entries.size, queue.skipped)
    }
}
