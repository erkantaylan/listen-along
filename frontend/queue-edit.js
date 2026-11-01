// Playlist edit mode and drag-to-reorder for list rows.
//
// Normal mode (default): rows are clean and a click / tap / Enter plays.
// Edit mode ("Edit" in the playlist header, only for users who may edit the
// playlist): rows get a drag handle and a remove button, and clicking a row
// does nothing. queue.js renders the rows; this module only keeps the mode
// and moves rows around under the pointer.

let editMode = false;
const listeners = new Set();

export function isEditMode() {
  return editMode;
}

export function onEditModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setEditMode(on) {
  on = !!on;
  if (on === editMode) return;
  editMode = on;
  listeners.forEach((fn) => { try { fn(editMode); } catch (err) { console.error(err); } });
}

let dragging = false;
/** True while a row is being dragged (re-renders should wait). */
export function isDragging() {
  return dragging;
}

const START_DISTANCE = 4;   // px of movement before a press on the handle becomes a drag
const EDGE = 56;            // px from the top/bottom of the visible list that auto-scrolls
const MAX_SPEED = 14;       // px per frame, at the very edge
const MAX_BOOST = 6;        // holding at the edge speeds up, or a long list takes minutes
const BOOST_AFTER = 2500;   // ms at the edge to reach MAX_BOOST

function playerBarHeight() {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--app-player-height'));
  return Number.isFinite(v) ? v : 0;
}

/**
 * Pointer-based drag reordering (mouse, touch and pen alike: HTML5 drag and
 * drop does not work on touch screens) on a windowed list (virtual-list.js).
 * The dragged row follows the pointer and the rows it passes slide out of its
 * way. Its target comes from arithmetic, not from the rows in the DOM, so a drag
 * can run through rows that are not rendered yet: auto-scroll brings them in,
 * and the dragged row stays pinned in the DOM meanwhile. On release
 * onDrop(fromPosition, toPosition) is called (only if it moved).
 *
 * list:       the <ul>
 * view:       its createVirtualList()
 * scroller:   the element that scrolls the list
 * onEnd():    called after every drag (moved or not), e.g. to flush a re-render
 *
 * The returned function re-applies the slide to freshly rendered rows: pass it to
 * createVirtualList as onRender.
 */
export function bindDragReorder(list, { view, rowSelector, handleSelector, scroller, onDrop, onEnd }) {
  let drag = null;

  function shiftRows() {
    const d = drag;
    for (const [pos, row] of view.rendered()) {
      if (pos === d.from) continue;
      let shift = 0;
      if (d.from < d.target && pos > d.from && pos <= d.target) shift = -d.height;
      else if (d.from > d.target && pos >= d.target && pos < d.from) shift = d.height;
      row.style.transform = shift ? `translateY(${shift}px)` : '';
    }
  }

  function layout(clientY) {
    const d = drag;
    const dy = clientY - d.startY + (scroller.scrollTop - d.startScroll);
    d.row.style.transform = `translateY(${dy}px)`;
    d.target = Math.max(0, Math.min(view.count - 1, d.from + Math.round(dy / d.height)));
    shiftRows();
  }

  function autoScroll(now) {
    const d = drag;
    if (!d || !d.started) return;
    const box = scroller.getBoundingClientRect();
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, window.innerHeight - playerBarHeight());
    let speed = 0;
    if (d.lastY < top + EDGE) speed = -MAX_SPEED * Math.min(1, (top + EDGE - d.lastY) / EDGE);
    else if (d.lastY > bottom - EDGE) speed = MAX_SPEED * Math.min(1, (d.lastY - (bottom - EDGE)) / EDGE);
    if (speed) {
      if (!d.edgeSince) d.edgeSince = now;
      const boost = 1 + (MAX_BOOST - 1) * Math.min(1, (now - d.edgeSince) / BOOST_AFTER);
      scroller.scrollTop += speed * boost;
      layout(d.lastY);
    } else {
      d.edgeSince = 0;
    }
    d.raf = requestAnimationFrame(autoScroll);
  }

  function begin() {
    const d = drag;
    d.started = true;
    dragging = true;
    d.from = view.positionOf(d.row);
    d.target = d.from;
    d.height = view.rowHeight;
    view.pin(d.from);
    list.classList.add('is-reordering');
    document.body.classList.add('app-dragging');
    d.row.classList.add('dragging');
    d.raf = requestAnimationFrame(autoScroll);
  }

  function finish(commit) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    try { d.handle.releasePointerCapture(d.pointerId); } catch {}
    if (!d.started) return;
    dragging = false;
    view.unpin(d.from);
    list.classList.remove('is-reordering');
    document.body.classList.remove('app-dragging');
    d.row.classList.remove('dragging');
    d.row.style.transform = '';
    for (const row of view.rendered().values()) row.style.transform = '';
    // A drag ends with a click on the handle: it must not act.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    if (commit && d.target !== d.from) onDrop(d.from, d.target);
    if (onEnd) onEnd();
  }

  list.addEventListener('pointerdown', (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const handle = e.target.closest(handleSelector);
    if (!handle || !list.contains(handle)) return;
    const row = handle.closest(rowSelector);
    if (!row) return;
    e.preventDefault(); // no text selection, no focus steal, no scroll start
    drag = { row, handle, pointerId: e.pointerId, startY: e.clientY, lastY: e.clientY, startScroll: scroller.scrollTop, started: false, edgeSince: 0 };
    try { handle.setPointerCapture(e.pointerId); } catch {}
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastY = e.clientY;
    if (!drag.started) {
      if (Math.abs(e.clientY - drag.startY) < START_DISTANCE) return;
      begin();
    }
    e.preventDefault();
    layout(e.clientY);
  });
  list.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) finish(true); });
  list.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) finish(false); });
  list.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.pointerId) finish(true); });
  // Escape cancels a drag in progress.
  document.addEventListener('keydown', (e) => { if (drag && drag.started && e.key === 'Escape') finish(false); });

  return () => { if (drag && drag.started) shiftRows(); };
}
