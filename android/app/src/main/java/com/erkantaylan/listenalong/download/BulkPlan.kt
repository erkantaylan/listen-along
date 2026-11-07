package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.api.Song

/**
 * What "download all shown" would do: how many songs it would fetch, how much
 * space that roughly takes, and how many it skips because they are already on
 * the device or already queued.
 */
data class BulkPlan(
    val toDownload: List<Song>,
    val alreadyHave: Int,
    val estimatedMb: Int,
    /** Songs with no duration, counted at [ASSUMED_MINUTES] each. */
    val unknownDurations: Int,
) {
    val count: Int get() = toDownload.size

    companion object {
        /**
         * Between the library's two formats: AAC m4a (128 kbit/s, about
         * 0.96 MB a minute) and Opus (YouTube's ~130-160 kbit/s VBR, about
         * 1.0-1.2). The song list does not say which a song is, so one figure
         * for both, on the high side so the estimate does not fall short.
         */
        const val MB_PER_MINUTE = 1.1
        const val ASSUMED_MINUTES = 4.0

        fun of(songs: List<Song>, snapshot: DownloadSnapshot): BulkPlan {
            val wanted = songs.distinctBy { it.id }.filter {
                when (snapshot.stateOf(it.id)) {
                    is DownloadState.Absent, is DownloadState.Failed -> true
                    else -> false
                }
            }
            val unknown = wanted.count { (it.durationSec ?: 0) <= 0 }
            return BulkPlan(
                toDownload = wanted,
                alreadyHave = songs.distinctBy { it.id }.size - wanted.size,
                estimatedMb = estimateMb(wanted),
                unknownDurations = unknown,
            )
        }

        fun estimateMb(songs: List<Song>): Int {
            val minutes = songs.sumOf { song ->
                val seconds = song.durationSec ?: 0
                if (seconds > 0) seconds / 60.0 else ASSUMED_MINUTES
            }
            return Math.round(minutes * MB_PER_MINUTE).toInt()
        }
    }
}

/** "about 340 MB", "about 1.2 GB". */
fun formatMb(mb: Int): String =
    if (mb >= 1000) String.format(java.util.Locale.US, "%.1f GB", mb / 1000.0) else "$mb MB"
