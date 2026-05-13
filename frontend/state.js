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
  isHost: false,
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
  userMode: 'listening',
  listeningMode: 'synchronized',
  pinned: false,
  soloPlaylistId: null,
  soloPlaylistSongs: [],
  soloCurrentIndex: -1,
  soloRepeatMode: getStoredRepeatMode(),
  playlists: [],
  pendingLobbyId: null,
  volume: storageGet(STORAGE_KEYS.VOLUME) !== null ? parseFloat(storageGet(STORAGE_KEYS.VOLUME)) : 1,
  isMuted: false,
  volumeBeforeMute: 1,
  hideErroredSongs: storageGet(STORAGE_KEYS.HIDE_ERRORED_SONGS) !== 'false',
  queueSort: storageGet(STORAGE_KEYS.QUEUE_SORT) || 'default',
  queueCurrentIndex: -1,
  followingSocketId: null,
  followingUsername: null,
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
  listeningModeBadge: document.getElementById('listening-mode-badge'),
  modeBtn: document.getElementById('mode-btn'),
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
  socialTab: document.getElementById('social-tab'),
  songInput: document.getElementById('song-input'),
  addSongBtn: document.getElementById('add-song-btn'),
  queueList: document.getElementById('queue-list'),
  hideErroredCheckbox: document.getElementById('hide-errored-songs'),
  queueSortSelect: document.getElementById('queue-sort'),
  clearQueueBtn: document.getElementById('clear-queue-btn'),
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  chatSendBtn: document.getElementById('chat-send-btn'),
  chatMentionSongBtn: document.getElementById('chat-mention-song-btn'),
  chatSongPreview: document.getElementById('chat-song-preview'),
  chatSongPreviewTitle: document.getElementById('chat-song-preview-title'),
  chatSongPreviewRemove: document.getElementById('chat-song-preview-remove'),
  chatTicker: document.getElementById('chat-ticker'),
  chatTickerContent: document.getElementById('chat-ticker-content'),
  listenersList: document.getElementById('listeners-list'),
  profileEditor: document.getElementById('profile-editor'),
  profileEmojiBtn: document.getElementById('profile-emoji-btn'),
  profileNameInput: document.getElementById('profile-name-input'),
  profileSaveBtn: document.getElementById('profile-save-btn'),
  emojiPicker: document.getElementById('emoji-picker'),
  volumeBtn: document.getElementById('volume-btn'),
  volumeBar: document.getElementById('volume-bar'),
  volumeIcon: document.getElementById('volume-icon'),
  soloVolumeBtn: document.getElementById('solo-volume-btn'),
  soloVolumeBar: document.getElementById('solo-volume-bar'),
  soloVolumeIcon: document.getElementById('solo-volume-icon'),
  audioPlayer: document.getElementById('audio-player'),
  toastContainer: document.getElementById('toast-container'),
  versionDisplay: document.getElementById('version-display'),
  dashboardUptime: document.getElementById('dashboard-uptime'),
  statLobbies: document.getElementById('stat-lobbies'),
  statUsers: document.getElementById('stat-users'),
  statMemory: document.getElementById('stat-memory'),
  statDisk: document.getElementById('stat-disk'),
  dashboardLobbyList: document.getElementById('dashboard-lobby-list'),
  soloView: document.getElementById('solo-view'),
  soloBackBtn: document.getElementById('solo-back-btn'),
  soloPlaylistName: document.getElementById('solo-playlist-name'),
  soloSongCount: document.getElementById('solo-song-count'),
  soloAlbumArt: document.getElementById('solo-album-art'),
  soloTrackTitle: document.getElementById('solo-track-title'),
  soloTrackArtist: document.getElementById('solo-track-artist'),
  soloProgressBar: document.getElementById('solo-progress-bar'),
  soloCurrentTime: document.getElementById('solo-current-time'),
  soloDuration: document.getElementById('solo-duration'),
  soloPlayBtn: document.getElementById('solo-play-btn'),
  soloPrevBtn: document.getElementById('solo-prev-btn'),
  soloNextBtn: document.getElementById('solo-next-btn'),
  soloRepeatBtn: document.getElementById('solo-repeat-btn'),
  soloSongInput: document.getElementById('solo-song-input'),
  soloAddSongBtn: document.getElementById('solo-add-song-btn'),
  soloAddSongHeaderBtn: document.getElementById('solo-add-song-header-btn'),
  soloQueueList: document.getElementById('solo-queue-list'),
  lobbiesSection: document.getElementById('lobbies-section'),
  lobbiesList: document.getElementById('lobbies-list'),
  playlistsSection: document.getElementById('playlists-section'),
  createPlaylistBtn: document.getElementById('create-playlist-btn'),
  playlistsList: document.getElementById('playlists-list'),
  cacheReady: document.getElementById('cache-ready'),
  cacheDownloading: document.getElementById('cache-downloading'),
  cachePending: document.getElementById('cache-pending'),
  cacheError: document.getElementById('cache-error'),
  cacheDuration: document.getElementById('cache-duration'),
  cacheUnused: document.getElementById('cache-unused'),
  cacheSongList: document.getElementById('cache-song-list'),
  cacheFilter: document.getElementById('cache-filter'),
  nukeCacheBtn: document.getElementById('nuke-cache-btn'),
  clearErrorsBtn: document.getElementById('clear-errors-btn'),
  cleanOrphansBtn: document.getElementById('clean-orphans-btn'),
  purgeUnregisteredBtn: document.getElementById('purge-unregistered-btn'),
  dashboardUserList: document.getElementById('dashboard-user-list'),
  usersApproved: document.getElementById('users-approved'),
  usersPending: document.getElementById('users-pending'),
  usersRejected: document.getElementById('users-rejected'),
  usersSearch: document.getElementById('users-search'),
  usersFilter: document.getElementById('users-filter'),
  roomTypeModal: document.getElementById('room-type-modal'),
  roomTypeLobbyName: document.getElementById('room-type-lobby-name'),
  roomTypeCreateBtn: document.getElementById('room-type-create-btn'),
  roomTypeCancelBtn: document.getElementById('room-type-cancel-btn')
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
