// Playlists (internally "lobbies"): creating, opening, sharing, the landing
// list and the owner controls. The server decides who may see / edit what
// (backend/src/playlistAccess.js); this only mirrors it in the UI.
import { state, elements, socket, STORAGE_KEYS, viewActivators, storageSet, storageRemove, setSuppressJoinToasts, setLobbiesInterval } from './state.js';
import { showView, showToast, escapeHtml, formatAge, copyToClipboard, t, navigateTo } from './ui.js';
import { parseRoute, playlistPath } from './router.js';
import { player } from './player.js';
import { playViewedFromTop } from './playback.js';
import { desiredMembership, membershipActions } from './player-queue.js';
import { isEditMode, setEditMode } from './queue-edit.js';
import { isNewPlaylistPending, newPlaylistCreated, newPlaylistFailed } from './new-playlist.js';
import { playlistMenuItems, privateBadgeHtml, LOCK_SVG } from './playlist-actions.js';
import { openContextMenu, closeContextMenu, bindContextMenu } from './context-menu.js';
import { loadPlaylists, onPlaylists, isPinned, togglePlaylistPin, getPlaylists, isLoaded } from './playlist-store.js';
import { closePickDialog } from './pick-dialog.js';
import { playlistCoverIndex, playlistInitials } from './playlist-filter.js';

// Register landing view activator
viewActivators.landing = () => {
  loadPlaylists();
  setLobbiesInterval(setInterval(loadPlaylists, 10000));
};


const visibilityLabel = (v) => v === 'private' ? t('landing.private', 'Private') : t('landing.public', 'Public');
export const playlistTitle = (name, id) => name || `${t('lobby.playlist', 'Playlist')} ${id}`;

// "by you" / "by <name>" / "shared" (ownerless legacy playlists).
export function ownerText({ isOwner, ownerId, ownerName }) {
  if (isOwner) return t('landing.byYou', 'by you');
  if (!ownerId) return t('landing.noOwner', 'shared');
  return ownerName ? t('landing.byOwner', `by ${ownerName}`, { name: ownerName }) : '';
}

// Header of the playlist page: name, "Private" badge (the current state, not
// an action), owner, and the owner's ⋮ menu (Rename, Make private / public,
// Delete).
function renderPlaylistHeader() {
  elements.lobbyName.textContent = playlistTitle(state.lobbyName, state.lobbyId);
  // The cover of initials, as in the sidebar and on the landing tiles.
  const avatar = document.getElementById('lobby-avatar');
  if (avatar) {
    avatar.className = `playlist-avatar view-avatar cover-${playlistCoverIndex(state.lobbyId)}`;
    avatar.textContent = playlistInitials(playlistTitle(state.lobbyName, state.lobbyId));
  }
  document.title = `${playlistTitle(state.lobbyName, state.lobbyId)} · listen-along`;
  const priv = state.visibility === 'private';
  if (elements.visibilityBadge) {
    elements.visibilityBadge.hidden = !priv;
    elements.visibilityBadge.innerHTML = `${LOCK_SVG.replace('<svg ', '<svg class="icon-sm" ')}${escapeHtml(visibilityLabel('private'))}`;
  }
  if (elements.playlistOwner) {
    const text = ownerText({ isOwner: state.isOwner, ownerId: state.ownerId, ownerName: state.ownerName });
    elements.playlistOwner.textContent = text;
    elements.playlistOwner.hidden = !text;
  }
  if (elements.playlistMenuBtn) elements.playlistMenuBtn.hidden = !state.isOwner;
  if (elements.editQueueBtn) elements.editQueueBtn.hidden = !state.canEdit;
  const addSong = document.querySelector('#queue-tab .add-song');
  if (addSong) addSong.hidden = !state.canEdit;
  if (!state.canEdit && isEditMode()) setEditMode(false);
}

// The playlist page's ⋮ (owner only).
export function openPlaylistHeaderMenu(e) {
  const btn = elements.playlistMenuBtn;
  if (!btn || !state.lobbyId || !state.isOwner) return;
  if (btn.getAttribute('aria-expanded') === 'true') { closeContextMenu(); return; }
  const lobbyId = state.lobbyId;
  const pl = { id: lobbyId, name: state.lobbyName, visibility: state.visibility, canManage: state.isOwner };
  openContextMenu({ anchor: btn }, playlistMenuItems(pl, {
    returnFocus: btn,
    onChanged: (info) => {
      if (!info || info.id !== state.lobbyId) return;
      applyPlaylistMeta(info);
      renderPlaylistHeader();
    },
    onDeleted: () => { if (state.lobbyId === lobbyId) navigateTo('/'); },
  }), { label: t('playlistMenu.label', 'Playlist actions'), trigger: btn, focusFirst: !!e && e.detail === 0 });
}

function applyPlaylistMeta(data) {
  state.lobbyName = data.name || null;
  if (data.visibility) state.visibility = data.visibility;
  if ('ownerId' in data) state.ownerId = data.ownerId || null;
  if ('ownerName' in data) state.ownerName = data.ownerName || null;
  if ('isOwner' in data) state.isOwner = !!data.isOwner;
  if ('canEdit' in data) state.canEdit = !!data.canEdit;
}

function clearPlaylistState() {
  state.isOwner = false;
  state.canEdit = false;
  state.ownerId = null;
  state.ownerName = null;
  state.visibility = 'public';
  state.lobbyName = null;
  state.queue = [];
  state.queueLobbyId = null;
  state.listeners = [];
}

// --- Server-side lobby membership -------------------------------------------
// The socket is a member of the playback-context lobby (or, with nothing
// playing, of the lobby on screen) and only views any other lobby on screen;
// see desiredMembership in player-queue.js. `membership` is what has been
// asked of the server.
const membership = { member: null, viewing: null };

export function getMemberLobby() {
  return membership.member;
}

function emitMembership({ type, lobbyId }) {
  if (type === 'join') socket.emit('lobby:join', { lobbyId, username: state.username, emoji: state.emoji, userId: state.userId });
  else if (type === 'view') socket.emit('lobby:view', { lobbyId, userId: state.userId });
  else if (type === 'unview') socket.emit('lobby:unview', { lobbyId });
  else if (type === 'leave') socket.emit('lobby:leave', { lobbyId });
}

// Bring the server in line with the page on screen and the playback context.
// refresh: the lobby page needs its state (lobby:joined + queue) even when
// the socket is already in that lobby.
export function syncMembership({ refresh = false } = {}) {
  const desired = desiredMembership({ viewedLobbyId: state.lobbyId, contextLobbyId: player.context && player.context.lobbyId });
  const actions = membershipActions(membership, desired);
  actions.forEach(emitMembership);
  membership.member = desired.member;
  membership.viewing = desired.viewing;
  if (refresh && state.lobbyId && !actions.some(a => a.lobbyId === state.lobbyId && (a.type === 'join' || a.type === 'view'))) {
    emitMembership({ type: state.lobbyId === membership.member ? 'join' : 'view', lobbyId: state.lobbyId });
  }
}

// After a reconnect the server knows nothing about this socket.
export function resyncMembership() {
  membership.member = null;
  membership.viewing = null;
  syncMembership({ refresh: true });
}

// Show a lobby page (the view itself appears once lobby:joined arrives).
export function openLobbyPage(lobbyId, resetLobbyPage) {
  hideRejoinPrompt();
  if (state.autoplayLobbyId !== lobbyId) state.autoplayLobbyId = null;
  state.lobbyId = lobbyId;
  clearPlaylistState();
  if (resetLobbyPage) resetLobbyPage();
  syncMembership({ refresh: true });
}

// Leave the lobby page. Playback is not touched; the socket stays in the
// lobby being played from so its queue stays live.
export function closeLobbyPage(resetLobbyPage) {
  state.autoplayLobbyId = null;
  closePickDialog();
  if (!state.lobbyId) return;
  state.lobbyId = null;
  clearPlaylistState();
  document.title = 'listen-along';
  if (resetLobbyPage) resetLobbyPage();
  syncMembership();
}

export function shareLobby() {
  const url = `${window.location.origin}${playlistPath(state.lobbyId)}`;
  const qrUrl = `/api/qr/${state.lobbyId}`;
  const existing = document.getElementById('share-dialog');
  if (existing) existing.remove();
  const dialog = document.createElement('div');
  dialog.id = 'share-dialog';
  dialog.className = 'app-modal share-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'share-title');
  dialog.innerHTML = `<div class="card app-modal-card share-dialog"><div class="card-header d-flex flex-row align-items-center justify-content-between gap-2"><h2 id="share-title" class="h6 mb-0">Share playlist</h2><button class="btn-text theme-secondary btn-icon btn-sm share-close-btn" id="share-close-btn" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div><div class="card-body text-center"><img class="share-qr d-block mx-auto mb-4" src="${escapeHtml(qrUrl)}" alt="QR code for the playlist link" width="200" height="200"><div class="form-control fs-sm text-break user-select-all share-url">${escapeHtml(url)}</div></div><div class="card-footer d-flex justify-content-end gap-2 share-actions">${navigator.share ? '<button class="btn" id="share-native-btn" type="button">Share...</button>' : ''}<button class="btn-solid theme-primary" id="share-copy-btn" type="button">Copy Link</button></div></div>`;
  document.body.appendChild(dialog);
  document.getElementById('share-copy-btn').addEventListener('click', function() { copyToClipboard(url); });
  if (navigator.share) {
    var nativeBtn = document.getElementById('share-native-btn');
    if (nativeBtn) nativeBtn.addEventListener('click', function() { navigator.share({ title: 'Listen to my playlist on listen-along', text: 'Listen to music together with me', url }).catch(function() {}); });
  }
  document.getElementById('share-close-btn').addEventListener('click', function() { dialog.remove(); });
  dialog.addEventListener('click', function(e) { if (e.target === dialog) dialog.remove(); });
  dialog.addEventListener('keydown', function(e) { if (e.key === 'Escape') dialog.remove(); });
  document.getElementById('share-copy-btn').focus();
}

export function handleLobbyCreated(data, updatePinButton) {
  if (data.viewing) membership.viewing = data.lobbyId;
  else { membership.member = data.lobbyId; membership.viewing = null; }
  state.lobbyId = data.lobbyId;
  clearPlaylistState();
  state.listeners = data.users || [];
  applyPlaylistMeta({ ...data, isOwner: true, canEdit: true });
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  newPlaylistCreated();
  pushLobbyUrl(data.lobbyId);
  renderPlaylistHeader();
  updatePinButton();
  showView('lobby');
  syncMembership();
  showToast(data.visibility === 'private' ? 'Private playlist created. Only you can see it.' : 'Playlist created! Share the link to invite friends.', 'success');
}

export function handleLobbyJoined(data, updatePinButton, updateListeners, updateQueue) {
  if (player.context && player.context.lobbyId === data.lobbyId) {
    player.renameContext(data.lobbyId, data.name);
    // A now-playing sent before the join completed was dropped by the server.
    if (!data.viewing) reportNowPlaying();
  }
  if (data.lobbyId !== state.lobbyId) return;
  applyPlaylistMeta(data);
  state.listeners = data.listeners || data.users || [];
  setSuppressJoinToasts(true);
  setTimeout(function() { setSuppressJoinToasts(false); }, 2000);
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  hideRejoinPrompt();
  renderPlaylistHeader();
  updatePinButton();
  showView('lobby');
  updateListeners();
  updateQueue();
}

// Tell the member lobby what this browser is playing.
export function reportNowPlaying() {
  const t = player.track;
  if (!player.context || !t) return;
  socket.emit('listener:now-playing', { lobbyId: player.context.lobbyId, track: { title: t.title, thumbnail: t.thumbnail } });
}

// Missing, deleted, or someone else's private playlist: the server answers
// all of them the same way, and so does the page.
export function handleLobbyNotFound({ lobbyId }) {
  // The join/view did not happen. A failed join leaves the server in the
  // previous member lobby (only possible with nothing playing): leave it.
  if (membership.member === lobbyId) { membership.member = null; socket.emit('lobby:leave', {}); }
  if (membership.viewing === lobbyId) membership.viewing = null;
  if (storageGet_internal(STORAGE_KEYS.LAST_LOBBY) === lobbyId) storageRemove(STORAGE_KEYS.LAST_LOBBY);
  if (state.autoplayLobbyId === lobbyId) state.autoplayLobbyId = null;
  if (lobbyId !== state.lobbyId) return;
  showToast(t('lobby.notFound', 'Playlist not found'), 'error');
  navigateTo('/');
}

export function handleLobbyError(data) {
  if (isNewPlaylistPending()) { newPlaylistFailed(data.message); return; }
  if (data.message && data.message.toLowerCase().includes('not found')) {
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
    hideRejoinPrompt();
  }
  showToast(data.message || 'Playlist error', 'error');
}

export function handleLobbyRenamed(data) {
  player.renameContext(data.lobbyId, data.name);
  if (data.lobbyId !== state.lobbyId) return;
  state.lobbyName = data.name || null;
  renderPlaylistHeader();
  showToast(`Playlist renamed to "${data.name}"`, 'success');
}

// Name / visibility / owner changed (sent to everyone with the playlist open).
export function handleLobbyUpdated(data) {
  if (data.name !== undefined) player.renameContext(data.lobbyId, data.name);
  if (data.lobbyId !== state.lobbyId) return;
  applyPlaylistMeta({ ...data, isOwner: state.isOwner, canEdit: state.canEdit });
  renderPlaylistHeader();
}

// The navbar's pin is the viewer's own pin (same as the sidebar's), not the old
// shared lobby:pin flag, which the web no longer sets or shows.
export function updatePinButton() {
  if (!elements.pinBtn) return;
  const pinned = !!state.lobbyId && isPinned(state.lobbyId);
  const label = pinned ? t('sidebar.unpin', 'Unpin playlist') : t('lobby.pinPlaylist', 'Pin playlist');
  elements.pinBtn.classList.toggle('active', pinned);
  elements.pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  elements.pinBtn.title = label;
  elements.pinBtn.setAttribute('aria-label', label);
}

export function togglePin() {
  if (state.lobbyId) togglePlaylistPin(state.lobbyId, { toast: true });
}

export function handleUserJoined(data, updateListeners) {
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  if (data.users) { state.listeners = data.users; }
  else { state.listeners.push(data.user); }
  updateListeners();
  if (data.user.socketId === socket.id) return;
  // Use imported suppressJoinToasts from state (live binding)
  // We need to re-import it here to get the live binding
  import('./state.js').then(mod => {
    if (mod.suppressJoinToasts) return;
    const joinDisplay = data.user.emoji ? `${data.user.emoji} ${data.user.username}` : data.user.username;
    showToast(`${joinDisplay} joined`, 'success');
  });
}

export function handleUserLeft(data, updateListeners) {
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  if (data.users) state.listeners = data.users;
  else if (data.user) state.listeners = state.listeners.filter(u => u.socketId !== data.user.socketId);
  updateListeners();
}

export function handleLobbyClosed(data, resetLobbyPage) {
  const lobbyId = data.lobbyId || state.lobbyId;
  const wasContext = !!player.context && player.context.lobbyId === lobbyId;
  if (membership.member === lobbyId) membership.member = null;
  if (membership.viewing === lobbyId) membership.viewing = null;
  if (wasContext) player.stop();
  if (lobbyId === state.lobbyId) {
    showToast(data.message || 'This playlist is no longer available.', 'error');
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
    closeLobbyPage(resetLobbyPage);
    navigateTo('/');
  } else {
    if (wasContext) showToast(t('player.contextClosed', 'The playlist you were playing from is no longer available'), 'error');
    syncMembership();
  }
}

// Adds a history entry for the playlist unless the address bar is already on it.
function pushLobbyUrl(lobbyId) {
  if (parseRoute(window.location.pathname).lobbyId === lobbyId) return;
  window.history.pushState({ lobbyId }, '', playlistPath(lobbyId));
}

// "Back to your last playlist?" names the playlist, so look it up first. A
// playlist that is gone (or private to someone else: the API answers 404 for
// both) is forgotten and no prompt is shown.
export function checkForLastLobby() {
  const lastLobby = storageGet_internal(STORAGE_KEYS.LAST_LOBBY);
  if (!lastLobby) return;
  fetch(`/api/playlists/${encodeURIComponent(lastLobby)}`, { credentials: 'same-origin' })
    .then((res) => {
      if (res.status === 404 || res.status === 403) { storageRemove(STORAGE_KEYS.LAST_LOBBY); return null; }
      return res.ok ? res.json() : null;
    })
    .then((info) => {
      if (!info || info.id !== lastLobby) return;
      // The user may have moved on while this was loading.
      if (state.lobbyId || storageGet_internal(STORAGE_KEYS.LAST_LOBBY) !== lastLobby) return;
      if (!elements.landingView || !elements.landingView.classList.contains('active')) return;
      showRejoinPrompt(lastLobby, playlistTitle(info.name, info.id));
    })
    .catch(() => {});
}

// Internal import to avoid circular dependency
function storageGet_internal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function showRejoinPrompt(lobbyId, name) {
  if (document.getElementById('rejoin-prompt')) return;
  const prompt = document.createElement('div');
  prompt.id = 'rejoin-prompt';
  prompt.className = 'toast show rejoin-prompt';
  prompt.setAttribute('role', 'status');
  prompt.innerHTML = `<div class="toast-body"><p class="mb-1 fw-medium">Back to your last playlist?</p><div class="fs-sm fg-3 text-truncate mb-3 rejoin-lobby-name">${escapeHtml(name)}</div><div class="d-flex justify-content-end gap-2 rejoin-actions"><button class="btn btn-sm rejoin-btn" id="rejoin-no" type="button">No thanks</button><button class="btn-solid theme-primary btn-sm rejoin-btn" id="rejoin-yes" type="button">Open</button></div></div>`;
  if (elements.landingView) elements.landingView.appendChild(prompt);
  document.getElementById('rejoin-yes').addEventListener('click', () => {
    hideRejoinPrompt();
    navigateTo(playlistPath(lobbyId));
  });
  document.getElementById('rejoin-no').addEventListener('click', () => {
    hideRejoinPrompt();
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
  });
}

export function hideRejoinPrompt() {
  const prompt = document.getElementById('rejoin-prompt');
  if (prompt) prompt.remove();
}

export function joinLobbyFromCard(lobbyId) {
  navigateTo(playlistPath(lobbyId));
}

// Cache of the most recently rendered lobbies, keyed by id. Owner-control
// handlers look up the (possibly quote-bearing) name here instead of through
// inline onclick args, so user-controlled names never enter HTML attributes.
const lobbyCache = new Map();

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const PIN_ICON = '<svg class="pin-indicator" viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>';
const EQ_HTML = '<span class="person-eq playlist-eq" aria-hidden="true"><i></i><i></i><i></i></span>';
const RADIO_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z"/></svg>';
const LIBRARY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5a2.5 2.5 0 1 1-1-2V5h4v2z"/></svg>';
const ARTIST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

// The playlist the player is playing from right now, or null.
const playingLobbyId = () => (player.isPlaying && player.track && player.context && player.context.type === 'lobby' ? player.context.lobbyId : null);

// The landing page ("Home"): "Your playlists" (everything you own, public and
// private) as tiles, followed by tiles for Radio, the music library and Artists;
// then the Artists shelf (artists.js) and a shelf of cards for other people's
// public playlists (and ownerless shared ones). The server only sends what you
// may see. Your pins first, then newest. Owner controls (visibility, delete)
// only on your own playlists. Tiles and cards are .lobby-card (role="link"):
// click / Enter / Space opens, ⋮ / right-click / long-press is the menu, a
// double-click plays (row-double-click.js).
function renderLobbies(lobbies) {
  if (!elements.lobbiesSection || !elements.lobbiesList || !elements.myPlaylistsList) return;
  lobbyCache.clear();
  for (const l of lobbies) lobbyCache.set(l.id, l);
  const sorted = [...lobbies].sort((a, b) => (b.pinnedByMe - a.pinnedByMe) || (b.createdAt - a.createdAt));
  const mine = sorted.filter(l => l.isOwner);
  const others = sorted.filter(l => !l.isOwner);
  const nowId = playingLobbyId();
  elements.myPlaylistsList.removeAttribute('aria-busy');
  setListHtml(elements.myPlaylistsList, (mine.length ? mine.map(l => tileHtml(l, nowId)).join('') : myPlaylistsEmptyHtml()) + shortcutTilesHtml());
  elements.lobbiesSection.hidden = others.length === 0;
  setListHtml(elements.lobbiesList, others.map(l => cardHtml(l, nowId)).join(''));
  updateLobbiesShelfNav();
}

// Re-render only when the markup changed (the list is polled), and keep
// keyboard focus on the same control of the same playlist.
function setListHtml(list, html) {
  if (list.dataset.html === html) return;
  const active = document.activeElement;
  const row = list.contains(active) ? active.closest('[data-playlist-id]') : null;
  const id = row && row.dataset.playlistId;
  const part = !row ? null : active === row ? '' : ['lobby-quick-play', 'lobby-menu-btn'].find(c => active.classList.contains(c));
  list.innerHTML = html;
  list.dataset.html = html;
  if (id && part != null) {
    const again = list.querySelector(`[data-playlist-id="${CSS.escape(id)}"]`);
    const target = again && (part ? again.querySelector(`.${part}`) || again : again);
    if (target) target.focus({ preventScroll: true });
  }
}

function myPlaylistsEmptyHtml() {
  return `<li class="app-empty lobbies-empty"><p class="fw-medium fg-1 mb-1">${escapeHtml(t('landing.noPlaylists', 'No playlists yet'))}</p>`
    + `<p class="fs-sm fg-3 mb-4">${escapeHtml(t('landing.emptyHint', 'Make one, add songs, and share the link to listen together.'))}</p>`
    + `<button type="button" class="btn lobbies-empty-new" aria-haspopup="dialog" onclick="window.app.newPlaylist(this)">${PLUS_ICON}${escapeHtml(t('landing.newPlaylist', 'New playlist'))}</button></li>`;
}

const songsText = (n) => (n === 1 ? t('sidebar.oneSong', '1 song') : t('sidebar.songs', `${n} songs`, { count: n }));
const listenersText = (n) => `${n} ${n === 1 ? t('lobby.listener', 'listener') : t('lobby.listeners', 'listeners')}`;

// What a tile or card says about a playlist, and its buttons.
function playlistParts(l, nowId) {
  const title = playlistTitle(l.name, l.id);
  const priv = l.visibility === 'private';
  const playing = l.id === nowId;
  const owner = ownerText(l);
  const songs = songsText(l.songCount);
  const listeners = l.userCount ? listenersText(l.userCount) : '';
  // JS string inside an HTML attribute: JSON-encode, then HTML-escape.
  const idArg = escapeHtml(JSON.stringify(l.id));
  const label = [title, priv ? t('landing.private', 'Private') : '', owner, songs, listeners, playing ? t('radio.nowPlaying', 'playing') : ''].filter(Boolean).join(', ');
  const playLabel = playing ? t('landing.pause', `Pause ${title}`, { name: title }) : t('landing.play', `Play ${title}`, { name: title });
  const menuLabel = t('playlistMenu.labelFor', `Actions for ${title}`, { name: title });
  const playBtn = (cls) => (l.songCount > 0 || playing
    ? `<button type="button" class="${cls} lobby-quick-play" title="${escapeHtml(playLabel)}" aria-label="${escapeHtml(playLabel)}" onclick="event.stopPropagation();window.app.toggleLobbyPlayback(${idArg})">${playing ? PAUSE_ICON : PLAY_ICON}</button>` : '');
  const menuBtn = `<button type="button" class="btn-text theme-secondary btn-icon btn-sm lobby-menu-btn" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(menuLabel)}" aria-label="${escapeHtml(menuLabel)}">${MORE_ICON}</button>`;
  const open = `data-playlist-id="${escapeHtml(l.id)}" tabindex="0" role="link" aria-label="${escapeHtml(label)}"`
    + ` onclick="if(!event.target.closest('.lobby-menu-btn'))window.app.joinLobbyFromCard(${idArg})"`
    + ` onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===this){event.preventDefault();window.app.joinLobbyFromCard(${idArg})}"`;
  const avatar = (cls = '') => `<span class="playlist-avatar ${cls} cover-${playlistCoverIndex(l.id)}" aria-hidden="true">${escapeHtml(playlistInitials(title))}</span>`;
  const name = `${l.pinnedByMe ? PIN_ICON : ''}${escapeHtml(title)}`;
  return { title, priv, playing, owner, songs, listeners, playBtn, menuBtn, open, avatar, name };
}

// "Your playlists": a wide, short tile (cover of initials, name, songs and listeners).
function tileHtml(l, nowId) {
  const p = playlistParts(l, nowId);
  const meta = [p.songs, p.listeners].filter(Boolean).join(' · ');
  return `<li class="landing-tile lobby-card${p.priv ? ' is-private' : ''}${p.playing ? ' is-playing' : ''}" ${p.open}>`
    + p.avatar()
    + `<span class="landing-tile-text"><span class="landing-tile-name">${p.name}</span>`
    + `<span class="landing-tile-meta">${p.playing ? EQ_HTML : ''}${p.priv ? privateBadgeHtml('lobby-visibility-badge') : ''}<span class="text-truncate">${escapeHtml(meta)}</span></span></span>`
    + p.playBtn('btn-text theme-secondary btn-icon btn-sm') + p.menuBtn
    + `</li>`;
}

// Other people's public playlists: a card on the shelf.
function cardHtml(l, nowId) {
  const p = playlistParts(l, nowId);
  const meta = [p.owner, p.songs, p.listeners].filter(Boolean).join(' · ');
  return `<li class="playlist-card lobby-card${p.priv ? ' is-private' : ''}${p.playing ? ' is-playing' : ''}" ${p.open}>`
    + `<span class="playlist-card-media">${p.avatar('playlist-card-art')}${p.playBtn('btn btn-icon')}${p.menuBtn}</span>`
    + `<span class="playlist-card-title" title="${escapeHtml(p.title)}">${p.name}</span>`
    + `<span class="playlist-card-meta">${p.playing ? EQ_HTML : ''}<span class="text-truncate">${escapeHtml(meta)}</span></span>`
    + `</li>`;
}

// After your playlists: Radio, Library & Downloads and Artists, as tiles too.
function shortcutTilesHtml() {
  const tile = (href, cover, icon, name, meta, extra = '') => `<li class="landing-tile landing-shortcut">`
    + `<a class="landing-tile-link" href="${href}" data-spa-link><span class="playlist-avatar ${cover}" aria-hidden="true">${icon}</span>`
    + `<span class="landing-tile-text"><span class="landing-tile-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="landing-tile-meta"><span class="text-truncate">${escapeHtml(meta)}</span></span></span></a>${extra}</li>`;
  const radio = t('radio.title', 'Radio');
  const playRadio = t('landing.play', `Play ${radio}`, { name: radio });
  return tile('/radio', 'cover-radio', RADIO_ICON, radio, t('radio.subtitleLoading', 'All songs, shuffled'),
    `<button type="button" class="btn-text theme-secondary btn-icon btn-sm landing-shortcut-play" title="${escapeHtml(playRadio)}" aria-label="${escapeHtml(playRadio)}" onclick="window.app.playRadio()">${PLAY_ICON}</button>`)
    + tile('/library', 'cover-library', LIBRARY_ICON, t('landing.library', 'Library & Downloads'), t('landing.libraryTileMeta', 'Songs, requests and downloads'))
    + tile('/artists', 'cover-artists', ARTIST_ICON, t('artists.title', 'Artists'), t('landing.artistsTileMeta', 'Every artist in the library'));
}

// The public playlists shelf's ‹ ›: only with a mouse and only while the row overflows (CSS + this).
function updateLobbiesShelfNav() {
  const shelf = elements.lobbiesList;
  const prev = document.getElementById('lobbies-shelf-prev');
  const next = document.getElementById('lobbies-shelf-next');
  if (!shelf || !prev || !next) return;
  const overflow = shelf.scrollWidth - shelf.clientWidth > 1;
  prev.hidden = !overflow;
  next.hidden = !overflow;
  prev.disabled = shelf.scrollLeft <= 1;
  next.disabled = shelf.scrollLeft >= shelf.scrollWidth - shelf.clientWidth - 1;
}

function scrollLobbiesShelf(direction) {
  const shelf = elements.lobbiesList;
  const rtl = getComputedStyle(shelf).direction === 'rtl' ? -1 : 1;
  shelf.scrollBy({ left: direction * rtl * Math.max(shelf.clientWidth * 0.8, 160), behavior: 'smooth' });
}

// The tile / card button: pause the playlist playing now, else quick play.
export function toggleLobbyPlayback(lobbyId) {
  if (playingLobbyId() === lobbyId) { player.pause(); return; }
  quickPlayLobby(lobbyId);
}

// Quick play (landing row, ⋮ Play, double-click on a row): the playlist already
// playing just resumes; otherwise open it and start from its first song, now if
// it is on screen with its queue, else once the queue arrives (handleQueueUpdated
// in queue.js).
export function quickPlayLobby(lobbyId) {
  if (player.context && player.context.lobbyId === lobbyId && player.track) {
    if (!player.isPlaying) player.play();
    return;
  }
  if (state.lobbyId === lobbyId && state.queueLobbyId === lobbyId) {
    navigateTo(playlistPath(lobbyId));
    playViewedFromTop();
    return;
  }
  state.autoplayLobbyId = lobbyId;
  navigateTo(playlistPath(lobbyId));
}

// ⋮ menus (and right-click / long-press) on the landing rows: Play, Copy
// link for everyone; Rename, Make private / public, Delete for the owner.
export function setupLandingMenus() {
  onPlaylists(renderLobbies);
  // The playlist playing now: equaliser, accent title, Pause on its button.
  const rerender = () => { if (isLoaded()) renderLobbies(getPlaylists()); };
  for (const event of ['state', 'context', 'track']) player.on(event, rerender);
  window.addEventListener('languageChanged', rerender);
  const shelf = elements.lobbiesList;
  if (shelf) {
    shelf.addEventListener('scroll', updateLobbiesShelfNav, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(updateLobbiesShelfNav).observe(shelf);
  }
  document.getElementById('lobbies-shelf-prev')?.addEventListener('click', () => scrollLobbiesShelf(-1));
  document.getElementById('lobbies-shelf-next')?.addEventListener('click', () => scrollLobbiesShelf(1));
  onPlaylists(updatePinButton);
  window.addEventListener('languageChanged', updatePinButton);
  for (const list of [elements.myPlaylistsList, elements.lobbiesList]) {
    bindContextMenu(list, {
      rowSelector: '.lobby-card',
      triggerSelector: '.lobby-menu-btn',
      label: (row) => { const l = lobbyCache.get(row.dataset.playlistId); return t('playlistMenu.labelFor', `Actions for ${l ? playlistTitle(l.name, l.id) : ''}`, { name: l ? playlistTitle(l.name, l.id) : '' }); },
      getItems: (row) => {
        const id = row.dataset.playlistId;
        const l = lobbyCache.get(id);
        if (!l) return null;
        // Rows re-render every 10s: return focus to the row by id.
        const returnFocus = () => document.querySelector(`.lobby-card[data-playlist-id="${CSS.escape(id)}"] .lobby-menu-btn`);
        return playlistMenuItems(l, {
          returnFocus,
          onPlay: () => quickPlayLobby(id),
          onTogglePin: () => togglePlaylistPin(id),
          onChanged: () => loadPlaylists(),
          onDeleted: () => loadPlaylists(),
        });
      },
    });
  }
}
