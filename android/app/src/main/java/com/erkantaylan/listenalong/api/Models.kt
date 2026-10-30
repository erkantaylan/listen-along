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
