package com.erkantaylan.listenalong.core.domain

import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SortOrder
import com.erkantaylan.listenalong.core.storage.LocalSong

/*
 * The offline rules several screens share (Library offline, On device, the
 * car): what is on the phone, searched and sorted the way the server would.
 */

/** A downloaded song as a library song, for the offline library and for playing. */
fun LocalSong.toSong(): Song = Song(
    id = songId,
    title = title.ifBlank { displayName.substringBeforeLast('.') },
    artist = artist,
    durationRaw = durationSec?.toDouble(),
)

/** The offline library: what is on the device, searched and sorted like the server would. */
fun offlineLibrary(
    local: Collection<LocalSong>,
    query: String,
    sort: SortOrder,
    /** Only these song ids (the Broken filter offline: the saved report list). */
    only: Set<String>? = null,
): List<Song> {
    val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val hits = local.filter { song -> only == null || song.songId in only }.filter { song ->
        val hay = "${song.title} ${song.artist} ${song.displayName}".lowercase()
        words.all { it in hay }
    }
    val sorted = when (sort) {
        SortOrder.RECENT -> hits.sortedByDescending { it.savedAt }
        SortOrder.TITLE -> hits.sortedWith(compareBy({ it.title.lowercase() }, { it.artist.lowercase() }))
        SortOrder.ARTIST -> hits.sortedWith(compareBy({ it.artist.lowercase() }, { it.title.lowercase() }))
    }
    return sorted.map { it.toSong() }
}

/** Downloaded songs, newest first is not useful for music: artist, then title. */
fun sortedForDevice(songs: Collection<LocalSong>, query: String): List<LocalSong> {
    val needle = query.trim().lowercase()
    return songs
        .filter {
            needle.isEmpty() || it.title.lowercase().contains(needle) ||
                it.artist.lowercase().contains(needle) || it.displayName.lowercase().contains(needle)
        }
        .sortedWith(compareBy<LocalSong>({ it.artist.lowercase() }, { it.title.lowercase() }))
}
