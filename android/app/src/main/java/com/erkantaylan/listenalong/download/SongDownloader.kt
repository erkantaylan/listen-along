package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.storage.AudioFormat
import com.erkantaylan.listenalong.storage.AudioSink
import com.erkantaylan.listenalong.storage.FileNames
import com.erkantaylan.listenalong.storage.LocalSong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlin.coroutines.coroutineContext

/**
 * Fetches one song and writes it, byte for byte, into the [AudioSink].
 *
 * No resume: songs are a few megabytes, and a MediaStore pending file is not
 * something to keep around between attempts. A failed or cancelled transfer
 * throws its partial file away.
 */
class SongDownloader(private val sink: AudioSink) {

    suspend fun download(
        client: LibraryClient,
        song: QueuedSong,
        onProgress: (bytesRead: Long, total: Long) -> Unit = { _, _ -> },
        now: () -> Long = System::currentTimeMillis,
    ): LocalSong = withContext(Dispatchers.IO) {
        val context = coroutineContext
        client.streamFile(song.id, context[Job]) { contentType, contentLength, body ->
            val format = AudioFormat.fromContentType(contentType)
            val name = FileNames.displayName(song.artist, song.title, format)
            val pending = sink.begin(name, format)
            try {
                var written = 0L
                onProgress(0, contentLength)
                val buffer = ByteArray(64 * 1024)
                var sinceReport = 0L
                while (true) {
                    context.ensureActive()
                    val read = body.read(buffer)
                    if (read < 0) break
                    pending.output.write(buffer, 0, read)
                    written += read
                    sinceReport += read
                    if (sinceReport >= 128 * 1024) {
                        onProgress(written, contentLength)
                        sinceReport = 0
                    }
                }
                pending.output.flush()
                if (contentLength >= 0 && written != contentLength) {
                    throw IOException("Transfer cut short: $written of $contentLength bytes")
                }
                if (written == 0L) throw IOException("The server sent an empty file")
                onProgress(written, contentLength)
                context.ensureActive()

                val saved = pending.commit()
                LocalSong(
                    songId = song.id,
                    uri = saved.uri,
                    displayName = saved.displayName,
                    title = song.title,
                    artist = song.artist,
                    durationSec = song.durationSec,
                    mimeType = format.mimeType,
                    bytes = written,
                    savedAt = now(),
                )
            } catch (t: Throwable) {
                pending.abort()
                throw t
            }
        }
    }
}
