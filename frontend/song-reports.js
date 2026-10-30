// "Mark as broken — needs replacement" for library songs, plus the song
// context menu built on context-menu.js.
//
// - A store of every song with an open report (GET /api/library?reported=1),
//   indexed by song id, YouTube id and source link so a playlist entry
//   (`library:<id>` or a YouTube URL) finds its song. Refreshed on
//   library:updated; listeners (library page, queue, player bar) re-render.
// - reportIconHtml(): the small warning icon button on a reported song; it
//   opens a popover with the report count, reasons and reporters.
// - songMenuItems(): the menu items for one song. Add new song actions here
//   (e.g. "Replace with an alternative from YouTube…").
// - bindSongMenu(): context menu on rows of a list.
import { showToast } from './ui.js';
import { bindContextMenu, openContextMenu, closeContextMenu, isContextMenuOpen } from './context-menu.js';

const MAX_REASON = 200;
const PRESET_REASONS = ['Wrong song', 'Bad audio', 'Cut off', 'Too quiet / too loud'];

const store = {
  byId: new Map(),     // song id -> public song (with reports)
  byYoutube: new Map(),
  bySource: new Map(),
  loaded: false,
  timer: null,
  seq: 0,
};
const listeners = new Set();
const resolved = new Map(); // queue url -> song id | null (cache of lookups)

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function youtubeIdFromUrl(url) {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(String(url || ''));
  return m ? m[1] : null;
}

export function onReportsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSongs(songs) {
  store.byId.clear(); store.byYoutube.clear(); store.bySource.clear();
  for (const s of songs) {
    if (!s || !s.report_count) continue;
    store.byId.set(s.id, s);
    if (s.youtube_id) store.byYoutube.set(s.youtube_id, s.id);
    if (s.source_url) store.bySource.set(s.source_url, s.id);
  }
  store.loaded = true;
  listeners.forEach((fn) => { try { fn(); } catch (err) { console.error(err); } });
}

export async function loadReports() {
  const mine = ++store.seq;
  try {
    const res = await fetch('/api/library?reported=1&limit=1000', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (mine !== store.seq) return;
    setSongs(data.songs || []);
  } catch {}
}

// library:updated (any change: upload, replace, delete, reports) -> reload, coalesced.
export function handleReportsUpdated(payload) {
  if (payload && payload.replaced) resolved.clear();
  clearTimeout(store.timer);
  store.timer = setTimeout(loadReports, 150);
}

export function reportsLoaded() {
  return store.loaded;
}

export function reportedCount() {
  return store.byId.size;
}

/** The library song id a queue/player url refers to, if known without asking the server. */
function knownSongId(url) {
  if (!url) return null;
  if (url.startsWith('library:')) return url.slice(8);
  const yt = youtubeIdFromUrl(url);
  if (yt && store.byYoutube.has(yt)) return store.byYoutube.get(yt);
  if (store.bySource.has(url)) return store.bySource.get(url);
  return resolved.get(url) || null;
}

/** Open reports of a song, by song id or by a queue url. */
export function reportsFor({ songId, url } = {}) {
  const id = songId || knownSongId(url);
  const song = id ? store.byId.get(id) : null;
  return song ? song.reports || [] : [];
}

/** Resolve a queue / player url to a library song id (asks the server for YouTube urls). */
export async function resolveSongId({ songId, url } = {}) {
  if (songId) return songId;
  const known = knownSongId(url);
  if (known) return known;
  if (resolved.has(url)) return resolved.get(url);
  const yt = youtubeIdFromUrl(url);
  let id = null;
  if (yt) {
    try {
      const res = await fetch(`/api/library?youtube_id=${encodeURIComponent(yt)}&limit=1`, { credentials: 'same-origin' });
      if (res.ok) { const data = await res.json(); id = data.songs && data.songs[0] ? data.songs[0].id : null; }
    } catch {}
  }
  resolved.set(url, id);
  return id;
}

function relative(value) {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** One line per report: "“wrong song” — Ayşe, 2h ago". */
export function reportLines(reports) {
  return (reports || []).map((r) => `${r.reason ? `“${r.reason}”` : 'No reason given'} — ${r.mine ? 'you' : r.reported_by}, ${relative(r.updated_at || r.created_at)}`);
}

function reportSummary(n) {
  return `Needs replacement — marked as broken by ${n} ${n === 1 ? 'person' : 'people'}`;
}

const WARN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';

/**
 * The small warning icon on a reported song (empty string when there are no
 * reports). A real button: clicking it opens the details popover
 * (bindSongMenu / bindReportIcons wire the click).
 */
export function reportIconHtml(reports) {
  if (!reports || !reports.length) return '';
  const label = `${reportSummary(reports.length)}. Show details`;
  return `<button type="button" class="btn-text theme-warning btn-icon btn-xs song-broken-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="${escapeHtml(label)}" title="${escapeHtml(reportSummary(reports.length))}">${WARN_ICON}</button>`;
}

/** The details popover of a reported song, under its icon. */
export function openReportPopover(anchor, reports) {
  if (!reports || !reports.length) return;
  if (isContextMenuOpen() && anchor.getAttribute('aria-expanded') === 'true') { closeContextMenu(); return; }
  const n = reports.length;
  const items = [{ header: `Needs replacement · ${n} ${n === 1 ? 'report' : 'reports'}` }];
  for (const r of reports) {
    items.push({ text: r.reason || 'No reason given' });
    items.push({ text: `${r.mine ? 'you' : r.reported_by}, ${relative(r.updated_at || r.created_at)}`, muted: true });
  }
  openContextMenu({ anchor }, items, { kind: 'popover', label: reportSummary(n), trigger: anchor });
}

/** Clicks on report icons inside root open the popover. describe(icon) -> reports. */
export function bindReportIcons(root, getReports) {
  if (!root) return;
  root.addEventListener('click', (e) => {
    const icon = e.target.closest('.song-broken-btn');
    if (!icon || !root.contains(icon)) return;
    e.preventDefault();
    e.stopPropagation();
    openReportPopover(icon, getReports(icon));
  });
}

// --- Mark / unmark ---------------------------------------------------------

async function sendReport(songId, reason) {
  const res = await fetch(`/api/library/${encodeURIComponent(songId)}/report`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function unmarkBroken(songId) {
  try {
    const res = await fetch(`/api/library/${encodeURIComponent(songId)}/report`, { method: 'DELETE', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showToast('Unmarked: no longer reported by you', 'success');
    loadReports();
  } catch (err) {
    showToast(`Could not unmark: ${err.message}`, 'error');
  }
}

function closeReportDialog() {
  const d = document.getElementById('report-dialog');
  if (d) {
    const back = d._returnFocus;
    d.remove();
    if (back && document.contains(back)) back.focus({ preventScroll: true });
  }
}

export function isReportDialogOpen() {
  return !!document.getElementById('report-dialog');
}

/** The "Mark as broken" dialog: optional reason (presets or free text). */
export function openReportDialog({ songId, title, artist, current = null, returnFocus = null }) {
  closeReportDialog();
  const dialog = document.createElement('div');
  dialog.id = 'report-dialog';
  dialog.className = 'app-modal report-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'report-title');
  dialog._returnFocus = returnFocus || document.activeElement;
  const editing = !!current;
  dialog.innerHTML = `<form class="card app-modal-card report-form" novalidate>
    <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
      <h2 id="report-title" class="h6 mb-0 text-truncate">${editing ? 'Edit your report' : 'Mark as broken'}</h2>
      <button class="btn-text theme-secondary btn-icon btn-sm report-close" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>
    <div class="card-body vstack gap-4">
      <p class="fs-sm fg-3 mb-0"><span class="fg-2">${escapeHtml(title || 'This song')}${artist ? ` — ${escapeHtml(artist)}` : ''}</span> gets a warning icon for everyone until someone replaces its audio.</p>
      <div>
        <div class="form-label" id="report-presets-label">What is wrong? <span class="fg-3">(optional)</span></div>
        <div class="d-flex flex-wrap gap-2 mb-3" role="group" aria-labelledby="report-presets-label">
          ${PRESET_REASONS.map((r) => `<button type="button" class="btn btn-sm report-preset" data-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
        </div>
        <input class="form-control" id="report-reason" maxlength="${MAX_REASON}" autocomplete="off" placeholder="Or describe it…" aria-label="Reason" aria-describedby="report-count" value="${escapeHtml(current && current.reason ? current.reason : '')}">
        <div class="fs-xs fg-4 text-end mt-1" id="report-count"></div>
      </div>
      <div class="alert theme-danger fs-sm mb-0 report-error" role="alert" hidden></div>
    </div>
    <div class="card-footer d-flex justify-content-end gap-2">
      <button class="btn report-cancel" type="button">Cancel</button>
      <button class="btn-solid theme-primary report-submit" type="submit">${editing ? 'Update' : 'Mark as broken'}</button>
    </div>
  </form>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector('#report-reason');
  const count = dialog.querySelector('#report-count');
  const err = dialog.querySelector('.report-error');
  const syncCount = () => {
    count.textContent = `${input.value.length}/${MAX_REASON}`;
    dialog.querySelectorAll('.report-preset').forEach((b) => {
      const on = b.dataset.reason === input.value.trim();
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };
  syncCount();
  input.addEventListener('input', syncCount);
  dialog.querySelectorAll('.report-preset').forEach((b) => b.addEventListener('click', () => {
    input.value = input.value.trim() === b.dataset.reason ? '' : b.dataset.reason;
    syncCount();
    input.focus();
  }));
  dialog.querySelector('.report-close').addEventListener('click', closeReportDialog);
  dialog.querySelector('.report-cancel').addEventListener('click', closeReportDialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeReportDialog(); });
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeReportDialog(); } });
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const submit = dialog.querySelector('.report-submit');
    submit.disabled = true;
    try {
      await sendReport(songId, input.value.trim());
      closeReportDialog();
      showToast(editing ? 'Report updated' : `Marked “${title || 'song'}” as broken`, 'success');
      loadReports();
    } catch (ex) {
      err.textContent = `Could not mark it: ${ex.message}`;
      err.hidden = false;
      submit.disabled = false;
    }
  });
  input.focus();
}

// --- Menu ------------------------------------------------------------------

const ICONS = {
  broken: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  unmark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
};

/**
 * Menu items for one song. song: { songId?, url?, title, artist }.
 * Resolves the library song first (a playlist entry may be a YouTube url).
 */
export async function songMenuItems(song, { returnFocus = null } = {}) {
  const items = [{ header: song.title || 'Song' }];
  const songId = await resolveSongId(song);
  if (!songId) {
    items.push({ label: 'Not in the library yet', description: 'It can be reported once it is uploaded', disabled: true });
    return items;
  }
  const reports = reportsFor({ songId });
  const mine = reports.find((r) => r.mine);
  const target = { songId, title: song.title, artist: song.artist, returnFocus };
  if (mine) {
    items.push({ label: 'Edit broken report…', icon: ICONS.edit, description: mine.reason || 'No reason given', onSelect: () => openReportDialog({ ...target, current: mine }) });
    items.push({ label: 'Unmark broken', icon: ICONS.unmark, onSelect: () => unmarkBroken(songId) });
  } else {
    items.push({
      label: 'Mark as broken',
      icon: ICONS.broken,
      description: reports.length ? `Already reported by ${reports.length} ${reports.length === 1 ? 'person' : 'people'}` : undefined,
      onSelect: () => openReportDialog(target),
    });
  }
  return items;
}

/**
 * Context menu on a list's song rows. describe(row) -> { songId?, url?, title, artist } | null.
 */
export function bindSongMenu(root, rowSelector, describe) {
  bindReportIcons(root, (icon) => {
    const row = icon.closest(rowSelector);
    const d = row ? describe(row) : null;
    return d ? reportsFor(d) : [];
  });
  bindContextMenu(root, {
    rowSelector,
    triggerSelector: '.song-menu-btn',
    label: (row) => { const d = describe(row); return d && d.title ? `Actions for ${d.title}` : 'Song actions'; },
    getItems: (row) => {
      const d = describe(row);
      return d ? songMenuItems(d, { returnFocus: row.querySelector('.song-menu-btn') || row }) : null;
    },
  });
}

/** The visible "⋮" button that opens a row's menu (keyboard / touch). */
export function songMenuButtonHtml(title, extraClass = '') {
  return `<button class="btn-text theme-secondary btn-icon btn-sm song-menu-btn${extraClass ? ` ${extraClass}` : ''}" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${escapeHtml(title || 'this song')}" title="More actions"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></button>`;
}
