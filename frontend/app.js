// Listen-Along Frontend — Entry point and orchestrator
import { state, elements, auth, socket, STORAGE_KEYS, viewActivators, setSocket, storageSet } from './state.js';
import { showView, showToast, switchTab, setupLanguageSelector, fetchVersion, t, setupRangeFill, navigateTo } from './ui.js';
import { setupAudioPlayer } from './audio.js';
import { player, setupPlayer } from './player.js';
import { setupPlayerBar, setupPlayerBarControls, refreshPlayerBar } from './player-bar.js';
import { checkAuth, setupLoginView, showPendingCard, setupProfilePage, loadProfilePage } from './auth.js';
import { setupSocial, applySocialRoute, toggleSocial } from './social.js';
import { checkUrlForDashboard, dashboardJoinLobby, dashboardRemoveLobby, dashboardApproveUser, dashboardRejectUser } from './dashboard.js';
import { setupLibraryPage, openLibraryPage, closeLibraryPage, isLibraryOpen, showLibraryRoute, handleLibraryUpdated, handleRequestsUpdated } from './library.js';
import { parseRoute, legacyRedirect } from './router.js';
import { createLobby, shareLobby, handleLobbyCreated, handleLobbyJoined, handleLobbyNotFound, handleLobbyError, handleLobbyRenamed, handleLobbyUpdated, handleLobbyPinned, updateVisibilityHint, toggleCurrentVisibility, handleUserJoined, handleUserLeft, handleLobbyClosed, checkForLastLobby, joinLobbyFromCard, updatePinButton, togglePin, promptRenameLobby, toggleLobbyVisibility, deleteLobbyCard, openLobbyPage, closeLobbyPage, syncMembership, resyncMembership, reportNowPlaying } from './lobby.js';
import { handleDownloadStatus, handleDownloadProgress, handleUsersUpdated, handleFollowSync, followPerson, flushPendingFollow, isFollowingPerson, stopFollowing, cycleRepeatMode, toggleShuffle, togglePlayback, playPrevious, playNext, seekTo, updatePlayButton, updatePlaybackModeUI, updateNowPlaying, _setQueueFns } from './playback.js';
import { handleQueueUpdated, handleSongAdded, addSong, removeSong, clearQueue, downloadPlaylist, cancelPlaylistDownload, moveSongUp, moveSongDown, playSongAt, setupQueueDragAndDrop, setupQueueSearch, updateQueue, updateListeners, resetLobbyUI, openSource, copySourceUrl } from './queue.js';

// Wire up cross-module dependencies
_setQueueFns(updateQueue, updateListeners);

// Register profile view activator
viewActivators.profile = () => { loadProfilePage(); };

// Socket.IO Setup
function setupSocket() {
  const sock = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
  setSocket(sock);
  // Global chat + people panel, and now-playing reports from the player.
  setupSocial(sock, {
    name: auth.user && auth.user.name,
    emoji: auth.user && auth.user.emoji,
    reportPlayback: true,
    follow: followPerson,
    isFollowing: isFollowingPerson,
    stopFollowing,
  });

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
    s.on('lobby:created', (data) => handleLobbyCreated(data, updatePinButton));
    s.on('lobby:joined', (data) => { handleLobbyJoined(data, updatePinButton, updateListeners, updateQueue); flushPendingFollow(data); });
    s.on('lobby:not-found', handleLobbyNotFound);
    s.on('lobby:error', handleLobbyError);
    s.on('lobby:user-joined', (data) => handleUserJoined(data, updateListeners));
    s.on('lobby:user-left', (data) => handleUserLeft(data, updateListeners));
    s.on('lobby:closed', (data) => { if ((data.lobbyId || state.lobbyId) === state.lobbyId) closeLibraryPage(); handleLobbyClosed(data, resetLobbyPage); });
    s.on('lobby:renamed', handleLobbyRenamed);
    s.on('lobby:updated', handleLobbyUpdated);
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

    // Follow Events
    s.on('follow:sync', handleFollowSync);
    s.on('follow:error', (data) => showToast(data.message, 'error'));
  });
}

// Event Listeners Setup
function setupEventListeners() {
  elements.createLobbyBtn.addEventListener('click', createLobby);

  if (elements.visibilitySelect) elements.visibilitySelect.addEventListener('change', updateVisibilityHint);
  if (elements.visibilityBtn) elements.visibilityBtn.addEventListener('click', toggleCurrentVisibility);

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

// Switching or leaving a playlist page: clear its lists.
function resetLobbyPage() {
  resetLobbyUI();
}

const routeViews = { landing: 'landingView', lobby: 'lobbyView', profile: 'profileView' };
function isViewActive(view) {
  const el = elements[routeViews[view]];
  return !!el && el.classList.contains('active');
}

// Make the UI match the address bar (see router.js for the URL scheme). Runs
// on load and on Back/Forward; in-app navigation pushes the URL itself.
function applyRoute() {
  // Old /lobby/<id> links (bookmarks, history entries) become /playlist/<id>.
  const moved = legacyRedirect(window.location.pathname, window.location.search);
  if (moved) history.replaceState(history.state, '', moved);
  const route = parseRoute(window.location.pathname, window.location.search);
  if (route.view === 'dashboard') { window.location.reload(); return; }
  applySocialRoute(route.view === 'social');
  if (route.view === 'social') {
    // Phones: the Social view covers the page; desktop: the sidebar over the
    // landing page (a playlist page under it would be left anyway).
    closeLobbyPage(resetLobbyPage);
    if (!isViewActive('landing') && !isViewActive('profile')) showView('landing');
  } else if (route.lobbyId) {
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
  if (authData.user && authData.user.status === 'pending') { showPendingCard(); showView('login'); initPendingSocial(); return; }
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

// Pending users can already use the global chat (and see who is around),
// nothing else: a socket for the social panel only.
function initPendingSocial() {
  const sock = io({ reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
  setupSocial(sock, { name: auth.user && auth.user.name, emoji: auth.user && auth.user.emoji });
  const btn = document.getElementById('pending-chat-btn');
  if (btn) { btn.hidden = false; btn.addEventListener('click', toggleSocial); }
  const sync = () => applySocialRoute(parseRoute(window.location.pathname).view === 'social');
  window.addEventListener('popstate', sync);
  sync();
}

function initAuthenticatedApp() {
  // Old account-link redirects land on /#profile.
  if (window.location.hash === '#profile') history.replaceState(null, '', '/profile');
  const moved = legacyRedirect(window.location.pathname, window.location.search);
  if (moved) history.replaceState(null, '', moved);
  const route = parseRoute(window.location.pathname, window.location.search);
  showView(route.view === 'profile' ? 'profile' : 'landing');
  setupSocket();
  setupEventListeners();
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
  // Starting a song in another playlist moves the server membership there.
  player.on('context', () => syncMembership());
  fetchVersion();

  if (auth.authenticated && auth.user) {
    if (auth.user.name) { state.username = auth.user.name; storageSet(STORAGE_KEYS.USERNAME, auth.user.name); }
    if (auth.user.emoji) { state.emoji = auth.user.emoji; storageSet(STORAGE_KEYS.EMOJI, auth.user.emoji); }
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
