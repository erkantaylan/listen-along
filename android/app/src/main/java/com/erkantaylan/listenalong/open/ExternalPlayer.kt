package com.erkantaylan.listenalong.open

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.erkantaylan.listenalong.storage.LocalSong

/**
 * Hands a saved song to whichever player the user has (VLC, the system
 * player...). There is deliberately no built-in player: the files are plain
 * tagged audio, and every player already does this better.
 */
object ExternalPlayer {

    sealed interface Result {
        data object Opened : Result
        data class NoHandler(val mimeType: String) : Result
    }

    fun open(context: Context, song: LocalSong): Result {
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(song.uri), song.mimeType)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return try {
            // No chooser: the user's default player (or the system's
            // "open with" sheet when there is none) is the right answer.
            context.startActivity(intent)
            Result.Opened
        } catch (_: ActivityNotFoundException) {
            Result.NoHandler(song.mimeType)
        }
    }
}
