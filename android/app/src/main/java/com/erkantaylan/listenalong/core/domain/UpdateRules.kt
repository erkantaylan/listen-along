package com.erkantaylan.listenalong.core.domain

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * When to offer a newer Android release (never forced): pure rules, tested in
 * UpdateRulesTest. Versions are compared as numbers, never as strings:
 * versionName X.Y.Z is versionCode X*10000 + Y*100 + Z (app/build.gradle.kts).
 */
object UpdateRules {

    /** "Later" hides a version for this long; a newer version shows at once. */
    const val SNOOZE_MS = 3L * 24 * 60 * 60 * 1000

    /** While the app stays open, it asks again at most this often (a cold start always asks). */
    const val RECHECK_MS = 12L * 60 * 60 * 1000

    data class Version(val major: Int, val minor: Int, val patch: Int, val suffix: String?) : Comparable<Version> {
        /** The release's versionCode, as the build computes it. */
        val code: Int get() = major * 10000 + minor * 100 + patch

        override fun compareTo(other: Version): Int = compareValuesBy(this, other,
            { it.major }, { it.minor }, { it.patch },
            // A suffixed build (1.2.3-dev, 1.2.3-rc1) comes before 1.2.3 itself.
            { if (it.suffix == null) 1 else 0 })
    }

    private val PATTERN = Regex("""^v?(\d{1,4})\.(\d{1,2})\.(\d{1,2})(?:-([0-9A-Za-z.-]+))?$""")

    /** "0.5.0", "android-v0.5.0", "0.2.0-dev"; null for anything else. */
    fun parse(text: String?): Version? {
        val clean = text?.trim()?.removePrefix("android-") ?: return null
        val m = PATTERN.matchEntire(clean) ?: return null
        val (a, b, c, suffix) = m.destructured
        return Version(a.toInt(), b.toInt(), c.toInt(), suffix.ifEmpty { null })
    }

    /** Whether [latest] is a release newer than [installed]. A pre-release or malformed name is never offered. */
    fun isNewer(latest: String?, installed: String?): Boolean {
        val l = parse(latest) ?: return false
        val i = parse(installed) ?: return false
        if (l.suffix != null) return false
        return l > i
    }

    /** The version the user tapped "Later" on, and when. */
    data class Dismissal(val version: String, val at: Long)

    fun shouldShow(latest: String?, installed: String?, dismissed: Dismissal?, now: Long): Boolean {
        if (!isNewer(latest, installed)) return false
        if (dismissed == null) return true
        val sameVersion = parse(dismissed.version)?.let { d -> parse(latest)?.let { it.compareTo(d) == 0 } } == true
        return !(sameVersion && now - dismissed.at < SNOOZE_MS)
    }

    /** Builds that never look for updates unless asked (a debug build, a local "-dev" build). */
    fun isDevBuild(versionName: String, debug: Boolean): Boolean = debug || parse(versionName)?.suffix != null

    /** The repository whose GitHub releases the server's `/api/app/latest` points at (backend app-release). */
    const val RELEASES_PATH = "/erkantaylan/listen-along/releases"

    private val SAFE_SEGMENT = Regex("""^[A-Za-z0-9._-]+$""")

    /**
     * Whether the update notice may open [url]: only this repository's
     * releases on github.com, as the server answers them (the APK's
     * `browser_download_url` .../releases/download/<tag>/<file>, the
     * release's page .../releases/tag/<tag>, the list .../releases).
     * GitHub's redirect from a download link to its asset host happens in
     * the browser; the app is never handed that host. Exactly `https://`,
     * host github.com, no user, port, query or fragment, plain path
     * segments only.
     */
    fun isReleaseUrl(url: String?): Boolean {
        if (url == null || !url.startsWith("https://github.com/") || url.any { it.isWhitespace() || it.isISOControl() || it == '\\' }) return false
        val parsed = url.toHttpUrlOrNull() ?: return false
        if (!parsed.isHttps || parsed.host != "github.com" || parsed.port != 443) return false
        if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty()) return false
        if (parsed.encodedQuery != null || parsed.encodedFragment != null) return false
        val segments = parsed.encodedPathSegments.let { if (it.lastOrNull() == "") it.dropLast(1) else it }
        val base = RELEASES_PATH.trim('/').split('/')
        if (segments.size < base.size || segments.take(base.size) != base) return false
        val rest = segments.drop(base.size)
        if (rest.any { !SAFE_SEGMENT.matches(it) || it == "." || it == ".." }) return false
        return when (rest.firstOrNull()) {
            null -> true
            "tag" -> rest.size == 2
            "download" -> rest.size == 3
            "latest" -> rest.size == 1 || (rest.size == 3 && rest[1] == "download")
            else -> false
        }
    }
}
