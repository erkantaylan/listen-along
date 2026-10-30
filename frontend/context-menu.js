// Reusable context menu (DESIGN.md "Context menu"). One menu element at a
// time, Bootstrap 6 `.menu` markup, no Bootstrap JS.
//
//   openContextMenu({ x, y } | { anchor }, items, { label, returnFocus, focusFirst })
//   closeContextMenu()
//   bindContextMenu(root, { rowSelector, triggerSelector, getItems, label })
//
// items: [{ label, description?, icon? (svg string), theme? ('danger'…),
//           disabled?, onSelect() }] plus { header: 'text' }, { divider: true }
//           and { text: 'plain line', muted? } (non-interactive).
// options.kind 'popover' renders the same floating box as role="dialog"
// (details, not actions: e.g. who reported a song, a person's card) with the
// same placement and closing rules; Tab cycles inside it instead of closing.
// A popover item may be { html, onAction(action) }: trusted markup (the
// caller escapes it) whose [data-ctx-action] buttons call onAction and close.
// options.sheet: below 576px the box becomes a bottom sheet (phones).
// updateContextMenu(items) re-renders the open box in place (live data),
// keeping focus on the same control.
//
// bindContextMenu wires a list: right-click (contextmenu) on a row, a ~500ms
// long-press on touch, the keyboard context-menu key / Shift+F10 on a focused
// row, and a visible "⋮" trigger button inside the row. The browser's own
// menu is suppressed on rows only (and kept on links and when Shift is held).
// getItems(row) may return a Promise; returning nothing opens no menu.

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

let menuEl = null;
let current = null; // { trigger, returnFocus, kind, items }
const SHEET_MQ = '(max-width: 575.98px)';

function itemButtons() {
  return menuEl ? [...menuEl.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')] : [];
}

function focusItem(index) {
  const items = itemButtons();
  if (!items.length) return;
  const i = (index + items.length) % items.length;
  items[i].focus();
}

function focusables() {
  return menuEl ? [...menuEl.querySelectorAll('button:not([disabled]), [href], [tabindex="0"]')] : [];
}

function trapTab(e) {
  e.preventDefault();
  const f = focusables();
  if (!f.length) return;
  const at = f.indexOf(document.activeElement);
  const next = e.shiftKey ? (at <= 0 ? f.length - 1 : at - 1) : (at + 1) % f.length;
  f[next].focus();
}

function onMenuKeydown(e) {
  const items = itemButtons();
  const at = items.indexOf(document.activeElement);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusItem(at + 1); break;
    case 'ArrowUp': e.preventDefault(); focusItem(at < 0 ? -1 : at - 1); break;
    case 'Home': e.preventDefault(); focusItem(0); break;
    case 'End': e.preventDefault(); focusItem(-1); break;
    case 'Escape': e.preventDefault(); e.stopPropagation(); closeContextMenu({ restoreFocus: true }); break;
    case 'Tab':
      if (current && current.kind === 'popover') { trapTab(e); break; }
      e.preventDefault(); closeContextMenu({ restoreFocus: true }); break;
    default: break;
  }
}

function onOutsidePointer(e) {
  if (!menuEl || menuEl.contains(e.target)) return;
  // Its own trigger toggles it (the click handler closes it).
  if (current && current.trigger && current.trigger.contains(e.target)) return;
  closeContextMenu();
}
function onScroll(e) {
  if (menuEl && e.target !== menuEl && !(e.target instanceof Node && menuEl.contains(e.target))) closeContextMenu();
}
function onWindowChange() { closeContextMenu(); }

function addGlobalListeners() {
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('blur', onWindowChange);
}
function removeGlobalListeners() {
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('blur', onWindowChange);
}

export function isContextMenuOpen() {
  return !!menuEl;
}

export function closeContextMenu({ restoreFocus = false } = {}) {
  if (!menuEl) return;
  const { trigger, returnFocus: back } = current || {};
  const returnFocus = typeof back === 'function' ? back() : back;
  menuEl.remove();
  menuEl = null;
  current = null;
  removeGlobalListeners();
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Keep the menu inside the viewport: flip left/up when it would overflow,
// then clamp to an 8px margin.
function place(x, y, alignRight = false) {
  const m = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = menuEl.getBoundingClientRect();
  let left = alignRight ? x - r.width : x;
  let top = y;
  if (left + r.width > vw - m) left = x - r.width;
  if (top + r.height > vh - m) top = y - r.height;
  left = Math.max(m, Math.min(left, vw - m - r.width));
  top = Math.max(m, Math.min(top, vh - m - r.height));
  menuEl.style.left = `${Math.round(left)}px`;
  menuEl.style.top = `${Math.round(top)}px`;
}

function positionMenu(at, asSheet) {
  if (asSheet) return; // CSS pins it to the bottom edge.
  if (at && at.anchor && document.contains(at.anchor)) {
    const r = at.anchor.getBoundingClientRect();
    place(at.alignLeft ? r.left : r.right, r.bottom + 2, !at.alignLeft);
  } else if (at && !at.anchor) {
    place(at.x || 0, at.y || 0);
  }
}

function itemsHtml(items) {
  return items.map((item, i) => {
    if (item.html !== undefined) return `<div class="app-ctx-html" data-ctx-html="${i}">${item.html}</div>`;
    if (item.divider) return '<div class="menu-divider" role="separator"></div>';
    if (item.text !== undefined) return `<div class="menu-text app-ctx-text${item.muted ? ' fg-3 fs-xs' : ''}">${escapeHtml(item.text)}</div>`;
    if (item.header) return `<div class="menu-header text-truncate app-ctx-header" role="presentation" title="${escapeHtml(item.header)}">${escapeHtml(item.header)}</div>`;
    const theme = item.theme ? ` theme-${escapeHtml(item.theme)}` : '';
    const disabled = item.disabled ? ' aria-disabled="true" disabled' : '';
    const icon = item.icon ? `<span class="menu-item-icon" aria-hidden="true">${item.icon}</span>` : '';
    const body = item.description
      ? `<span class="menu-item-content"><span>${escapeHtml(item.label)}</span><span class="menu-item-description">${escapeHtml(item.description)}</span></span>`
      : `<span class="menu-item-content">${escapeHtml(item.label)}</span>`;
    return `<button type="button" class="menu-item${theme}" role="menuitem" tabindex="-1" data-ctx-index="${i}"${disabled}>${icon}${body}</button>`;
  }).join('');
}

/** Re-render the open box with new items (live updates), keeping focus. */
export function updateContextMenu(items) {
  if (!menuEl || !current || !items || !items.length) return;
  const a = document.activeElement;
  const key = a && menuEl.contains(a) ? (a.dataset.ctxAction ? `[data-ctx-action="${a.dataset.ctxAction}"]` : a.dataset.ctxIndex ? `[data-ctx-index="${a.dataset.ctxIndex}"]` : null) : null;
  const hadFocus = a && menuEl.contains(a);
  current.items = items;
  menuEl.innerHTML = itemsHtml(items);
  positionMenu(current.at, current.asSheet);
  if (hadFocus) {
    const again = key && menuEl.querySelector(key);
    if (again && !again.disabled) again.focus({ preventScroll: true }); else menuEl.focus({ preventScroll: true });
  }
}

/**
 * Open the menu at a point ({ x, y }, viewport coordinates) or under an
 * element ({ anchor }: below it, right-aligned).
 * options.trigger: a button that gets aria-expanded; options.returnFocus:
 * where focus goes back after Escape / a selection; options.focusFirst:
 * focus the first item (keyboard), else the menu itself.
 */
export function openContextMenu(at, items, { label = 'Actions', trigger = null, returnFocus = null, focusFirst = false, kind = 'menu', sheet = false, className = '' } = {}) {
  closeContextMenu();
  if (!items || !items.length) return null;
  const el = document.createElement('div');
  const asSheet = sheet && window.matchMedia(SHEET_MQ).matches;
  el.className = `menu app-ctx-menu${kind === 'popover' ? ' app-ctx-popover' : ''}${asSheet ? ' app-ctx-sheet' : ''}${className ? ` ${className}` : ''}`;
  el.setAttribute('role', kind === 'popover' ? 'dialog' : 'menu');
  el.setAttribute('aria-label', label);
  el.tabIndex = -1;
  el.innerHTML = itemsHtml(items);
  el.addEventListener('keydown', onMenuKeydown);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    const list = (current && current.items) || items;
    const act = e.target.closest('[data-ctx-action]');
    if (act) {
      if (act.disabled) return;
      const holder = act.closest('[data-ctx-html]');
      const item = holder ? list[Number(holder.dataset.ctxHtml)] : null;
      closeContextMenu({ restoreFocus: true });
      if (item && typeof item.onAction === 'function') item.onAction(act.dataset.ctxAction);
      return;
    }
    const btn = e.target.closest('[data-ctx-index]');
    if (!btn || btn.disabled) return;
    const item = list[Number(btn.dataset.ctxIndex)];
    closeContextMenu({ restoreFocus: true });
    if (item && typeof item.onSelect === 'function') item.onSelect();
  });
  document.body.appendChild(el);
  menuEl = el;
  current = { trigger, returnFocus: returnFocus || trigger || null, kind, items, at, asSheet };
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  el.classList.add('show');
  positionMenu(at, asSheet);
  addGlobalListeners();
  if (focusFirst && kind === 'popover') {
    const f = focusables()[0];
    (f || el).focus({ preventScroll: true });
  } else if (focusFirst) focusItem(0); else el.focus({ preventScroll: true });
  return el;
}

/**
 * Wire context menus onto the rows of a container (delegated, so rows can be
 * re-rendered freely).
 * @param {Element} root
 * @param {{ rowSelector: string, triggerSelector?: string,
 *           getItems: (row: Element) => (object[]|null|Promise<object[]|null>),
 *           label?: (row: Element) => string }} opts
 */
export function bindContextMenu(root, { rowSelector, triggerSelector = '.song-menu-btn', getItems, label }) {
  if (!root) return;
  let seq = 0;
  const show = async (row, at, extra = {}) => {
    const mine = ++seq;
    const items = await getItems(row);
    if (mine !== seq || !items || !document.contains(row)) return;
    openContextMenu(at, items, { label: label ? label(row) : 'Song actions', returnFocus: extra.trigger || row, ...extra });
  };

  // Long-press (touch / pen): open at the finger, swallow what follows.
  let press = null;
  let suppressUntil = 0;
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    const row = e.target.closest(rowSelector);
    if (!row || !root.contains(row) || e.target.closest('a[href], input, textarea, select')) return;
    cancelPress();
    press = {
      x: e.clientX, y: e.clientY, row,
      timer: setTimeout(() => {
        const p = press;
        press = null;
        if (!p) return;
        suppressUntil = Date.now() + 800;
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch {} }
        show(p.row, { x: p.x, y: p.y });
      }, LONG_PRESS_MS),
    };
  });
  root.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => root.addEventListener(t, cancelPress));
  root.addEventListener('scroll', cancelPress, true);
  // The click / dragstart a long-press ends with must not also act.
  root.addEventListener('click', (e) => {
    if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); suppressUntil = 0; }
  }, true);

  root.addEventListener('contextmenu', (e) => {
    const row = e.target.closest(rowSelector);
    if (!row || !root.contains(row)) return;
    // Keep the browser's menu on links, inputs, and with Shift held.
    if (e.shiftKey || e.target.closest('a[href], input, textarea, select')) return;
    e.preventDefault();
    if (Date.now() < suppressUntil) return; // Android fires one after our long-press
    cancelPress();
    // Keyboard (context-menu key / Shift+F10) reports 0,0 or no pointer type: anchor to the row.
    const fromKeyboard = (e.clientX === 0 && e.clientY === 0) || e.pointerType === '';
    if (fromKeyboard) {
      const r = row.getBoundingClientRect();
      show(row, { x: r.left + 16, y: r.top + Math.min(r.height, 32) }, { focusFirst: true });
    } else {
      show(row, { x: e.clientX, y: e.clientY });
    }
  });

  root.addEventListener('click', (e) => {
    const btn = triggerSelector && e.target.closest(triggerSelector);
    if (!btn || !root.contains(btn)) return;
    const row = btn.closest(rowSelector) || btn;
    e.preventDefault();
    e.stopPropagation();
    if (menuEl && current && current.trigger === btn) { closeContextMenu(); return; }
    // Keyboard activation (Enter / Space: detail 0) focuses the first item.
    show(row, { anchor: btn }, { trigger: btn, focusFirst: e.detail === 0 });
  });
}
