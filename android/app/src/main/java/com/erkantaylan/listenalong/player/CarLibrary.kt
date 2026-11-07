package com.erkantaylan.listenalong.player

import android.os.Bundle
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import androidx.media3.session.SessionError
import com.erkantaylan.listenalong.AppGraph
import com.erkantaylan.listenalong.api.Playlist
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.ui.sortedForDevice
import com.erkantaylan.listenalong.ui.toSong
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * The session callback of [PlaybackService]: what controllers may do, and the
 * browsable library Android Auto shows ([CarNode] is the tree).
 *
 * The data comes from the same places as the app's screens, with no socket:
 * playlists from [com.erkantaylan.listenalong.playlists.PlaylistRepository]
 * (its saved copies when the server cannot be reached), the downloads from the
 * download index, the newest songs from the library API. Offline, nothing
 * waits on the network: playlists come from the saved copies, the library
 * shows the downloads, and songs that are not on the phone are left out.
 */
@OptIn(UnstableApi::class)
class CarLibrary(
    private val graph: AppGraph,
    private val scope: CoroutineScope,
    private val ownPackage: String,
) : MediaLibrarySession.Callback {

    /** The last library page, for offline and for resolving a tapped song. */
    @Volatile private var lastLibrary: List<Song>? = null

    private val online: Boolean get() = graph.connectivity.online.value

    // ---- Connection --------------------------------------------------------------------------

    /**
     * Everyone gets the default commands minus seek back / seek forward.
     * With those, the session also advertised ACTION_REWIND and
     * ACTION_FAST_FORWARD, and car screens (Android Auto, head units) put
     * "-15 s / +15 s" buttons where previous and next belong. A music queue
     * wants previous / next, which stay (they are ACTION_SKIP_TO_*).
     */
    override fun onConnectAsync(
        session: MediaSession,
        controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.ConnectionResult> {
        val defaults = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller).build()
        val result = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
            .setAvailablePlayerCommands(withoutSeekButtons(defaults.availablePlayerCommands))
            .build()
        return Futures.immediateFuture(result)
    }

    /** Browsing shows playlist names: only for this app, the car, and trusted system controllers. */
    private fun mayBrowse(session: MediaSession, browser: MediaSession.ControllerInfo): Boolean =
        browser.packageName == ownPackage ||
            session.isAutoCompanionController(browser) ||
            session.isAutomotiveController(browser) ||
            browser.isTrusted

    // ---- Browsing ----------------------------------------------------------------------------

    override fun onGetLibraryRoot(
        session: MediaLibrarySession,
        browser: MediaSession.ControllerInfo,
        params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
        if (!mayBrowse(session, browser)) {
            return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED))
        }
        val extras = Bundle().apply {
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
        }
        val rootParams = LibraryParams.Builder().setExtras(extras).build()
        return Futures.immediateFuture(
            LibraryResult.ofItem(folder(CarNode.Root, "Listen Along", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED), rootParams),
        )
    }

    override fun onGetItem(
        session: MediaLibrarySession,
        browser: MediaSession.ControllerInfo,
        mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> = future {
        if (!mayBrowse(session, browser)) return@future LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED)
        val item = when (val node = CarNode.parse(mediaId)) {
            null -> null
            CarNode.Root -> folder(node, "Listen Along", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            CarNode.Playlists -> folder(node, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS)
            is CarNode.Songs -> folder(node, listTitle(node.list), MediaMetadata.MEDIA_TYPE_PLAYLIST)
            is CarNode.Shuffle -> shuffleItem(node.list)
            is CarNode.Track -> {
                val songs = songs(node.list)
                songs.getOrNull(CarNode.startIndex(songs, node.index, node.songId))
                    ?.takeIf { it.id == node.songId }
                    ?.let { track(node, it) }
            }
        }
        if (item != null) LibraryResult.ofItem(item, null) else LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
    }

    override fun onGetChildren(
        session: MediaLibrarySession,
        browser: MediaSession.ControllerInfo,
        parentId: String,
        page: Int,
        pageSize: Int,
        params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = future {
        if (!mayBrowse(session, browser)) return@future LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED)
        val children: List<MediaItem> = when (val node = CarNode.parse(parentId)) {
            CarNode.Root -> listOf(
                folder(CarNode.Playlists, "Playlists", MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS),
                folder(CarNode.Songs(CarList.Device), listTitle(CarList.Device), MediaMetadata.MEDIA_TYPE_PLAYLIST),
                folder(CarNode.Songs(CarList.Library), listTitle(CarList.Library), MediaMetadata.MEDIA_TYPE_PLAYLIST),
            )
            CarNode.Playlists -> playlists().map { p ->
                folder(CarNode.Songs(CarList.Playlist(p.id)), p.displayName, MediaMetadata.MEDIA_TYPE_PLAYLIST, subtitle = p.ownerLine)
            }
            is CarNode.Songs -> songItems(node.list)
            else -> return@future LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
        }
        LibraryResult.ofItemList(page(children, page, pageSize), params)
    }

    override fun onSearch(
        session: MediaLibrarySession,
        browser: MediaSession.ControllerInfo,
        query: String,
        params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> = future {
        if (!mayBrowse(session, browser)) return@future LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED)
        val count = songs(CarList.Search(query.trim())).size
        session.notifySearchResultChanged(browser, query, count, params)
        LibraryResult.ofVoid()
    }

    override fun onGetSearchResult(
        session: MediaLibrarySession,
        browser: MediaSession.ControllerInfo,
        query: String,
        page: Int,
        pageSize: Int,
        params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = future {
        if (!mayBrowse(session, browser)) return@future LibraryResult.ofError(SessionError.ERROR_PERMISSION_DENIED)
        val list = CarList.Search(query.trim())
        val items = songs(list).mapIndexed { i, song -> track(CarNode.Track(list, i, song.id), song) }
        LibraryResult.ofItemList(page(items, page, pageSize), params)
    }

    // ---- Playing -----------------------------------------------------------------------------

    /**
     * The app's own screens send ready MediaItems (with a URI): they pass
     * through. The car sends a media id from the tree (or a voice search):
     * that becomes the whole list, starting at the song asked for.
     */
    override fun onSetMediaItems(
        mediaSession: MediaSession,
        controller: MediaSession.ControllerInfo,
        mediaItems: List<MediaItem>,
        startIndex: Int,
        startPositionMs: Long,
    ): ListenableFuture<MediaItemsWithStartPosition> {
        if (mediaItems.all { it.localConfiguration != null }) {
            return Futures.immediateFuture(MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs))
        }
        return future {
            val single = mediaItems.singleOrNull()
            val query = single?.requestMetadata?.searchQuery
            val node = single?.let { CarNode.parse(it.mediaId) }
            when {
                query != null -> queueFor(CarList.Search(query.trim()), start = 0, shuffle = false, player = mediaSession.player)
                node is CarNode.Track -> {
                    val songs = songs(node.list)
                    queueFor(node.list, songs, CarNode.startIndex(songs, node.index, node.songId), shuffle = false, player = mediaSession.player)
                }
                node is CarNode.Shuffle -> queueFor(node.list, start = 0, shuffle = true, player = mediaSession.player)
                node is CarNode.Songs -> queueFor(node.list, start = 0, shuffle = false, player = mediaSession.player)
                else -> {
                    val items = resolveEach(mediaItems)
                    MediaItemsWithStartPosition(items, startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)), startPositionMs)
                }
            }
        }
    }

    /** "Add to queue" from a controller: each track becomes one playable item. */
    override fun onAddMediaItems(
        mediaSession: MediaSession,
        controller: MediaSession.ControllerInfo,
        mediaItems: List<MediaItem>,
    ): ListenableFuture<List<MediaItem>> {
        if (mediaItems.all { it.localConfiguration != null }) return Futures.immediateFuture(mediaItems)
        return future { resolveEach(mediaItems) }
    }

    private suspend fun resolveEach(mediaItems: List<MediaItem>): List<MediaItem> {
        val resolved = mediaItems.mapNotNull { item ->
            if (item.localConfiguration != null) return@mapNotNull item
            val node = CarNode.parse(item.mediaId) as? CarNode.Track ?: return@mapNotNull null
            val songs = songs(node.list)
            val song = songs.getOrNull(CarNode.startIndex(songs, node.index, node.songId))?.takeIf { it.id == node.songId }
                ?: return@mapNotNull null
            PlayQueue.build(listOf(song), 0, graph.readableDownloads(), streamUrl(), online)
                .entries.firstOrNull()?.let { MediaItems.forEntry(it, listTitle(node.list)) }
        }
        if (resolved.isEmpty()) throw IOException(if (online) "Nothing to play" else "Offline, and this song is not on the phone")
        return resolved
    }

    private suspend fun queueFor(list: CarList, start: Int, shuffle: Boolean, player: Player): MediaItemsWithStartPosition =
        queueFor(list, songs(list), start, shuffle, player)

    private suspend fun queueFor(
        list: CarList,
        songs: List<Song>,
        start: Int,
        shuffle: Boolean,
        player: Player,
    ): MediaItemsWithStartPosition {
        val queue = PlayQueue.build(songs, start, graph.readableDownloads(), streamUrl(), online)
        if (queue.entries.isEmpty()) {
            throw IOException(if (online) "Nothing to play here" else "Offline, and none of these songs are on the phone")
        }
        val label = contextLabel(list)
        val items = queue.entries.map { MediaItems.forEntry(it, label) }
        // Shuffle in the car is the app's Shuffle button: shuffle on, a random first song.
        // Otherwise the shuffle setting is left as it is, as in the app.
        if (shuffle) player.shuffleModeEnabled = true
        val first = if (shuffle) items.indices.random() else queue.startIndex
        return MediaItemsWithStartPosition(items, first, 0L)
    }

    private fun streamUrl(): ((String) -> String)? {
        if (!graph.settings.config.value.hasToken) return null
        val client = graph.client()
        return { id -> client.fileUrl(id).toString() }
    }

    // ---- Data --------------------------------------------------------------------------------

    private suspend fun playlists(): List<Playlist> {
        if (!online) return graph.playlists.cachedPlaylists().orEmpty()
        return try {
            graph.playlists.playlists().value
        } catch (e: IOException) {
            graph.playlists.cachedPlaylists() ?: throw e
        }
    }

    /** The songs of [list], from the server when it can be reached, else from what is saved. */
    private suspend fun songs(list: CarList): List<Song> = when (list) {
        CarList.Device -> deviceSongs()
        CarList.Library -> {
            if (!online) lastLibrary ?: deviceSongs()
            else try {
                graph.client().list(limit = LIBRARY_SIZE).songs.also { lastLibrary = it }
            } catch (e: IOException) {
                lastLibrary ?: deviceSongs()
            }
        }
        is CarList.Playlist -> {
            val saved = if (online) {
                try {
                    graph.playlists.songs(list.playlistId).value
                } catch (e: IOException) {
                    graph.playlists.cachedSongs(list.playlistId) ?: throw e
                }
            } else {
                graph.playlists.cachedSongs(list.playlistId)
            }
            saved?.songs.orEmpty().mapNotNull { it.toSong() }
        }
        is CarList.Search -> {
            val offlineHits = { sortedForDevice(graph.index.entries.value.values, list.query).map { it.toSong() } }
            if (list.query.isBlank()) deviceSongs()
            else if (!online) offlineHits()
            else try {
                graph.client().list(query = list.query, limit = SEARCH_SIZE).songs
            } catch (e: IOException) {
                offlineHits()
            }
        }
    }

    private fun deviceSongs(): List<Song> = sortedForDevice(graph.index.entries.value.values, "").map { it.toSong() }

    /** Shuffle, then the songs. Positions come from [songs], the same call the play path uses. */
    private suspend fun songItems(list: CarList): List<MediaItem> {
        val songs = songs(list)
        val downloaded = graph.index.entries.value
        val tracks = songs.mapIndexedNotNull { i, song ->
            // Offline, a song that is not on the phone could only fail: leave it out.
            if (!online && song.id !in downloaded) null else track(CarNode.Track(list, i, song.id), song)
        }
        return if (tracks.isEmpty()) tracks else listOf(shuffleItem(list)) + tracks
    }

    private fun listTitle(list: CarList): String = when (list) {
        CarList.Device -> "On device"
        CarList.Library -> if (online) "Recently added" else "Recently added (offline: on device)"
        is CarList.Playlist -> graph.playlists.cachedPlaylists()?.firstOrNull { it.id == list.playlistId }?.displayName ?: "Playlist"
        is CarList.Search -> "Search: ${list.query}"
    }

    /** What the app's player shows under the title ("from …"). */
    private fun contextLabel(list: CarList): String = when (list) {
        CarList.Device -> "On device"
        CarList.Library -> "Library"
        is CarList.Playlist -> listTitle(list)
        is CarList.Search -> "Search"
    }

    // ---- Items -------------------------------------------------------------------------------

    private fun folder(node: CarNode, title: String, mediaType: Int, subtitle: String? = null): MediaItem =
        MediaItem.Builder()
            .setMediaId(node.id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(mediaType)
                    .build(),
            )
            .build()

    private fun shuffleItem(list: CarList): MediaItem =
        MediaItem.Builder()
            .setMediaId(CarNode.Shuffle(list).id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle("Shuffle")
                    .setSubtitle(listTitle(list))
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST)
                    .build(),
            )
            .build()

    private fun track(node: CarNode.Track, song: Song): MediaItem {
        val downloaded = graph.index.contains(song.id)
        val artist = song.artist.takeIf { it.isNotBlank() && it != "Unknown" }
        return MediaItem.Builder()
            .setMediaId(node.id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(song.title.ifBlank { "Untitled" })
                    .setArtist(artist)
                    .setSubtitle(artist)
                    .setAlbumTitle(song.album)
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .apply { MediaItems.thumbnailUrl(song.youtubeId)?.let { setArtworkUri(it.toUri()) } }
                    // The car marks downloaded songs with its download icon.
                    .setExtras(Bundle().apply { if (downloaded) putLong(EXTRA_DOWNLOAD_STATUS, STATUS_DOWNLOADED) })
                    .build(),
            )
            .build()
    }

    // ---- Plumbing ----------------------------------------------------------------------------

    /** Runs [block] on the session's (main) thread and hands its result to Media3. */
    private fun <T> future(block: suspend () -> T): ListenableFuture<T> {
        val result = SettableFuture.create<T>()
        scope.launch {
            try {
                result.set(block())
            } catch (e: CancellationException) {
                result.cancel(false)
                throw e
            } catch (e: Throwable) {
                result.setException(e)
            }
        }
        return result
    }

    private fun <T> page(items: List<T>, page: Int, pageSize: Int): List<T> {
        if (pageSize <= 0 || pageSize == Int.MAX_VALUE) return items
        val from = page.toLong() * pageSize
        if (from >= items.size) return emptyList()
        return items.subList(from.toInt(), minOf(items.size, (from + pageSize).toInt()))
    }

    companion object {
        /** How many of the newest songs "Recently added" lists. */
        const val LIBRARY_SIZE = 200
        const val SEARCH_SIZE = 50

        /** MediaDescriptionCompat.EXTRA_DOWNLOAD_STATUS / STATUS_DOWNLOADED, read by Android Auto. */
        private const val EXTRA_DOWNLOAD_STATUS = "android.media.extra.DOWNLOAD_STATUS"
        private const val STATUS_DOWNLOADED = 2L

        fun withoutSeekButtons(commands: Player.Commands): Player.Commands =
            commands.buildUpon()
                .remove(Player.COMMAND_SEEK_BACK)
                .remove(Player.COMMAND_SEEK_FORWARD)
                .build()
    }
}
