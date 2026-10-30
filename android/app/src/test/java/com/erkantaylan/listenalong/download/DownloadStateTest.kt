package com.erkantaylan.listenalong.download

import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.storage.DownloadIndex
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.storage.MemoryTextStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun q(id: String) = QueuedSong(id, "Title $id", "Artist")
private fun local(id: String) = LocalSong(id, "content://media/external/audio/media/$id", "$id.m4a", "T", "A",
                                          mimeType = "audio/mp4", bytes = 10)

class DownloadQueueTest {

    @Test
    fun `enqueue skips duplicates, already queued and already downloaded`() {
        val queue = DownloadQueue(MemoryTextStore())
        val added1 = queue.enqueue(listOf(q("a"), q("b"), q("a")), isDownloaded = { false })
        assertEquals(listOf("a", "b"), added1.map { it.id })

        val added2 = queue.enqueue(listOf(q("b"), q("c"), q("d")), isDownloaded = { it == "d" })
        assertEquals(listOf("c"), added2.map { it.id })
        assertEquals(listOf("a", "b", "c"), queue.pending.value.map { it.id })
    }

    @Test
    fun `claimNext hands out each song once, in order`() {
        val queue = DownloadQueue(MemoryTextStore())
        queue.enqueue(listOf(q("a"), q("b"), q("c")), { false })
        assertEquals("a", queue.claimNext()?.id)
        assertEquals("b", queue.claimNext()?.id)
        assertTrue(queue.isRunning("a"))
        queue.finish("a")
        assertEquals("c", queue.claimNext()?.id)
        assertNull(queue.claimNext())
        assertEquals(listOf("b", "c"), queue.pending.value.map { it.id })
    }

    @Test
    fun `release keeps the song queued for the next claim`() {
        val queue = DownloadQueue(MemoryTextStore())
        queue.enqueue(listOf(q("a")), { false })
        queue.claimNext()
        queue.release("a")
        assertTrue(queue.contains("a"))
        assertEquals("a", queue.claimNext()?.id)
    }

    @Test
    fun `cancel removes it and reports whether it was running`() {
        val queue = DownloadQueue(MemoryTextStore())
        queue.enqueue(listOf(q("a"), q("b")), { false })
        queue.claimNext()
        assertTrue(queue.cancel("a"))
        assertFalse(queue.cancel("b"))
        assertTrue(queue.pending.value.isEmpty())
    }

    @Test
    fun `the queue survives a restart, running marks do not`() {
        val store = MemoryTextStore()
        val before = DownloadQueue(store)
        before.enqueue(listOf(q("a"), q("b")), { false })
        before.claimNext() // "a" was mid-download when the process died

        val after = DownloadQueue(store)
        assertEquals(listOf("a", "b"), after.pending.value.map { it.id })
        assertFalse(after.isRunning("a"))
        assertEquals("a", after.claimNext()?.id)
    }

    @Test
    fun `corrupt storage starts empty instead of crashing`() {
        val queue = DownloadQueue(MemoryTextStore("{not json"))
        assertTrue(queue.pending.value.isEmpty())
    }
}

class DownloadIndexTest {

    @Test
    fun `put, get, remove and persistence`() {
        val store = MemoryTextStore()
        val index = DownloadIndex(store)
        index.put(local("a"))
        index.put(local("b"))
        index.remove("b")
        assertTrue(index.contains("a"))

        val reloaded = DownloadIndex(store)
        assertEquals(setOf("a"), reloaded.entries.value.keys)
        assertEquals("content://media/external/audio/media/a", reloaded["a"]?.uri)
    }

    @Test
    fun `reconcile drops files deleted outside the app`() {
        val index = DownloadIndex(MemoryTextStore())
        listOf("a", "b", "c").forEach { index.put(local(it)) }

        val gone = index.reconcile { it.songId != "b" }

        assertEquals(listOf("b"), gone.map { it.songId })
        assertEquals(setOf("a", "c"), index.entries.value.keys)
    }

    @Test
    fun `reconcile keeps an entry when the check itself fails`() {
        val index = DownloadIndex(MemoryTextStore())
        index.put(local("a"))
        val gone = index.reconcile { throw SecurityException("provider hiccup") }
        assertTrue(gone.isEmpty())
        assertTrue(index.contains("a"))
    }
}

class DownloadSnapshotTest {

    @Test
    fun `a song on the device is Done whatever else is recorded`() {
        val snap = DownloadSnapshot(
            downloaded = mapOf("a" to local("a")),
            pending = listOf(q("a")),
            progress = mapOf("a" to Progress(1, 2)),
            failures = mapOf("a" to "old failure"),
        )
        assertTrue(snap.stateOf("a") is DownloadState.Done)
    }

    @Test
    fun `progress beats queued, queued beats a stale failure`() {
        val snap = DownloadSnapshot(
            pending = listOf(q("a"), q("b")),
            progress = mapOf("a" to Progress(50, 200)),
            failures = mapOf("b" to "earlier", "c" to "boom"),
        )
        val a = snap.stateOf("a") as DownloadState.InProgress
        assertEquals(0.25f, a.fraction!!, 0.0001f)
        assertEquals(DownloadState.Queued, snap.stateOf("b"))
        assertEquals(DownloadState.Failed("boom"), snap.stateOf("c"))
        assertEquals(DownloadState.Absent, snap.stateOf("zzz"))
    }

    @Test
    fun `unknown total has no fraction`() {
        assertNull(DownloadState.InProgress(100, -1).fraction)
    }
}

class BulkPlanTest {

    private fun song(id: String, seconds: Double?) = Song(id = id, title = id, durationRaw = seconds)

    @Test
    fun `estimates about one MB per minute`() {
        val songs = listOf(song("a", 180.0), song("b", 240.0), song("c", 60.0))
        assertEquals(8, BulkPlan.estimateMb(songs))
    }

    @Test
    fun `songs with no duration count as four minutes`() {
        assertEquals(8, BulkPlan.estimateMb(listOf(song("a", null), song("b", 0.0))))
    }

    @Test
    fun `plan skips songs already here or queued, retries failed ones`() {
        val snap = DownloadSnapshot(
            downloaded = mapOf("have" to local("have")),
            pending = listOf(q("queued")),
            failures = mapOf("failed" to "x"),
        )
        val songs = listOf(song("have", 100.0), song("queued", 100.0), song("failed", 120.0),
                           song("new", null), song("new", null))

        val plan = BulkPlan.of(songs, snap)

        assertEquals(listOf("failed", "new"), plan.toDownload.map { it.id })
        assertEquals(2, plan.count)
        assertEquals(2, plan.alreadyHave)
        assertEquals(1, plan.unknownDurations)
        assertEquals(6, plan.estimatedMb) // 2 min + 4 min assumed
    }

    @Test
    fun `formatMb switches to GB`() {
        assertEquals("340 MB", formatMb(340))
        assertEquals("1.2 GB", formatMb(1234))
    }
}
