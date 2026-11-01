// The two columns' widths: the sidebar's rail / expanded choice, the widths the
// user dragged, and the drag handles (DESIGN.md "Columns and breakpoints").
// layout-rules.js decides; this applies the result as CSS variables on <body>,
// which is also what moves the page column and its @container rules.
// Only a width the user chose is ever stored. A small window clamps what is
// applied and leaves the stored value alone, so it returns when there is room.
import {
  CHAT_MAX, CHAT_MIN, DOCK_MIN, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_RAIL,
  defaultChatWidth, defaultSidebarWidth, resolveColumns,
} from './layout-rules.js';
import { storageGet, storageRemove, storageSet } from './state.js';

const MODE_KEY = 'listen-sidebarMode';
const LEFT_KEY = 'listen-sidebarWidth';
const RIGHT_KEY = 'listen-chatWidth';
const KEY_STEP = 16;
const DRAG_START_PX = 3;
const DOUBLE_TAP_MS = 400;

let started = false;
let mode = null; // 'rail' | 'expanded' | null (automatic)
const saved = { left: null, right: null };
const lastTap = { left: 0, right: 0 };
let drag = null;

function loadWidth(key, min, max) {
  const raw = storageGet(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

function columns(override = {}) {
  const { body } = document;
  const width = window.innerWidth;
  return resolveColumns({
    width,
    pref: mode,
    chatDocked: body.classList.contains('has-social') && !body.classList.contains('social-collapsed') && width >= DOCK_MIN,
    hasSidebar: body.classList.contains('has-plnav'),
    left: saved.left,
    right: saved.right,
    ...override,
  });
}

// No inline variable at the default width: app.css stays the one source there.
function setWidthVar(name, value, fallback) {
  const { style } = document.body;
  if (value == null || value === fallback) style.removeProperty(name);
  else style.setProperty(name, `${value}px`);
}

function syncHandle(id, now, min, max) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('aria-valuenow', String(now));
  el.setAttribute('aria-valuemin', String(min));
  el.setAttribute('aria-valuemax', String(max));
}

function apply(cols) {
  const { body } = document;
  const width = window.innerWidth;
  if (body.classList.contains('plnav-rail') !== cols.rail) {
    body.classList.toggle('plnav-rail', cols.rail);
    document.dispatchEvent(new CustomEvent('app:railchange'));
  }
  setWidthVar('--app-sidebar-width', cols.rail ? null : cols.left, defaultSidebarWidth(width));
  setWidthVar('--app-social-width', cols.right, defaultChatWidth(width));
  if (cols.left != null) syncHandle('plnav-resizer', cols.left, SIDEBAR_RAIL, columns({ pref: 'expanded', left: SIDEBAR_MAX }).left);
  if (cols.right != null) syncHandle('social-resizer', cols.right, CHAT_MIN, columns({ right: CHAT_MAX }).right);
}

export function applyColumns() {
  apply(columns(drag && drag.override ? drag.override : {}));
}

export const isSidebarRail = () => document.body.classList.contains('plnav-rail');

function setMode(value) {
  mode = value;
  if (value) storageSet(MODE_KEY, value);
  else storageRemove(MODE_KEY);
}

export function toggleSidebarRail() {
  setMode(isSidebarRail() ? 'expanded' : 'rail');
  applyColumns();
}

// ------------------------------------------------------------- what a width means

// What dragging or stepping to this width asks of the layout.
function overrideFor(side, width) {
  if (side === 'right') return { right: Math.round(Math.max(CHAT_MIN, Math.min(CHAT_MAX, width))) };
  if (width < SIDEBAR_MIN) return { pref: 'rail' };
  return { pref: 'expanded', left: Math.round(Math.min(SIDEBAR_MAX, width)) };
}

const widthOf = (side, cols) => (side === 'right' ? cols.right : cols.left);

function commit(side, override, before) {
  const cols = columns(override);
  if (widthOf(side, cols) === before) { apply(columns()); return; } // back where it started: nothing chosen
  if (side === 'right') {
    saved.right = cols.right;
    storageSet(RIGHT_KEY, String(saved.right));
  } else if (cols.rail) {
    setMode('rail'); // the expanded width stays, for when it opens again
  } else {
    saved.left = cols.left;
    storageSet(LEFT_KEY, String(saved.left));
    // Automatic stays automatic only if it would give this very width; a width
    // past its comfortable floor, or out of a rail, is a choice like the toggle.
    const automatic = columns({ pref: null });
    if (mode === 'rail' || (!mode && (automatic.rail || automatic.left !== cols.left))) setMode('expanded');
  }
  apply(columns());
}

function reset(side) {
  if (side === 'right') {
    saved.right = null;
    storageRemove(RIGHT_KEY);
  } else {
    saved.left = null;
    storageRemove(LEFT_KEY);
    setMode(null); // as if never touched: automatic again
  }
  apply(columns());
}

// ------------------------------------------------------------- pointer

// The chat panel's edge is on its left: dragging left widens it.
const draggedWidth = ({ side, startWidth, startX }, x) => startWidth + (side === 'right' ? startX - x : x - startX);

function frame() {
  if (!drag) return;
  drag.raf = 0;
  drag.override = overrideFor(drag.side, draggedWidth(drag, drag.x));
  apply(columns(drag.override));
}

function endDrag() {
  if (drag.raf) cancelAnimationFrame(drag.raf);
  document.body.classList.remove('panel-resizing');
  drag.el.classList.remove('is-dragging');
  document.removeEventListener('keydown', onDragKey, true);
  drag = null;
}

function cancelDrag() {
  if (!drag) return;
  endDrag();
  apply(columns());
}

function onDragKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  cancelDrag();
}

function bindPointer(el, side) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary || drag) return;
    e.preventDefault(); // no text selection; the focus stays where it was (the chat input)
    el.setPointerCapture(e.pointerId);
    drag = { el, side, id: e.pointerId, startX: e.clientX, x: e.clientX, startWidth: widthOf(side, columns()), moved: false, raf: 0, override: null };
    document.addEventListener('keydown', onDragKey, true);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    if (!drag.moved) {
      if (Math.abs(drag.x - drag.startX) < DRAG_START_PX) return;
      drag.moved = true;
      document.body.classList.add('panel-resizing');
      el.classList.add('is-dragging');
    }
    if (!drag.raf) drag.raf = requestAnimationFrame(frame);
  });
  el.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, startWidth } = drag;
    const width = draggedWidth(drag, e.clientX);
    endDrag();
    if (moved) {
      lastTap[side] = 0;
      commit(side, overrideFor(side, width), startWidth);
      return;
    }
    // Two taps: a double-click, and the same for a finger (no dblclick event there).
    if (e.timeStamp - lastTap[side] < DOUBLE_TAP_MS) { lastTap[side] = 0; reset(side); }
    else lastTap[side] = e.timeStamp;
  });
  el.addEventListener('pointercancel', cancelDrag);
  el.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.id) cancelDrag(); });
}

// ------------------------------------------------------------- keyboard

function bindKeys(el, side) {
  el.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || drag) return;
    const before = widthOf(side, columns());
    if (before == null) return;
    // The arrows move the divider: on the chat panel's edge, left is wider.
    const wider = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const narrower = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
    let target;
    if (e.key === narrower) target = before - KEY_STEP;
    // Out of the rail, one step lands on the smallest expanded width.
    else if (e.key === wider) target = side === 'left' && before < SIDEBAR_MIN ? SIDEBAR_MIN : before + KEY_STEP;
    else if (e.key === 'Home') target = side === 'right' ? CHAT_MIN : SIDEBAR_RAIL;
    else if (e.key === 'End') target = side === 'right' ? CHAT_MAX : SIDEBAR_MAX;
    else if (e.key === 'Enter') { e.preventDefault(); reset(side); return; }
    else return;
    e.preventDefault();
    commit(side, overrideFor(side, target), before);
  });
}

// Sets everything up once; both the sidebar and the chat panel ask for it (the
// chat panel can be on a page without a sidebar: pending, /dashboard).
export function setupPanelWidths() {
  if (started) return;
  started = true;
  const savedMode = storageGet(MODE_KEY);
  mode = savedMode === 'rail' || savedMode === 'expanded' ? savedMode : null;
  saved.left = loadWidth(LEFT_KEY, SIDEBAR_MIN, SIDEBAR_MAX);
  saved.right = loadWidth(RIGHT_KEY, CHAT_MIN, CHAT_MAX);
  for (const [id, side] of [['plnav-resizer', 'left'], ['social-resizer', 'right']]) {
    const el = document.getElementById(id);
    if (!el) continue;
    bindPointer(el, side);
    bindKeys(el, side);
  }
  window.addEventListener('resize', applyColumns);
  document.addEventListener('app:viewchange', applyColumns); // the chat panel opened or closed
}
