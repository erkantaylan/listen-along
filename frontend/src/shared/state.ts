// Shared state, constants, and storage helpers for Listen-Along
import { initialRepeatMode } from '../player/player-queue.ts';
import type { RepeatMode } from '../player/player-queue.ts';
import { byId } from './dom.ts';
import type { AuthUser, LobbyUser, QueueEntry, Track, Visibility } from './types.ts';

export const STORAGE_KEYS = {
  USER_ID: 'listen-userId',
  USERNAME: 'listen-username',
  EMOJI: 'listen-emoji',
  LAST_LOBBY: 'listen-lastLobby',
  REPEAT_MODE: 'listen-repeatMode',
  SHUFFLE_ENABLED: 'listen-shuffleEnabled',
  PLAYBACK_MODE: 'listen-playbackMode',
  VOLUME: 'listen-volume',
  QUEUE_SORT: 'listen-queueSort'
};

export const AVATAR_EMOJIS: readonly string[] = ['🎸','🎹','🎺','🎷','🥁','🎤','🎧','🎵','🦊','🐱','🐶','🐸','🦄','🐙','🤖','👻','🔥','⚡','🌈','🍕'];

// localStorage Helpers
export function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); }
  catch (e) { console.warn('localStorage unavailable:', e); return null; }
}

export function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); }
  catch (e) { console.warn('localStorage unavailable:', e); }
}

export function storageRemove(key: string): void {
  try { localStorage.removeItem(key); }
  catch (e) { console.warn('localStorage unavailable:', e); }
}

// User identity
export function getOrCreateUserId(): string {
  const stored = storageGet(STORAGE_KEYS.USER_ID);
  if (stored) return stored;
  const newId = 'user_' + crypto.randomUUID().replace(/-/g, '').slice(0, 9);
  storageSet(STORAGE_KEYS.USER_ID, newId);
  return newId;
}

export function getOrCreateUsername(): string {
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

export function getOrCreateEmoji(): string {
  const stored = storageGet(STORAGE_KEYS.EMOJI);
  if (stored) return stored;
  const randomIdx = new Uint32Array(1);
  crypto.getRandomValues(randomIdx);
  const emoji = AVATAR_EMOJIS[randomIdx[0] % AVATAR_EMOJIS.length];
  storageSet(STORAGE_KEYS.EMOJI, emoji);
  return emoji;
}

// No stored choice: Replay list ('all'); a stored 'off' stays off.
export function getStoredRepeatMode(): RepeatMode {
  return initialRepeatMode(storageGet(STORAGE_KEYS.REPEAT_MODE));
}

export function getStoredShuffleEnabled(): boolean {
  return storageGet(STORAGE_KEYS.SHUFFLE_ENABLED) === 'true';
}

// Migrate old unified playback mode to separate repeat + shuffle keys
function migratePlaybackMode() {
  const stored = storageGet(STORAGE_KEYS.PLAYBACK_MODE);
  if (stored && ['repeat-all', 'repeat-one', 'stop', 'shuffle'].includes(stored)) {
    const repeatMap: Record<string, RepeatMode> = { 'repeat-all': 'all', 'repeat-one': 'one', 'stop': 'off', 'shuffle': 'off' };
    storageSet(STORAGE_KEYS.REPEAT_MODE, repeatMap[stored]);
    storageSet(STORAGE_KEYS.SHUFFLE_ENABLED, String(stored === 'shuffle'));
    try { localStorage.removeItem(STORAGE_KEYS.PLAYBACK_MODE); } catch (e) { /* ignore */ }
  }
}
migratePlaybackMode();

// Auth state
export const auth: { checked: boolean; authenticated: boolean; user: AuthUser | null } = {
  checked: false,
  authenticated: false,
  user: null
};

// A download's progress by song url (download:status / download:progress).
export interface DownloadState {
  status: string;
  percent: number;
  error?: string;
}

// A load that waits for the user's first gesture (audio.ts).
export interface PendingPlay {
  src: string;
  position: number;
  shouldPlay: boolean;
}

export interface AppState {
  lobbyId: string | null;
  autoplayLobbyId: string | null;
  queueLobbyId: string | null;
  ownerId: string | null;
  isPlaying: boolean;
  isShuffleEnabled: boolean;
  currentTrack: Track | null;
  queue: QueueEntry[];
  listeners: LobbyUser[];
  userId: string;
  username: string;
  emoji: string;
  repeatMode: RepeatMode;
  audioUnlocked: boolean;
  pendingPlay: PendingPlay | null;
  downloadStatus: Record<string, DownloadState>;
  visibility: Visibility;
  isOwner: boolean;
  canEdit: boolean;
  ownerName: string | null;
  volume: number;
  isMuted: boolean;
  volumeBeforeMute: number;
  queueSort: string;
  revealPlayingIn: string | null;
  listeningAlong: boolean;
  playRequested: boolean;
  lobbyName: string | null;
  // The page on screen's "play from the top" (radio.ts, artist-page.ts set it;
  // the player bar's Play uses it with nothing loaded). Not in the initial state.
  viewPlay?: (() => void) | null;
}

// App State
export const state: AppState = {
  lobbyId: null,
  // Quick play from the landing page: play this playlist once its queue arrives.
  autoplayLobbyId: null,
  // The lobby whose queue has arrived, so state.queue is its list and not just empty.
  queueLobbyId: null,
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
  visibility: 'public',
  isOwner: false,
  canEdit: false,  // may add / remove / reorder songs (server: playlistAccess.canEdit)
  ownerName: null,
  volume: storageGet(STORAGE_KEYS.VOLUME) !== null ? parseFloat(storageGet(STORAGE_KEYS.VOLUME) as string) : 1,
  isMuted: false,
  volumeBeforeMute: 1,
  queueSort: storageGet(STORAGE_KEYS.QUEUE_SORT) || 'default',
  revealPlayingIn: null,  // lobby id: bring the current song into view once its queue is here
  listeningAlong: false,  // listen-along.ts drives the player
  playRequested: false,   // the last load was meant to sound (audio.ts playAudioWithUnlock)
  lobbyName: null
};

// DOM Elements
export const elements = {
  loginView: byId('login-view'),
  landingView: byId('landing-view'),
  lobbyView: byId('lobby-view'),
  radioView: byId('radio-view'),
  artistsView: byId('artists-view'),
  artistView: byId('artist-view'),
  searchView: byId('search-view'),
  appView: byId('app-view'),
  dashboardView: byId('dashboard-view'),
  pendingView: byId('pending-view'),
  profileView: byId('profile-view'),
  pendingIcon: byId('pending-icon'),
  pendingTitle: byId('pending-title'),
  pendingMessage: byId('pending-message'),
  pendingRetryBtn: byId<HTMLButtonElement>('pending-retry-btn'),
  newPlaylistBtn: byId<HTMLButtonElement>('new-playlist-btn'),
  backBtn: byId<HTMLButtonElement>('back-btn'),
  shareBtn: byId<HTMLButtonElement>('share-btn'),
  lobbyName: byId('lobby-name'),
  pinBtn: byId<HTMLButtonElement>('pin-btn'),
  userCount: byId('user-count'),
  albumArt: byId('album-art'),
  trackTitle: byId('track-title'),
  trackArtist: byId('track-artist'),
  progressBar: byId<HTMLInputElement>('progress-bar'),
  currentTime: byId('current-time'),
  duration: byId('duration'),
  playBtn: byId<HTMLButtonElement>('play-btn'),
  prevBtn: byId<HTMLButtonElement>('prev-btn'),
  nextBtn: byId<HTMLButtonElement>('next-btn'),
  repeatBtn: byId<HTMLButtonElement>('repeat-btn'),
  shuffleBtn: byId<HTMLButtonElement>('shuffle-btn'),
  navItems: document.querySelectorAll<HTMLElement>('.nav-item'),
  queueTab: byId('queue-tab'),
  queueList: byId('queue-list'),
  queueSortSelect: byId<HTMLSelectElement>('queue-sort'),
  clearQueueBtn: byId<HTMLButtonElement>('clear-queue-btn'),
  editQueueBtn: byId<HTMLButtonElement>('edit-queue-btn'),
  downloadQueueBtn: byId<HTMLButtonElement>('download-queue-btn'),
  playlistDownloadProgress: byId('playlist-download-progress'),
  pdlLabel: byId('pdl-label'),
  pdlBarFill: byId('pdl-bar-fill'),
  pdlCancel: byId<HTMLButtonElement>('pdl-cancel'),
  volumeBtn: byId<HTMLButtonElement>('volume-btn'),
  volumeBar: byId<HTMLInputElement>('volume-bar'),
  volumeIcon: byId<SVGSVGElement>('volume-icon'),
  audioPlayer: byId<HTMLAudioElement>('audio-player'),
  toastContainer: byId('toast-container'),
  dashboardUptime: byId('dashboard-uptime'),
  statLobbies: byId('stat-lobbies'),
  statUsers: byId('stat-users'),
  statMemory: byId('stat-memory'),
  statDisk: byId('stat-disk'),
  dashboardLobbyList: byId('dashboard-lobby-list'),
  lobbiesSection: byId('lobbies-section'),
  myPlaylistsList: byId('my-playlists-list'),
  lobbiesList: byId('lobbies-list'),
  dashboardUserList: byId('dashboard-user-list'),
  usersApproved: byId('users-approved'),
  usersPending: byId('users-pending'),
  usersRejected: byId('users-rejected'),
  usersSearch: byId<HTMLInputElement>('users-search'),
  usersFilter: byId<HTMLSelectElement>('users-filter'),
  visibilityBadge: byId('playlist-visibility-badge'),
  playlistMenuBtn: byId<HTMLButtonElement>('playlist-menu-btn'),
  playlistOwner: byId('playlist-owner')
};

// Mutable globals (exported as let for live bindings). The socket is set once
// at start-up (app.ts), before anything uses it: typed as always there.
export let socket: AppSocket = null as unknown as AppSocket;
export let suppressJoinToasts = false;
export let dashboardInterval: ReturnType<typeof setInterval> | null = null;
export let lobbiesInterval: ReturnType<typeof setInterval> | null = null;

export function setSocket(s: AppSocket): void { socket = s; }
export function setSuppressJoinToasts(v: boolean): void { suppressJoinToasts = v; }
export function setDashboardInterval(v: ReturnType<typeof setInterval> | null): void { dashboardInterval = v; }
export function setLobbiesInterval(v: ReturnType<typeof setInterval> | null): void { lobbiesInterval = v; }

// View activator callbacks — modules register here, showView() reads from here
export const viewActivators: Record<string, () => void> = {};
