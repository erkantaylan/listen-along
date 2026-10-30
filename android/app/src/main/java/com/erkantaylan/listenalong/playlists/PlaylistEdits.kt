package com.erkantaylan.listenalong.playlists

import com.erkantaylan.listenalong.api.PlaylistEntry

/**
 * The local side of editing a playlist's song list: drag-and-drop reordering
 * and removing with Undo. Pure list logic, so it runs in unit tests; the view
 * model sends the resulting server calls (one move per finished drag, one
 * remove per removal that was not undone).
 *
 * A removal is first only *pending*: the entry leaves the list at once, and
 * [undo] puts it back where it was. It reaches the server when the Undo
 * snackbar times out, when another entry is removed, when a drag starts, or
 * when editing ends ([PendingRemoval] is then returned to be committed).
 */
data class PlaylistEdits(
    val entries: List<PlaylistEntry>,
    val pending: PendingRemoval? = null,
    /** The drag in progress: the entry's key and where it started. */
    val drag: Drag? = null,
) {
    data class PendingRemoval(val entry: PlaylistEntry, val index: Int)

    data class Drag(val entryId: String, val fromIndex: Int)

    /** A finished drag that moved something: [position] is the server's 1-based target. */
    data class Move(val entryId: String, val position: Int)

    /**
     * Removes [entryId]. Returns the new state and the removal that was
     * pending before, which must now be committed (null if none).
     */
    fun remove(entryId: String): Pair<PlaylistEdits, PendingRemoval?> {
        val index = entries.indexOfFirst { it.entryId == entryId }
        if (index < 0) return this to null
        val next = copy(
            entries = entries.toMutableList().apply { removeAt(index) },
            pending = PendingRemoval(entries[index], index),
        )
        return next to pending
    }

    /** Puts the pending removal back at its old place. */
    fun undo(): PlaylistEdits {
        val p = pending ?: return this
        val list = entries.toMutableList()
        list.add(p.index.coerceIn(0, list.size), p.entry)
        return copy(entries = list, pending = null)
    }

    /** The pending removal is being sent: forget it locally (the entry stays out). */
    fun commitPending(): Pair<PlaylistEdits, PendingRemoval?> = copy(pending = null) to pending

    /** A drag starts on [entryId]. */
    fun startDrag(entryId: String): PlaylistEdits {
        val index = entries.indexOfFirst { it.entryId == entryId }
        return if (index < 0) this else copy(drag = Drag(entryId, index))
    }

    /** While dragging: the dragged entry takes [targetId]'s place (the list updates live). */
    fun dragOver(targetId: String): PlaylistEdits {
        val d = drag ?: return this
        val from = entries.indexOfFirst { it.entryId == d.entryId }
        val to = entries.indexOfFirst { it.entryId == targetId }
        if (from < 0 || to < 0 || from == to) return this
        return copy(entries = reorder(entries, from, to))
    }

    /** The drag ends. Returns the move to send, or null if it ended where it started. */
    fun endDrag(): Pair<PlaylistEdits, Move?> {
        val d = drag ?: return this to null
        val now = entries.indexOfFirst { it.entryId == d.entryId }
        val next = copy(drag = null)
        return next to if (now < 0 || now == d.fromIndex) null else Move(d.entryId, now + 1)
    }

    companion object {
        /** [list] with the item at [from] moved to [to]. */
        fun <T> reorder(list: List<T>, from: Int, to: Int): List<T> {
            if (from !in list.indices || to !in list.indices || from == to) return list
            return list.toMutableList().apply { add(to, removeAt(from)) }
        }
    }
}
