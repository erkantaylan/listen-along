package com.erkantaylan.listenalong.core.domain

import com.erkantaylan.listenalong.core.domain.PlaylistFetch.Fresh
import com.erkantaylan.listenalong.core.domain.PlaylistFetch.Gone
import com.erkantaylan.listenalong.core.domain.PlaylistFetch.Stale
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.testing.local
import com.erkantaylan.listenalong.testing.song
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaylistSyncPlannerTest {

    private val now = 10_000_000_000L
    private fun songs(vararg ids: String) = ids.map { song(it) }
    private fun record(id: String, vararg known: String, pending: List<String>? = null, unavailable: Boolean = false) =
        DownloadedPlaylist(id, "Playlist $id", known = known.toList(), pendingShrink = pending, unavailable = unavailable)
    private fun synced(id: String) = local(id).copy(manual = false)
    private fun mine(id: String) = local(id)

    private fun plan(
        vararg playlists: Pair<DownloadedPlaylist, PlaylistFetch>,
        downloaded: List<LocalSong> = emptyList(),
        queued: Map<String, Boolean> = emptyMap(),
        missing: Map<String, Long> = emptyMap(),
        settings: SyncSettings = SyncSettings(),
        network: NetworkInfo = NetworkInfo(),
    ) = PlaylistSyncPlanner.plan(
        SyncInput(playlists.toList(), downloaded.associateBy { it.songId }, queued, missing, settings, network, now)
    )

    // --- Additions ------------------------------------------------------------

    @Test
    fun `a new downloaded playlist downloads every song, in order`() {
        val p = plan(record("p") to Fresh(songs("a", "b", "c")))
        assertEquals(listOf("a", "b", "c"), p.download.map { it.id })
        assertEquals(listOf("a", "b", "c"), p.playlists.single().known)
        assertEquals(now, p.playlists.single().lastSyncAt)
        assertNull(p.hold)
    }

    @Test
    fun `songs added on the server download, the ones already here do not`() {
        val p = plan(record("p", "a", "b") to Fresh(songs("a", "b", "c", "d")), downloaded = listOf(synced("a"), synced("b")))
        assertEquals(listOf("c", "d"), p.download.map { it.id })
        assertTrue(p.delete.isEmpty())
    }

    @Test
    fun `a song twice in a playlist, or in two playlists, downloads once`() {
        val p = plan(
            record("p") to Fresh(songs("a", "b", "a")),
            record("q") to Fresh(songs("b", "c")),
        )
        assertEquals(listOf("a", "b", "c"), p.download.map { it.id })
        assertEquals(listOf("a", "b"), p.playlists[0].known)
    }

    @Test
    fun `a song already queued (by the user or the sync) is not queued again`() {
        val p = plan(record("p") to Fresh(songs("a", "b", "c")), queued = mapOf("a" to true, "b" to false))
        assertEquals(listOf("c"), p.download.map { it.id })
        assertTrue(p.cancel.isEmpty())
    }

    @Test
    fun `a file missing on the server is skipped for a day, then tried again`() {
        val recent = plan(record("p") to Fresh(songs("a", "b")), missing = mapOf("a" to now - 1000))
        assertEquals(listOf("b"), recent.download.map { it.id })
        assertTrue(recent.retryMissing.isEmpty())

        val old = plan(record("p") to Fresh(songs("a")), missing = mapOf("a" to now - PlaylistSyncPlanner.MISSING_RETRY_MS))
        assertEquals(listOf("a"), old.download.map { it.id })
        assertEquals(listOf("a"), old.retryMissing)
    }

    // --- Removals and who owns a file ------------------------------------------

    @Test
    fun `a song removed from the playlist is deleted when the app downloaded it for the playlist`() {
        val p = plan(record("p", "a", "b", "c") to Fresh(songs("a", "b")), downloaded = listOf(synced("a"), synced("b"), synced("c")))
        assertEquals(listOf("c"), p.delete)
    }

    @Test
    fun `with the setting off a removed song is kept`() {
        val p = plan(
            record("p", "a", "b", "c") to Fresh(songs("a", "b")),
            downloaded = listOf(synced("a"), synced("b"), synced("c")),
            settings = SyncSettings(removeUnlisted = false),
        )
        assertTrue(p.delete.isEmpty())
        assertEquals(listOf("a", "b"), p.playlists.single().known)
    }

    @Test
    fun `a song the user downloaded themselves is never deleted`() {
        val p = plan(record("p", "a", "b", "c") to Fresh(songs("a", "b")), downloaded = listOf(synced("a"), synced("b"), mine("c")))
        assertTrue(p.delete.isEmpty())
    }

    @Test
    fun `downloads from before playlist sync read as the user's and are never deleted`() {
        // An index entry written by an older version has no `manual` field: it decodes as true.
        val old = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString<LocalSong>(
            """{"songId":"c","uri":"content://x/c","displayName":"A - C.m4a","title":"C","mimeType":"audio/mp4"}"""
        )
        assertTrue(old.manual)
        val p = plan(record("p", "a", "b", "c") to Fresh(songs("a", "b")), downloaded = listOf(synced("a"), synced("b"), old))
        assertTrue(p.delete.isEmpty())
    }

    @Test
    fun `a file found in the folder from an earlier install is never deleted`() {
        val p = plan(
            record("p", "a", "b", "c") to Fresh(songs("a", "b")),
            downloaded = listOf(synced("a"), synced("b"), synced("c").copy(reclaimed = true)),
        )
        assertTrue(p.delete.isEmpty())
    }

    @Test
    fun `a song another downloaded playlist holds is kept`() {
        val p = plan(
            record("p", "a", "b", "c") to Fresh(songs("a", "b")),
            record("q", "c") to Fresh(songs("c")),
            downloaded = listOf(synced("a"), synced("b"), synced("c")),
        )
        assertTrue(p.delete.isEmpty())
    }

    @Test
    fun `a song held only by a playlist that could not be fetched is kept`() {
        val p = plan(
            record("p", "a", "b", "c") to Fresh(songs("a", "b")),
            record("q", "c") to Stale(emptyList()),
            downloaded = listOf(synced("a"), synced("b"), synced("c")),
        )
        assertTrue(p.delete.isEmpty())
    }

    @Test
    fun `a playlist's own queued songs that it no longer holds are cancelled, the user's are not`() {
        val p = plan(record("p", "a", "b") to Fresh(songs("a")), queued = mapOf("b" to false, "x" to true))
        assertEquals(listOf("b"), p.cancel)
    }

    // --- The mass-deletion guard ----------------------------------------------

    @Test
    fun `an empty playlist after a full one deletes nothing until a later fetch says the same`() {
        val files = listOf(synced("a"), synced("b"), synced("c"))
        val first = plan(record("p", "a", "b", "c") to Fresh(emptyList()), downloaded = files)
        assertTrue(first.delete.isEmpty())
        assertEquals(listOf("p"), first.heldShrinks)
        val held = first.playlists.single()
        assertEquals(listOf("a", "b", "c"), held.known)
        assertEquals(emptyList<String>(), held.pendingShrink)

        val second = plan(held to Fresh(emptyList()), downloaded = files)
        assertEquals(listOf("a", "b", "c"), second.delete.sorted())
        assertNull(second.playlists.single().pendingShrink)
        assertTrue(second.playlists.single().known.isEmpty())
    }

    @Test
    fun `losing more than half at once is held, and its new songs still download`() {
        val files = listOf("a", "b", "c", "d").map(::synced)
        val p = plan(record("p", "a", "b", "c", "d") to Fresh(songs("a", "e")), downloaded = files)
        assertTrue(p.delete.isEmpty())
        assertEquals(listOf("e"), p.download.map { it.id })
        assertEquals(listOf("a", "e"), p.playlists.single().pendingShrink)
    }

    @Test
    fun `a different list after a held shrink is judged afresh`() {
        val held = record("p", "a", "b", "c", "d", pending = listOf("a"))
        val files = listOf("a", "b", "c", "d").map(::synced)
        // Back to normal (only d removed): accepted, the held shrink forgotten, d deleted.
        val p = plan(held to Fresh(songs("a", "b", "c")), downloaded = files)
        assertEquals(listOf("d"), p.delete)
        assertNull(p.playlists.single().pendingShrink)
        assertEquals(listOf("a", "b", "c"), p.playlists.single().known)
    }

    @Test
    fun `small removals are not held`() {
        assertFalse(PlaylistSyncPlanner.isBigShrink(listOf("a", "b", "c"), listOf("a", "b")))  // one song
        assertFalse(PlaylistSyncPlanner.isBigShrink(listOf("a", "b"), listOf("a")))            // one song of two
        assertTrue(PlaylistSyncPlanner.isBigShrink(listOf("a"), emptyList()))                  // emptied
        assertTrue(PlaylistSyncPlanner.isBigShrink(listOf("a", "b", "c"), listOf("a")))        // two of three
        assertFalse(PlaylistSyncPlanner.isBigShrink(emptyList(), emptyList()))
        assertFalse(PlaylistSyncPlanner.isBigShrink(listOf("a", "b", "c", "d"), listOf("a", "b")))  // exactly half
    }

    // --- A playlist that disappeared, offline, networks --------------------------

    @Test
    fun `a playlist that answers 404 becomes unavailable and keeps its files`() {
        val p = plan(record("p", "a", "b") to Gone, downloaded = listOf(synced("a")))
        val r = p.playlists.single()
        assertTrue(r.unavailable)
        assertEquals(listOf("a", "b"), r.known)
        assertTrue(p.delete.isEmpty())
        assertTrue(p.download.isEmpty()) // b is not fetched for a playlist we cannot see
    }

    @Test
    fun `an unavailable playlist that is visible again is synced again`() {
        val p = plan(record("p", "a", unavailable = true) to Fresh(songs("a", "b")))
        assertFalse(p.playlists.single().unavailable)
        assertEquals(listOf("a", "b"), p.download.map { it.id })
    }

    @Test
    fun `offline nothing changes and nothing is deleted, the missing songs wait`() {
        val p = plan(
            record("p", "a", "b") to Stale(songs("a", "b")),
            downloaded = listOf(synced("a")),
            network = NetworkInfo(online = false),
        )
        assertEquals(listOf("a", "b"), p.playlists.single().known)
        assertTrue(p.delete.isEmpty())
        assertEquals(listOf("b"), p.download.map { it.id })
        assertEquals(SyncHold.OFFLINE, p.hold)
    }

    @Test
    fun `on mobile data with the setting off the downloads wait for Wi-Fi`() {
        val metered = NetworkInfo(metered = true)
        assertEquals(SyncHold.WAITING_FOR_WIFI, plan(record("p") to Fresh(songs("a")), network = metered,
                                                     settings = SyncSettings(allowMetered = false)).hold)
        assertNull(plan(record("p") to Fresh(songs("a")), network = metered).hold) // the default: allowed
        assertNull(plan(record("p") to Fresh(songs("a")), network = NetworkInfo(), settings = SyncSettings(allowMetered = false)).hold)
    }

    @Test
    fun `never while roaming or under Data Saver on a metered network`() {
        val s = SyncSettings(allowMetered = true)
        assertFalse(PlaylistSyncPlanner.mayDownload(NetworkInfo(metered = true, roaming = true), s))
        assertFalse(PlaylistSyncPlanner.mayDownload(NetworkInfo(metered = true, dataSaver = true), s))
        assertTrue(PlaylistSyncPlanner.mayDownload(NetworkInfo(metered = false, roaming = true), s)) // roaming but unmetered
        assertFalse(PlaylistSyncPlanner.mayDownload(NetworkInfo(online = false), s))
    }

    // --- Turning Download off --------------------------------------------------

    @Test
    fun `turning Download off releases only this playlist's own sync files`() {
        val p = record("p", "a", "b", "c", "d")
        val q = record("q", "b")
        val downloaded = listOf(synced("a"), synced("b"), mine("c")).associateBy { it.songId }
        val r = PlaylistSyncPlanner.release(p, listOf(p, q), downloaded, queued = mapOf("d" to false))
        assertEquals(listOf("a"), r.removable) // b is q's too, c is the user's
        assertEquals(listOf("d"), r.cancel)
    }

    // --- Status -----------------------------------------------------------------

    @Test
    fun `status says downloading, waiting, paused, failed, downloaded or unavailable`() {
        val r = record("p", "a", "b", "c")
        val here = listOf(synced("a")).associateBy { it.songId }
        val s = SyncSettings()
        assertEquals(PlaylistDownloadStatus.Off, playlistStatus(null, here, emptySet(), emptyMap(), emptySet(), NetworkInfo(), s))
        assertEquals(PlaylistDownloadStatus.Downloading(1, 3, 1000),
                     playlistStatus(r, here, setOf("b", "c"), emptyMap(), emptySet(), NetworkInfo(), s))
        assertEquals(PlaylistDownloadStatus.WaitingForWifi(1, 3, 1000),
                     playlistStatus(r, here, setOf("b", "c"), emptyMap(), emptySet(), NetworkInfo(metered = true), SyncSettings(allowMetered = false)))
        assertEquals(PlaylistDownloadStatus.Paused(1, 3, 1000),
                     playlistStatus(r, here, setOf("b"), emptyMap(), emptySet(), NetworkInfo(online = false), s))
        assertEquals(PlaylistDownloadStatus.Failed(1, 3, 1000, "Not enough free space on the phone"),
                     playlistStatus(r, here, emptySet(), mapOf("b" to "Not enough free space on the phone"), emptySet(), NetworkInfo(), s))
        assertEquals(PlaylistDownloadStatus.Downloaded(1, 1000, missingOnServer = 2),
                     playlistStatus(r, here, emptySet(), emptyMap(), setOf("b", "c"), NetworkInfo(), s))
        assertEquals(PlaylistDownloadStatus.Unavailable(1, 1000),
                     playlistStatus(r.copy(unavailable = true), here, emptySet(), emptyMap(), emptySet(), NetworkInfo(), s))
    }
}
