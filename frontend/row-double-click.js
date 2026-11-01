// Double-click on a playlist row (sidebar, rail, landing) or Radio's row plays it.
//
// The first click navigates as always, so by the second press the row may have
// been re-rendered or, on the landing page, replaced by the playlist page: that
// press can land on anything, like a song row. So this does not use the browser's
// dblclick, which goes to whatever is under the pointer then. It remembers the
// first click and takes the whole second press itself: nothing under it is
// clicked, no text is selected, nothing navigates twice. A mouse only: a tap,
// also a double tap, stays one navigation. A row's own controls keep their clicks.

const ROWS = '#plnav-radio, .plnav-row[data-playlist-id], .lobby-card[data-playlist-id]';
const CONTROLS = 'button, input, textarea, select, [contenteditable="true"]';
const SLOP_PX = 8;

/** What a click on `el` would start: { id } (id 'radio' for Radio), with control: true on a row's own control, or null. */
export function rowTarget(el) {
  const row = el && el.closest ? el.closest(ROWS) : null;
  if (!row) return null;
  const id = row.id === 'plnav-radio' ? 'radio' : row.dataset.playlistId;
  return el.closest(CONTROLS) ? { id, control: true } : { id };
}

export function createRowDoubleClick(onDouble) {
  let pointerType = 'mouse';
  let first = null;
  let swallow = false;
  return {
    pointerdown(e) { pointerType = e.pointerType; },

    // Capture phase: the second press, before anything under it hears about it.
    mousedown(e) {
      swallow = false;
      const near = first && e.button === 0 && e.detail >= 2
        && Math.abs(e.clientX - first.x) <= SLOP_PX && Math.abs(e.clientY - first.y) <= SLOP_PX;
      const here = near ? rowTarget(e.target) : null;
      if (!near || (here && here.control)) { first = null; return; }
      e.preventDefault();
      e.stopPropagation();
      swallow = true;
      if (e.detail === 2) onDouble(first.id);
    },

    // Capture phase: the click that second press ends in.
    clickCapture(e) {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    },

    // Bubble phase, so a click something else swallowed (closing a menu) does not count.
    click(e) {
      const plain = e.detail === 1 && e.button === 0 && pointerType === 'mouse'
        && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
      const target = plain ? rowTarget(e.target) : null;
      first = target && !target.control ? { id: target.id, x: e.clientX, y: e.clientY } : null;
    },
  };
}

export function setupRowDoubleClick(onDouble) {
  const gesture = createRowDoubleClick(onDouble);
  window.addEventListener('pointerdown', gesture.pointerdown, true);
  window.addEventListener('mousedown', gesture.mousedown, true);
  window.addEventListener('click', gesture.clickCapture, true);
  document.addEventListener('click', gesture.click);
}
