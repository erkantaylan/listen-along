package com.erkantaylan.listenalong.core.download

import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.ApiProvider
import com.erkantaylan.listenalong.core.network.ListenAlongApi
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.storage.AudioFormat
import com.erkantaylan.listenalong.core.storage.AudioSink
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.FileMatcher
import com.erkantaylan.listenalong.core.storage.LocalSong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
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
    private val clientProvider: ApiProvider,
    /** Makes sure a worker is (or will be) running. */
    private val kick: () -> Unit,
    private val concurrency: Int = DEFAULT_CONCURRENCY,
    private val retryDelaysMs: List<Long> = listOf(2_000, 6_000),
    private val now: () -> Long = System::currentTimeMillis,
    /** Where file and MediaStore work runs (tests pass their own dispatcher). */
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /** After a song is saved (its cover is fetched next to it); a failure here never fails the download. */
    private val onSaved: suspend (LocalSong) -> Unit = {},
    /**
     * Whether playlist sync's downloads may run on the network in force
     * (the "Download over mobile data" setting, roaming, Data Saver). The
     * user's own downloads always run, as before.
     */
    private val mayFetchAuto: () -> Boolean = { true },
    /** Playlist sync's downloads are waiting for a network they may use: have a worker wait for one. */
    private val waitForNetwork: () -> Unit = {},
    /** A song whose file the server does not have (404): playlist sync skips it for a while. */
    private val onMissing: (String) -> Unit = {},
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

    /**
     * Queues [songs] (skipping ones already here or queued). Returns how many
     * were added. [manual]: the user asked (the default); false: playlist sync.
     */
    fun enqueue(songs: List<Song>, manual: Boolean = true): Int {
        val ids = songs.mapTo(HashSet()) { it.id }
        failures.update { it - ids }
        val added = queue.enqueue(songs.map { QueuedSong.of(it, manual) }, index::contains)
        if (queue.pending.value.isNotEmpty()) kick()
        return added.size
    }

    /** Forgets the last failure of these songs (a playlist's Retry). */
    fun clearFailures(songIds: Collection<String>) {
        failures.update { it - songIds.toSet() }
    }

    /**
     * Playlist sync removing a song it downloaded: only a file this app saved
     * for a playlist ([LocalSong.manual] false) and not found in the folder
     * from an earlier install. Never asks the user (no consent prompt): a file
     * that cannot be deleted silently stays. Returns whether it is gone.
     */
    suspend fun deleteOwned(local: LocalSong): Boolean {
        val current = index[local.songId] ?: return false
        if (current.manual || current.reclaimed) return false
        return delete(current)
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
    suspend fun reconcile(): Int = withContext(io) {
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
    suspend fun reclaim(force: Boolean = false): Int = withContext(io) {
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
                    mimeType = AudioFormat.mimeTypeOf(file.displayName, file.mimeType),
                    bytes = file.bytes,
                    savedAt = now(),
                    // Without media access only this install's own files are visible.
                    reclaimed = hasAccess,
                    youtubeId = song.youtubeId,
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
    suspend fun delete(local: LocalSong): Boolean = withContext(io) {
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
    suspend fun drain(stats: DrainStats = DrainStats()) = drainLock.withLock { drainLocked(stats) }

    /** One drain at a time in this process (two workers may start one: the queue's and the network wait). */
    private val drainLock = Mutex()

    private suspend fun drainLocked(stats: DrainStats) {
        // One drain at a time per process (WorkManager's unique work), and
        // nothing is being written yet: anything pending now is an orphan
        // from a process that died mid-download.
        if (jobs.isEmpty()) withContext(io) { sink.cleanupAbandoned() }

        // A queued song whose file is already in the folder is not fetched
        // again: runOne finds it in the index.
        reclaim()

        val client = clientProvider()
        if (client == null) {
            // Nothing can be fetched without a server; say so on every row.
            while (true) {
                val song = queue.claimNext { true } ?: break
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
                        // Playlist sync's songs wait while the network is not one they may use.
                        val song = queue.claimNext { it.manual || mayFetchAuto() } ?: break
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
        if (queue.pending.value.any { !it.manual }) waitForNetwork()
    }

    private suspend fun runOne(client: ListenAlongApi, song: QueuedSong, stats: DrainStats) {
        val id = song.id
        try {
            if (index.contains(id)) {
                queue.finish(id)
                return
            }
            sink.freeBytes()?.let { free ->
                if (free < MIN_FREE_BYTES) throw LowStorageException()
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
            runCatching { onSaved(local) }
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
            if (t is ApiException && t.code == 404) onMissing(id)
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
        t is LowStorageException -> "Not enough free space on the phone"
        t is ApiException && t.code == 404 -> "Not on the server any more"
        t is ApiException && t.sessionEnded -> "Signed out: sign in again"
        t is ApiException -> "Server error: ${t.message}"
        else -> t.message ?: t::class.simpleName ?: "Download failed"
    }

    companion object {
        const val DEFAULT_CONCURRENCY = 2
        /** Below this much free space nothing more is downloaded (the phone needs room to work). */
        const val MIN_FREE_BYTES = 200L * 1024 * 1024
    }
}

/** The phone is almost full: the download is not started. */
class LowStorageException : IOException("Not enough free space")
