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
// An item with `checked` (true / false) is a radio choice: role="menuitemradio",
// aria-checked and a check mark.
// options.kind 'popover' renders the same floating box as role="dialog"
// (details, not actions: e.g. who reported a song, a person's card) with the
// same placement and closing rules; Tab cycles inside it instead of closing.
// A popover item may be { html, onAction(action) }: trusted markup (the
// caller escapes it) whose [data-ctx-action] buttons call onAction and close.
// options.sheet: below 576px the box becomes a bottom sheet (phones).
// updateContextMenu(items) re-renders the open box in place (live data),
// keeping focus on the same control.
//
// An item may be { label, icon?, submenu: { label, searchLabel?, items(query),
// footer?, emptyText?, onOpen? } }: a second box beside the menu (a bottom sheet
// with a back button below 576px, replacing the menu). searchLabel adds a search
// box; items(query) is called again as it changes. Its items use the same shape.
// refreshSubmenu() re-renders the open one (live data).
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
let subEl = null;
let sub = null; // { def, btn, asSheet, items, query }
let subTimer = null;
let viewportWidth = 0;
const SHEET_MQ = '(max-width: 575.98px)';

function itemButtons() {
  return menuEl ? [...menuEl.querySelectorAll(':is([role="menuitem"], [role="menuitemradio"]):not([aria-disabled="true"])')] : [];
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
    case 'ArrowDown': e.preventDefault(); closeSubmenu(); focusItem(at + 1); break;
    case 'ArrowUp': e.preventDefault(); closeSubmenu(); focusItem(at < 0 ? -1 : at - 1); break;
    case 'Home': e.preventDefault(); closeSubmenu(); focusItem(0); break;
    case 'End': e.preventDefault(); closeSubmenu(); focusItem(-1); break;
    case 'ArrowRight': {
      const btn = document.activeElement;
      if (btn && btn.matches('[data-ctx-sub]')) { e.preventDefault(); openSubmenu(btn, { focus: true }); }
      break;
    }
    case 'Escape': e.preventDefault(); e.stopPropagation(); closeContextMenu({ restoreFocus: true }); break;
    case 'Tab':
      if (current && current.kind === 'popover') { trapTab(e); break; }
      e.preventDefault(); closeContextMenu({ restoreFocus: true }); break;
    default: break;
  }
}

const inMenus = (node) => node instanceof Node && ((menuEl && menuEl.contains(node)) || (subEl && subEl.contains(node)));

function onOutsidePointer(e) {
  if (!menuEl || inMenus(e.target)) return;
  // Its own trigger toggles it (the click handler closes it).
  if (current && current.trigger && current.trigger.contains(e.target)) return;
  const asSheet = (current && current.asSheet) || (sub && sub.asSheet);
  closeContextMenu();
  // A sheet dims the page, and a click that only closes a menu must not play
  // the song row under the pointer.
  if (e.pointerType !== 'mouse' || asSheet || (e.target instanceof Element && e.target.closest('.list-group-item-action'))) swallowNextClick();
}
function onScroll(e) {
  if (menuEl && !inMenus(e.target)) closeContextMenu();
}
function onWindowChange(e) {
  // A phone's on-screen keyboard resizes some browsers' window: only the height.
  if (e.type === 'resize' && subEl && subEl.contains(document.activeElement) && document.documentElement.clientWidth === viewportWidth) return;
  closeContextMenu();
}

// On touch, the tap that dismisses a menu must not also press what is under it
// (a song row would start playing). A scroll sends no click, hence the timeout.
function swallowNextClick() {
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 800);
}

function addGlobalListeners() {
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('blur', onWindowChange);
  viewportWidth = document.documentElement.clientWidth;
}
function removeGlobalListeners() {
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('blur', onWindowChange);
}

// --- Submenu ---------------------------------------------------------------

const BACK_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';

function placeSubmenu() {
  if (!subEl || sub.asSheet) return;
  const m = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const parent = menuEl.getBoundingClientRect();
  const r = subEl.getBoundingClientRect();
  let left = parent.right - 2;
  if (left + r.width > vw - m) left = parent.left - r.width + 2;
  subEl.style.left = `${Math.round(Math.max(m, Math.min(left, vw - m - r.width)))}px`;
  subEl.style.top = `${Math.round(Math.max(m, Math.min(sub.btn.getBoundingClientRect().top - 8, vh - m - r.height)))}px`;
}

// The on-screen keyboard covers a fixed bottom sheet: sit on top of it.
function fitSheetToKeyboard() {
  const vv = window.visualViewport;
  if (!vv || !subEl || !sub.asSheet) return;
  subEl.style.bottom = `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`;
  subEl.style.maxHeight = `${Math.round(Math.min(window.innerHeight * 0.75, vv.height - 8))}px`;
}

function renderSubmenu() {
  const { def } = sub;
  const list = subEl.querySelector('.app-ctx-sub-list');
  const had = list.contains(document.activeElement) ? [...list.querySelectorAll('[role="menuitem"]')].indexOf(document.activeElement) : -1;
  const shown = def.items(sub.query) || [];
  const footer = def.footer || [];
  sub.items = [...shown, ...footer];
  list.innerHTML = shown.length ? itemsHtml(shown) : `<div class="menu-text app-ctx-text fg-3 fs-sm">${escapeHtml(def.emptyText || '')}</div>`;
  const foot = subEl.querySelector('.app-ctx-sub-footer');
  if (foot) foot.innerHTML = itemsHtml(footer, shown.length);
  if (had >= 0) {
    const again = subItems();
    const target = again[Math.min(had, again.length - 1)] || subEl.querySelector('input');
    if (target) target.focus({ preventScroll: true });
  }
  placeSubmenu();
}

const subItems = () => (subEl ? [...subEl.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')] : []);

function onSubKeydown(e) {
  const input = subEl.querySelector('input');
  const onInput = document.activeElement === input;
  const stops = [...(input ? [input] : []), ...subItems()];
  const at = stops.indexOf(document.activeElement);
  const go = (i) => { if (stops.length) stops[(i + stops.length) % stops.length].focus(); };
  e.stopPropagation();
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); go(at + 1); break;
    case 'ArrowUp': e.preventDefault(); go(at < 0 ? -1 : at - 1); break;
    case 'Home': if (!onInput) { e.preventDefault(); go(0); } break;
    case 'End': if (!onInput) { e.preventDefault(); go(-1); } break;
    case 'ArrowLeft':
      if (!onInput || !input.value) { e.preventDefault(); closeSubmenu({ restoreFocus: true }); }
      break;
    case 'Escape':
      e.preventDefault();
      if (input && input.value) { input.value = ''; sub.query = ''; renderSubmenu(); input.focus(); } else closeSubmenu({ restoreFocus: true });
      break;
    case 'Tab':
      e.preventDefault();
      if (stops.length) stops[onInput || at < 0 ? (e.shiftKey ? stops.length - 1 : Math.min(1, stops.length - 1)) : 0].focus();
      break;
    case 'Enter':
      // In the search box: the first match, once something has been typed.
      if (onInput) {
        e.preventDefault();
        const first = input.value.trim() && subEl.querySelector('.app-ctx-sub-list [role="menuitem"]:not([aria-disabled="true"])');
        if (first) first.click();
      }
      break;
    default: break;
  }
}

function openSubmenu(btn, { focus = false } = {}) {
  clearTimeout(subTimer);
  const parentItem = current.items[Number(btn.dataset.ctxIndex)];
  if (!parentItem || !parentItem.submenu) return;
  if (sub && sub.btn === btn) { if (focus) focusSubmenu(); return; }
  closeSubmenu();
  const def = parentItem.submenu;
  const asSheet = window.matchMedia(SHEET_MQ).matches;
  const el = document.createElement('div');
  el.className = `menu app-ctx-menu app-ctx-sub show${asSheet ? ' app-ctx-sheet' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', def.label);
  el.tabIndex = -1;
  el.innerHTML = `${asSheet ? `<div class="app-ctx-sub-head"><button type="button" class="btn-text theme-secondary btn-icon btn-sm app-ctx-sub-back" aria-label="${escapeHtml(def.backLabel || 'Back')}" title="${escapeHtml(def.backLabel || 'Back')}">${BACK_ICON}</button><h2 class="h6 mb-0 text-truncate">${escapeHtml(def.label)}</h2></div>` : ''}
    ${def.searchLabel ? `<div class="app-ctx-sub-search"><input type="search" class="form-control form-control-sm" aria-label="${escapeHtml(def.searchLabel)}" placeholder="${escapeHtml(def.searchLabel)}" autocomplete="off" enterkeyhint="go"></div>` : ''}
    <div class="app-ctx-sub-list" role="menu" aria-label="${escapeHtml(def.label)}"></div>
    ${def.footer && def.footer.length ? '<div class="app-ctx-sub-footer"></div>' : ''}`;
  el.addEventListener('keydown', onSubKeydown);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerover', () => clearTimeout(subTimer));
  el.addEventListener('input', (e) => { if (e.target.matches('input')) { sub.query = e.target.value; renderSubmenu(); } });
  el.addEventListener('click', (e) => {
    if (e.target.closest('.app-ctx-sub-back')) { closeSubmenu({ restoreFocus: true }); return; }
    const row = e.target.closest('[data-ctx-index]');
    if (!row || row.disabled) return;
    const item = sub.items[Number(row.dataset.ctxIndex)];
    closeContextMenu({ restoreFocus: true });
    if (item && typeof item.onSelect === 'function') item.onSelect();
  });
  document.body.appendChild(el);
  subEl = el;
  sub = { def, btn, asSheet, items: [], query: '' };
  btn.setAttribute('aria-expanded', 'true');
  if (asSheet) {
    menuEl.hidden = true;
    fitSheetToKeyboard();
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitSheetToKeyboard); window.visualViewport.addEventListener('scroll', fitSheetToKeyboard); }
  }
  renderSubmenu();
  if (typeof def.onOpen === 'function') def.onOpen();
  if (focus) focusSubmenu();
}

// Touch: no search focus, the keyboard would cover the list before it is seen.
function focusSubmenu() {
  if (!subEl) return;
  const input = subEl.querySelector('input');
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (input && !touch) input.focus({ preventScroll: true });
  else if (!input && subItems().length) subItems()[0].focus({ preventScroll: true });
  else subEl.focus({ preventScroll: true });
}

function closeSubmenu({ restoreFocus = false } = {}) {
  clearTimeout(subTimer);
  if (!subEl) return;
  const { btn, asSheet } = sub;
  subEl.remove();
  subEl = null;
  sub = null;
  btn.setAttribute('aria-expanded', 'false');
  if (asSheet) {
    if (menuEl) menuEl.hidden = false;
    if (window.visualViewport) { window.visualViewport.removeEventListener('resize', fitSheetToKeyboard); window.visualViewport.removeEventListener('scroll', fitSheetToKeyboard); }
  }
  if (restoreFocus && document.contains(btn)) btn.focus({ preventScroll: true });
}

/** Re-render the open submenu (live data); its search box and focus stay. */
export function refreshSubmenu() {
  if (subEl) renderSubmenu();
}

export function isContextMenuOpen() {
  return !!menuEl;
}

export function closeContextMenu({ restoreFocus = false } = {}) {
  if (!menuEl) return;
  closeSubmenu();
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

const CHECK = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const CHEVRON = '<span class="app-ctx-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></span>';

function itemsHtml(items, start = 0) {
  return items.map((item, n) => {
    const i = start + n;
    if (item.html !== undefined) return `<div class="app-ctx-html" data-ctx-html="${i}">${item.html}</div>`;
    if (item.divider) return '<div class="menu-divider" role="separator"></div>';
    if (item.text !== undefined) return `<div class="menu-text app-ctx-text${item.muted ? ' fg-3 fs-xs' : ''}">${escapeHtml(item.text)}</div>`;
    if (item.header) return `<div class="menu-header text-truncate app-ctx-header" role="presentation" title="${escapeHtml(item.header)}">${escapeHtml(item.header)}</div>`;
    const theme = item.theme ? ` theme-${escapeHtml(item.theme)}` : '';
    const disabled = item.disabled ? ' aria-disabled="true" disabled' : '';
    const radio = item.checked !== undefined;
    const glyph = radio ? (item.checked ? CHECK : '') : item.icon;
    const icon = glyph || radio ? `<span class="menu-item-icon" aria-hidden="true">${glyph}</span>` : '';
    const body = item.description
      ? `<span class="menu-item-content"><span>${escapeHtml(item.label)}</span><span class="menu-item-description">${escapeHtml(item.description)}</span></span>`
      : `<span class="menu-item-content">${escapeHtml(item.label)}</span>`;
    const opens = item.submenu && !item.disabled;
    const popup = opens ? ' aria-haspopup="true" aria-expanded="false" data-ctx-sub' : '';
    return `<button type="button" class="menu-item${theme}" role="${radio ? `menuitemradio" aria-checked="${item.checked ? 'true' : 'false'}` : 'menuitem'}" tabindex="-1" data-ctx-index="${i}"${popup}${disabled}>${icon}${body}${opens ? CHEVRON : ''}</button>`;
  }).join('');
}

/** Re-render the open box with new items (live updates), keeping focus. */
export function updateContextMenu(items) {
  if (!menuEl || !current || !items || !items.length) return;
  closeSubmenu();
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
    if (item && item.submenu) { openSubmenu(btn, { focus: true }); return; }
    closeContextMenu({ restoreFocus: true });
    if (item && typeof item.onSelect === 'function') item.onSelect();
  });
  // Mouse: a submenu opens on hover and closes on hovering a sibling. The delay
  // lets the pointer cross a sibling on its way into the submenu.
  el.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const row = e.target.closest('[data-ctx-index]');
    if (!row) return;
    clearTimeout(subTimer);
    if (row.matches('[data-ctx-sub]')) subTimer = setTimeout(() => { if (document.contains(row)) openSubmenu(row, { focus: true }); }, 150);
    else if (subEl) subTimer = setTimeout(() => { closeSubmenu(); if (menuEl) menuEl.focus({ preventScroll: true }); }, 250);
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
