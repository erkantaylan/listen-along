// The playlists sidebar ("Your Library"): a fixed left column from 768px, a
// drawer opened from the navbars below that (DESIGN.md "Playlists sidebar").
// The column is expanded or a 72px rail of avatars: the user's choice, else
// automatic by the room left for the page (layout-rules.js).
// The list comes from playlist-store.js, so everything here only navigates,
// pins and filters; the server decides what may be seen.
import { escapeHtml, navigateTo, t, trapFocus } from './ui.js';
import { parseRoute, playlistPath } from './router.js';
import { groupPlaylists, playlistInitials } from './playlist-filter.js';
import { DOCK_MIN, sidebarRail } from './layout-rules.js';
import { storageGet, storageSet } from './state.js';
import { getPlaylist, getPlaylists, isLoaded, loadPlaylists, onPlaylists, togglePlaylistPin } from './playlist-store.js';
import { LOCK_SVG, playlistMenuItems } from './playlist-actions.js';
import { bindContextMenu } from './context-menu.js';
import { ownerText, playlistTitle, quickPlayLobby } from './lobby.js';
import { openNewPlaylistDialog } from './new-playlist.js';

const PIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>';
const MORE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

const POLL_MS = 30000;
const DRAWER_MQ = '(width < 768px)';
const MODE_KEY = 'listen-sidebarMode';

const $ = (id) => document.getElementById(id);
let query = '';
let lastHtml = null;
let drawerReturnFocus = null;

function rowHtml(p, currentId) {
  const title = playlistTitle(p.name, p.id);
  const current = p.id === currentId;
  const pinLabel = p.pinnedByMe
    ? t('sidebar.unpinNamed', `Unpin ${title}`, { name: title })
    : t('sidebar.pinNamed', `Pin ${title}`, { name: title });
  const menuLabel = t('playlistMenu.labelFor', `Actions for ${title}`, { name: title });
  const songs = p.songCount === 1
    ? t('sidebar.oneSong', '1 song')
    : t('sidebar.songs', `${p.songCount} songs`, { count: p.songCount });
  const meta = [ownerText(p), songs].filter(Boolean).join(' · ');
  const privateMark = p.visibility === 'private'
    ? `${LOCK_SVG.replace('<svg ', `<svg class="icon-sm flex-shrink-0" `)}<span class="visually-hidden">${escapeHtml(t('landing.private', 'Private'))}: </span>` : '';
  return `<li class="list-group-item plnav-row${current ? ' is-current' : ''}${p.pinnedByMe ? ' is-pinned' : ''}" data-playlist-id="${escapeHtml(p.id)}">`
    + `<div class="plnav-link" role="link" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml([title, p.visibility === 'private' ? t('landing.private', 'Private') : '', meta].filter(Boolean).join(', '))}"${current ? ' aria-current="page"' : ''}>`
    + `<span class="plnav-avatar" aria-hidden="true">${escapeHtml(playlistInitials(title))}</span>`
    + `<span class="text-truncate plnav-name">${escapeHtml(title)}</span>`
    + `<span class="fs-xs fg-3 plnav-meta">${privateMark}<span class="text-truncate">${escapeHtml(meta)}</span></span>`
    + `</div>`
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-pin${p.pinnedByMe ? ' active' : ''}" aria-pressed="${p.pinnedByMe ? 'true' : 'false'}" aria-label="${escapeHtml(pinLabel)}" title="${escapeHtml(pinLabel)}">${PIN_SVG}</button>`
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(menuLabel)}" title="${escapeHtml(menuLabel)}">${MORE_SVG}</button>`
    + `</li>`;
}

function groupHtml(key, heading, rows, currentId) {
  if (!rows.length) return '';
  const id = `plnav-group-${key}`;
  return `<h3 id="${id}" class="fs-xs fw-semibold fg-3 text-uppercase people-heading">${escapeHtml(heading)}</h3>`
    + `<ul class="list-group list-group-flush plnav-list" aria-labelledby="${id}">${rows.map(p => rowHtml(p, currentId)).join('')}</ul>`;
}

function listHtml(currentId) {
  if (!isLoaded()) return `<p class="fs-sm fg-3 app-empty plnav-empty">${escapeHtml(t('landing.loading', 'Loading…'))}</p>`;
  const all = getPlaylists();
  if (!all.length) {
    return `<div class="app-empty plnav-empty"><p class="fw-medium fg-1 mb-1">${escapeHtml(t('landing.noPlaylists', 'No playlists yet'))}</p>`
      + `<p class="fs-sm fg-3 mb-4">${escapeHtml(t('landing.emptyHint', 'Make one, add songs, and share the link to listen together.'))}</p>`
      + `<button type="button" class="btn plnav-empty-new" aria-haspopup="dialog">${PLUS_SVG}${escapeHtml(t('landing.newPlaylist', 'New playlist'))}</button></div>`;
  }
  const g = groupPlaylists(all, query);
  const count = g.pinned.length + g.mine.length + g.others.length;
  if (!count) {
    return `<div class="app-empty plnav-empty"><p class="fs-sm fg-3 mb-3 text-break">${escapeHtml(t('sidebar.noMatches', `No playlists match “${query}”`, { query }))}</p>`
      + `<button type="button" class="btn btn-sm plnav-empty-clear">${escapeHtml(t('sidebar.clearSearch', 'Clear search'))}</button></div>`;
  }
  return groupHtml('pinned', t('sidebar.pinned', 'Pinned'), g.pinned, currentId)
    + groupHtml('mine', t('landing.yourPlaylists', 'Your playlists'), g.mine, currentId)
    + groupHtml('others', t('landing.publicPlaylists', 'Public playlists'), g.others, currentId);
}

// Re-renders only when something changed: polling must not disturb focus or an
// open menu. Focus follows the control across a re-render (a pinned row moves).
function render() {
  const list = $('plnav-list');
  if (!list) return;
  const currentId = parseRoute(window.location.pathname).lobbyId;
  const html = listHtml(currentId);
  if (html === lastHtml) return;
  const active = document.activeElement;
  const focusedRow = list.contains(active) ? active.closest('.plnav-row') : null;
  const hadFocus = list.contains(active);
  const part = !focusedRow ? null : ['plnav-pin', 'plnav-menu-btn', 'plnav-link'].find(c => active.classList.contains(c));
  const focusedId = focusedRow && focusedRow.dataset.playlistId;
  const scroll = list.scrollTop;
  list.innerHTML = html;
  lastHtml = html;
  list.scrollTop = scroll;
  if (focusedId && part) {
    const el = list.querySelector(`.plnav-row[data-playlist-id="${CSS.escape(focusedId)}"] .${part}`);
    if (el) el.focus({ preventScroll: true });
    else listFallback().focus({ preventScroll: true });
  } else if (hadFocus) {
    listFallback().focus({ preventScroll: true });
  }
  const status = $('plnav-status');
  if (status) {
    const g = groupPlaylists(getPlaylists(), query);
    const n = g.pinned.length + g.mine.length + g.others.length;
    status.textContent = query ? t('sidebar.resultCount', `Playlists found: ${n}`, { count: n }) : '';
  }
}

// Where focus goes when its row is gone; the rail has no search box.
function listFallback() {
  return document.body.classList.contains('plnav-rail') ? $('plnav-new') : $('plnav-search');
}

function setQuery(value) {
  query = value;
  const input = $('plnav-search');
  if (input.value !== value) input.value = value;
  $('plnav-search-clear').hidden = !value;
  render();
}

// ------------------------------------------------------------- rail

let mode = null;

function applyRail() {
  const body = document.body;
  const width = window.innerWidth;
  const chatDocked = body.classList.contains('has-social') && !body.classList.contains('social-collapsed') && width >= DOCK_MIN;
  const rail = sidebarRail({ width, pref: mode, chatDocked });
  body.classList.toggle('plnav-rail', rail);
  const toggle = $('plnav-toggle');
  const label = rail ? t('sidebar.expand', 'Expand playlists') : t('sidebar.collapse', 'Collapse playlists');
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
  toggle.setAttribute('aria-expanded', rail ? 'false' : 'true');
  if (rail && query) setQuery(''); // nowhere to see or clear it
}

function setupRail() {
  const saved = storageGet(MODE_KEY);
  mode = saved === 'rail' || saved === 'expanded' ? saved : null;
  $('plnav-toggle').addEventListener('click', () => {
    mode = document.body.classList.contains('plnav-rail') ? 'expanded' : 'rail';
    storageSet(MODE_KEY, mode);
    applyRail();
  });
  window.addEventListener('resize', applyRail);
  document.addEventListener('app:viewchange', applyRail); // the chat panel opened or closed
  window.addEventListener('languageChanged', applyRail);
  applyRail();
}

// ------------------------------------------------------------- drawer

const isDrawerMode = () => window.matchMedia(DRAWER_MQ).matches;

function setDrawerExpanded(open) {
  document.querySelectorAll('[data-plnav-open]').forEach(b => b.setAttribute('aria-expanded', open ? 'true' : 'false'));
}

function openDrawer(trigger) {
  drawerReturnFocus = trigger || null;
  document.body.classList.add('plnav-open');
  $('plnav-backdrop').hidden = false;
  setDrawerExpanded(true);
  $('plnav-close').focus({ preventScroll: true });
}

export function closeDrawer({ restoreFocus = false } = {}) {
  if (!document.body.classList.contains('plnav-open')) return;
  document.body.classList.remove('plnav-open');
  $('plnav-backdrop').hidden = true;
  setDrawerExpanded(false);
  const back = drawerReturnFocus;
  drawerReturnFocus = null;
  if (restoreFocus && back && document.contains(back)) back.focus({ preventScroll: true });
}

function goTo(id) {
  closeDrawer();
  navigateTo(playlistPath(id));
}

function menuItemsFor(row) {
  const id = row.dataset.playlistId;
  const pl = getPlaylist(id);
  if (!pl) return null;
  const returnFocus = () => document.querySelector(`.plnav-row[data-playlist-id="${CSS.escape(id)}"] .plnav-menu-btn`) || listFallback();
  return playlistMenuItems(pl, {
    returnFocus,
    onPlay: () => { closeDrawer(); quickPlayLobby(id); },
    onTogglePin: () => togglePlaylistPin(id),
    onChanged: () => loadPlaylists(),
    onDeleted: () => {
      loadPlaylists();
      if (parseRoute(window.location.pathname).lobbyId === id) navigateTo('/');
    },
  });
}

export function setupSidebar() {
  document.body.classList.add('has-plnav');
  setupRail();
  onPlaylists(render);
  loadPlaylists();
  setInterval(() => { if (!document.hidden) loadPlaylists(); }, POLL_MS);

  const list = $('plnav-list');
  const search = $('plnav-search');
  search.addEventListener('input', () => setQuery(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
  });
  $('plnav-search-clear').addEventListener('click', () => { setQuery(''); search.focus(); });

  $('plnav-new').addEventListener('click', (e) => { closeDrawer(); openNewPlaylistDialog(isDrawerMode() ? null : e.currentTarget); });
  $('plnav-home').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    closeDrawer();
    navigateTo('/');
  });
  $('plnav-profile').addEventListener('click', () => { closeDrawer(); navigateTo('/profile'); });

  list.addEventListener('click', (e) => {
    if (e.target.closest('.plnav-empty-new')) { closeDrawer(); openNewPlaylistDialog(null); return; }
    if (e.target.closest('.plnav-empty-clear')) { setQuery(''); search.focus(); return; }
    const row = e.target.closest('.plnav-row');
    if (!row) return;
    if (e.target.closest('.plnav-pin')) { togglePlaylistPin(row.dataset.playlistId); return; }
    if (e.target.closest('.plnav-menu-btn')) return;
    goTo(row.dataset.playlistId);
  });
  list.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.classList.contains('plnav-link')) return;
    e.preventDefault();
    goTo(e.target.closest('.plnav-row').dataset.playlistId);
  });
  bindContextMenu(list, {
    rowSelector: '.plnav-row',
    triggerSelector: '.plnav-menu-btn',
    label: (row) => { const p = getPlaylist(row.dataset.playlistId); const name = p ? playlistTitle(p.name, p.id) : ''; return t('playlistMenu.labelFor', `Actions for ${name}`, { name }); },
    getItems: menuItemsFor,
  });

  // Drawer (below 768px).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plnav-open]');
    if (btn) openDrawer(btn);
  });
  $('plnav-close').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  $('plnav-backdrop').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  $('app-sidebar').addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('plnav-open')) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeDrawer({ restoreFocus: true }); return; }
    trapFocus($('app-sidebar'), e);
  });
  window.matchMedia(DRAWER_MQ).addEventListener('change', () => closeDrawer());

  // The current row follows the address bar; any navigation closes the drawer.
  window.addEventListener('popstate', () => { closeDrawer(); render(); });
  document.addEventListener('app:viewchange', render);
  window.addEventListener('languageChanged', () => { lastHtml = null; render(); });
}
