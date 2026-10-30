package com.erkantaylan.listenalong.ui

import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.withFrameNanos

/**
 * Drag-and-drop reordering in a LazyColumn whose rows have String keys.
 * The dragged row follows the finger; when its middle crosses another row,
 * [onOver] is told so the list can swap them live; [onEnd] when it is let go.
 * Near the top or bottom edge the list scrolls by itself.
 */
@Stable
class ReorderState internal constructor(
    val listState: LazyListState,
    private val edgePx: Float,
) {
    internal var isDraggable: (Any) -> Boolean = { false }
    internal var onStart: (String) -> Unit = {}
    internal var onOver: (String) -> Unit = {}
    internal var onEnd: () -> Unit = {}

    var draggingKey by mutableStateOf<String?>(null)
        private set
    /** Where the dragged row's top started (viewport px) and how far the finger has moved since. */
    private var startOffset by mutableFloatStateOf(0f)
    private var delta by mutableFloatStateOf(0f)

    /** The dragged row's translation from its laid-out place. */
    fun translationOf(key: Any): Float {
        if (key != draggingKey) return 0f
        val item = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return 0f
        return startOffset + delta - item.offset
    }

    fun start(key: String) {
        val item = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key } ?: return
        draggingKey = key
        startOffset = item.offset.toFloat()
        delta = 0f
        onStart(key)
    }

    fun drag(dy: Float) {
        if (draggingKey == null) return
        delta += dy
        swapIfNeeded()
    }

    fun end() {
        if (draggingKey == null) return
        draggingKey = null
        delta = 0f
        onEnd()
    }

    private fun swapIfNeeded() {
        val key = draggingKey ?: return
        val items = listState.layoutInfo.visibleItemsInfo
        val current = items.firstOrNull { it.key == key } ?: return
        val middle = startOffset + delta + current.size / 2f
        val target = items.firstOrNull {
            it.key != key && isDraggable(it.key) && middle >= it.offset && middle <= it.offset + it.size
        } ?: return
        onOver(target.key as String)
    }

    /** How far to scroll this frame: the dragged row is within [edgePx] of an edge. */
    internal fun overscroll(): Float {
        val key = draggingKey ?: return 0f
        val info = listState.layoutInfo
        val item = info.visibleItemsInfo.firstOrNull { it.key == key } ?: return 0f
        val top = startOffset + delta
        val bottom = top + item.size
        return when {
            top < info.viewportStartOffset + edgePx -> -(info.viewportStartOffset + edgePx - top).coerceAtMost(edgePx) / 4f
            bottom > info.viewportEndOffset - edgePx -> (bottom - info.viewportEndOffset + edgePx).coerceAtMost(edgePx) / 4f
            else -> 0f
        }
    }

    /** After scrolling, the row under the finger may be another one. */
    internal fun afterScroll() = swapIfNeeded()
}

@Composable
fun rememberReorderState(
    listState: LazyListState,
    isDraggable: (Any) -> Boolean,
    onStart: (String) -> Unit,
    onOver: (String) -> Unit,
    onEnd: () -> Unit,
): ReorderState {
    val edge = with(LocalDensity.current) { 64.dp.toPx() }
    val state = remember(listState) { ReorderState(listState, edge) }
    val draggable by rememberUpdatedState(isDraggable)
    val start by rememberUpdatedState(onStart)
    val over by rememberUpdatedState(onOver)
    val end by rememberUpdatedState(onEnd)
    state.isDraggable = { draggable(it) }
    state.onStart = { start(it) }
    state.onOver = { over(it) }
    state.onEnd = { end() }
    // Edge auto-scroll, every frame while a row is held near the top or bottom.
    LaunchedEffect(state, state.draggingKey) {
        while (state.draggingKey != null) {
            val amount = state.overscroll()
            if (amount != 0f) {
                listState.scrollBy(amount)
                state.afterScroll()
            }
            withFrameNanos { }
        }
    }
    return state
}

/** On a drag handle: dragging starts at once. */
fun Modifier.dragHandle(state: ReorderState, key: String): Modifier = pointerInput(state, key) {
    detectDragGestures(
        onDragStart = { state.start(key) },
        onDragEnd = { state.end() },
        onDragCancel = { state.end() },
        onDrag = { change, amount -> change.consume(); state.drag(amount.y) },
    )
}

/** On a whole row: long-press, then drag. */
fun Modifier.longPressDrag(state: ReorderState, key: String): Modifier = pointerInput(state, key) {
    detectDragGesturesAfterLongPress(
        onDragStart = { state.start(key) },
        onDragEnd = { state.end() },
        onDragCancel = { state.end() },
        onDrag = { change, amount -> change.consume(); state.drag(amount.y) },
    )
}
