package com.erkantaylan.listenalong.player

import com.erkantaylan.listenalong.api.Song
import java.net.URLDecoder
import java.net.URLEncoder

/** A list of songs the car can browse and play from. */
sealed interface CarList {
    val key: String

    /** The downloaded songs (artist, then title, like On device). */
    data object Device : CarList { override val key = "device" }

    /** The newest songs in the library; the downloads when the server cannot be reached. */
    data object Library : CarList { override val key = "library" }

    data class Playlist(val playlistId: String) : CarList { override val key = "playlist:$playlistId" }

    /** Results of a voice or typed search in the car. */
    data class Search(val query: String) : CarList { override val key = "search:$query" }

    companion object {
        fun parse(key: String): CarList? = when {
            key == Device.key -> Device
            key == Library.key -> Library
            key.startsWith("playlist:") -> key.removePrefix("playlist:").takeIf { it.isNotEmpty() }?.let(::Playlist)
            key.startsWith("search:") -> Search(key.removePrefix("search:"))
            else -> null
        }
    }
}

/**
 * The Android Auto browse tree, as media ids:
 *
 * ```
 * root
 * ├── playlists            → one folder per playlist
 * │   └── list/playlist:…  → Shuffle, then the songs
 * ├── list/device          → Shuffle, then the downloaded songs
 * └── list/library         → Shuffle, then the newest songs
 * ```
 *
 * A song's id names its list, its position there and its song id, so tapping
 * it plays the whole list from that song. Pure, so the round trip is tested.
 */
sealed interface CarNode {
    val id: String

    data object Root : CarNode { override val id = "root" }

    data object Playlists : CarNode { override val id = "playlists" }

    /** A browsable list: Shuffle first, then its songs. */
    data class Songs(val list: CarList) : CarNode { override val id get() = "list/${enc(list.key)}" }

    /** One song of [list] at [index]: plays the list from there. */
    data class Track(val list: CarList, val index: Int, val songId: String) : CarNode {
        override val id get() = "track/${enc(list.key)}/$index/${enc(songId)}"
    }

    /** Plays [list] in shuffle. */
    data class Shuffle(val list: CarList) : CarNode { override val id get() = "shuffle/${enc(list.key)}" }

    companion object {
        fun parse(id: String): CarNode? {
            val parts = id.split('/')
            return when (parts[0]) {
                Root.id -> Root.takeIf { parts.size == 1 }
                Playlists.id -> Playlists.takeIf { parts.size == 1 }
                "list" -> if (parts.size == 2) CarList.parse(dec(parts[1]))?.let(::Songs) else null
                "shuffle" -> if (parts.size == 2) CarList.parse(dec(parts[1]))?.let(::Shuffle) else null
                "track" -> {
                    if (parts.size != 4) return null
                    val list = CarList.parse(dec(parts[1])) ?: return null
                    val index = parts[2].toIntOrNull()?.takeIf { it >= 0 } ?: return null
                    val songId = dec(parts[3]).takeIf { it.isNotEmpty() } ?: return null
                    Track(list, index, songId)
                }
                else -> null
            }
        }

        /**
         * Where to start in [songs] for a track that was at [index] with
         * [songId] when the car listed it. The list may have changed since
         * (a song added or removed): then the first song with that id, else
         * the top.
         */
        fun startIndex(songs: List<Song>, index: Int, songId: String): Int = when {
            songs.getOrNull(index)?.id == songId -> index
            else -> songs.indexOfFirst { it.id == songId }.coerceAtLeast(0)
        }

        private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
        private fun dec(s: String): String = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
    }
}
