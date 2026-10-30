package com.erkantaylan.listenalong.storage

/**
 * The container a downloaded song is saved as. Chosen from the response's
 * Content-Type, never from what we expect: new uploads are m4a, but legacy
 * songs migrated from the old cache keep their format. The server registers
 * `.mp3`, `.webm` and `.ogg`/`.opus` files there and serves them as
 * `audio/mpeg`, `audio/webm` and `audio/ogg` (see MIME_BY_EXT in the
 * backend's library.js).
 *
 * [mimeType] is what MediaStore is told, so it must be a type MediaStore
 * accepts for the Audio collection. It rejects `audio/webm` outright
 * ("Unsupported MIME type"), so WebM, which is a subset of Matroska, is saved
 * as `.mka` / `audio/x-matroska`; the bytes are unchanged.
 */
enum class AudioFormat(val extension: String, val mimeType: String) {
    M4A("m4a", "audio/mp4"),
    MP3("mp3", "audio/mpeg"),
    WEBM("mka", "audio/x-matroska"),
    OGG("ogg", "audio/ogg");

    companion object {
        fun fromContentType(contentType: String?): AudioFormat {
            val mime = contentType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
            return when (mime) {
                "audio/mpeg", "audio/mp3", "audio/mpeg3", "audio/x-mpeg", "audio/x-mp3" -> MP3
                "audio/webm", "video/webm" -> WEBM
                "audio/ogg", "audio/opus", "audio/x-opus", "audio/vorbis", "application/ogg" -> OGG
                // audio/mp4, audio/m4a, audio/x-m4a, audio/aac and anything
                // unexpected (application/octet-stream): the server stores m4a.
                else -> M4A
            }
        }

        fun fromMimeType(mimeType: String?): AudioFormat = fromContentType(mimeType)
    }
}

/**
 * Display names for saved songs: `"<Artist> - <Title>.m4a"`, made safe for
 * every filesystem the file might end up on (FAT/exFAT SD cards included,
 * which reject more characters than ext4 does).
 */
object FileNames {

    /**
     * Budget for the base name in UTF-8 bytes. Filesystems allow 255; this
     * leaves room for the extension and for the " (12)" MediaStore appends
     * when a name is already taken.
     */
    const val MAX_BASE_BYTES = 200

    private val FORBIDDEN = Regex("[\\\\/:*?\"<>|\\p{Cntrl}]")
    private val WHITESPACE = Regex("\\s+")

    /** The server's placeholder when an upload carried no artist. */
    private const val UNKNOWN_ARTIST = "Unknown"

    fun baseName(artist: String?, title: String?): String {
        val cleanTitle = sanitize(title.orEmpty())
        val cleanArtist = sanitize(artist.orEmpty())
        val hasArtist = cleanArtist.isNotEmpty() && !cleanArtist.equals(UNKNOWN_ARTIST, ignoreCase = true)
        val joined = when {
            hasArtist && cleanTitle.isNotEmpty() -> "$cleanArtist - $cleanTitle"
            cleanTitle.isNotEmpty() -> cleanTitle
            hasArtist -> cleanArtist
            else -> ""
        }
        // A cut right after the artist would leave a dangling " -".
        return truncateUtf8(joined, MAX_BASE_BYTES).trimEnds().removeSuffix(" -").trimEnds()
            .ifEmpty { "Untitled" }
    }

    fun displayName(artist: String?, title: String?, format: AudioFormat): String =
        "${baseName(artist, title)}.${format.extension}"

    /**
     * Replaces characters that are illegal or dangerous in a filename with a
     * space, collapses runs of whitespace, and strips leading and trailing dots
     * and spaces: a leading dot hides the file, a trailing one is dropped or
     * rejected by FAT. Letters in any script are kept as they are.
     */
    fun sanitize(raw: String): String =
        raw.replace(FORBIDDEN, " ")
            .replace(WHITESPACE, " ")
            .trimEnds()

    private fun String.trimEnds(): String = trim { it == ' ' || it == '.' || it.isWhitespace() }

    /** Cuts to at most [maxBytes] of UTF-8 without splitting a character. */
    internal fun truncateUtf8(text: String, maxBytes: Int): String {
        if (text.toByteArray(Charsets.UTF_8).size <= maxBytes) return text
        val out = StringBuilder()
        var used = 0
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val chars = Character.charCount(cp)
            val bytes = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8).size
            if (used + bytes > maxBytes) break
            out.appendCodePoint(cp)
            used += bytes
            i += chars
        }
        return out.toString()
    }
}
