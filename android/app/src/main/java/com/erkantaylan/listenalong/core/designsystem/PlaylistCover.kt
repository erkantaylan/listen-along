package com.erkantaylan.listenalong.core.designsystem

import java.text.Normalizer
import java.util.Locale

/**
 * A playlist's placeholder cover: its initials on one of six muted colours
 * picked from its id. A port of the web's `playlistInitials` /
 * `playlistCoverIndex` (frontend/src/features/playlists/playlist-filter.ts),
 * so a playlist has the same cover on the web and on the phone; the tests use
 * the web's fixtures with the values the web computes.
 */
object PlaylistCover {
    const val COLOURS = 6

    /** 1..[COLOURS]: a 31-hash of the id's code points, kept to 32 unsigned bits as the web's `>>> 0` does. */
    fun index(id: String?): Int {
        var h = 0L
        val s = id.orEmpty()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            h = (h * 31 + cp) and 0xFFFFFFFFL
            i += Character.charCount(cp)
        }
        return (h % COLOURS).toInt() + 1
    }

    /** JavaScript's `\s` (Unicode spaces too), which Java's `\s` is not. */
    private val JS_SPACE = Regex("[\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")
    private val TURKISH = Locale.forLanguageTag("tr")

    /** One or two capitals: the first whole character of the first two words, Turkish rules ("istanbul" → "İ"); "?" when empty. */
    fun initials(name: String?): String {
        val words = Normalizer.normalize(name.orEmpty(), Normalizer.Form.NFC).trim().split(JS_SPACE).filter { it.isNotEmpty() }
        val letters = words.take(2).joinToString("") { w -> String(Character.toChars(w.codePointAt(0))) }
        return letters.uppercase(TURKISH).ifEmpty { "?" }
    }
}
