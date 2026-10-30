// Listen-Along Frontend — Entry point and orchestrator
import { state, elements, auth, socket, STORAGE_KEYS, viewActivators, setSocket, storageSet } from './state.js';
import { showView, showToast, switchTab, setupLanguageSelector, fetchVersion, t, setupRangeFill, navigateTo } from './ui.js';
import { setupAudioPlayer } from './audio.js';
import { player, setupPlayer } from './player.js';
import { setupPlayerBar, setupPlayerBarControls, refreshPlayerBar } from './player-bar.js';
import { checkAuth, setupLoginView, showPendingCard, setupProfileEditor, setupProfilePage, loadProfilePage } from './auth.js';
import { checkUrlForDashboard, dashboardJoinLobby, dashboardRemoveLobby, dashboardApproveUser, dashboardRejectUser } from './dashboard.js';
import { setupLibraryPage, openLibraryPage, closeLibraryPage, isLibraryOpen, showLibraryRoute, handleLibraryUpdated, handleRequestsUpdated } from './library.js';
import { parseRoute } from './router.js';
import { createLobby, shareLobby, handleLobbyCreated, handleLobbyJoined, handleLobbyNotFound, handleLobbyError, handleLobbyRenamed, handleLobbyPinned, handleUserJoined, handleUserLeft, handleLobbyClosed, checkForLastLobby, joinLobbyFromCard, updatePinButton, togglePin, promptRenameLobby, toggleLobbyVisibility, deleteLobbyCard, openLobbyPage, closeLobbyPage, syncMembership, resyncMembership, reportNowPlaying } from './lobby.js';
import { handleDownloadStatus, handleDownloadProgress, handleUsersUpdated, handleFollowSync, cycleRepeatMode, toggleShuffle, togglePlayback, playPrevious, playNext, seekTo, updatePlayButton, updatePlaybackModeUI, updateNowPlaying, _setQueueFns } from './playback.js';
import { handleQueueUpdated, handleSongAdded, addSong, removeSong, clearQueue, downloadPlaylist, cancelPlaylistDownload, moveSongUp, moveSongDown, playSongAt, setupQueueDragAndDrop, setupQueueSearch, updateQueue, updateListeners, resetLobbyUI, openSource, copySourceUrl } from './queue.js';
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

    // Events emitted before the first connect are buffered; after a reconnect
    // the server has forgotten this socket, so ask for everything again.
    let connectedBefore = false;
    s.on('connect', () => {
      console.log('Connected to server');
      if (connectedBefore) { showToast(t('toast.reconnected', 'Reconnected!'), 'success'); resyncMembership(); }
      connectedBefore = true;
    });
    s.on('disconnect', () => { console.log('Disconnected from server'); showToast(t('toast.connectionLost', 'Connection lost. Reconnecting...'), 'error'); });

    // Lobby Events
    s.on('lobby:created', (data) => handleLobbyCreated(data, requestChatHistory, updatePinButton));
    s.on('lobby:joined', (data) => handleLobbyJoined(data, requestChatHistory, updatePinButton, updateListeners, updateQueue));
    s.on('lobby:not-found', handleLobbyNotFound);
    s.on('lobby:error', handleLobbyError);
    s.on('lobby:user-joined', (data) => handleUserJoined(data, updateListeners));
    s.on('lobby:user-left', (data) => handleUserLeft(data, updateListeners));
    s.on('lobby:closed', (data) => { if ((data.lobbyId || state.lobbyId) === state.lobbyId) closeLibraryPage(); handleLobbyClosed(data, resetLobbyPage); });
    s.on('lobby:renamed', handleLobbyRenamed);
    s.on('lobby:pinned', (data) => handleLobbyPinned(data, updatePinButton));

    // Queue Events
    s.on('queue:update', handleQueueUpdated);
    s.on('queue:song-added', handleSongAdded);
    s.on('queue:error', (data) => showToast(data.message, 'error'));
    s.on('queue:adding', (data) => showToast(data.status, 'info'));
    s.on('queue:requested', (data) => showToast(data.message, 'info'));
    s.on('request:fulfilled', (data) => showToast(data.message, 'success'));

    // Library Events
    s.on('library:updated', handleLibraryUpdated);
    s.on('requests:updated', handleRequestsUpdated);

    // Download Events
    s.on('download:status', handleDownloadStatus);
    s.on('download:progress', handleDownloadProgress);

    // Mode Events
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

  if (elements.roomTypeCreateBtn) {
    elements.roomTypeCreateBtn.addEventListener('click', () => {
      if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
      const lobbyId = state.pendingLobbyId; // cleared below, before the import resolves
      import('./state.js').then(mod => {
        mod.socket.emit('lobby:create', { username: state.username, emoji: state.emoji, lobbyId, userId: state.userId, asViewer: !!player.context });
      });
      state.pendingLobbyId = null;
    });
  }
  if (elements.roomTypeCancelBtn) {
    elements.roomTypeCancelBtn.addEventListener('click', () => {
      if (elements.roomTypeModal) elements.roomTypeModal.hidden = true;
      state.pendingLobbyId = null;
      closeLibraryPage();
      navigateTo('/');
    });
  }

  // Back only navigates: playback and the playback context are untouched.
  elements.backBtn.addEventListener('click', () => navigateTo('/'));
  elements.shareBtn.addEventListener('click', shareLobby);
  if (elements.renameBtn) elements.renameBtn.addEventListener('click', promptRenameLobby);
  if (elements.pinBtn) elements.pinBtn.addEventListener('click', togglePin);

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
  if (browseLibBtn) browseLibBtn.addEventListener('click', () => openLibraryPage('library'));
  const landingLibBtn = document.getElementById('landing-library-btn');
  if (landingLibBtn) landingLibBtn.addEventListener('click', () => openLibraryPage('library'));
  setupLibraryPage();

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
  if (elements.downloadQueueBtn) elements.downloadQueueBtn.addEventListener('click', downloadPlaylist);
  if (elements.pdlCancel) elements.pdlCancel.addEventListener('click', cancelPlaylistDownload);

  // Tabs
  elements.navItems.forEach(item => item.addEventListener('click', () => switchTab(item.dataset.tab)));

  // Browser navigation
  window.addEventListener('popstate', applyRoute);
}

// Switching or leaving a lobby page: clear its lists and chat.
function resetLobbyPage() {
  resetLobbyUI();
  resetChat();
}

const routeViews = { landing: 'landingView', lobby: 'lobbyView', profile: 'profileView' };
function isViewActive(view) {
  const el = elements[routeViews[view]];
  return !!el && el.classList.contains('active');
}

// Make the UI match the address bar (see router.js for the URL scheme). Runs
// on load and on Back/Forward; in-app navigation pushes the URL itself.
function applyRoute() {
  const route = parseRoute(window.location.pathname, window.location.search);
  if (route.view === 'dashboard') { window.location.reload(); return; }
  if (elements.roomTypeModal && !elements.roomTypeModal.hidden && route.lobbyId !== state.pendingLobbyId) {
    elements.roomTypeModal.hidden = true;
    state.pendingLobbyId = null;
  }
  if (route.lobbyId) {
    // The lobby view shows once lobby:joined arrives.
    if (route.lobbyId !== state.lobbyId) openLobbyPage(route.lobbyId, resetLobbyPage);
  } else {
    closeLobbyPage(resetLobbyPage);
    if (!isViewActive(route.view)) showView(route.view);
  }
  refreshPlayerBar();
  if (route.library) showLibraryRoute(route.library);
  else if (isLibraryOpen()) closeLibraryPage();
}

// Initialize Application
async function init() {
  if (window.i18n) { await window.i18n.init(); setupLanguageSelector(updateQueue, updateListeners); }
  setupPlayerBar();
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
  // Old account-link redirects land on /#profile.
  if (window.location.hash === '#profile') history.replaceState(null, '', '/profile');
  const route = parseRoute(window.location.pathname, window.location.search);
  showView(route.view === 'profile' ? 'profile' : 'landing');
  setupSocket();
  setupEventListeners();
  setupProfileEditor();
  setupProfilePage();
  applyRoute();
  if (!route.lobbyId) checkForLastLobby();
  setupRangeFill();
  setupAudioPlayer();
  setupPlayer();
  setupPlayerBarControls();
  // The full player and the lobby page follow the app-wide player.
  player.on('state', updatePlayButton);
  player.on('track', (track) => {
    updateNowPlaying(track);
    updateQueue();
    reportNowPlaying();
  });
  // Starting a song in another lobby moves the server membership there.
  player.on('context', () => syncMembership());
  fetchVersion();

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

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
