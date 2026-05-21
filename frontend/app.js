// Listen-Along Frontend — Entry point and orchestrator
import { state, elements, auth, socket, STORAGE_KEYS, viewActivators, setSocket, storageSet } from './state.js';
import { showView, showToast, switchTab, setupLanguageSelector, fetchVersion, t } from './ui.js';
import { setupAudioPlayer, setupMediaSession, playAudioWithUnlock } from './audio.js';
import { checkAuth, setupLoginView, showPendingCard, setupProfileEditor, setupProfilePage, loadProfilePage } from './auth.js';
import { checkUrlForDashboard, dashboardJoinLobby, dashboardRemoveLobby, deleteCachedSong, playCachedSong, dashboardApproveUser, dashboardRejectUser } from './dashboard.js';
import { createLobby, joinLobby, leaveLobby, shareLobby, handleLobbyCreated, handleLobbyJoined, handleLobbyNotFound, handleLobbyError, handleLobbyRenamed, handleLobbyPinned, handleUserJoined, handleUserLeft, handleLobbyClosed, checkUrlForLobby, joinLobbyFromCard, updatePinButton, togglePin, promptRenameLobby, toggleLobbyVisibility, deleteLobbyCard } from './lobby.js';
import { handlePlaybackState, handlePlaybackSync, handleTrackChanged, handleShuffleState, handleDownloadStatus, handleDownloadProgress, handleModeChanged, handleUsersUpdated, handleFollowSync, toggleUserMode, cycleRepeatMode, toggleShuffle, togglePlayback, playPrevious, playNext, seekTo, advanceLocalQueue, updateNowPlaying, updatePlayButton, updatePlaybackModeUI, updateListeningModeBadge, updateModeButton, _setQueueFns } from './playback.js';
import { handleQueueUpdated, handleSongAdded, addSong, removeSong, clearQueue, moveSongUp, moveSongDown, playSongAt, setupQueueDragAndDrop, setupQueueSearch, showLibraryDialog, updateQueue, updateListeners, resetLobbyUI, openSource, copySourceUrl } from './queue.js';
import { toggleSongMention, clearSongMention, sendChatMessage, handleChatMessage, handleChatHistory, requestChatHistory, resetChat } from './chat.js';

// Wire up cross-module dependencies
_setQueueFns(updateQueue, updateListeners);

// Register profile view activator
viewActivators.profile = () => { loadProfilePage(); };

// Socket.IO Setup
function setupSocket() {
  setSocket(io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 }));

  // We need to re-import socket after setSocket to get the live binding
  import('./state.js').then(mod => {
    const s = mod.socket;

    s.on('connect', () => { console.log('Connected to server'); if (state.lobbyId) joinLobby(state.lobbyId); });
    s.on('disconnect', () => { console.log('Disconnected from server'); showToast(t('toast.connectionLost', 'Connection lost. Reconnecting...'), 'error'); });
    s.on('reconnect', () => { console.log('Reconnected to server'); showToast(t('toast.reconnected', 'Reconnected!'), 'success'); if (state.lobbyId) joinLobby(state.lobbyId); });

    // Lobby Events
    s.on('lobby:created', (data) => handleLobbyCreated(data, requestChatHistory, updateListeningModeBadge, updatePinButton));
    s.on('lobby:joined', (data) => handleLobbyJoined(data, requestChatHistory, updateListeningModeBadge, updatePinButton, updateListeners, updateQueue, updateNowPlaying, handlePlaybackSync));
    s.on('lobby:not-found', handleLobbyNotFound);
    s.on('lobby:error', handleLobbyError);
    s.on('lobby:user-joined', (data) => handleUserJoined(data, updateListeners));
    s.on('lobby:user-left', (data) => handleUserLeft(data, updateListeners));
    s.on('lobby:closed', (data) => handleLobbyClosed(data, resetLobbyUI));
    s.on('lobby:renamed', handleLobbyRenamed);
    s.on('lobby:pinned', (data) => handleLobbyPinned(data, updatePinButton));

    // Queue Events
    s.on('queue:update', handleQueueUpdated);
    s.on('queue:song-added', handleSongAdded);
    s.on('queue:error', (data) => showToast(data.message, 'error'));
    s.on('queue:adding', (data) => showToast(data.status, 'info'));

    // Playback Events
    s.on('playback:state', handlePlaybackState);
    s.on('playback:sync', handlePlaybackSync);
    s.on('playback:track-changed', handleTrackChanged);
    s.on('playback:shuffle', handleShuffleState);

    // Download Events
    s.on('download:status', handleDownloadStatus);
    s.on('download:progress', handleDownloadProgress);

    // Mode Events
    s.on('mode:changed', handleModeChanged);
    s.on('users:updated', handleUsersUpdated);

    // Chat Events
    s.on('chat:message', handleChatMessage);
    s.on('chat:history', handleChatHistory);
    s.on('chat:error', (data) => showToast(data.message, 'error'));

    // Follow Events
    s.on('follow:sync', handleFollowSync);
    s.on('follow:error', (data) => showToast(data.message, 'error'));
  });
}

// Event Listeners Setup
function setupEventListeners() {
  elements.createLobbyBtn.addEventListener('click', createLobby);

  document.querySelectorAll('.lobby-type-selector').forEach(selector => {
    selector.querySelectorAll('.lobby-type-option').forEach(option => {
      option.addEventListener('click', () => {
        selector.querySelectorAll('.lobby-type-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
      });
    });
  });

  if (elements.roomTypeCreateBtn) {
    elements.roomTypeCreateBtn.addEventListener('click', () => {
      const selectedMode = document.querySelector('#room-type-modal input[name="roomTypeMode"]:checked');
      const listeningMode = selectedMode ? selectedMode.value : 'synchronized';
      if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
      import('./state.js').then(mod => {
        mod.socket.emit('lobby:create', { username: state.username, emoji: state.emoji, listeningMode, lobbyId: state.pendingLobbyId, userId: state.userId });
      });
      state.pendingLobbyId = null;
    });
  }
  if (elements.roomTypeCancelBtn) {
    elements.roomTypeCancelBtn.addEventListener('click', () => {
      if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
      state.pendingLobbyId = null;
      window.history.pushState({}, '', '/');
      showView('landing');
    });
  }

  elements.backBtn.addEventListener('click', () => leaveLobby(resetLobbyUI, resetChat));
  elements.shareBtn.addEventListener('click', shareLobby);
  if (elements.renameBtn) elements.renameBtn.addEventListener('click', promptRenameLobby);
  if (elements.pinBtn) elements.pinBtn.addEventListener('click', togglePin);
  if (elements.modeBtn) elements.modeBtn.addEventListener('click', toggleUserMode);

  // Playback Controls
  elements.playBtn.addEventListener('click', togglePlayback);
  elements.prevBtn.addEventListener('click', playPrevious);
  elements.nextBtn.addEventListener('click', playNext);
  elements.repeatBtn.addEventListener('click', cycleRepeatMode);
  elements.shuffleBtn.addEventListener('click', toggleShuffle);
  elements.progressBar.addEventListener('input', seekTo);

  // Queue
  elements.addSongBtn.addEventListener('click', addSong);
  elements.songInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addSong(); });
  var browseLibBtn = document.getElementById('browse-library-btn');
  if (browseLibBtn) browseLibBtn.addEventListener('click', showLibraryDialog);

  // Chat
  if (elements.chatSendBtn) elements.chatSendBtn.addEventListener('click', sendChatMessage);
  if (elements.chatInput) elements.chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatMessage(); });
  if (elements.chatMentionSongBtn) elements.chatMentionSongBtn.addEventListener('click', toggleSongMention);
  if (elements.chatSongPreviewRemove) elements.chatSongPreviewRemove.addEventListener('click', clearSongMention);

  setupQueueDragAndDrop();
  setupQueueSearch();

  if (elements.hideErroredCheckbox) {
    elements.hideErroredCheckbox.checked = state.hideErroredSongs;
    elements.hideErroredCheckbox.addEventListener('change', (e) => { state.hideErroredSongs = e.target.checked; storageSet(STORAGE_KEYS.HIDE_ERRORED_SONGS, state.hideErroredSongs); updateQueue(); });
  }
  if (elements.queueSortSelect) {
    elements.queueSortSelect.value = state.queueSort;
    elements.queueSortSelect.addEventListener('change', (e) => { state.queueSort = e.target.value; storageSet(STORAGE_KEYS.QUEUE_SORT, state.queueSort); updateQueue(); });
  }
  if (elements.clearQueueBtn) elements.clearQueueBtn.addEventListener('click', clearQueue);

  // Tabs
  elements.navItems.forEach(item => item.addEventListener('click', () => switchTab(item.dataset.tab)));

  // Browser navigation
  window.addEventListener('popstate', () => {
    const path = window.location.pathname;
    if (path === '/') { if (state.lobbyId) leaveLobby(resetLobbyUI, resetChat); }
    else checkUrlForLobby();
  });
}

// Initialize Application
async function init() {
  if (window.i18n) { await window.i18n.init(); setupLanguageSelector(updateQueue, updateListeners); }
  if (checkUrlForDashboard()) return;
  await setupLoginView();
  const authData = await checkAuth();
  if (!authData.authenticated) { showView('login'); return; }
  if (authData.user && authData.user.status === 'pending') { showPendingCard(); showView('login'); return; }
  if (authData.user && authData.user.status === 'denied') {
    showPendingCard();
    const pendingTitle = document.querySelector('.pending-title');
    const pendingMsg = document.querySelector('.pending-message');
    if (pendingTitle) pendingTitle.textContent = 'Access unavailable';
    if (pendingMsg) pendingMsg.textContent = 'This is a private application. If you believe you should have access, contact the administrator directly.';
    showView('login');
    return;
  }
  initAuthenticatedApp();
}

function initAuthenticatedApp() {
  showView('landing');
  setupSocket();
  setupEventListeners();
  setupProfileEditor();
  setupProfilePage();
  checkUrlForLobby();
  setupAudioPlayer(advanceLocalQueue);
  setupMediaSession(togglePlayback, playNext, playPrevious);
  fetchVersion();

  if (window.location.hash === '#profile') {
    showView('profile');
    history.replaceState(null, '', window.location.pathname);
  }

  if (auth.authenticated && auth.user) {
    if (auth.user.name) { state.username = auth.user.name; storageSet(STORAGE_KEYS.USERNAME, auth.user.name); if (elements.profileNameInput) elements.profileNameInput.value = auth.user.name; }
    if (auth.user.emoji) { state.emoji = auth.user.emoji; storageSet(STORAGE_KEYS.EMOJI, auth.user.emoji); if (elements.profileEmojiBtn) elements.profileEmojiBtn.textContent = auth.user.emoji; }
  }
}

// Expose API for inline onclick handlers
window.app = {
  removeSong, moveSongUp, moveSongDown, playSongAt,
  openSource, copySourceUrl, joinLobbyFromCard,
  toggleLobbyVisibility, deleteLobbyCard
};
window.dashboardJoinLobby = dashboardJoinLobby;
window.dashboardRemoveLobby = dashboardRemoveLobby;
window.dashboardApproveUser = dashboardApproveUser;
window.dashboardRejectUser = dashboardRejectUser;
window.deleteCachedSong = deleteCachedSong;
window.playCachedSong = playCachedSong;

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
