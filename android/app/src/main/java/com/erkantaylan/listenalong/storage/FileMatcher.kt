package com.erkantaylan.listenalong.storage

import com.erkantaylan.listenalong.api.Song
import java.text.Normalizer
import kotlin.math.abs

/**
 * Decides which file in the folder is which library song, after the index
 * that knew has been lost. A file's name is rebuilt from the song's artist and
 * title, the way it was when saving, and the file's own duration must agree.
 *
 * A wrong match would play the wrong song under this song's name, while a
 * missed one only costs a download, so anything doubtful stays unmatched: a
 * " (1)" copy, a duration that is unknown or differs, or a name and duration
 * that fit more than one song or more than one file.
 */
object FileMatcher {

    /** The same tolerance the server uses for "probably the same recording" (library.js). */
    const val DURATION_TOLERANCE_SEC = 3

    fun match(songs: List<Song>, files: List<SavedFile>): List<Pair<Song, SavedFile>> {
        val songsByName = HashMap<String, MutableSet<Song>>()
        songs.forEach { song ->
            savedNames(song).forEach { songsByName.getOrPut(it) { LinkedHashSet() } += song }
        }
        val candidates = files.flatMap { file ->
            val name = baseOf(file.displayName) ?: return@flatMap emptyList()
            songsByName[name].orEmpty().filter { durationAgrees(it, file) }.map { it to file }
        }
        val perSong = candidates.groupingBy { it.first.id }.eachCount()
        val perFile = candidates.groupingBy { it.second.uri }.eachCount()
        return candidates.filter { (song, file) -> perSong[song.id] == 1 && perFile[file.uri] == 1 }
    }

    /**
     * A playlist entry drops a trailing " - Artist" from the title before it
     * is downloaded (PlaylistEntry.cleanTitle), so the library's title can
     * stand for either name.
     */
    private fun savedNames(song: Song): Set<String> {
        val artist = song.artist.trim()
        val title = song.title.trim()
        val clean = if (artist.isNotEmpty() && title.endsWith(" - $artist") && title.length > artist.length + 3) {
            title.dropLast(artist.length + 3)
        } else title
        return setOf(title, clean).mapTo(LinkedHashSet()) { nfc(FileNames.baseName(artist, it)) }
    }

    /** The name without its extension, for any audio file the app knows (`.ogg` and `.opus` included). */
    private fun baseOf(displayName: String): String? {
        AudioFormat.fromFileName(displayName) ?: return null
        return nfc(displayName.substringBeforeLast('.'))
    }

    private fun durationAgrees(song: Song, file: SavedFile): Boolean {
        val expected = song.durationRaw ?: return false
        val actual = file.durationMs ?: return false
        if (expected <= 0) return false
        return abs(actual / 1000.0 - expected) <= DURATION_TOLERANCE_SEC
    }

    private fun nfc(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFC)
}
