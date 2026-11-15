// Playlists (on the wire still "lobbies": lobby:* events, lobbyId fields):
// creating, opening, sharing, the landing list and the owner controls. The
// server decides who may see / edit what (backend/src/core/playlists/playlistAccess.ts); this
// only mirrors it in the UI.
import { state, elements, socket, STORAGE_KEYS, viewActivators, storageSet, storageRemove, setSuppressJoinToasts, setLobbiesInterval } from '../../shared/state.ts';
import { showView, showToast, escapeHtml, formatAge, copyToClipboard, t, navigateTo } from '../../shared/ui.ts';
import { maybeById, byId } from '../../shared/dom.ts';
import { parseRoute, playlistPath } from '../../router.ts';
import { player } from '../../player/player.ts';
import { playViewedFromTop } from '../../player/playback.ts';
import { desiredMembership, membershipActions } from '../../player/player-queue.ts';
import type { Membership, MembershipAction } from '../../player/player-queue.ts';
import { isEditMode, setEditMode } from '../queue/queue-edit.ts';
import { isNewPlaylistPending, newPlaylistCreated, newPlaylistFailed } from './new-playlist.ts';
import { playlistMenuItems, privateBadgeHtml, LOCK_SVG } from './playlist-actions.ts';
import { moveToFolderItem } from './folder-actions.ts';
import { openContextMenu, closeContextMenu, bindContextMenu } from '../../shared/context-menu.ts';
import { loadPlaylists, onPlaylists, isPinned, togglePlaylistPin, getPlaylists, isLoaded } from './playlist-store.ts';
import { closePickDialog } from '../picker/pick-dialog.ts';
import { playlistCoverIndex, playlistInitials } from './playlist-filter.ts';
import { syncPlaylistMeta } from '../queue/queue.ts';
import type {
  LobbyClosedPayload, LobbyCreatedPayload, LobbyErrorPayload, LobbyJoinedPayload, LobbyNotFoundPayload,
  LobbyRenamedPayload, LobbyUpdatedPayload, LobbyUser, LobbyUserChangePayload, PlaylistDetail, PlaylistSummary, Visibility,
} from '../../shared/types.ts';

// Who owns a playlist, as ownerText reads it (a PlaylistSummary or the page's state).
export interface PlaylistOwnerInfo {
  isOwner: boolean;
  ownerId: string | null;
  ownerName: string | null;
}

// What applyPlaylistMeta copies into the page's state: lobby:joined,
// lobby:created, lobby:updated or a PATCH answer (fields it lacks stay).
interface PlaylistMeta {
  name: string | null;
  visibility?: Visibility;
  ownerId?: string | null;
  ownerName?: string | null;
  isOwner?: boolean;
  canEdit?: boolean;
}

// A playback context that may be a playlist's (only that kind has a lobbyId).
type MaybePlaylistContext = { lobbyId?: string };

// Register landing view activator
viewActivators.landing = () => {
  loadPlaylists();
  setLobbiesInterval(setInterval(loadPlaylists, 10000));
};


const visibilityLabel = (v: Visibility): string => v === 'private' ? t('landing.private', 'Private') : t('landing.public', 'Public');
export const playlistTitle = (name: string | null | undefined, id: string | null | undefined): string => name || `${t('lobby.playlist', 'Playlist')} ${id}`;

// "by you" / "by <name>" / "shared" (ownerless legacy playlists).
export function ownerText({ isOwner, ownerId, ownerName }: PlaylistOwnerInfo): string {
  if (isOwner) return t('landing.byYou', 'by you');
  if (!ownerId) return t('landing.noOwner', 'shared');
  return ownerName ? t('landing.byOwner', `by ${ownerName}`, { name: ownerName }) : '';
}

// Header of the playlist page: name, "Private" badge (the current state, not
// an action), owner, and the owner's ⋮ menu (Rename, Make private / public,
// Delete).
function renderPlaylistHeader(): void {
  elements.lobbyName.textContent = playlistTitle(state.lobbyName, state.lobbyId);
  // The cover of initials, as in the sidebar and on the landing tiles.
  const avatar = maybeById('lobby-avatar');
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
  if (!state.canEdit && isEditMode()) setEditMode(false);
  syncPlaylistMeta();
  // The search field's placeholder names this playlist when it may be added to (search.ts).
  document.dispatchEvent(new CustomEvent('app:playlistmeta'));
}

// The playlist page's ⋮ (owner only).
export function openPlaylistHeaderMenu(e?: MouseEvent | null): void {
  const btn = elements.playlistMenuBtn;
  if (!btn || !state.lobbyId || !state.isOwner) return;
  if (btn.getAttribute('aria-expanded') === 'true') { closeContextMenu(); return; }
  const playlistId = state.lobbyId;
  const pl = { id: playlistId, name: state.lobbyName, visibility: state.visibility, canManage: state.isOwner };
  openContextMenu({ anchor: btn }, playlistMenuItems(pl, {
    returnFocus: btn,
    onChanged: (info) => {
      if (!info || info.id !== state.lobbyId) return;
      applyPlaylistMeta(info);
      renderPlaylistHeader();
    },
    onDeleted: () => { if (state.lobbyId === playlistId) navigateTo('/'); },
  }), { label: t('playlistMenu.label', 'Playlist actions'), trigger: btn, focusFirst: !!e && e.detail === 0 });
}

function applyPlaylistMeta(data: PlaylistMeta): void {
  state.lobbyName = data.name || null;
  if (data.visibility) state.visibility = data.visibility;
  if ('ownerId' in data) state.ownerId = data.ownerId || null;
  if ('ownerName' in data) state.ownerName = data.ownerName || null;
  if ('isOwner' in data) state.isOwner = !!data.isOwner;
  if ('canEdit' in data) state.canEdit = !!data.canEdit;
}

function clearPlaylistState(): void {
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

// --- Server-side playlist membership ----------------------------------------
// The socket is a member of the playback-context playlist (or, with nothing
// playing, of the playlist on screen) and only views any other playlist on
// screen; see desiredMembership in player-queue.ts. `membership` is what has
// been asked of the server.
const membership: Membership = { member: null, viewing: null };

export function getMemberPlaylist(): string | null {
  return membership.member;
}

function emitMembership({ type, lobbyId: playlistId }: MembershipAction): void {
  if (type === 'join') socket.emit('lobby:join', { lobbyId: playlistId, username: state.username, emoji: state.emoji, userId: state.userId });
  else if (type === 'view') socket.emit('lobby:view', { lobbyId: playlistId, userId: state.userId });
  else if (type === 'unview') socket.emit('lobby:unview', { lobbyId: playlistId });
  else if (type === 'leave') socket.emit('lobby:leave', { lobbyId: playlistId });
}

// Bring the server in line with the page on screen and the playback context.
// refresh: the playlist page needs its state (lobby:joined + queue) even when
// the socket is already in that playlist.
export function syncMembership({ refresh = false }: { refresh?: boolean } = {}): void {
  const desired = desiredMembership({ viewedLobbyId: state.lobbyId, contextLobbyId: player.context && (player.context as MaybePlaylistContext).lobbyId });
  const actions = membershipActions(membership, desired);
  actions.forEach(emitMembership);
  membership.member = desired.member;
  membership.viewing = desired.viewing;
  if (refresh && state.lobbyId && !actions.some(a => a.lobbyId === state.lobbyId && (a.type === 'join' || a.type === 'view'))) {
    emitMembership({ type: state.lobbyId === membership.member ? 'join' : 'view', lobbyId: state.lobbyId });
  }
}

// After a reconnect the server knows nothing about this socket.
export function resyncMembership(): void {
  membership.member = null;
  membership.viewing = null;
  syncMembership({ refresh: true });
}

// Show a playlist page (the view itself appears once lobby:joined arrives).
export function openPlaylistPage(playlistId: string, resetPlaylistPage?: (() => void) | null): void {
  hideRejoinPrompt();
  if (state.autoplayLobbyId !== playlistId) state.autoplayLobbyId = null;
  state.lobbyId = playlistId;
  clearPlaylistState();
  if (resetPlaylistPage) resetPlaylistPage();
  syncMembership({ refresh: true });
}

// Leave the playlist page. Playback is not touched; the socket stays in the
// playlist being played from so its queue stays live.
export function closePlaylistPage(resetPlaylistPage?: (() => void) | null): void {
  state.autoplayLobbyId = null;
  closePickDialog();
  if (!state.lobbyId) return;
  state.lobbyId = null;
  clearPlaylistState();
  document.title = 'listen-along';
  if (resetPlaylistPage) resetPlaylistPage();
  syncMembership();
}

export function sharePlaylist(): void {
  const url = `${window.location.origin}${playlistPath(state.lobbyId as string)}`;
  const qrUrl = `/api/qr/${state.lobbyId}`;
  const existing = maybeById('share-dialog');
  if (existing) existing.remove();
  const dialog = document.createElement('div');
  dialog.id = 'share-dialog';
  dialog.className = 'app-modal share-overlay';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'share-title');
  // navigator.share is missing in some browsers (lib.dom types it as always there).
  dialog.innerHTML = `<div class="card app-modal-card share-dialog"><div class="card-header d-flex flex-row align-items-center justify-content-between gap-2"><h2 id="share-title" class="h6 mb-0">Share playlist</h2><button class="btn-text theme-secondary btn-icon btn-sm share-close-btn" id="share-close-btn" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div><div class="card-body text-center"><img class="share-qr d-block mx-auto mb-4" src="${escapeHtml(qrUrl)}" alt="QR code for the playlist link" width="200" height="200"><div class="form-control fs-sm text-break user-select-all share-url">${escapeHtml(url)}</div></div><div class="card-footer d-flex justify-content-end gap-2 share-actions">${(navigator.share as Navigator['share'] | undefined) ? '<button class="btn" id="share-native-btn" type="button">Share...</button>' : ''}<button class="btn-solid theme-primary" id="share-copy-btn" type="button">Copy Link</button></div></div>`;
  document.body.appendChild(dialog);
  byId<HTMLButtonElement>('share-copy-btn').addEventListener('click', function() { copyToClipboard(url); });
  if (navigator.share) {
    var nativeBtn = maybeById<HTMLButtonElement>('share-native-btn');
    if (nativeBtn) nativeBtn.addEventListener('click', function() { navigator.share({ title: 'Listen to my playlist on listen-along', text: 'Listen to music together with me', url }).catch(function() {}); });
  }
  byId<HTMLButtonElement>('share-close-btn').addEventListener('click', function() { dialog.remove(); });
  dialog.addEventListener('click', function(e) { if (e.target === dialog) dialog.remove(); });
  dialog.addEventListener('keydown', function(e) { if (e.key === 'Escape') dialog.remove(); });
  byId<HTMLButtonElement>('share-copy-btn').focus();
}

export function handlePlaylistCreated(data: LobbyCreatedPayload, updatePinButton: () => void): void {
  if (data.viewing) membership.viewing = data.lobbyId;
  else { membership.member = data.lobbyId; membership.viewing = null; }
  state.lobbyId = data.lobbyId;
  clearPlaylistState();
  state.listeners = data.users || [];
  applyPlaylistMeta({ ...data, isOwner: true, canEdit: true });
  storageSet(STORAGE_KEYS.LAST_LOBBY, data.lobbyId);
  newPlaylistCreated();
  pushPlaylistUrl(data.lobbyId);
  renderPlaylistHeader();
  updatePinButton();
  showView('lobby');
  syncMembership();
  showToast(data.visibility === 'private' ? 'Private playlist created. Only you can see it.' : 'Playlist created! Share the link to invite friends.', 'success');
}

export function handlePlaylistJoined(data: LobbyJoinedPayload, updatePinButton: () => void, updateListeners: () => void, updateQueue: () => void): void {
  if (player.context && (player.context as MaybePlaylistContext).lobbyId === data.lobbyId) {
    player.renameContext(data.lobbyId, data.name);
    // A now-playing sent before the join completed was dropped by the server.
    if (!data.viewing) reportNowPlaying();
  }
  if (data.lobbyId !== state.lobbyId) return;
  applyPlaylistMeta(data);
  // The server never sends `listeners` (backend/src/core/playlists/playlistSockets.ts sends `users`); read as before.
  state.listeners = (data as LobbyJoinedPayload & { listeners?: LobbyUser[] }).listeners || data.users || [];
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

// Tell the member playlist what this browser is playing.
export function reportNowPlaying(): void {
  const t = player.track;
  if (!player.context || !t) return;
  socket.emit('listener:now-playing', { lobbyId: (player.context as MaybePlaylistContext).lobbyId, track: { title: t.title, thumbnail: t.thumbnail } });
}

// Missing, deleted, or someone else's private playlist: the server answers
// all of them the same way, and so does the page.
export function handlePlaylistNotFound({ lobbyId: playlistId }: LobbyNotFoundPayload): void {
  // The join/view did not happen. A failed join leaves the server in the
  // previous member playlist (only possible with nothing playing): leave it.
  if (membership.member === playlistId) { membership.member = null; socket.emit('lobby:leave', {}); }
  if (membership.viewing === playlistId) membership.viewing = null;
  if (storageGet_internal(STORAGE_KEYS.LAST_LOBBY) === playlistId) storageRemove(STORAGE_KEYS.LAST_LOBBY);
  if (state.autoplayLobbyId === playlistId) state.autoplayLobbyId = null;
  if (playlistId !== state.lobbyId) return;
  showToast(t('lobby.notFound', 'Playlist not found'), 'error');
  navigateTo('/');
}

export function handlePlaylistError(data: LobbyErrorPayload): void {
  if (isNewPlaylistPending()) { newPlaylistFailed(data.message); return; }
  if (data.message && data.message.toLowerCase().includes('not found')) {
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
    hideRejoinPrompt();
  }
  showToast(data.message || 'Playlist error', 'error');
}

export function handlePlaylistRenamed(data: LobbyRenamedPayload): void {
  player.renameContext(data.lobbyId, data.name);
  if (data.lobbyId !== state.lobbyId) return;
  state.lobbyName = data.name || null;
  renderPlaylistHeader();
  showToast(`Playlist renamed to "${data.name}"`, 'success');
}

// Name / visibility / owner changed (sent to everyone with the playlist open).
export function handlePlaylistUpdated(data: LobbyUpdatedPayload): void {
  if (data.name !== undefined) player.renameContext(data.lobbyId, data.name);
  if (data.lobbyId !== state.lobbyId) return;
  applyPlaylistMeta({ ...data, isOwner: state.isOwner, canEdit: state.canEdit });
  renderPlaylistHeader();
}

// The navbar's pin is the viewer's own pin (same as the sidebar's), not the old
// shared lobby:pin flag, which the web no longer sets or shows.
export function updatePinButton(): void {
  if (!elements.pinBtn) return;
  const pinned = !!state.lobbyId && isPinned(state.lobbyId);
  const label = pinned ? t('sidebar.unpin', 'Unpin playlist') : t('lobby.pinPlaylist', 'Pin playlist');
  elements.pinBtn.classList.toggle('active', pinned);
  elements.pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  elements.pinBtn.title = label;
  elements.pinBtn.setAttribute('aria-label', label);
}

export function togglePin(): void {
  if (state.lobbyId) togglePlaylistPin(state.lobbyId, { toast: true });
}

export function handleUserJoined(data: LobbyUserChangePayload, updateListeners: () => void): void {
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  if (data.users) { state.listeners = data.users; }
  else { state.listeners.push(data.user); }
  updateListeners();
  if (data.user.socketId === socket.id) return;
  // Use imported suppressJoinToasts from state (live binding)
  // We need to re-import it here to get the live binding
  import('../../shared/state.ts').then(mod => {
    if (mod.suppressJoinToasts) return;
    const joinDisplay = data.user.emoji ? `${data.user.emoji} ${data.user.username}` : data.user.username;
    showToast(`${joinDisplay} joined`, 'success');
  });
}

export function handleUserLeft(data: LobbyUserChangePayload, updateListeners: () => void): void {
  if (data.lobbyId && data.lobbyId !== state.lobbyId) return;
  if (data.users) state.listeners = data.users;
  else if (data.user) state.listeners = state.listeners.filter(u => u.socketId !== data.user.socketId);
  updateListeners();
}

export function handlePlaylistClosed(data: LobbyClosedPayload, resetPlaylistPage?: (() => void) | null): void {
  const playlistId = data.lobbyId || state.lobbyId;
  const wasContext = !!player.context && (player.context as MaybePlaylistContext).lobbyId === playlistId;
  if (membership.member === playlistId) membership.member = null;
  if (membership.viewing === playlistId) membership.viewing = null;
  if (wasContext) player.stop();
  if (playlistId === state.lobbyId) {
    showToast(data.message || 'This playlist is no longer available.', 'error');
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
    closePlaylistPage(resetPlaylistPage);
    navigateTo('/');
  } else {
    if (wasContext) showToast(t('player.contextClosed', 'The playlist you were playing from is no longer available'), 'error');
    syncMembership();
  }
}

// Adds a history entry for the playlist unless the address bar is already on it.
function pushPlaylistUrl(playlistId: string): void {
  if (parseRoute(window.location.pathname).lobbyId === playlistId) return;
  window.history.pushState({ lobbyId: playlistId }, '', playlistPath(playlistId));
}

// "Back to your last playlist?" names the playlist, so look it up first. A
// playlist that is gone (or private to someone else: the API answers 404 for
// both) is forgotten and no prompt is shown.
export function checkForLastPlaylist(): void {
  const lastPlaylist = storageGet_internal(STORAGE_KEYS.LAST_LOBBY);
  if (!lastPlaylist) return;
  fetch(`/api/playlists/${encodeURIComponent(lastPlaylist)}`, { credentials: 'same-origin' })
    .then((res) => {
      if (res.status === 404 || res.status === 403) { storageRemove(STORAGE_KEYS.LAST_LOBBY); return null; }
      return res.ok ? res.json() as Promise<PlaylistDetail> : null;
    })
    .then((info) => {
      if (!info || info.id !== lastPlaylist) return;
      // The user may have moved on while this was loading.
      if (state.lobbyId || storageGet_internal(STORAGE_KEYS.LAST_LOBBY) !== lastPlaylist) return;
      if (!elements.landingView || !elements.landingView.classList.contains('active')) return;
      showRejoinPrompt(lastPlaylist, playlistTitle(info.name, info.id));
    })
    .catch(() => {});
}

// Internal import to avoid circular dependency
function storageGet_internal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function showRejoinPrompt(playlistId: string, name: string): void {
  if (maybeById('rejoin-prompt')) return;
  const prompt = document.createElement('div');
  prompt.id = 'rejoin-prompt';
  prompt.className = 'toast show rejoin-prompt';
  prompt.setAttribute('role', 'status');
  prompt.innerHTML = `<div class="toast-body"><p class="mb-1 fw-medium">Back to your last playlist?</p><div class="fs-sm fg-3 text-truncate mb-3 rejoin-lobby-name">${escapeHtml(name)}</div><div class="d-flex justify-content-end gap-2 rejoin-actions"><button class="btn btn-sm rejoin-btn" id="rejoin-no" type="button">No thanks</button><button class="btn-solid theme-primary btn-sm rejoin-btn" id="rejoin-yes" type="button">Open</button></div></div>`;
  if (elements.landingView) elements.landingView.appendChild(prompt);
  byId<HTMLButtonElement>('rejoin-yes').addEventListener('click', () => {
    hideRejoinPrompt();
    navigateTo(playlistPath(playlistId));
  });
  byId<HTMLButtonElement>('rejoin-no').addEventListener('click', () => {
    hideRejoinPrompt();
    storageRemove(STORAGE_KEYS.LAST_LOBBY);
  });
}

export function hideRejoinPrompt(): void {
  const prompt = maybeById('rejoin-prompt');
  if (prompt) prompt.remove();
}

export function joinPlaylistFromCard(playlistId: string): void {
  navigateTo(playlistPath(playlistId));
}

// Cache of the most recently rendered playlists, keyed by id. Owner-control
// handlers look up the (possibly quote-bearing) name here instead of through
// inline onclick args, so user-controlled names never enter HTML attributes.
const playlistCache = new Map<string, PlaylistSummary>();

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
const playingPlaylistId = (): string | null => (player.isPlaying && player.track && player.context && player.context.type === 'lobby' ? player.context.lobbyId : null);

// The landing page ("Home"): "Your playlists" (everything you own, public and
// private) as tiles, followed by tiles for Radio, the music library and Artists;
// then the Artists shelf (artists.ts) and a shelf of cards for other people's
// public playlists (and ownerless shared ones). The server only sends what you
// may see. Your pins first, then newest. Owner controls (visibility, delete)
// only on your own playlists. Tiles and cards are .lobby-card (role="link"):
// click / Enter / Space opens, ⋮ / right-click / long-press is the menu, a
// double-click plays (row-double-click.ts).
function renderPlaylists(playlists: PlaylistSummary[]): void {
  if (!elements.lobbiesSection || !elements.lobbiesList || !elements.myPlaylistsList) return;
  playlistCache.clear();
  for (const l of playlists) playlistCache.set(l.id, l);
  const sorted = [...playlists].sort((a, b) => (Number(b.pinnedByMe) - Number(a.pinnedByMe)) || (b.createdAt - a.createdAt));
  const mine = sorted.filter(l => l.isOwner);
  const others = sorted.filter(l => !l.isOwner);
  const nowId = playingPlaylistId();
  elements.myPlaylistsList.removeAttribute('aria-busy');
  setListHtml(elements.myPlaylistsList, (mine.length ? mine.map(l => tileHtml(l, nowId)).join('') : myPlaylistsEmptyHtml()) + shortcutTilesHtml());
  elements.lobbiesSection.hidden = others.length === 0;
  setListHtml(elements.lobbiesList, others.map(l => cardHtml(l, nowId)).join(''));
  updatePlaylistsShelfNav();
}

// Re-render only when the markup changed (the list is polled), and keep
// keyboard focus on the same control of the same playlist.
function setListHtml(list: HTMLElement, html: string): void {
  if (list.dataset.html === html) return;
  // Only read when it is inside the list (so an element).
  const active = document.activeElement as HTMLElement;
  const row = list.contains(active) ? active.closest<HTMLElement>('[data-playlist-id]') : null;
  const id = row && row.dataset.playlistId;
  const part = !row ? null : active === row ? '' : ['lobby-quick-play', 'lobby-menu-btn'].find(c => active.classList.contains(c));
  list.innerHTML = html;
  list.dataset.html = html;
  if (id && part != null) {
    const again = list.querySelector<HTMLElement>(`[data-playlist-id="${CSS.escape(id)}"]`);
    const target = again && (part ? again.querySelector<HTMLElement>(`.${part}`) || again : again);
    if (target) target.focus({ preventScroll: true });
  }
}

function myPlaylistsEmptyHtml(): string {
  return `<li class="app-empty lobbies-empty"><p class="fw-medium fg-1 mb-1">${escapeHtml(t('landing.noPlaylists', 'No playlists yet'))}</p>`
    + `<p class="fs-sm fg-3 mb-4">${escapeHtml(t('landing.emptyHint', 'Make one, add songs, and share the link to listen together.'))}</p>`
    + `<button type="button" class="btn lobbies-empty-new" aria-haspopup="dialog" onclick="window.app.newPlaylist(this)">${PLUS_ICON}${escapeHtml(t('landing.newPlaylist', 'New playlist'))}</button></li>`;
}

const songsText = (n: number): string => (n === 1 ? t('sidebar.oneSong', '1 song') : t('sidebar.songs', `${n} songs`, { count: n }));
const listenersText = (n: number): string => `${n} ${n === 1 ? t('lobby.listener', 'listener') : t('lobby.listeners', 'listeners')}`;

// What a tile or card says about a playlist, and its buttons.
function playlistParts(l: PlaylistSummary, nowId: string | null) {
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
  const playBtn = (cls: string): string => (l.songCount > 0 || playing
    ? `<button type="button" class="${cls} lobby-quick-play" title="${escapeHtml(playLabel)}" aria-label="${escapeHtml(playLabel)}" onclick="event.stopPropagation();window.app.toggleLobbyPlayback(${idArg})">${playing ? PAUSE_ICON : PLAY_ICON}</button>` : '');
  const menuBtn = `<button type="button" class="btn-text theme-secondary btn-icon btn-sm lobby-menu-btn" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(menuLabel)}" aria-label="${escapeHtml(menuLabel)}">${MORE_ICON}</button>`;
  const open = `data-playlist-id="${escapeHtml(l.id)}" tabindex="0" role="link" aria-label="${escapeHtml(label)}"`
    + ` onclick="if(!event.target.closest('.lobby-menu-btn'))window.app.joinLobbyFromCard(${idArg})"`
    + ` onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===this){event.preventDefault();window.app.joinLobbyFromCard(${idArg})}"`;
  const avatar = (cls = ''): string => `<span class="playlist-avatar ${cls} cover-${playlistCoverIndex(l.id)}" aria-hidden="true">${escapeHtml(playlistInitials(title))}</span>`;
  const name = `${l.pinnedByMe ? PIN_ICON : ''}${escapeHtml(title)}`;
  return { title, priv, playing, owner, songs, listeners, playBtn, menuBtn, open, avatar, name };
}

// "Your playlists": a wide, short tile (cover of initials, name, songs and listeners).
function tileHtml(l: PlaylistSummary, nowId: string | null): string {
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
function cardHtml(l: PlaylistSummary, nowId: string | null): string {
  const p = playlistParts(l, nowId);
  const meta = [p.owner, p.songs, p.listeners].filter(Boolean).join(' · ');
  return `<li class="playlist-card lobby-card${p.priv ? ' is-private' : ''}${p.playing ? ' is-playing' : ''}" ${p.open}>`
    + `<span class="playlist-card-media">${p.avatar('playlist-card-art')}${p.playBtn('btn btn-icon')}${p.menuBtn}</span>`
    + `<span class="playlist-card-title" title="${escapeHtml(p.title)}">${p.name}</span>`
    + `<span class="playlist-card-meta">${p.playing ? EQ_HTML : ''}<span class="text-truncate">${escapeHtml(meta)}</span></span>`
    + `</li>`;
}

// After your playlists: Radio, Library & Downloads and Artists, as tiles too.
function shortcutTilesHtml(): string {
  const tile = (href: string, cover: string, icon: string, name: string, meta: string, extra = ''): string => `<li class="landing-tile landing-shortcut">`
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
function updatePlaylistsShelfNav(): void {
  const shelf = elements.lobbiesList;
  const prev = maybeById<HTMLButtonElement>('lobbies-shelf-prev');
  const next = maybeById<HTMLButtonElement>('lobbies-shelf-next');
  if (!shelf || !prev || !next) return;
  const overflow = shelf.scrollWidth - shelf.clientWidth > 1;
  prev.hidden = !overflow;
  next.hidden = !overflow;
  prev.disabled = shelf.scrollLeft <= 1;
  next.disabled = shelf.scrollLeft >= shelf.scrollWidth - shelf.clientWidth - 1;
}

function scrollPlaylistsShelf(direction: number): void {
  const shelf = elements.lobbiesList;
  const rtl = getComputedStyle(shelf).direction === 'rtl' ? -1 : 1;
  shelf.scrollBy({ left: direction * rtl * Math.max(shelf.clientWidth * 0.8, 160), behavior: 'smooth' });
}

// The tile / card button: pause the playlist playing now, else quick play.
export function togglePlaylistPlayback(playlistId: string): void {
  if (playingPlaylistId() === playlistId) { player.pause(); return; }
  quickPlayPlaylist(playlistId);
}

// Quick play (landing row, ⋮ Play, double-click on a row): the playlist already
// playing just resumes; otherwise open it and start from its first song, now if
// it is on screen with its queue, else once the queue arrives (handleQueueUpdated
// in queue.ts).
export function quickPlayPlaylist(playlistId: string): void {
  if (player.context && (player.context as MaybePlaylistContext).lobbyId === playlistId && player.track) {
    if (!player.isPlaying) player.play();
    return;
  }
  if (state.lobbyId === playlistId && state.queueLobbyId === playlistId) {
    navigateTo(playlistPath(playlistId));
    playViewedFromTop();
    return;
  }
  state.autoplayLobbyId = playlistId;
  navigateTo(playlistPath(playlistId));
}

// ⋮ menus (and right-click / long-press) on the landing rows: Play, Copy
// link for everyone; Rename, Make private / public, Delete for the owner.
export function setupLandingMenus(): void {
  onPlaylists(renderPlaylists);
  // The playlist playing now: equaliser, accent title, Pause on its button.
  const rerender = () => { if (isLoaded()) renderPlaylists(getPlaylists()); };
  for (const event of ['state', 'context', 'track'] as const) player.on(event, rerender);
  window.addEventListener('languageChanged', rerender);
  const shelf = elements.lobbiesList;
  if (shelf) {
    shelf.addEventListener('scroll', updatePlaylistsShelfNav, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(updatePlaylistsShelfNav).observe(shelf);
  }
  maybeById('lobbies-shelf-prev')?.addEventListener('click', () => scrollPlaylistsShelf(-1));
  maybeById('lobbies-shelf-next')?.addEventListener('click', () => scrollPlaylistsShelf(1));
  onPlaylists(updatePinButton);
  window.addEventListener('languageChanged', updatePinButton);
  for (const list of [elements.myPlaylistsList, elements.lobbiesList]) {
    bindContextMenu(list, {
      rowSelector: '.lobby-card',
      triggerSelector: '.lobby-menu-btn',
      label: (row) => { const l = playlistCache.get(row.dataset.playlistId as string); return t('playlistMenu.labelFor', `Actions for ${l ? playlistTitle(l.name, l.id) : ''}`, { name: l ? playlistTitle(l.name, l.id) : '' }); },
      getItems: (row) => {
        // Rows are rendered with data-playlist-id.
        const id = row.dataset.playlistId as string;
        const l = playlistCache.get(id);
        if (!l) return null;
        // Rows re-render every 10s: return focus to the row by id.
        const returnFocus = () => document.querySelector<HTMLElement>(`.lobby-card[data-playlist-id="${CSS.escape(id)}"] .lobby-menu-btn`);
        return playlistMenuItems(l, {
          returnFocus,
          onPlay: () => quickPlayPlaylist(id),
          onTogglePin: () => togglePlaylistPin(id),
          folderItem: moveToFolderItem(id, { returnFocus }),
          onChanged: () => loadPlaylists(),
          onDeleted: () => loadPlaylists(),
        });
      },
    });
  }
}
