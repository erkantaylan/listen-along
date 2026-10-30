package com.erkantaylan.listenalong.playlists

import com.erkantaylan.listenalong.api.Playlist
import com.erkantaylan.listenalong.api.PlaylistEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaylistEditsTest {

    private fun entries(vararg ids: String) = ids.map { PlaylistEntry(entryId = it, libraryId = "lib-$it", title = it.uppercase()) }
    private fun PlaylistEdits.ids() = entries.map { it.entryId }

    @Test
    fun `remove takes the entry out at once and undo puts it back in place`() {
        val start = PlaylistEdits(entries("a", "b", "c"))
        val (removed, committed) = start.remove("b")
        assertNull("nothing was pending before", committed)
        assertEquals(listOf("a", "c"), removed.ids())
        assertEquals("b", removed.pending?.entry?.entryId)
        assertEquals(1, removed.pending?.index)

        val undone = removed.undo()
        assertEquals(listOf("a", "b", "c"), undone.ids())
        assertNull(undone.pending)
    }

    @Test
    fun `a second removal commits the first`() {
        val (first, _) = PlaylistEdits(entries("a", "b", "c")).remove("a")
        val (second, committed) = first.remove("c")
        assertEquals("a", committed?.entry?.entryId)
        assertEquals(listOf("b"), second.ids())
        assertEquals("c", second.pending?.entry?.entryId)
        // Undo only brings back the last one.
        assertEquals(listOf("b", "c"), second.undo().ids())
    }

    @Test
    fun `commitPending hands over the removal and keeps the entry out`() {
        val (removed, _) = PlaylistEdits(entries("a", "b")).remove("a")
        val (after, pending) = removed.commitPending()
        assertEquals("a", pending?.entry?.entryId)
        assertNull(after.pending)
        assertEquals(listOf("b"), after.ids())
        assertSame(after, after.undo())
    }

    @Test
    fun `removing an unknown entry changes nothing`() {
        val start = PlaylistEdits(entries("a"))
        val (after, committed) = start.remove("zzz")
        assertSame(start, after)
        assertNull(committed)
    }

    @Test
    fun `a drag reorders live and ends with one move to the final 1-based position`() {
        var edits = PlaylistEdits(entries("a", "b", "c", "d")).startDrag("a")
        edits = edits.dragOver("b")
        assertEquals(listOf("b", "a", "c", "d"), edits.ids())
        edits = edits.dragOver("c")
        assertEquals(listOf("b", "c", "a", "d"), edits.ids())
        val (ended, move) = edits.endDrag()
        assertNull(ended.drag)
        assertEquals(PlaylistEdits.Move("a", 3), move)
    }

    @Test
    fun `dragging up works too`() {
        var edits = PlaylistEdits(entries("a", "b", "c", "d")).startDrag("d")
        edits = edits.dragOver("b")
        assertEquals(listOf("a", "d", "b", "c"), edits.ids())
        assertEquals(PlaylistEdits.Move("d", 2), edits.endDrag().second)
    }

    @Test
    fun `a drag that comes back to where it started sends nothing`() {
        var edits = PlaylistEdits(entries("a", "b", "c")).startDrag("b")
        edits = edits.dragOver("c").dragOver("c")  // down past c, then back up over it
        assertEquals(listOf("a", "b", "c"), edits.ids())
        assertNull(edits.endDrag().second)
    }

    @Test
    fun `dragOver without a drag, or onto itself, is ignored`() {
        val start = PlaylistEdits(entries("a", "b"))
        assertSame(start, start.dragOver("b"))
        val dragging = start.startDrag("a")
        assertSame(dragging, dragging.dragOver("a"))
        assertSame(dragging, dragging.dragOver("missing"))
        assertNull(start.endDrag().second)
    }

    @Test
    fun `reorder moves one item and leaves bad indices alone`() {
        val list = listOf(1, 2, 3, 4)
        assertEquals(listOf(2, 3, 1, 4), PlaylistEdits.reorder(list, 0, 2))
        assertEquals(listOf(4, 1, 2, 3), PlaylistEdits.reorder(list, 3, 0))
        assertSame(list, PlaylistEdits.reorder(list, 0, 9))
        assertSame(list, PlaylistEdits.reorder(list, 1, 1))
    }

    @Test
    fun `who may edit a playlist`() {
        // The server's canEdit wins when it is sent.
        assertFalse(Playlist(id = "p", visibility = "public", canEdit = false).editable)
        assertTrue(Playlist(id = "p", visibility = "private", canEdit = true).editable)
        // Otherwise: public is anyone's, private only the owner's.
        assertTrue(Playlist(id = "p", visibility = "public").editable)
        assertTrue(Playlist(id = "p", visibility = "private", isOwner = true).editable)
        assertFalse(Playlist(id = "p", visibility = "private", isOwner = false).editable)
    }
}
