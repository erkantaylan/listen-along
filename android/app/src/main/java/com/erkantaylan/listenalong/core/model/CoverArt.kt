package com.erkantaylan.listenalong.core.model

/**
 * A song's cover: the public YouTube thumbnail the web shows too
 * (`https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg`). Public on purpose:
 * it is fetched by a client that never carries the session (core/network
 * ImageHttp), and the server's authenticated `/api/covers` is not used.
 */
object CoverArt {
    const val DEFAULT_BASE = "https://i.ytimg.com/vi/"

    /** Debug builds may point this at the stub (`--es thumbs …`), so the dev loop never asks YouTube. */
    @Volatile
    var base: String = DEFAULT_BASE

    /** YouTube ids are 11 characters of [A-Za-z0-9_-]; anything else is not put into a URL. */
    private val ID = Regex("^[A-Za-z0-9_-]{6,32}$")

    fun thumbnailUrl(youtubeId: String?): String? =
        youtubeId?.trim()?.takeIf { ID.matches(it) }?.let { "$base$it/hqdefault.jpg" }
}
