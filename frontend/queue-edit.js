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
const MAX_SPEED = 14;       // px per frame

function playerBarHeight() {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--app-player-height'));
  return Number.isFinite(v) ? v : 0;
}

/**
 * Pointer-based drag reordering (mouse, touch and pen alike: HTML5 drag and
 * drop does not work on touch screens). The dragged row follows the pointer
 * and the rows it passes slide out of its way; on release
 * onDrop(fromRow, toRow) is called with the row it was dragged from and the
 * row whose place it takes (toRow === fromRow: no move).
 *
 * list:      the <ul> (rows may be re-rendered between drags)
 * scroller:  the element that scrolls the list
 * onEnd():   called after every drag (moved or not), e.g. to flush a re-render
 */
export function bindDragReorder(list, { rowSelector, handleSelector, scroller, onDrop, onEnd }) {
  let drag = null;

  const visibleRows = () => [...list.querySelectorAll(rowSelector)].filter((r) => r.offsetParent !== null);

  const scrollTop = () => (scroller ? scroller.scrollTop : window.scrollY);

  function layout(clientY) {
    const d = drag;
    const dy = clientY - d.startY + (scrollTop() - d.startScroll);
    d.row.style.transform = `translateY(${dy}px)`;
    const center = d.centers[d.from] + dy;
    let target = d.from;
    for (let i = d.from + 1; i < d.rows.length; i++) if (center > d.centers[i]) target = i;
    for (let i = d.from - 1; i >= 0; i--) if (center < d.centers[i]) target = i;
    d.target = target;
    d.rows.forEach((r, i) => {
      if (i === d.from) return;
      let shift = 0;
      if (d.from < target && i > d.from && i <= target) shift = -d.height;
      else if (d.from > target && i >= target && i < d.from) shift = d.height;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  function autoScroll() {
    const d = drag;
    if (!d || !d.started) return;
    const top = scroller ? Math.max(scroller.getBoundingClientRect().top, 0) : 0;
    const bottom = Math.min(scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight, window.innerHeight - playerBarHeight());
    let speed = 0;
    if (d.lastY < top + EDGE) speed = -MAX_SPEED * Math.min(1, (top + EDGE - d.lastY) / EDGE);
    else if (d.lastY > bottom - EDGE) speed = MAX_SPEED * Math.min(1, (d.lastY - (bottom - EDGE)) / EDGE);
    if (speed) {
      if (scroller) scroller.scrollTop += speed; else window.scrollBy(0, speed);
      layout(d.lastY);
    }
    d.raf = requestAnimationFrame(autoScroll);
  }

  function begin() {
    const d = drag;
    d.started = true;
    dragging = true;
    d.rows = visibleRows();
    d.from = d.rows.indexOf(d.row);
    const rects = d.rows.map((r) => r.getBoundingClientRect());
    d.centers = rects.map((r) => r.top + r.height / 2);
    d.height = rects[d.from].height;
    d.target = d.from;
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
    list.classList.remove('is-reordering');
    document.body.classList.remove('app-dragging');
    d.row.classList.remove('dragging');
    d.rows.forEach((r) => { r.style.transform = ''; });
    // A drag ends with a click on the handle: it must not act.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    if (commit && d.target !== d.from) onDrop(d.row, d.rows[d.target]);
    if (onEnd) onEnd();
  }

  list.addEventListener('pointerdown', (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const handle = e.target.closest(handleSelector);
    if (!handle || !list.contains(handle)) return;
    const row = handle.closest(rowSelector);
    if (!row) return;
    e.preventDefault(); // no text selection, no focus steal, no scroll start
    drag = { row, handle, pointerId: e.pointerId, startY: e.clientY, lastY: e.clientY, startScroll: scrollTop(), started: false };
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
}
