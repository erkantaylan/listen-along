// Lobby creation, joining, leaving, sharing, and related handlers
import { state, elements, socket, STORAGE_KEYS, viewActivators, storageSet, storageRemove, setSuppressJoinToasts, setLobbiesInterval } from './state.js';
import { showView, showToast, escapeHtml, formatAge, copyToClipboard, t } from './ui.js';

// Register landing view activator
viewActivators.landing = () => {
  fetchLobbies();
  setLobbiesInterval(setInterval(fetchLobbies, 10000));
};

export function createLobby() {
  elements.createLobbyBtn.disabled = true;
  elements.createLobbyBtn.textContent = 'Creating...';
  const selectedMode = document.querySelector('input[name="listeningMode"]:checked');
  const listeningMode = selectedMode ? selectedMode.value : 'synchronized';
  const name = elements.lobbyNameInput ? elements.lobbyNameInput.value.trim() : '';
  socket.emit('lobby:create', { username: state.username, emoji: state.emoji, listeningMode, name: name || undefined, userId: state.userId });
}

export function joinLobby(lobbyId) {
  socket.emit('lobby:join', { lobbyId, username: state.username, emoji: state.emoji, userId: state.userId });
}

export function leaveLobby(resetLobbyUI, resetChat) {
  socket.emit('lobby:leave', { lobbyId: state.lobbyId });
  storageRemove(STORAGE_KEYS.LAST_LOBBY);
  hideRejoinPrompt();
  state.lobbyId = null;
  state.isHost = false;
  state.lobbyName = null;
  state.listeningMode = 'synchronized';
  state.pinned = false;
  state.queue = [];
  state.listeners = [];
  state.currentTrack = null;
  state.downloadStatus = {};
  state.queueCurrentIndex = -1;
  elements.audioPlayer.pause();
  elements.audioPlayer.src = '';
  window.history.pushState({}, '', '/');
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
  dialog.className = 'share-overlay';
  dialog.innerHTML = `<div class="share-dialog"><h3>Share Lobby</h3><img class="share-qr" src="${qrUrl}" alt="QR Code" width="200" height="200"><div class="share-url">${escapeHtml(url)}</div><div class="share-actions"><button class="btn btn-primary" id="share-copy-btn">Copy Link</button>${navigator.share ? '<button class="btn" id="share-native-btn">Share...</button>' : ''}</div><button class="btn-icon share-close-btn" id="share-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div>`;
  document.body.appendChild(dialog);
  document.getElementById('share-copy-btn').addEventListener('click', function() { copyToClipboard(url); });
  if (navigator.share) {
    var nativeBtn = document.getElementById('share-native-btn');
    if (nativeBtn) nativeBtn.addEventListener('click', function() { navigator.share({ title: 'Join my listen-along lobby!', text: 'Listen to music together with me', url }).catch(function() {}); });
  }
  document.getElementById('share-close-btn').addEventListener('click', function() { dialog.remove(); });
  dialog.addEventListener('click', function(e) { if (e.target === dialog) dialog.remove(); });
}

export function handleLobbyCreated(data, requestChatHistory, updateListeningModeBadge, updatePinButton) {
  state.lobbyId = data.lobbyId;
  state.isHost = true;
  state.listeningMode = data.listeningMode || 'synchronized';
  state.lobbyName = data.name || null;
  state.pinned = data.pinned || false;
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  elements.createLobbyBtn.disabled = false;
  elements.createLobbyBtn.textContent = 'Create Lobby';
  if (elements.lobbyNameInput) elements.lobbyNameInput.value = '';
  window.history.pushState({ lobbyId: data.lobbyId }, '', `/lobby/${data.lobbyId}`);
  elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
  updateListeningModeBadge();
  updatePinButton();
  showView('lobby');
  requestChatHistory();
  showToast('Lobby created! Share the link to invite friends.', 'success');
}

export function handleLobbyJoined(data, requestChatHistory, updateListeningModeBadge, updatePinButton, updateListeners, updateQueue, updateNowPlaying, handlePlaybackSync) {
  state.lobbyId = data.lobbyId;
  state.isHost = data.isHost || false;
  state.listeningMode = data.listeningMode || 'synchronized';
  state.lobbyName = data.name || null;
  state.pinned = data.pinned || false;
  state.queue = data.queue || [];
  state.listeners = data.listeners || data.users || [];
  state.currentTrack = data.currentTrack || null;
  setSuppressJoinToasts(true);
  setTimeout(function() { setSuppressJoinToasts(false); }, 2000);
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  hideRejoinPrompt();
  elements.lobbyName.textContent = data.name || `Lobby ${data.lobbyId}`;
  updateListeningModeBadge();
  updatePinButton();
  showView('lobby');
  updateListeners();
  updateQueue();
  requestChatHistory();
  if (state.currentTrack) {
    updateNowPlaying(state.currentTrack);
    if (data.playbackState) handlePlaybackSync(data.playbackState);
  }
}

export function handleLobbyNotFound({ lobbyId }) {
  state.pendingLobbyId = lobbyId;
  if (elements.roomTypeLobbyName) elements.roomTypeLobbyName.textContent = lobbyId;
  const modalOptions = document.querySelectorAll('#room-type-modal .lobby-type-option');
  modalOptions.forEach(opt => {
    const isSync = opt.dataset.mode === 'synchronized';
    opt.classList.toggle('selected', isSync);
    const radio = opt.querySelector('input[type="radio"]');
    if (radio) radio.checked = isSync;
  });
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

export function checkUrlForLobby() {
  const path = window.location.pathname;
  const match = path.match(/^\/lobby\/([a-zA-Z0-9-]+)$/);
  if (match) { state.lobbyId = match[1]; joinLobby(match[1]); }
  else { checkForLastLobby(); }
}

function checkForLastLobby() {
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
  prompt.className = 'rejoin-prompt';
  prompt.innerHTML = `<div class="rejoin-content"><p>Rejoin your last lobby?</p><div class="rejoin-lobby-id">${escapeHtml(lobbyId)}</div><div class="rejoin-actions"><button class="btn rejoin-btn" id="rejoin-yes">Rejoin</button><button class="btn btn-secondary rejoin-btn" id="rejoin-no">No thanks</button></div></div>`;
  if (elements.landingView) elements.landingView.appendChild(prompt);
  document.getElementById('rejoin-yes').addEventListener('click', () => {
    hideRejoinPrompt();
    window.history.pushState({ lobbyId }, '', `/lobby/${lobbyId}`);
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
  window.history.pushState({ lobbyId }, '', `/lobby/${lobbyId}`);
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
    const modeLabel = l.listeningMode === 'independent' ? 'Independent' : 'Jam';
    const modeClass = l.listeningMode === 'independent' ? 'independent' : 'synchronized';
    const age = formatAge(l.createdAt);
    const displayName = l.name ? escapeHtml(l.name) : escapeHtml(l.id);
    const idArg = escapeHtml(l.id);
    const pinIcon = l.pinned ? '<svg class="pin-indicator" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>' : '';
    // Owner-only controls: visibility toggle + delete. Non-owners never see these
    // and never see other people's private lobbies (filtered server-side).
    const privateBadge = (l.isOwner && !l.isPublic)
      ? '<span class="lobby-visibility-badge private">Private</span>' : '';
    const ownerControls = l.isOwner ? `<div class="lobby-owner-controls">`
      + `<button type="button" class="lobby-visibility-toggle" title="${l.isPublic ? 'Make private' : 'Make public'}" onclick="event.stopPropagation();window.app.toggleLobbyVisibility('${idArg}', ${l.isPublic ? 'false' : 'true'})">${l.isPublic ? 'Public' : 'Private'}</button>`
      + `<button type="button" class="lobby-delete-btn" title="Delete lobby" onclick="event.stopPropagation();window.app.deleteLobbyCard('${idArg}')">✕</button>`
      + `</div>` : '';
    return `<li class="lobby-card" onclick="window.app.joinLobbyFromCard('${idArg}')"><div class="lobby-card-header"><span class="lobby-card-id">${pinIcon}${displayName}${privateBadge}</span><span class="listening-mode-badge ${modeClass}">${modeLabel}</span></div><div class="lobby-card-stats"><span class="lobby-card-stat"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>${l.userCount}</span><span class="lobby-card-stat"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>${l.songCount}</span><span class="lobby-card-age">${age}</span>${ownerControls}</div></li>`;
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
