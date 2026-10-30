// Playlists (internally "lobbies"): creating, opening, sharing, the landing
// list and the owner controls. The server decides who may see / edit what
// (backend/src/playlistAccess.js); this only mirrors it in the UI.
import { state, elements, socket, STORAGE_KEYS, viewActivators, storageSet, storageRemove, setSuppressJoinToasts, setLobbiesInterval } from './state.js';
import { showView, showToast, escapeHtml, formatAge, copyToClipboard, t, navigateTo } from './ui.js';
import { parseRoute, playlistPath } from './router.js';
import { player } from './player.js';
import { desiredMembership, membershipActions } from './player-queue.js';
import { isEditMode, setEditMode } from './queue-edit.js';
import { isNewPlaylistPending, newPlaylistCreated, newPlaylistFailed } from './new-playlist.js';

// Register landing view activator
viewActivators.landing = () => {
  fetchLobbies();
  setLobbiesInterval(setInterval(fetchLobbies, 10000));
};

const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
const GLOBE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

const visibilityLabel = (v) => v === 'private' ? t('landing.private', 'Private') : t('landing.public', 'Public');
const playlistTitle = (name, id) => name || `${t('lobby.playlist', 'Playlist')} ${id}`;

// "by you" / "by <name>" / "shared" (ownerless legacy playlists).
function ownerText({ isOwner, ownerId, ownerName }) {
  if (isOwner) return t('landing.byYou', 'by you');
  if (!ownerId) return t('landing.noOwner', 'shared');
  return ownerName ? t('landing.byOwner', `by ${ownerName}`, { name: ownerName }) : '';
}

// Header of the playlist page: name, visibility badge, owner, owner-only toggle.
function renderPlaylistHeader() {
  elements.lobbyName.textContent = playlistTitle(state.lobbyName, state.lobbyId);
  document.title = `${playlistTitle(state.lobbyName, state.lobbyId)} · listen-along`;
  const priv = state.visibility === 'private';
  if (elements.visibilityBadge) {
    elements.visibilityBadge.hidden = !priv;
    elements.visibilityBadge.textContent = visibilityLabel('private');
  }
  if (elements.playlistOwner) {
    const text = ownerText({ isOwner: state.isOwner, ownerId: state.ownerId, ownerName: state.ownerName });
    elements.playlistOwner.textContent = text;
    elements.playlistOwner.hidden = !text;
  }
  if (elements.visibilityBtn) {
    elements.visibilityBtn.hidden = !state.isOwner;
    const label = priv ? t('lobby.makePublic', 'Make public') : t('lobby.makePrivate', 'Make private');
    elements.visibilityBtn.innerHTML = priv ? GLOBE_ICON : LOCK_ICON;
    elements.visibilityBtn.setAttribute('aria-label', label);
    elements.visibilityBtn.title = label;
  }
  if (elements.editQueueBtn) elements.editQueueBtn.hidden = !state.canEdit;
  const addSong = document.querySelector('#queue-tab .add-song');
  if (addSong) addSong.hidden = !state.canEdit;
  if (!state.canEdit && isEditMode()) setEditMode(false);
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
  state.pinned = false;
  state.queue = [];
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
  state.lobbyId = lobbyId;
  clearPlaylistState();
  if (resetLobbyPage) resetLobbyPage();
  syncMembership({ refresh: true });
}

// Leave the lobby page. Playback is not touched; the socket stays in the
// lobby being played from so its queue stays live.
export function closeLobbyPage(resetLobbyPage) {
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
  state.pinned = data.pinned || false;
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
  state.pinned = data.pinned || false;
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

export function handleLobbyPinned(data, updatePinButton) {
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  state.pinned = data.pinned;
  updatePinButton();
  showToast(data.pinned ? 'Playlist pinned' : 'Playlist unpinned', 'success');
}

export function updatePinButton() {
  if (!elements.pinBtn) return;
  elements.pinBtn.classList.toggle('active', state.pinned);
  elements.pinBtn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
  elements.pinBtn.title = state.pinned ? 'Unpin playlist' : 'Pin playlist';
}

// Owner-only: switch the open playlist between public and private.
export function toggleCurrentVisibility() {
  if (!state.lobbyId || !state.isOwner) return;
  const next = state.visibility === 'private' ? 'public' : 'private';
  setPlaylistVisibility(state.lobbyId, next).then((info) => {
    if (!info || info.id !== state.lobbyId) return;
    applyPlaylistMeta(info);
    renderPlaylistHeader();
    showToast(next === 'private' ? 'Playlist is now private. Only you can see it.' : 'Playlist is now public.', 'success');
  });
}

export function togglePin() {
  socket.emit('lobby:pin', { lobbyId: state.lobbyId, pinned: !state.pinned });
}

export function promptRenameLobby() {
  const currentName = state.lobbyName || '';
  const newName = prompt('Playlist name:', currentName);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) { showToast('Name cannot be empty', 'error'); return; }
  if (trimmed.length > 50) { showToast('Name must be 50 characters or less', 'error'); return; }
  socket.emit('lobby:rename', { lobbyId: state.lobbyId, name: trimmed });
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

export function fetchLobbies() {
  fetch('/api/playlists', { credentials: 'same-origin' })
    .then(res => res.ok ? res.json() : { playlists: [] })
    .then(data => renderLobbies(data.playlists || []))
    .catch(() => {});
}

// Cache of the most recently rendered lobbies, keyed by id. Owner-control
// handlers look up the (possibly quote-bearing) name here instead of through
// inline onclick args, so user-controlled names never enter HTML attributes.
const lobbyCache = new Map();

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

// The landing page: "Your playlists" (everything you own, public and
// private) first, then other people's public playlists (and ownerless
// shared ones). The server only sends what you may see. Pinned first, then
// newest. Owner controls (visibility, delete) only on your own playlists.
function renderLobbies(lobbies) {
  if (!elements.lobbiesSection || !elements.lobbiesList || !elements.myPlaylistsList) return;
  lobbyCache.clear();
  for (const l of lobbies) lobbyCache.set(l.id, l);
  const sorted = [...lobbies].sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
  const mine = sorted.filter(l => l.isOwner);
  const others = sorted.filter(l => !l.isOwner);
  elements.myPlaylistsList.removeAttribute('aria-busy');
  elements.myPlaylistsList.innerHTML = mine.length ? mine.map(lobbyRowHtml).join('') : myPlaylistsEmptyHtml();
  elements.lobbiesSection.hidden = others.length === 0;
  elements.lobbiesList.innerHTML = others.map(lobbyRowHtml).join('');
}

function myPlaylistsEmptyHtml() {
  return `<li class="list-group-item app-empty lobbies-empty"><p class="fw-medium fg-1 mb-1">${escapeHtml(t('landing.noPlaylists', 'No playlists yet'))}</p>`
    + `<p class="fs-sm fg-3 mb-4">${escapeHtml(t('landing.emptyHint', 'Make one, add songs, and share the link to listen together.'))}</p>`
    + `<button type="button" class="btn lobbies-empty-new" aria-haspopup="dialog" onclick="window.app.newPlaylist(this)">${PLUS_ICON}${escapeHtml(t('landing.newPlaylist', 'New playlist'))}</button></li>`;
}

function lobbyRowHtml(l) {
  const age = formatAge(l.createdAt);
  const title = playlistTitle(l.name, l.id);
  const displayName = escapeHtml(title);
  // JS string inside an HTML attribute: JSON-encode, then HTML-escape.
  const idArg = escapeHtml(JSON.stringify(l.id));
  const priv = l.visibility === 'private';
  const pinIcon = l.pinned ? '<svg class="pin-indicator" viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>' : '';
  const privateBadge = priv
    ? `<span class="badge badge-subtle theme-secondary lobby-visibility-badge private"><svg class="icon-sm" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>${escapeHtml(visibilityLabel('private'))}</span>` : '';
  const owner = ownerText(l);
  const toggleLabel = priv ? t('lobby.makePublic', 'Make public') : t('lobby.makePrivate', 'Make private');
  const deleteLabel = t('lobby.deletePlaylist', 'Delete playlist');
  const playLabel = t('landing.play', `Play ${title}`, { name: title });
  const playBtn = l.songCount > 0
    ? `<button type="button" class="btn-text theme-secondary btn-icon btn-sm lobby-quick-play" title="${escapeHtml(playLabel)}" aria-label="${escapeHtml(playLabel)}" onclick="event.stopPropagation();window.app.quickPlayLobby(${idArg})">${PLAY_ICON}</button>` : '';
  const ownerControls = l.canManage
    ? `<button type="button" class="btn-text theme-secondary btn-icon btn-sm lobby-visibility-toggle" title="${escapeHtml(toggleLabel)}" aria-label="${escapeHtml(toggleLabel)}" onclick="event.stopPropagation();window.app.toggleLobbyVisibility(${idArg}, ${priv ? 'true' : 'false'})">${priv ? GLOBE_ICON : LOCK_ICON}</button>`
      + `<button type="button" class="btn-text theme-danger btn-icon btn-sm lobby-delete-btn" title="${escapeHtml(deleteLabel)}" aria-label="${escapeHtml(deleteLabel)}" onclick="event.stopPropagation();window.app.deleteLobbyCard(${idArg})"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>` : '';
  const controls = playBtn || ownerControls ? `<div class="d-flex gap-1 ms-auto flex-shrink-0 lobby-owner-controls">${playBtn}${ownerControls}</div>` : '';
  return `<li class="list-group-item list-group-item-action lobby-card${priv ? ' is-private' : ''}" data-playlist-id="${escapeHtml(l.id)}" tabindex="0" role="link" onclick="window.app.joinLobbyFromCard(${idArg})" onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===this){event.preventDefault();window.app.joinLobbyFromCard(${idArg})}">`
    + `<div class="d-flex align-items-center gap-2 lobby-card-header"><span class="d-flex align-items-center gap-2 min-w-0 fw-medium lobby-card-id"><span class="text-truncate">${pinIcon}${displayName}</span>${privateBadge}</span>${controls}</div>`
    + `<div class="d-flex flex-wrap align-items-center column-gap-3 fs-sm fg-3 mt-1 lobby-card-stats">`
    + (owner ? `<span class="text-truncate lobby-card-owner">${escapeHtml(owner)}</span>` : '')
    + `<span class="lobby-card-stat" title="Songs"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>${l.songCount}<span class="visually-hidden"> songs</span></span>`
    + `<span class="lobby-card-stat" title="Listeners"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>${l.userCount}<span class="visually-hidden"> listening</span></span>`
    + `<span class="lobby-card-age">${age}</span></div></li>`;
}

// Quick play (landing row): the playlist already playing just resumes;
// otherwise open it and start from its first song once the queue arrives
// (handleQueueUpdated in queue.js).
export function quickPlayLobby(lobbyId) {
  if (player.context && player.context.lobbyId === lobbyId && player.track) {
    if (!player.isPlaying) player.play();
    return;
  }
  state.autoplayLobbyId = lobbyId;
  navigateTo(playlistPath(lobbyId));
}

// PATCH the visibility; resolves with the updated playlist info (or null).
function setPlaylistVisibility(lobbyId, visibility) {
  return fetch(`/api/playlists/${encodeURIComponent(lobbyId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ visibility })
  })
    .then(res => { if (!res.ok) throw new Error('visibility update failed'); return res.json(); })
    .catch(() => { showToast(t('lobbyVisibilityError', 'Failed to update visibility'), 'error'); return null; });
}

// Owner-only: switch a playlist's visibility from its card.
export function toggleLobbyVisibility(lobbyId, makePublic) {
  setPlaylistVisibility(lobbyId, makePublic ? 'public' : 'private').then(() => fetchLobbies());
}

// Owner-only: delete a playlist from its card, with a confirmation naming it.
export function deleteLobbyCard(lobbyId) {
  const cached = lobbyCache.get(lobbyId);
  const label = (cached && cached.name) || lobbyId;
  const prompt = t(
    'confirmDeletePlaylist',
    `Delete playlist "${label}"? It is removed for everyone, permanently.`,
    { name: label }
  );
  if (!confirm(prompt)) return;
  fetch(`/api/playlists/${encodeURIComponent(lobbyId)}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  })
    .then(res => { if (!res.ok) throw new Error('delete failed'); return res.json(); })
    .then(() => { showToast(t('toast.playlistDeleted', 'Playlist deleted'), 'success'); fetchLobbies(); })
    .catch(() => showToast(t('lobbyDeleteError', 'Failed to delete playlist'), 'error'));
}
