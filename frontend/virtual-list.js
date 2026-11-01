// A windowed list: thousands of equal-height rows in an existing scroller, with
// only the rows near the viewport in the DOM (DESIGN.md "Long lists"). It knows
// nothing about songs, so anything long can use it: give it the <ul>, the element
// that scrolls and a source, and set --vl-row-height on the list in CSS.
//
//   const view = createVirtualList({ list, scroller, stickyTop: () => 32 });
//   view.setSource({ count, keyOf(pos), indexOfKey(key), renderRow(pos) });
//
// renderRow returns the markup of one row. The row gets --vl-pos, data-vl-pos and
// aria-posinset / aria-setsize, so a screen reader hears "3 of 2,500". Rows are
// absolutely placed, which lets a row outside the window stay in the DOM: the one
// holding keyboard focus always does, and so does anything pinned (a dragged row).
// The list element's event listeners stay valid, so bind them there, delegated.

// Pure: which rows [start, end) to render. viewTop is how far the viewport's top
// is below the list's top (negative while the list has not reached it yet).
export function windowRange({ viewTop, viewHeight, rowHeight, count, overscan = 12 }) {
  if (!(count > 0) || !(rowHeight > 0)) return { start: 0, end: 0 };
  const top = Math.max(0, viewTop);
  const bottom = Math.max(0, viewTop + Math.max(0, viewHeight));
  const start = Math.floor(top / rowHeight) - overscan;
  const end = Math.ceil(bottom / rowHeight) + overscan;
  return { start: Math.min(Math.max(0, start), count), end: Math.min(Math.max(0, end), count) };
}

// Pure: the scrollTop that brings a row into view, or the same scrollTop when it
// already is. rowTop and rowHeight are in the scroller's content coordinates.
export function scrollTopFor({ rowTop, rowHeight, scrollTop, viewHeight, stickyTop = 0, align = 'nearest' }) {
  if (align === 'center') return Math.max(0, rowTop - stickyTop - (viewHeight - stickyTop - rowHeight) / 2);
  if (rowTop < scrollTop + stickyTop) return Math.max(0, rowTop - stickyTop);
  if (rowTop + rowHeight > scrollTop + viewHeight) return rowTop + rowHeight - viewHeight;
  return scrollTop;
}

const DEFAULT_ROW_HEIGHT = 56;

export function createVirtualList({ list, scroller, overscan = 12, stickyTop = () => 0, onRender = null }) {
  let source = null;
  const rows = new Map(); // position -> element
  const pins = new Set();
  let cachedHeight = DEFAULT_ROW_HEIGHT;
  const template = document.createElement('template');

  function rowHeight() {
    const first = rows.values().next().value;
    const height = first ? first.getBoundingClientRect().height : 0;
    if (height > 0) cachedHeight = height;
    return cachedHeight;
  }

  // Scroller's viewport top, measured from the list's top.
  const viewTop = () => scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;

  function createRow(pos) {
    template.innerHTML = source.renderRow(pos);
    const el = template.content.firstElementChild;
    el.classList.add('vlist-row');
    el.style.setProperty('--vl-pos', pos);
    el.dataset.vlPos = pos;
    el.setAttribute('aria-posinset', pos + 1);
    el.setAttribute('aria-setsize', source.count);
    return el;
  }

  function holdsFocus(el) {
    return el.contains(document.activeElement);
  }

  function render(alsoKeep = -1) {
    if (!source) return;
    const { start, end } = windowRange({ viewTop: viewTop(), viewHeight: scroller.clientHeight, rowHeight: rowHeight(), count: source.count, overscan });
    const wanted = (pos) => (pos >= start && pos < end) || pins.has(pos) || pos === alsoKeep;
    let changed = false;
    for (const [pos, el] of rows) {
      if (wanted(pos) || holdsFocus(el)) continue;
      el.remove();
      rows.delete(pos);
      changed = true;
    }
    const add = (pos) => {
      if (rows.has(pos) || pos < 0 || pos >= source.count) return;
      rows.set(pos, createRow(pos));
      changed = true;
    };
    for (let pos = start; pos < end; pos++) add(pos);
    pins.forEach(add);
    add(alsoKeep);
    if (!changed) return;
    // DOM order follows position, for Tab and screen readers. Rows already in the
    // list keep their relative order, so none of them moves (a move would blur it).
    let cursor = list.firstElementChild;
    for (const pos of [...rows.keys()].sort((a, b) => a - b)) {
      const el = rows.get(pos);
      if (el === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(el, cursor);
    }
    if (onRender) onRender();
  }

  // Scroll events already come once per frame, right before painting.
  scroller.addEventListener('scroll', () => render(), { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => render()).observe(scroller);

  return {
    /**
     * New data. anchor keeps the song at the top of the viewport where it is when
     * rows are added or removed above it (someone else's edit); leave it off for
     * the user's own move or removal, where the rows around it should shift.
     */
    setSource(next, { anchor = true } = {}) {
      let anchorKey, anchorPos = -1, focusKey;
      const height = rowHeight();
      if (source && source.count) {
        const top = viewTop();
        if (anchor && top > 0) {
          anchorPos = Math.floor(top / height);
          if (anchorPos < source.count) anchorKey = source.keyOf(anchorPos);
        }
        for (const [pos, el] of rows) if (holdsFocus(el)) focusKey = source.keyOf(pos);
      }
      list.replaceChildren();
      rows.clear();
      pins.clear();
      source = next;
      list.classList.add('vlist');
      list.style.setProperty('--vl-count', next.count);
      if (anchorKey !== undefined) {
        const moved = next.indexOfKey(anchorKey);
        if (moved >= 0 && moved !== anchorPos) scroller.scrollTop += (moved - anchorPos) * height;
      }
      render(focusKey !== undefined ? next.indexOfKey(focusKey) : -1);
    },

    /** Not a windowed list right now: show this markup instead (an empty state). */
    clear(html = '') {
      source = null;
      rows.clear();
      pins.clear();
      list.classList.remove('vlist');
      list.style.removeProperty('--vl-count');
      list.innerHTML = html;
    },

    /** Scroll a row into view and render it. align: 'nearest' or 'center'. */
    scrollToIndex(pos, { align = 'nearest' } = {}) {
      if (!source || pos < 0 || pos >= source.count) return null;
      const height = rowHeight();
      const scrollTop = scroller.scrollTop;
      const next = scrollTopFor({ rowTop: scrollTop - viewTop() + pos * height, rowHeight: height, scrollTop, viewHeight: scroller.clientHeight, stickyTop: stickyTop(), align });
      if (next !== scrollTop) scroller.scrollTop = next;
      render(pos);
      return rows.get(pos) || null;
    },

    positionOf: (el) => parseInt(el.dataset.vlPos, 10),
    rowAt: (pos) => rows.get(pos) || null,
    rendered: () => rows,
    pin(pos) { pins.add(pos); },
    unpin(pos) { pins.delete(pos); },
    get count() { return source ? source.count : 0; },
    get rowHeight() { return rowHeight(); },
    /** Rows that fit in the viewport, for PageUp / PageDown. */
    get pageSize() { return Math.max(1, Math.floor((scroller.clientHeight - stickyTop()) / rowHeight()) - 1); },
  };
}
