package com.erkantaylan.listenalong.api

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Turns whatever was typed into the Settings field into a usable base URL.
 *
 * "listen.example.com" becomes "https://listen.example.com/"; a path prefix is
 * kept (the server may live under one behind a reverse proxy); a query or a
 * fragment is dropped. Returns null when nothing usable is left.
 */
object ServerUrl {

    private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

    fun normalize(input: String): HttpUrl? {
        var text = input.trim()
        if (text.isEmpty()) return null
        if (!text.contains("://")) {
            // The dev hosts (adb reverse tunnel, emulator alias) speak plain
            // HTTP and are the only ones network_security_config lets through.
            val host = text.substringBefore('/').substringBefore(':')
            text = (if (host in LOCAL_HOSTS) "http://" else "https://") + text
        }
        val url = text.toHttpUrlOrNull() ?: return null
        if (url.host.isBlank()) return null

        val segments = url.pathSegments.filter { it.isNotEmpty() }
        return url.newBuilder()
            .query(null)
            .fragment(null)
            .encodedPath("/")
            .apply { segments.forEach { addPathSegment(it) } }
            .build()
            .let { built ->
                // A trailing slash, so relative API paths resolve under the prefix.
                if (built.encodedPath.endsWith("/")) built
                else built.newBuilder().addPathSegment("").build()
            }
    }

    /** What to show back in the field: no trailing slash. */
    fun display(url: HttpUrl): String = url.toString().trimEnd('/')
}
