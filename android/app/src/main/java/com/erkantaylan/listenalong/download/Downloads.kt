package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.AudioSink
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.LocalSong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Counts for one run of the worker, for its notification. */
class DrainStats {
    val done = AtomicInteger()
    val failed = AtomicInteger()
}

/**
 * The download machinery, one per process. The UI enqueues and cancels here;
 * [DownloadWorker] calls [drain] to do the work.
 *
 * The queue and the index are persisted. Progress and failures are not: they
 * describe what is happening now, and a failure is forgotten as soon as you
 * try again.
 */
class Downloads(
    val queue: DownloadQueue,
    val index: DownloadIndex,
    private val sink: AudioSink,
    /** The client for the server currently configured, or null when there is none. */
    private val clientProvider: () -> LibraryClient?,
    /** Makes sure a worker is (or will be) running. */
    private val kick: () -> Unit,
    private val concurrency: Int = DEFAULT_CONCURRENCY,
    private val retryDelaysMs: List<Long> = listOf(2_000, 6_000),
) {

    private val downloader = SongDownloader(sink)
    private val progress = MutableStateFlow<Map<String, Progress>>(emptyMap())
    private val failures = MutableStateFlow<Map<String, String>>(emptyMap())
    private val jobs = ConcurrentHashMap<String, Job>()

    val snapshots: Flow<DownloadSnapshot> =
        combine(index.entries, queue.pending, progress, failures, ::DownloadSnapshot)

    fun snapshot(): DownloadSnapshot =
        DownloadSnapshot(index.entries.value, queue.pending.value, progress.value, failures.value)

    /** Queues [songs] (skipping ones already here or queued). Returns how many were added. */
    fun enqueue(songs: List<Song>): Int {
        val ids = songs.mapTo(HashSet()) { it.id }
        failures.update { it - ids }
        val added = queue.enqueue(songs.map(QueuedSong::of), index::contains)
        if (queue.pending.value.isNotEmpty()) kick()
        return added.size
    }

    fun cancel(songId: String) {
        queue.cancel(songId)
        jobs[songId]?.cancel()
        progress.update { it - songId }
    }

    fun cancelAll() {
        queue.cancelAll()
        jobs.values.forEach { it.cancel() }
        progress.value = emptyMap()
    }

    /** Forgets songs whose files were deleted outside the app. Returns how many. */
    suspend fun reconcile(): Int = withContext(Dispatchers.IO) {
        index.reconcile { sink.exists(it.uri) }.size
    }

    /** Deletes the file (when it is still ours to delete) and forgets it either way. */
    suspend fun delete(local: LocalSong): Boolean = withContext(Dispatchers.IO) {
        val removed = runCatching { sink.delete(local.uri) }.getOrDefault(false)
        index.remove(local.songId)
        removed
    }

    /**
     * Works through the queue, [concurrency] songs at a time, until it is
     * empty. Cancelling the calling coroutine (WorkManager stopping the worker)
     * leaves unfinished songs queued for the next run.
     */
    suspend fun drain(stats: DrainStats = DrainStats()) {
        val client = clientProvider()
        if (client == null) {
            // Nothing can be fetched without a server; say so on every row.
            while (true) {
                val song = queue.claimNext() ?: break
                failures.update { it + (song.id to "No server set — see Settings") }
                queue.finish(song.id)
                stats.failed.incrementAndGet()
            }
            return
        }

        coroutineScope {
            repeat(concurrency) {
                launch {
                    while (currentCoroutineContext().isActive) {
                        val song = queue.claimNext() ?: break
                        // Its own job, so cancelling one song leaves the lane
                        // (and the other lane) running.
                        coroutineScope {
                            val job = launch { runOne(client, song, stats) }
                            jobs[song.id] = job
                            job.join()
                        }
                    }
                }
            }
        }
    }

    private suspend fun runOne(client: LibraryClient, song: QueuedSong, stats: DrainStats) {
        val id = song.id
        try {
            if (index.contains(id)) {
                queue.finish(id)
                return
            }
            progress.update { it + (id to Progress(0, -1)) }
            val local = withRetries {
                downloader.download(client, song, onProgress = { read, total ->
                    progress.update { it + (id to Progress(read, total)) }
                })
            }
            index.put(local)
            queue.finish(id)
            stats.done.incrementAndGet()
        } catch (c: CancellationException) {
            // Cancelled by the user: already out of the queue, release is a
            // no-op. Worker stopping: stays queued for the next run.
            queue.release(id)
            throw c
        } catch (t: Throwable) {
            if (!currentCoroutineContext().isActive) {
                // A cancelled call surfaces as an IOException from the read.
                queue.release(id)
                return
            }
            failures.update { it + (id to describe(t)) }
            queue.finish(id)
            stats.failed.incrementAndGet()
        } finally {
            progress.update { it - id }
            jobs.remove(id)
        }
    }

    private suspend fun <T> withRetries(block: suspend () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: IOException) {
                val permanent = e is ApiException && e.code in 400..499
                if (permanent || attempt >= retryDelaysMs.size || !currentCoroutineContext().isActive) throw e
                delay(retryDelaysMs[attempt++])
            }
        }
    }

    private fun describe(t: Throwable): String = when {
        t is ApiException && t.code == 404 -> "Not on the server any more"
        t is ApiException && t.unauthorized -> "Token rejected (${t.code})"
        t is ApiException -> "Server error: ${t.message}"
        else -> t.message ?: t::class.simpleName ?: "Download failed"
    }

    companion object {
        const val DEFAULT_CONCURRENCY = 2
    }
}
