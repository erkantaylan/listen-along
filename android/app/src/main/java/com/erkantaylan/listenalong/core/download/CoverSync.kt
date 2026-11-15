package com.erkantaylan.listenalong.core.download

import com.erkantaylan.listenalong.core.model.CoverArt
import com.erkantaylan.listenalong.core.network.ApiProvider
import com.erkantaylan.listenalong.core.storage.CoverStore
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.LocalSong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * Keeps a cover next to every downloaded song ([CoverStore]): fetched right
 * after the song is saved, backfilled for songs downloaded before covers
 * were kept (their YouTube ids are learnt once from the library, never by
 * downloading the audio again), and deleted with the download. Offline it
 * stops quietly and tries again on the next [sync]. Songs with no YouTube
 * video keep the file's embedded picture or the placeholder.
 */
class CoverSync(
    private val index: DownloadIndex,
    private val store: CoverStore,
    private val api: ApiProvider,
    /** The image's bytes, null when there is none (a 4xx); throws on a network error. Blocking. */
    private val fetch: (url: String) -> ByteArray?,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Mutex()
    /** Songs known to have no cover this run (no video, or the thumbnail is gone): not asked again until restart. */
    private val none = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var idsLearnt = false

    /** The cover of a song that was just downloaded. Failing is fine: [sync] tries again. */
    suspend fun fetchFor(local: LocalSong) = withContext(io) {
        if (store.has(local.songId)) return@withContext
        val url = CoverArt.thumbnailUrl(local.youtubeId) ?: return@withContext
        try {
            fetch(url)?.let { store.save(local.songId, it) } ?: none.add(local.songId)
        } catch (c: CancellationException) {
            throw c
        } catch (_: Exception) {
        }
    }

    /** Drops covers of songs no longer downloaded, then fetches the missing ones. Returns how many were saved. */
    suspend fun sync(): Int = withContext(io) {
        lock.withLock {
            store.retainOnly(index.entries.value.keys)
            fun missing() = index.entries.value.values.filter { !store.has(it.songId) && it.songId !in none }
            if (missing().isEmpty()) return@withContext 0

            if (!idsLearnt && missing().any { it.youtubeId == null }) {
                val client = api() ?: return@withContext 0
                val songs = try {
                    client.listAll()
                } catch (c: CancellationException) {
                    throw c
                } catch (_: Exception) {
                    return@withContext 0 // offline or the server is down: next time
                }
                idsLearnt = true
                index.setYoutubeIds(songs.mapNotNull { s -> s.youtubeId?.takeIf { it.isNotBlank() }?.let { s.id to it } }.toMap())
            }

            var saved = 0
            for (local in missing()) {
                val url = CoverArt.thumbnailUrl(local.youtubeId)
                if (url == null) {
                    if (idsLearnt || local.youtubeId != null) none.add(local.songId)
                    continue
                }
                val bytes = try {
                    fetch(url)
                } catch (c: CancellationException) {
                    throw c
                } catch (_: IOException) {
                    break // the connection is gone: stop here, the rest next time
                }
                if (bytes == null) none.add(local.songId) else {
                    store.save(local.songId, bytes)
                    saved++
                }
            }
            saved
        }
    }
}
