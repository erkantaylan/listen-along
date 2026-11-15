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
export function windowRange({ viewTop, viewHeight, rowHeight, count, overscan = 12 }: { viewTop: number; viewHeight: number; rowHeight: number; count: number; overscan?: number }): { start: number; end: number } {
  if (!(count > 0) || !(rowHeight > 0)) return { start: 0, end: 0 };
  const top = Math.max(0, viewTop);
  const bottom = Math.max(0, viewTop + Math.max(0, viewHeight));
  const start = Math.floor(top / rowHeight) - overscan;
  const end = Math.ceil(bottom / rowHeight) + overscan;
  return { start: Math.min(Math.max(0, start), count), end: Math.min(Math.max(0, end), count) };
}

// Pure: the scrollTop that brings a row into view, or the same scrollTop when it
// already is. rowTop and rowHeight are in the scroller's content coordinates.
export type ScrollAlign = 'nearest' | 'center';

export function scrollTopFor({ rowTop, rowHeight, scrollTop, viewHeight, stickyTop = 0, align = 'nearest' }: { rowTop: number; rowHeight: number; scrollTop: number; viewHeight: number; stickyTop?: number; align?: ScrollAlign }): number {
  if (align === 'center') return Math.max(0, rowTop - stickyTop - (viewHeight - stickyTop - rowHeight) / 2);
  if (rowTop < scrollTop + stickyTop) return Math.max(0, rowTop - stickyTop);
  if (rowTop + rowHeight > scrollTop + viewHeight) return rowTop + rowHeight - viewHeight;
  return scrollTop;
}

const DEFAULT_ROW_HEIGHT = 56;

// What a list shows: count rows, each with a stable key (a song's id).
export interface VirtualSource<K = unknown> {
  count: number;
  keyOf(pos: number): K;
  indexOfKey(key: K): number;
  renderRow(pos: number): string;
}

export interface VirtualList {
  setSource<K>(next: VirtualSource<K>, opts?: { anchor?: boolean }): void;
  clear(html?: string): void;
  scrollToIndex(pos: number, opts?: { align?: ScrollAlign }): HTMLElement | null;
  positionOf(el: HTMLElement): number;
  rowAt(pos: number): HTMLElement | null;
  rendered(): Map<number, HTMLElement>;
  pin(pos: number): void;
  unpin(pos: number): void;
  readonly count: number;
  readonly rowHeight: number;
  readonly pageSize: number;
}

export function createVirtualList({ list, scroller, overscan = 12, stickyTop = () => 0, onRender = null }: {
  list: HTMLElement;
  scroller: HTMLElement;
  overscan?: number;
  stickyTop?: () => number;
  onRender?: (() => void) | null;
}): VirtualList {
  // The key type is the caller's; inside, keys are only handed back to the same source.
  let source: VirtualSource | null = null;
  const rows = new Map<number, HTMLElement>(); // position -> element
  const pins = new Set<number>();
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

  function createRow(src: VirtualSource, pos: number): HTMLElement {
    template.innerHTML = src.renderRow(pos);
    const el = template.content.firstElementChild as HTMLElement;
    el.classList.add('vlist-row');
    el.style.setProperty('--vl-pos', String(pos));
    el.dataset.vlPos = String(pos);
    el.setAttribute('aria-posinset', String(pos + 1));
    el.setAttribute('aria-setsize', String(src.count));
    return el;
  }

  function holdsFocus(el: HTMLElement): boolean {
    return el.contains(document.activeElement);
  }

  function render(alsoKeep = -1): void {
    const src = source;
    if (!src) return;
    const { start, end } = windowRange({ viewTop: viewTop(), viewHeight: scroller.clientHeight, rowHeight: rowHeight(), count: src.count, overscan });
    const wanted = (pos: number) => (pos >= start && pos < end) || pins.has(pos) || pos === alsoKeep;
    let changed = false;
    for (const [pos, el] of rows) {
      if (wanted(pos) || holdsFocus(el)) continue;
      el.remove();
      rows.delete(pos);
      changed = true;
    }
    const add = (pos: number) => {
      if (rows.has(pos) || pos < 0 || pos >= src.count) return;
      rows.set(pos, createRow(src, pos));
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
      const el = rows.get(pos) as HTMLElement;
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
    setSource<K>(nextSource: VirtualSource<K>, { anchor = true }: { anchor?: boolean } = {}) {
      const next = nextSource as VirtualSource;
      let anchorKey: unknown, anchorPos = -1, focusKey: unknown;
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
      list.style.setProperty('--vl-count', String(next.count));
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
    scrollToIndex(pos: number, { align = 'nearest' }: { align?: ScrollAlign } = {}) {
      if (!source || pos < 0 || pos >= source.count) return null;
      const height = rowHeight();
      const scrollTop = scroller.scrollTop;
      const next = scrollTopFor({ rowTop: scrollTop - viewTop() + pos * height, rowHeight: height, scrollTop, viewHeight: scroller.clientHeight, stickyTop: stickyTop(), align });
      if (next !== scrollTop) scroller.scrollTop = next;
      render(pos);
      return rows.get(pos) || null;
    },

    positionOf: (el: HTMLElement) => parseInt(el.dataset.vlPos ?? '', 10),
    rowAt: (pos: number) => rows.get(pos) || null,
    rendered: () => rows,
    pin(pos: number) { pins.add(pos); },
    unpin(pos: number) { pins.delete(pos); },
    get count() { return source ? source.count : 0; },
    get rowHeight() { return rowHeight(); },
    /** Rows that fit in the viewport, for PageUp / PageDown. */
    get pageSize() { return Math.max(1, Math.floor((scroller.clientHeight - stickyTop()) / rowHeight()) - 1); },
  };
}
