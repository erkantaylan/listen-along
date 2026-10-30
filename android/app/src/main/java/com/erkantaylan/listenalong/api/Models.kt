package com.erkantaylan.listenalong.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.Locale
import kotlin.math.roundToInt

/**
 * One song in the server's music library, as `GET /api/library` returns it.
 *
 * Everything except the id is optional on purpose: legacy songs migrated from
 * the old cache can lack an artist, an album or a duration, and the app must
 * still list and download them.
 */
@Serializable
data class Song(
    val id: String,
    @SerialName("youtube_id") val youtubeId: String? = null,
    val title: String = "",
    val artist: String = "",
    val album: String? = null,
    /** The server sends a number; it can be fractional for some uploads. */
    @SerialName("duration_sec") val durationRaw: Double? = null,
    @SerialName("uploaded_by") val uploadedBy: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("source_url") val sourceUrl: String? = null,
) {
    val durationSec: Int? get() = durationRaw?.roundToInt()
}

@Serializable
data class LibraryPage(
    val songs: List<Song> = emptyList(),
    val total: Int = songs.size,
)

@Serializable
data class Me(val name: String)

enum class Visibility(val param: String) {
    PUBLIC("public"),
    PRIVATE("private");

    companion object {
        fun of(value: String?): Visibility = if (value == "private") PRIVATE else PUBLIC
    }
}

/**
 * A playlist as `GET /api/playlists` describes it. [isOwner] and [canManage]
 * come from the server, which is the only judge of who may do what: the app
 * just hides buttons the server would refuse anyway, and shows its error when
 * it refuses something.
 */
@Serializable
data class Playlist(
    val id: String,
    val name: String? = null,
    val visibility: String = "public",
    val ownerId: String? = null,
    val ownerName: String? = null,
    val isOwner: Boolean = false,
    /** Owner-only actions: visibility and delete. */
    val canManage: Boolean = false,
    val pinned: Boolean = false,
    val userCount: Int = 0,
    val songCount: Int = 0,
    val createdAt: Long? = null,
) {
    val isPrivate: Boolean get() = Visibility.of(visibility) == Visibility.PRIVATE
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: "Untitled playlist"

    /** The web's muted line: "by you", "by Ayşe", or "shared" for an ownerless legacy playlist. */
    val ownerLine: String
        get() = when {
            isOwner -> "by you"
            ownerId == null -> "shared"
            !ownerName.isNullOrBlank() -> "by $ownerName"
            else -> "by someone else"
        }
}

@Serializable
data class PlaylistList(val playlists: List<Playlist> = emptyList())

/**
 * One entry of a playlist (`GET /api/playlists/:id/songs`). The entry id is
 * the handle for removing and moving it; [libraryId] is the library song
 * behind it, null when the entry is something the library does not have
 * (an old YouTube-only queue entry), which can be neither played nor
 * downloaded from here.
 */
@Serializable
data class PlaylistEntry(
    val position: Int = 0,
    @SerialName("entry_id") val entryId: String,
    @SerialName("library_id") val libraryId: String? = null,
    @SerialName("youtube_id") val youtubeId: String? = null,
    /** The queue's title: "Title - Artist" when the song has an artist. */
    val title: String = "",
    val artist: String? = null,
    @SerialName("duration_sec") val durationRaw: Double? = null,
    val url: String? = null,
    val thumbnail: String? = null,
    @SerialName("added_by") val addedBy: String? = null,
) {
    val playable: Boolean get() = !libraryId.isNullOrBlank()

    /** The title without the " - Artist" the server appends to queue entries. */
    val cleanTitle: String
        get() {
            val a = artist?.trim().orEmpty()
            val t = title.trim()
            return if (a.isNotEmpty() && t.endsWith(" - $a") && t.length > a.length + 3) t.dropLast(a.length + 3) else t
        }

    /** The library song behind this entry, for playing and downloading. Null when there is none. */
    fun toSong(): Song? = libraryId?.takeIf { it.isNotBlank() }?.let {
        Song(
            id = it,
            youtubeId = youtubeId,
            title = cleanTitle,
            artist = artist?.takeIf { a -> a != "Unknown" }.orEmpty(),
            durationRaw = durationRaw,
        )
    }
}

@Serializable
data class PlaylistSongs(
    val playlist: Playlist? = null,
    val songs: List<PlaylistEntry> = emptyList(),
)

@Serializable
data class AddSongsSummary(
    val total: Int = 0,
    val added: Int = 0,
    @SerialName("already_in_playlist") val alreadyInPlaylist: Int = 0,
    @SerialName("not_in_library") val notInLibrary: Int = 0,
    val invalid: Int = 0,
)

@Serializable
data class AddSongsResult(
    val summary: AddSongsSummary = AddSongsSummary(),
    @SerialName("song_count") val songCount: Int = 0,
)

/** The `sort` values the server understands. */
enum class SortOrder(val param: String, val label: String) {
    RECENT("recent", "Recent"),
    TITLE("title", "Title"),
    ARTIST("artist", "Artist"),
}

/** "3:07", or "1:02:45" past the hour. Blank when unknown. */
fun formatDuration(seconds: Int?): String {
    if (seconds == null || seconds < 0) return ""
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
    else String.format(Locale.US, "%d:%02d", m, s)
}
