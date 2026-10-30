package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.storage.LocalSong

/** What the app shows for one library song. */
sealed interface DownloadState {
    data object Absent : DownloadState
    data object Queued : DownloadState
    data class InProgress(val bytesRead: Long, val total: Long) : DownloadState {
        /** Null while the size is unknown (no Content-Length). */
        val fraction: Float? get() = if (total > 0) (bytesRead.toFloat() / total).coerceIn(0f, 1f) else null
    }
    data class Done(val local: LocalSong) : DownloadState
    data class Failed(val message: String) : DownloadState
}

data class Progress(val bytesRead: Long, val total: Long)

/**
 * Everything the download machinery knows, at one instant. Screens hold one
 * of these and ask it about individual songs, rather than each piece of UI
 * stitching four maps together.
 */
data class DownloadSnapshot(
    val downloaded: Map<String, LocalSong> = emptyMap(),
    /** Waiting or running, in order. */
    val pending: List<QueuedSong> = emptyList(),
    val progress: Map<String, Progress> = emptyMap(),
    val failures: Map<String, String> = emptyMap(),
) {
    private val pendingIds: Set<String> by lazy { pending.mapTo(HashSet()) { it.id } }

    /**
     * Precedence: a file on the device wins over everything (a stale failure
     * or a leftover queue entry must not hide it); then a running transfer;
     * then waiting; then the last failure.
     */
    fun stateOf(songId: String): DownloadState {
        downloaded[songId]?.let { return DownloadState.Done(it) }
        progress[songId]?.let { return DownloadState.InProgress(it.bytesRead, it.total) }
        if (songId in pendingIds) return DownloadState.Queued
        failures[songId]?.let { return DownloadState.Failed(it) }
        return DownloadState.Absent
    }

    val activeCount: Int get() = pending.size
}
