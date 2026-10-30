// Lobby creation, joining, leaving, sharing, and related handlers
import { state, elements, socket, STORAGE_KEYS, viewActivators, storageSet, storageRemove, setSuppressJoinToasts, setLobbiesInterval } from './state.js';
import { showView, showToast, escapeHtml, formatAge, copyToClipboard, t } from './ui.js';
import { parseRoute } from './router.js';

// Register landing view activator
viewActivators.landing = () => {
  fetchLobbies();
  setLobbiesInterval(setInterval(fetchLobbies, 10000));
};

export function createLobby() {
  elements.createLobbyBtn.disabled = true;
  elements.createLobbyBtn.textContent = 'Creating...';
  const name = elements.lobbyNameInput ? elements.lobbyNameInput.value.trim() : '';
  socket.emit('lobby:create', { username: state.username, emoji: state.emoji, name: name || undefined, userId: state.userId });
}

export function joinLobby(lobbyId) {
  socket.emit('lobby:join', { lobbyId, username: state.username, emoji: state.emoji, userId: state.userId });
}

// updateUrl: false when the address bar already moved (Back/Forward).
export function leaveLobby(resetLobbyUI, resetChat, { updateUrl = true } = {}) {
  socket.emit('lobby:leave', { lobbyId: state.lobbyId });
  storageRemove(STORAGE_KEYS.LAST_LOBBY);
  hideRejoinPrompt();
  state.lobbyId = null;
  state.isHost = false;
  state.lobbyName = null;
  state.pinned = false;
  state.queue = [];
  state.listeners = [];
  state.currentTrack = null;
  state.downloadStatus = {};
  elements.audioPlayer.pause();
  elements.audioPlayer.src = '';
  if (updateUrl) window.history.pushState({}, '', '/');
  showView('landing');
  resetLobbyUI();
  resetChat();
}

export function shareLobby() {
  const url = window.location.href;
  const qrUrl = `/api/qr/${state.lobbyId}`;
  const existing = document.getElementById('share-dialog');
  if (existing) existing.remove();
  const dialog = document.createElement('div');
  dialog.id = 'share-dialog';
  dialog.className = 'app-modal share-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'share-title');
  dialog.innerHTML = `<div class="card app-modal-card share-dialog"><div class="card-header d-flex flex-row align-items-center justify-content-between gap-2"><h2 id="share-title" class="h6 mb-0">Share Lobby</h2><button class="btn-text theme-secondary btn-icon btn-sm share-close-btn" id="share-close-btn" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div><div class="card-body text-center"><img class="share-qr d-block mx-auto mb-4" src="${escapeHtml(qrUrl)}" alt="QR code for the lobby link" width="200" height="200"><div class="form-control fs-sm text-break user-select-all share-url">${escapeHtml(url)}</div></div><div class="card-footer d-flex justify-content-end gap-2 share-actions">${navigator.share ? '<button class="btn" id="share-native-btn" type="button">Share...</button>' : ''}<button class="btn-solid theme-primary" id="share-copy-btn" type="button">Copy Link</button></div></div>`;
  document.body.appendChild(dialog);
  document.getElementById('share-copy-btn').addEventListener('click', function() { copyToClipboard(url); });
  if (navigator.share) {
    var nativeBtn = document.getElementById('share-native-btn');
    if (nativeBtn) nativeBtn.addEventListener('click', function() { navigator.share({ title: 'Join my listen-along lobby!', text: 'Listen to music together with me', url }).catch(function() {}); });
  }
  document.getElementById('share-close-btn').addEventListener('click', function() { dialog.remove(); });
  dialog.addEventListener('click', function(e) { if (e.target === dialog) dialog.remove(); });
  dialog.addEventListener('keydown', function(e) { if (e.key === 'Escape') dialog.remove(); });
  document.getElementById('share-copy-btn').focus();
}

export function handleLobbyCreated(data, requestChatHistory, updatePinButton) {
  state.lobbyId = data.lobbyId;
  state.isHost = true;
  state.lobbyName = data.name || null;
  state.pinned = data.pinned || false;
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  elements.createLobbyBtn.disabled = false;
  elements.createLobbyBtn.textContent = 'Create Lobby';
  if (elements.lobbyNameInput) elements.lobbyNameInput.value = '';
  pushLobbyUrl(data.lobbyId);
  elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
  updatePinButton();
  showView('lobby');
  requestChatHistory();
  showToast('Lobby created! Share the link to invite friends.', 'success');
}

export function handleLobbyJoined(data, requestChatHistory, updatePinButton, updateListeners, updateQueue) {
  state.lobbyId = data.lobbyId;
  state.isHost = data.isHost || false;
  state.lobbyName = data.name || null;
  state.pinned = data.pinned || false;
  state.queue = data.queue || [];
  state.listeners = data.listeners || data.users || [];
  setSuppressJoinToasts(true);
  setTimeout(function() { setSuppressJoinToasts(false); }, 2000);
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  hideRejoinPrompt();
  elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
  updatePinButton();
  showView('lobby');
  updateListeners();
  updateQueue();
  requestChatHistory();
}

export function handleLobbyNotFound({ lobbyId }) {
  state.pendingLobbyId = lobbyId;
  if (elements.roomTypeLobbyName) elements.roomTypeLobbyName.textContent = lobbyId;
  if (elements.roomTypeModal) elements.roomTypeModal.hidden = false;
}

export function handleLobbyError(data) {
  elements.createLobbyBtn.disabled = false;
  elements.createLobbyBtn.textContent = 'Create Lobby';
  if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
  state.pendingLobbyId = null;
  if (data.message && data.message.toLowerCase().includes('not found')) {
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
    hideRejoinPrompt();
  }
  showToast(data.message || 'Lobby error', 'error');
}

export function handleLobbyRenamed(data) {
  state.lobbyName = data.name || null;
  elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
  showToast(`Lobby renamed to "${data.name}"`, 'success');
}

export function handleLobbyPinned(data, updatePinButton) {
  state.pinned = data.pinned;
  updatePinButton();
  showToast(data.pinned ? 'Lobby pinned — it won\'t be removed' : 'Lobby unpinned', 'success');
}

export function updatePinButton() {
  if (!elements.pinBtn) return;
  elements.pinBtn.classList.toggle('active', state.pinned);
  elements.pinBtn.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
  elements.pinBtn.title = state.pinned ? 'Unpin lobby (allow cleanup)' : 'Pin lobby (prevent cleanup)';
}

export function togglePin() {
  socket.emit('lobby:pin', { lobbyId: state.lobbyId, pinned: !state.pinned });
}

export function promptRenameLobby() {
  const currentName = state.lobbyName || '';
  const newName = prompt('Enter new lobby name:', currentName);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) { showToast('Name cannot be empty', 'error'); return; }
  if (trimmed.length > 50) { showToast('Name must be 50 characters or less', 'error'); return; }
  socket.emit('lobby:rename', { lobbyId: state.lobbyId, name: trimmed });
}

export function handleUserJoined(data, updateListeners) {
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
  state.listeners = state.listeners.filter(u => u.id !== data.userId);
  updateListeners();
}

export function handleLobbyClosed(data, resetLobbyUI) {
  showToast(data.message || 'This lobby has been closed.', 'error');
  storageRemove(STORAGE_KEYS.LAST_LOBBY);
  state.lobbyId = null;
  state.isHost = false;
  state.queue = [];
  state.listeners = [];
  state.currentTrack = null;
  elements.audioPlayer.pause();
  elements.audioPlayer.src = '';
  window.history.pushState({}, '', '/');
  showView('landing');
  resetLobbyUI();
}

// Adds a history entry for the lobby unless the address bar is already on it
// (e.g. /lobby/<id> was opened directly and the lobby was created from there).
function pushLobbyUrl(lobbyId) {
  if (parseRoute(window.location.pathname).lobbyId === lobbyId) return;
  window.history.pushState({ lobbyId }, '', `/lobby/${lobbyId}`);
}

export function checkForLastLobby() {
  const lastLobby = storageGet_internal(STORAGE_KEYS.LAST_LOBBY);
  if (!lastLobby) return;
  showRejoinPrompt(lastLobby);
}

// Internal import to avoid circular dependency
function storageGet_internal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function showRejoinPrompt(lobbyId) {
  if (document.getElementById('rejoin-prompt')) return;
  const prompt = document.createElement('div');
  prompt.id = 'rejoin-prompt';
  prompt.className = 'toast show rejoin-prompt';
  prompt.setAttribute('role', 'status');
  prompt.innerHTML = `<div class="toast-body"><p class="mb-1 fw-medium">Rejoin your last lobby?</p><div class="fs-sm fg-3 text-truncate mb-3 rejoin-lobby-id">${escapeHtml(lobbyId)}</div><div class="d-flex justify-content-end gap-2 rejoin-actions"><button class="btn btn-sm rejoin-btn" id="rejoin-no" type="button">No thanks</button><button class="btn-solid theme-primary btn-sm rejoin-btn" id="rejoin-yes" type="button">Rejoin</button></div></div>`;
  if (elements.landingView) elements.landingView.appendChild(prompt);
  document.getElementById('rejoin-yes').addEventListener('click', () => {
    hideRejoinPrompt();
    pushLobbyUrl(lobbyId);
    state.lobbyId = lobbyId;
    joinLobby(lobbyId);
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
  pushLobbyUrl(lobbyId);
  state.lobbyId = lobbyId;
  joinLobby(lobbyId);
}

export function fetchLobbies() {
  fetch('/api/lobbies').then(res => res.json()).then(data => renderLobbies(data.lobbies || [])).catch(() => {});
}

// Cache of the most recently rendered lobbies, keyed by id. Owner-control
// handlers look up the (possibly quote-bearing) name here instead of through
// inline onclick args, so user-controlled names never enter HTML attributes.
const lobbyCache = new Map();

function renderLobbies(lobbies) {
  if (!elements.lobbiesSection || !elements.lobbiesList) return;
  lobbyCache.clear();
  for (const l of lobbies) lobbyCache.set(l.id, l);
  if (lobbies.length === 0) { elements.lobbiesSection.hidden = true; return; }
  elements.lobbiesSection.hidden = false;
  elements.lobbiesList.innerHTML = lobbies.map(l => {
    const age = formatAge(l.createdAt);
    const displayName = l.name ? escapeHtml(l.name) : escapeHtml(l.id);
    // JS string inside an HTML attribute: JSON-encode, then HTML-escape.
    const idArg = escapeHtml(JSON.stringify(l.id));
    const pinIcon = l.pinned ? '<svg class="pin-indicator" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>' : '';
    // Owner-only controls: visibility toggle + delete. Non-owners never see these
    // and never see other people's private lobbies (filtered server-side).
    const privateBadge = (l.isOwner && !l.isPublic)
      ? '<span class="badge badge-subtle theme-secondary lobby-visibility-badge private">Private</span>' : '';
    const ownerControls = l.isOwner ? `<div class="d-flex gap-1 ms-auto lobby-owner-controls">`
      + `<button type="button" class="btn btn-xs lobby-visibility-toggle" title="${l.isPublic ? 'Make private' : 'Make public'}" onclick="event.stopPropagation();window.app.toggleLobbyVisibility(${idArg}, ${l.isPublic ? 'false' : 'true'})">${l.isPublic ? 'Public' : 'Private'}</button>`
      + `<button type="button" class="btn-text theme-danger btn-icon btn-xs lobby-delete-btn" title="Delete lobby" aria-label="Delete lobby" onclick="event.stopPropagation();window.app.deleteLobbyCard(${idArg})">✕</button>`
      + `</div>` : '';
    return `<li class="list-group-item list-group-item-action lobby-card" tabindex="0" role="button" onclick="window.app.joinLobbyFromCard(${idArg})" onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===this){event.preventDefault();window.app.joinLobbyFromCard(${idArg})}"><div class="d-flex align-items-center justify-content-between gap-2 lobby-card-header"><span class="d-flex align-items-center gap-2 min-w-0 fw-medium lobby-card-id"><span class="text-truncate">${pinIcon}${displayName}</span>${privateBadge}</span></div><div class="d-flex align-items-center gap-3 fs-sm fg-3 mt-1 lobby-card-stats"><span class="lobby-card-stat"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>${l.userCount}</span><span class="lobby-card-stat"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>${l.songCount}</span><span class="lobby-card-age">${age}</span>${ownerControls}</div></li>`;
  }).join('');
}

// Owner-only: toggle a lobby's public/private visibility from its card.
export function toggleLobbyVisibility(lobbyId, makePublic) {
  fetch(`/api/lobbies/${encodeURIComponent(lobbyId)}/visibility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ is_public: makePublic })
  })
    .then(res => { if (!res.ok) throw new Error('visibility update failed'); return res.json(); })
    .then(() => fetchLobbies())
    .catch(() => showToast(t('lobbyVisibilityError', 'Failed to update visibility')));
}

// Owner-only: delete a lobby from its card, with a confirmation naming the lobby.
export function deleteLobbyCard(lobbyId) {
  const cached = lobbyCache.get(lobbyId);
  const label = (cached && cached.name) || lobbyId;
  const prompt = t(
    'confirmDeleteLobby',
    `Delete lobby "${label}"? This disconnects everyone and removes it permanently.`,
    { name: label }
  );
  if (!confirm(prompt)) return;
  fetch(`/api/lobbies/${encodeURIComponent(lobbyId)}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  })
    .then(res => { if (!res.ok) throw new Error('delete failed'); return res.json(); })
    .then(() => { showToast(t('lobbyDeleted', 'Lobby deleted')); fetchLobbies(); })
    .catch(() => showToast(t('lobbyDeleteError', 'Failed to delete lobby')));
}
