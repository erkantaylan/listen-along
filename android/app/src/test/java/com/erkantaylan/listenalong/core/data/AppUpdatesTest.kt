package com.erkantaylan.listenalong.core.data

import com.erkantaylan.listenalong.core.model.AppApk
import com.erkantaylan.listenalong.core.model.AppLatest
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import com.erkantaylan.listenalong.testing.FakeApi
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class AppUpdatesTest {
    private val api = FakeApi().apply {
        latest = AppLatest(available = true, version = "0.5.0", tag = "android-v0.5.0",
                           apk = AppApk("listen-along-0.5.0.apk", "https://github.com/erkantaylan/listen-along/releases/download/android-v0.5.0/listen-along-0.5.0.apk"))
    }
    private var clock = 1_000_000L
    private val store = MemoryTextStore()
    private fun updates(installed: String = "0.4.0", dev: Boolean = false) =
        AppUpdates({ api }, store, installed, dev, now = { clock })

    @Test
    fun `a newer release shows the notice with the APK link`() = runBlocking {
        val u = updates()
        u.checkOnOpen(signedIn = true, online = true)
        assertEquals("0.5.0", u.notice.value?.version)
        assertTrue(u.notice.value!!.downloadUrl.endsWith(".apk"))
    }

    @Test
    fun `nothing for the same version, a debug build, signed out or offline`() = runBlocking {
        updates(installed = "0.5.0").apply { checkOnOpen(true, true); assertNull(notice.value) }
        updates(installed = "0.2.0-dev", dev = true).apply { checkOnOpen(true, true); assertNull(notice.value) }
        updates().apply { checkOnOpen(signedIn = false, online = true); assertNull(notice.value) }
        updates().apply { checkOnOpen(signedIn = true, online = false); assertNull(notice.value) }
        assertEquals(1, api.calls.count { it == "appLatest" }) // only the first asked
    }

    @Test
    fun `a debug build asks when told to`() = runBlocking {
        val u = updates(installed = "0.2.0-dev", dev = true).apply { allowInDevBuild = true }
        u.checkOnOpen(true, true)
        assertEquals("0.5.0", u.notice.value?.version)
    }

    @Test
    fun `Later hides it for a few days, and a failed check is silent`() = runBlocking {
        val u = updates()
        u.checkOnOpen(true, true)
        u.later()
        assertNull(u.notice.value)
        val again = updates()
        again.checkOnOpen(true, true)
        assertNull(again.notice.value)                 // dismissed recently (saved)
        clock += 4L * 24 * 60 * 60 * 1000
        val later = updates()
        later.checkOnOpen(true, true)
        assertEquals("0.5.0", later.notice.value?.version)

        api.fail = IOException("offline")
        val failing = updates()
        failing.checkOnOpen(true, true)
        assertNull(failing.notice.value)
    }

    @Test
    fun `while the app stays open it asks at most every 12 hours`() = runBlocking {
        val u = updates(installed = "0.5.0")
        u.checkOnOpen(true, true)
        clock += 60 * 60 * 1000
        u.checkOnOpen(true, true)
        assertEquals(1, api.calls.count { it == "appLatest" })
        clock += 12L * 60 * 60 * 1000
        u.checkOnOpen(true, true)
        assertEquals(2, api.calls.count { it == "appLatest" })
    }

    @Test
    fun `Check for updates says up to date, newer, or could not check`() = runBlocking {
        assertEquals(UpdateCheck.UpToDate, updates(installed = "0.5.0").checkNow())
        assertTrue(updates().checkNow() is UpdateCheck.Available)
        api.latest = AppLatest(available = false, reason = "unavailable")
        assertEquals(UpdateCheck.Failed, updates().checkNow())
        api.fail = IOException("offline")
        assertEquals(UpdateCheck.Failed, updates().checkNow())
    }

    @Test
    fun `a link that is not this repository's GitHub release falls back to the server's app page`() = runBlocking {
        // The APK link is foreign: the release page (allowed) is used instead.
        api.latest = api.latest.copy(
            apk = AppApk("x.apk", "https://evil.example/listen-along-0.5.0.apk"),
            releaseUrl = "https://github.com/erkantaylan/listen-along/releases/tag/android-v0.5.0",
        )
        assertEquals("https://github.com/erkantaylan/listen-along/releases/tag/android-v0.5.0", (updates().checkNow() as UpdateCheck.Available).notice.downloadUrl)

        // Nothing allowed at all: <configured server>/app.
        api.latest = api.latest.copy(
            apk = AppApk("x.apk", "https://github.com/someone-else/listen-along/releases/download/v/x.apk"),
            releaseUrl = "http://github.com/erkantaylan/listen-along/releases/tag/android-v0.5.0",
            releasesUrl = "javascript:alert(1)",
        )
        assertEquals("https://music.test/app", (updates().checkNow() as UpdateCheck.Available).notice.downloadUrl)
    }
}
