package com.erkantaylan.listenalong.storage

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * Saves songs as ordinary public audio files under `Music/ListenAlong/`, so
 * VLC, the system player and any file manager see them. The server's bytes
 * are stored unchanged: its files already carry tags and cover art.
 *
 * Android 10+ (API 29) goes through MediaStore with IS_PENDING, which needs no
 * storage permission for files the app creates. Android 8–9 has no
 * RELATIVE_PATH, so the file is written directly into the public Music folder
 * (WRITE_EXTERNAL_STORAGE, requested at runtime) and then scanned in.
 */
class MediaStoreAudio(private val context: Context) : AudioSink {

    private val resolver: ContentResolver get() = context.contentResolver

    override fun begin(displayName: String, format: AudioFormat): PendingAudio =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) beginScoped(displayName, format)
        else beginLegacy(displayName, format)

    private fun beginScoped(displayName: String, format: AudioFormat): PendingAudio {
        val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            put(MediaStore.MediaColumns.MIME_TYPE, format.mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values)
            ?: throw IOException("MediaStore refused to create $displayName")
        val stream = try {
            resolver.openOutputStream(uri, "w") ?: throw IOException("Cannot write $displayName")
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }

        return object : PendingAudio {
            private var finished = false
            override val output: OutputStream = stream

            override fun commit(): SavedAudio {
                stream.close()
                val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                resolver.update(uri, done, null, null)
                finished = true
                return SavedAudio(uri.toString(), queryDisplayName(uri) ?: displayName)
            }

            override fun abort() {
                if (finished) return
                finished = true
                runCatching { stream.close() }
                runCatching { resolver.delete(uri, null, null) }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun beginLegacy(displayName: String, format: AudioFormat): PendingAudio {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), FOLDER)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create $dir")
        val target = uniqueFile(dir, displayName)
        val part = File(dir, ".${target.name}.part")
        val stream = FileOutputStream(part)

        return object : PendingAudio {
            private var finished = false
            override val output: OutputStream = stream

            override fun commit(): SavedAudio {
                stream.close()
                if (!part.renameTo(target)) {
                    part.delete()
                    throw IOException("Could not move ${target.name} into place")
                }
                finished = true
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DATA, target.absolutePath)
                    put(MediaStore.MediaColumns.DISPLAY_NAME, target.name)
                    put(MediaStore.MediaColumns.MIME_TYPE, format.mimeType)
                    put(MediaStore.MediaColumns.TITLE, target.nameWithoutExtension)
                }
                val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
                    ?: Uri.fromFile(target)
                // Let the scanner read the real tags (title, artist, cover).
                MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath),
                                                arrayOf(format.mimeType), null)
                return SavedAudio(uri.toString(), target.name)
            }

            override fun abort() {
                if (finished) return
                finished = true
                runCatching { stream.close() }
                part.delete()
            }
        }
    }

    override fun exists(uri: String): Boolean {
        val parsed = Uri.parse(uri)
        if (parsed.scheme == ContentResolver.SCHEME_FILE) return File(parsed.path.orEmpty()).isFile
        return try {
            resolver.query(parsed, arrayOf(MediaStore.MediaColumns._ID), null, null, null)
                ?.use { it.moveToFirst() } ?: false
        } catch (_: SecurityException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    override fun delete(uri: String): Boolean {
        val parsed = Uri.parse(uri)
        return try {
            if (parsed.scheme == ContentResolver.SCHEME_FILE) File(parsed.path.orEmpty()).delete()
            else resolver.delete(parsed, null, null) > 0
        } catch (_: SecurityException) {
            // Not ours any more (e.g. after a reinstall): the user can delete it
            // from their file manager; we just forget it.
            false
        }
    }

    override fun cleanupAbandoned(): Int = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Only this app's own pending rows are visible to it, so nothing
            // another app is writing can be caught here.
            val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val args = android.os.Bundle().apply {
                putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_ONLY)
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.MediaColumns.RELATIVE_PATH} = ?")
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(RELATIVE_PATH))
            }
            val ids = resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID), args, null)
                ?.use { c -> buildList { while (c.moveToNext()) add(c.getLong(0)) } }
                .orEmpty()
            ids.count { id ->
                resolver.delete(android.content.ContentUris.withAppendedId(collection, id), null, null) > 0
            }
        } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), FOLDER)
            dir.listFiles { f -> f.name.startsWith(".") && f.name.endsWith(".part") }
                .orEmpty().count { it.delete() }
        } else {
            0 // Android 10: MediaStore expires abandoned pending rows itself after a week.
        }
    }.getOrDefault(0)

    private fun queryDisplayName(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()

    private fun uniqueFile(dir: File, displayName: String): File {
        val base = displayName.substringBeforeLast('.')
        val ext = displayName.substringAfterLast('.', "")
        var candidate = File(dir, displayName)
        var n = 1
        while (candidate.exists()) {
            candidate = File(dir, "$base ($n).$ext")
            n++
        }
        return candidate
    }

    companion object {
        const val FOLDER = "ListenAlong"
        val RELATIVE_PATH = "${Environment.DIRECTORY_MUSIC}/$FOLDER/"
    }
}
