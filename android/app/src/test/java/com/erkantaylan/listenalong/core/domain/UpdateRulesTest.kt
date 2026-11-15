package com.erkantaylan.listenalong.core.domain

import com.erkantaylan.listenalong.core.domain.UpdateRules.Dismissal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {

    @Test
    fun `versions compare as numbers, like the version code`() {
        assertTrue(UpdateRules.isNewer("0.10.0", "0.9.0"))       // a string compare would say no
        assertTrue(UpdateRules.isNewer("1.0.0", "0.99.99"))
        assertTrue(UpdateRules.isNewer("0.4.1", "0.4.0"))
        assertFalse(UpdateRules.isNewer("0.4.0", "0.4.0"))       // equal
        assertFalse(UpdateRules.isNewer("0.3.9", "0.4.0"))       // older
        assertEquals(1002, UpdateRules.parse("0.10.2")!!.code)
        assertEquals(400, UpdateRules.parse("android-v0.4.0")!!.code)
    }

    @Test
    fun `malformed names are never offered`() {
        assertFalse(UpdateRules.isNewer("latest", "0.4.0"))
        assertFalse(UpdateRules.isNewer("1.0", "0.4.0"))
        assertFalse(UpdateRules.isNewer("", "0.4.0"))
        assertFalse(UpdateRules.isNewer(null, "0.4.0"))
        assertFalse(UpdateRules.isNewer("1.0.0", "garbage"))
        assertNull(UpdateRules.parse("1.2.3.4"))
    }

    @Test
    fun `pre-releases are not offered, and a dev build is older than its release`() {
        assertFalse(UpdateRules.isNewer("0.5.0-rc1", "0.4.0"))
        assertTrue(UpdateRules.isNewer("0.2.0", "0.2.0-dev"))
        assertTrue(UpdateRules.isDevBuild("0.2.0-dev", debug = false))
        assertTrue(UpdateRules.isDevBuild("0.4.0", debug = true))
        assertFalse(UpdateRules.isDevBuild("0.4.0", debug = false))
    }

    @Test
    fun `Later hides that version for three days, a newer one shows at once`() {
        val now = 10_000_000_000L
        val day = 24L * 60 * 60 * 1000
        assertTrue(UpdateRules.shouldShow("0.5.0", "0.4.0", null, now))
        assertFalse(UpdateRules.shouldShow("0.5.0", "0.4.0", Dismissal("0.5.0", now - day), now))       // dismissed recently
        assertTrue(UpdateRules.shouldShow("0.5.0", "0.4.0", Dismissal("0.5.0", now - 4 * day), now))    // a while ago
        assertTrue(UpdateRules.shouldShow("0.6.0", "0.4.0", Dismissal("0.5.0", now - day), now))        // an older version was dismissed
        assertFalse(UpdateRules.shouldShow("0.4.0", "0.4.0", null, now))
    }

    @Test
    fun `the update link opens only this repository's GitHub releases`() {
        val base = "https://github.com/erkantaylan/listen-along/releases"
        listOf(
            base, "$base/",
            "$base/tag/android-v0.5.0",
            "$base/download/android-v0.5.0/listen-along-0.5.0.apk",
            "$base/latest",
            "$base/latest/download/listen-along.apk",
        ).forEach { assertTrue(it, UpdateRules.isReleaseUrl(it)) }
    }

    @Test
    fun `other hosts, repositories, paths and tricks are refused`() {
        val base = "https://github.com/erkantaylan/listen-along/releases"
        listOf(
            "https://github.com/someone/listen-along/releases/download/v1/x.apk",   // another repository
            "https://github.com/erkantaylan/listen-along/archive/main.zip",         // not a release
            "https://github.com/erkantaylan/listen-along/releases/edit/android-v0.5.0",
            "https://github.com.evil.example/erkantaylan/listen-along/releases",     // look-alike host
            "https://evil.example/erkantaylan/listen-along/releases",
            "https://objects.githubusercontent.com/github-production-release-asset/x", // the redirect host: never handed to the app
            "https://user@github.com/erkantaylan/listen-along/releases",              // credentials
            "https://github.com:8443/erkantaylan/listen-along/releases",              // a port
            "$base/download/android-v0.5.0/x.apk?redirect=https://evil.example",     // a query
            "$base/tag/android-v0.5.0#x",                                            // a fragment
            "$base/download/%2e%2e/%2e%2e/x.apk",                                    // encoded dots
            "$base/download/a%2Fb/x.apk",                                            // an encoded slash
            "$base/../../evil/releases",
            "$base/download/android-v0.5.0/x.apk/more",
        ).forEach { assertFalse(it, UpdateRules.isReleaseUrl(it)) }
    }

    @Test
    fun `malformed and non-https values are refused`() {
        listOf(
            null, "", " ", "github.com/erkantaylan/listen-along/releases",
            "http://github.com/erkantaylan/listen-along/releases",
            "HTTPS://github.com/erkantaylan/listen-along/releases",
            "javascript:alert(1)", "intent://github.com/erkantaylan/listen-along/releases#Intent;end",
            "file:///sdcard/x.apk", "content://x/y", "https://", "https:///erkantaylan/listen-along/releases",
            "https://github.com\\@evil.example/erkantaylan/listen-along/releases",
            "https://github.com/erkantaylan/listen-along/releases/tag/a b",
            "https://github.com/erkantaylan/listen-along/releases\n",
        ).forEach { assertFalse(it.toString(), UpdateRules.isReleaseUrl(it)) }
    }
}
