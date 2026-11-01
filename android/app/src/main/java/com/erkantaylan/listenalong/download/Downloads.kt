package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.AudioSink
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.FileMatcher
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
    private val now: () -> Long = System::currentTimeMillis,
) {

    private val downloader = SongDownloader(sink)
    private val progress = MutableStateFlow<Map<String, Progress>>(emptyMap())
    private val failures = MutableStateFlow<Map<String, String>>(emptyMap())
    private val jobs = ConcurrentHashMap<String, Job>()
    private val reclaimLock = Mutex()

    /** Files already compared with the library and not matched, so a resume does not fetch it again. */
    private val unmatched = ConcurrentHashMap.newKeySet<String>()

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
        index.reconcile { !isGone(it) }.size
    }

    /** With no media access, a file from an earlier install is invisible whether it exists or not. */
    private fun isGone(local: LocalSong): Boolean =
        !(local.reclaimed && !sink.canSeeAllFiles) && !sink.exists(local.uri)

    /**
     * Recognises files in the folder that the index does not know (after a
     * reinstall or a data clear), by comparing them with the server's library.
     * Only asks the server when there is a file it has not compared yet;
     * [force] compares them again. A failure leaves everything as it was.
     * Returns how many songs came back.
     */
    suspend fun reclaim(force: Boolean = false): Int = withContext(Dispatchers.IO) {
        reclaimLock.withLock {
            if (force) unmatched.clear()
            val known = index.entries.value.values.mapTo(HashSet()) { it.uri }
            val files = runCatching { sink.listSaved() }.getOrDefault(emptyList())
                .filter { it.uri !in known && it.uri !in unmatched }
            if (files.isEmpty()) return@withContext 0
            val client = clientProvider() ?: return@withContext 0
            val songs = try {
                client.listAll()
            } catch (c: CancellationException) {
                throw c
            } catch (_: Exception) {
                return@withContext 0
            }
            val current = index.entries.value
            val matches = FileMatcher.match(songs.filterNot { it.id in current }, files)
            val hasAccess = sink.canSeeAllFiles
            matches.forEach { (song, file) ->
                index.put(LocalSong(
                    songId = song.id,
                    uri = file.uri,
                    displayName = file.displayName,
                    title = song.title,
                    artist = song.artist,
                    durationSec = song.durationSec,
                    mimeType = file.mimeType ?: "audio/mp4",
                    bytes = file.bytes,
                    savedAt = now(),
                    // Without media access only this install's own files are visible.
                    reclaimed = hasAccess,
                ))
            }
            val taken = matches.mapTo(HashSet()) { it.second.uri }
            files.filter { it.uri !in taken }.mapTo(unmatched) { it.uri }
            matches.size
        }
    }

    /**
     * Deletes the file and forgets it. Returns false, keeping the entry, when
     * the file is still there and this app may not delete it: an earlier
     * install's file needs the user's consent, and forgetting it instead would
     * only have [reclaim] find it again.
     */
    suspend fun delete(local: LocalSong): Boolean = withContext(Dispatchers.IO) {
        val removed = runCatching { sink.delete(local.uri) }.getOrDefault(false)
        val gone = removed || runCatching { isGone(local) }.getOrDefault(false)
        if (gone) index.remove(local.songId)
        gone
    }

    /**
     * Works through the queue, [concurrency] songs at a time, until it is
     * empty. Cancelling the calling coroutine (WorkManager stopping the worker)
     * leaves unfinished songs queued for the next run.
     */
    suspend fun drain(stats: DrainStats = DrainStats()) {
        // One drain at a time per process (WorkManager's unique work), and
        // nothing is being written yet: anything pending now is an orphan
        // from a process that died mid-download.
        if (jobs.isEmpty()) withContext(Dispatchers.IO) { sink.cleanupAbandoned() }

        // A queued song whose file is already in the folder is not fetched
        // again: runOne finds it in the index.
        reclaim()

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
