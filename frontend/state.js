// Shared state, constants, and storage helpers for Listen-Along

export const STORAGE_KEYS = {
  USER_ID: 'listen-userId',
  USERNAME: 'listen-username',
  EMOJI: 'listen-emoji',
  LAST_LOBBY: 'listen-lastLobby',
  REPEAT_MODE: 'listen-repeatMode',
  SHUFFLE_ENABLED: 'listen-shuffleEnabled',
  PLAYBACK_MODE: 'listen-playbackMode',
  VOLUME: 'listen-volume',
  HIDE_ERRORED_SONGS: 'listen-hideErroredSongs',
  QUEUE_SORT: 'listen-queueSort'
};

export const AVATAR_EMOJIS = ['🎸','🎹','🎺','🎷','🥁','🎤','🎧','🎵','🦊','🐱','🐶','🐸','🦄','🐙','🤖','👻','🔥','⚡','🌈','🍕'];

// localStorage Helpers
export function storageGet(key) {
  try { return localStorage.getItem(key); }
  catch (e) { console.warn('localStorage unavailable:', e); return null; }
}

export function storageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch (e) { console.warn('localStorage unavailable:', e); }
}

export function storageRemove(key) {
  try { localStorage.removeItem(key); }
  catch (e) { console.warn('localStorage unavailable:', e); }
}

// User identity
export function getOrCreateUserId() {
  const stored = storageGet(STORAGE_KEYS.USER_ID);
  if (stored) return stored;
  const newId = 'user_' + crypto.randomUUID().replace(/-/g, '').slice(0, 9);
  storageSet(STORAGE_KEYS.USER_ID, newId);
  return newId;
}

export function getOrCreateUsername() {
  const stored = storageGet(STORAGE_KEYS.USERNAME);
  if (stored) return stored;
  const adjectives = ['Happy', 'Chill', 'Groovy', 'Funky', 'Cool', 'Mellow'];
  const nouns = ['Listener', 'DJ', 'Vibes', 'Beat', 'Rhythm', 'Sound'];
  const randomValues = new Uint32Array(3);
  crypto.getRandomValues(randomValues);
  const adj = adjectives[randomValues[0] % adjectives.length];
  const noun = nouns[randomValues[1] % nouns.length];
  const newUsername = `${adj}${noun}${randomValues[2] % 100}`;
  storageSet(STORAGE_KEYS.USERNAME, newUsername);
  return newUsername;
}

export function getOrCreateEmoji() {
  const stored = storageGet(STORAGE_KEYS.EMOJI);
  if (stored) return stored;
  const randomIdx = new Uint32Array(1);
  crypto.getRandomValues(randomIdx);
  const emoji = AVATAR_EMOJIS[randomIdx[0] % AVATAR_EMOJIS.length];
  storageSet(STORAGE_KEYS.EMOJI, emoji);
  return emoji;
}

export function getStoredRepeatMode() {
  return storageGet(STORAGE_KEYS.REPEAT_MODE) || 'off';
}

export function getStoredShuffleEnabled() {
  return storageGet(STORAGE_KEYS.SHUFFLE_ENABLED) === 'true';
}

// Migrate old unified playback mode to separate repeat + shuffle keys
function migratePlaybackMode() {
  const stored = storageGet(STORAGE_KEYS.PLAYBACK_MODE);
  if (stored && ['repeat-all', 'repeat-one', 'stop', 'shuffle'].includes(stored)) {
    const repeatMap = { 'repeat-all': 'all', 'repeat-one': 'one', 'stop': 'off', 'shuffle': 'off' };
    storageSet(STORAGE_KEYS.REPEAT_MODE, repeatMap[stored]);
    storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(stored === 'shuffle'));
    try { localStorage.removeItem(STORAGE_KEYS.PLAYBACK_MODE); } catch (e) { /* ignore */ }
  }
}
migratePlaybackMode();

// Auth state
export const auth = {
  checked: false,
  authenticated: false,
  user: null
};

// App State
export const state = {
  lobbyId: null,
  ownerId: null,
  isPlaying: false,
  isShuffleEnabled: getStoredShuffleEnabled(),
  currentTrack: null,
  queue: [],
  listeners: [],
  userId: getOrCreateUserId(),
  username: getOrCreateUsername(),
  emoji: getOrCreateEmoji(),
  repeatMode: getStoredRepeatMode(),
  audioUnlocked: false,
  pendingPlay: null,
  downloadStatus: {},
  pinned: false,
  visibility: 'public',
  isOwner: false,
  canEdit: false,  // may add / remove / reorder songs (server: playlistAccess.canEdit)
  ownerName: null,
  volume: storageGet(STORAGE_KEYS.VOLUME) !== null ? parseFloat(storageGet(STORAGE_KEYS.VOLUME)) : 1,
  isMuted: false,
  volumeBeforeMute: 1,
  hideErroredSongs: storageGet(STORAGE_KEYS.HIDE_ERRORED_SONGS) !== 'false',
  queueSort: storageGet(STORAGE_KEYS.QUEUE_SORT) || 'default',
  listeningAlong: false,  // listen-along.js drives the player
  lobbyName: null
};

// DOM Elements
export const elements = {
  loginView: document.getElementById('login-view'),
  landingView: document.getElementById('landing-view'),
  lobbyView: document.getElementById('lobby-view'),
  dashboardView: document.getElementById('dashboard-view'),
  pendingView: document.getElementById('pending-view'),
  profileView: document.getElementById('profile-view'),
  pendingIcon: document.getElementById('pending-icon'),
  pendingTitle: document.getElementById('pending-title'),
  pendingMessage: document.getElementById('pending-message'),
  pendingRetryBtn: document.getElementById('pending-retry-btn'),
  createLobbyBtn: document.getElementById('create-lobby-btn'),
  backBtn: document.getElementById('back-btn'),
  shareBtn: document.getElementById('share-btn'),
  lobbyName: document.getElementById('lobby-name'),
  renameBtn: document.getElementById('rename-btn'),
  pinBtn: document.getElementById('pin-btn'),
  lobbyNameInput: document.getElementById('lobby-name-input'),
  userCount: document.getElementById('user-count'),
  albumArt: document.getElementById('album-art'),
  trackTitle: document.getElementById('track-title'),
  trackArtist: document.getElementById('track-artist'),
  progressBar: document.getElementById('progress-bar'),
  currentTime: document.getElementById('current-time'),
  duration: document.getElementById('duration'),
  playBtn: document.getElementById('play-btn'),
  prevBtn: document.getElementById('prev-btn'),
  nextBtn: document.getElementById('next-btn'),
  repeatBtn: document.getElementById('repeat-btn'),
  shuffleBtn: document.getElementById('shuffle-btn'),
  navItems: document.querySelectorAll('.nav-item'),
  queueTab: document.getElementById('queue-tab'),
  songInput: document.getElementById('song-input'),
  addSongBtn: document.getElementById('add-song-btn'),
  queueList: document.getElementById('queue-list'),
  hideErroredCheckbox: document.getElementById('hide-errored-songs'),
  queueSortSelect: document.getElementById('queue-sort'),
  clearQueueBtn: document.getElementById('clear-queue-btn'),
  editQueueBtn: document.getElementById('edit-queue-btn'),
  downloadQueueBtn: document.getElementById('download-queue-btn'),
  playlistDownloadProgress: document.getElementById('playlist-download-progress'),
  pdlLabel: document.getElementById('pdl-label'),
  pdlBarFill: document.getElementById('pdl-bar-fill'),
  pdlCancel: document.getElementById('pdl-cancel'),
  volumeBtn: document.getElementById('volume-btn'),
  volumeBar: document.getElementById('volume-bar'),
  volumeIcon: document.getElementById('volume-icon'),
  audioPlayer: document.getElementById('audio-player'),
  toastContainer: document.getElementById('toast-container'),
  versionDisplay: document.getElementById('version-display'),
  dashboardUptime: document.getElementById('dashboard-uptime'),
  statLobbies: document.getElementById('stat-lobbies'),
  statUsers: document.getElementById('stat-users'),
  statMemory: document.getElementById('stat-memory'),
  statDisk: document.getElementById('stat-disk'),
  dashboardLobbyList: document.getElementById('dashboard-lobby-list'),
  lobbiesSection: document.getElementById('lobbies-section'),
  lobbiesList: document.getElementById('lobbies-list'),
  dashboardUserList: document.getElementById('dashboard-user-list'),
  usersApproved: document.getElementById('users-approved'),
  usersPending: document.getElementById('users-pending'),
  usersRejected: document.getElementById('users-rejected'),
  usersSearch: document.getElementById('users-search'),
  usersFilter: document.getElementById('users-filter'),
  visibilitySelect: document.getElementById('playlist-visibility-select'),
  visibilityHint: document.getElementById('playlist-visibility-hint'),
  visibilityBadge: document.getElementById('playlist-visibility-badge'),
  visibilityBtn: document.getElementById('playlist-visibility-btn'),
  playlistOwner: document.getElementById('playlist-owner')
};

// Mutable globals (exported as let for live bindings)
export let socket = null;
export let suppressJoinToasts = false;
export let dashboardInterval = null;
export let lobbiesInterval = null;

export function setSocket(s) { socket = s; }
export function setSuppressJoinToasts(v) { suppressJoinToasts = v; }
export function setDashboardInterval(v) { dashboardInterval = v; }
export function setLobbiesInterval(v) { lobbiesInterval = v; }

// View activator callbacks — modules register here, showView() reads from here
export const viewActivators = {};
