// The global search: one field in the app shell's top bar, centred in the page
// column on every signed-in page (#app-search, body.has-topbar; on phones only
// on the search page, which the row of places and the drawer open), Ctrl+K /
// Cmd+K from anywhere, and the search page /search?q=… (DESIGN.md "Search").
//
//   Songs        the library, as you type (GET /api/library?sort=relevance)
//   Artists      the artists list (artists.ts), filtered here
//   Playlists    the viewer's list (playlist-store.ts; the server already left
//                out what they may not see), filtered here
//   From YouTube only on Enter or "Search YouTube for …" (POST /api/jobs/picks
//                { query }: 30 lookups a minute per client)
//   A link       POST /api/jobs/picks { input }: exactly that video, a Spotify
//                track as it resolves today, a YouTube playlist to import, or
//                the server's own reason it is not supported
//
// A library song played from here is a context of its own ({ type: 'search' })
// that repeats it until something else is chosen (player-queue.ts). Adding goes
// to the playlist this search was started on (an editable playlist page on
// screen when the field was focused, search-rules.ts startTarget), else to the
// one last played from (addTarget); the same song in a playlist asks first
// (add-to-playlist.ts). The pure rules are in search-rules.ts.
import { state, storageGet, storageSet } from '../../shared/state.ts';
import { escapeHtml, formatDuration, navigateTo, showToast, t } from '../../shared/ui.ts';
import { player } from '../../player/player.ts';
import { isLibraryOpen, libraryTrack } from '../library/library.ts';
import { searchPath, searchQueryOf, artistPath, playlistPath } from '../../router.ts';
import { bindSongMenu, songMenuButtonHtml } from '../library/song-reports.ts';
import { bindContextMenu, closeContextMenu, isContextMenuOpen, openContextMenu } from '../../shared/context-menu.ts';
import { addSongToPlaylist, confirmDuplicate, openPlaylistChooser } from '../playlists/add-to-playlist.ts';
import { getPlaylists, isLoaded as playlistsLoaded, loadPlaylists, onPlaylists, scheduleReload } from '../playlists/playlist-store.ts';
import { groupPlaylists, playlistCoverIndex, playlistInitials } from '../playlists/playlist-filter.ts';
import { ensureArtists, coverUrl, songCountText } from '../artists/artists.ts';
import { importPlaylist } from '../picker/pick-dialog.ts';
import { thumbUrl, watchUrl } from '../picker/pick-rules.ts';
import { isUnplayable } from '../../player/playback-failures.ts';
import { closeDrawer } from '../playlists/sidebar.ts';
import {
  ADD_KEY, SONGS_MAX, SONGS_SHOWN, addTarget, isAddKey, isSearchShortcut, isSpotifyLink, keepTarget, lastPlayedFrom, libraryChangeMatters,
  linkInput, linkOutcome, pageTarget, placeholderTarget, rankArtists, rankPlaylists, requestOutcome, rowStep, similarQuery, startTarget, youtubeOutcome,
} from './search-rules.ts';
import type { LibraryChange, LinkedLibrarySong, LinkOutcome } from './search-rules.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import type { MenuItem } from '../../shared/context-menu.ts';
import type { PicksAnswer } from '../picker/pick-rules.ts';
import type { TrackSource } from '../library/library.ts';
import type { Route } from '../../router.ts';
import type {
  ApiError, Artist, CreatePickedJobsResponse, LibraryListResponse, LibrarySong, PickVideo, PlaylistCreated, PlaylistSongsResponse, PlaylistSummary, Track,
} from '../../shared/types.ts';

/** A library song as a row shows it: a GET /api/library row, or one a pick answer names (in_library). */
type SearchSong = LibrarySong | LinkedLibrarySong;
type PlaylistOutcome = Extract<LinkOutcome, { kind: 'playlist' }>;

/** What a rendered row is (S.rows, by its data-key). */
type SongRow = { kind: 'song'; song: SearchSong; track: Track };
type VideoRow = { kind: 'video'; video: PickVideo };
type SearchRow =
  | SongRow
  | VideoRow
  | { kind: 'artist'; artist: Artist }
  | { kind: 'playlist'; playlist: PlaylistSummary }
  | { kind: 'ytgo' }
  | { kind: 'import'; outcome: PlaylistOutcome };

type SongsState = 'idle' | 'loading' | 'ready' | 'rate' | 'error';
type YoutubeState = 'idle' | 'loading' | 'ready' | 'rate' | 'error' | 'empty';

/** A pasted link being looked up (outcome set once it is 'ready'). */
interface LinkState {
  input: string;
  state: 'loading' | 'ready';
  outcome: LinkOutcome | null;
  spotify: boolean;
}

interface YoutubeSearch {
  query: string;
  state: YoutubeState;
  videos: PickVideo[];
  message?: string | null;
  seq: number;
}

interface SearchState {
  open: boolean;
  from: string;
  query: string;
  mode: 'empty' | 'text' | 'link';
  songs: LibrarySong[]; total: number; songsState: SongsState; showAll: boolean; songSeq: number;
  artists: Artist[];
  link: LinkState | null;
  linkSeq: number;
  similar: { query: string; songs: LibrarySong[]; seq: number };
  yt: YoutubeSearch;
  requested: Set<string>;
  busy: Set<string>;
  importing: boolean;
  stale: boolean;
  sessionTarget: string | null;
  rows: Map<string, SearchRow>;
}

/** POST /api/jobs { picks } answered: CreatePickedJobsResponse (2xx) or an ApiError. */
type JobsAnswer = Partial<CreatePickedJobsResponse> & Partial<ApiError>;
interface JobsBody {
  picks: string[];
  playlist_id?: string;
  allow_duplicates?: boolean;
}

/** What a row needs of a playlist (an /api/playlists item, or one just made). */
type NamedPlaylist = { id: string; name?: string | null };

const TYPE_DELAY_MS = 150;   // library results as you type
const LINK_DELAY_MS = 350;   // a pasted link is looked up once it stops changing
const SIMILAR_MAX = 5;
const LIBRARY_REFRESH_MS = 1500; // library changes come in bursts (an import's uploads)
const LAST_PLAYED_KEY = 'listen-lastPlayedPlaylist';
// Views with the top bar (from 768px, and the library overlay; below that only
// the search page). Not login, pending or /dashboard: no bar, no gap.
const VIEWS_WITH_FIELD = ['landing-view', 'lobby-view', 'radio-view', 'artists-view', 'artist-view', 'search-view', 'profile-view', 'app-view'];

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  request: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5a2.5 2.5 0 1 1-1-2V5h4v2z"/></svg>',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => maybeById<T>(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number> = {}): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const isMac = (): boolean => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const phone = (): boolean => window.matchMedia('(width < 768px)').matches;

const S: SearchState = {
  open: false,          // the search page is on screen
  from: '/',            // where the page's back button goes
  query: '',            // what the page shows results for
  mode: 'empty',        // 'empty' | 'text' | 'link'
  songs: [], total: 0, songsState: 'idle', showAll: false, songSeq: 0,
  artists: [],
  link: null,           // { input, state: 'loading' | 'ready', outcome }
  linkSeq: 0,
  similar: { query: '', songs: [], seq: 0 },
  yt: { query: '', state: 'idle', videos: [], seq: 0 },
  requested: new Set(), // YouTube ids asked for from this page (no second job by accident)
  busy: new Set(),      // row keys with an add / request on its way (a second press does nothing)
  importing: false,     // an import on its way
  stale: false,         // the library changed while the page was not on screen
  sessionTarget: null,  // a playlist id: the editable playlist page this search was started on
  rows: new Map(),      // row key -> what it is (the rendered rows)
};
const linkCache = new Map<string, LinkOutcome>(); // input -> outcome (answers only, never failures)
const ytCache = new Map<string, PickVideo[]>();   // query -> videos
let typeTimer: ReturnType<typeof setTimeout> | undefined;
let lastPointer = 'mouse';

// ------------------------------------------------------------------ the target

function currentTarget(): { playlist: PlaylistSummary; session: boolean } | null {
  return addTarget({ sessionId: S.sessionTarget, lastPlayedId: storageGet(LAST_PLAYED_KEY), playlists: getPlaylists() });
}

const playlistName = (p: NamedPlaylist): string => p.name || `${t('lobby.playlist', 'Playlist')} ${p.id}`;

function renderTarget(): void {
  const el = $('search-target');
  if (!el) return;
  const target = currentTarget();
  if (!target) {
    el.innerHTML = `<span class="fs-sm fg-3">${escapeHtml(t('search.noTarget', 'Play a playlist to add to it here in one step'))}</span>`;
    return;
  }
  const name = playlistName(target.playlist);
  el.innerHTML = `<span class="badge badge-subtle theme-primary search-target-chip">
      <span class="text-truncate">${escapeHtml(tf('search.addingTo', 'Adding to: {name}', { name }))}</span>
      ${target.session ? `<button type="button" class="btn-text theme-secondary btn-icon btn-xs search-target-clear" aria-label="${escapeHtml(tf('search.clearTarget', 'Stop adding to {name}', { name }))}" title="${escapeHtml(tf('search.clearTarget', 'Stop adding to {name}', { name }))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>` : ''}
    </span>${target.session ? '' : `<span class="fs-xs fg-3 search-target-why">${escapeHtml(t('search.lastPlayed', 'the playlist you last played'))}</span>`}`;
}

// The editable playlist page on screen, if any (search-rules.ts pageTarget).
function pagePlaylistId(): string | null {
  const view = document.querySelector('.view.active');
  return pageTarget({ view: view ? view.id.replace(/-view$/, '') : null, lobbyId: state.lobbyId, canEdit: state.canEdit, libraryOpen: isLibraryOpen() });
}

function refreshPlaceholder(): void {
  const input = $<HTMLInputElement>('app-search-input');
  if (!input) return;
  const target = placeholderTarget({ sessionId: S.sessionTarget, pageId: pagePlaylistId(), playlists: getPlaylists() });
  input.placeholder = target
    ? tf('search.placeholderTarget', 'Find songs to add to {name}', { name: playlistName(target) })
    : t('search.placeholder', 'Search songs, artists, playlists, or paste a link');
}

// The search starts (focus, Ctrl+K, the Search place): on an editable playlist
// page, that playlist becomes this search's target.
function armTarget(): void {
  const next = startTarget(S.sessionTarget, pagePlaylistId());
  if (next === S.sessionTarget) return;
  S.sessionTarget = next;
  refreshPlaceholder();
  renderTarget();
}

// ----------------------------------------------------------------- the field

/** Whether the top bar is on screen: a signed-in page that has it (on phones only the search page). */
function barShown(): boolean {
  if (!document.body.classList.contains('has-plnav')) return false;
  const lib = $('library-page');
  if (lib && !lib.hidden) return !phone(); // the overlay is a page panel too (on phones it has no bar)
  const view = document.querySelector('.view.active');
  if (!view || !VIEWS_WITH_FIELD.includes(view.id)) return false;
  return !phone() || view.id === 'search-view';
}

// The bar is part of the shell (index.html, app.css "Top bar"): it never moves,
// it is shown or not, and body.has-topbar makes only the page panel start under
// it (the sidebar and the chat column stay full height).
function syncBar(): void {
  const bar = $('app-search');
  if (!bar) return;
  const shown = barShown();
  bar.hidden = !shown;
  document.body.classList.toggle('has-topbar', shown);
  refreshPlaceholder();
}

/** Ctrl+K, the places: the field, here or on the search page. */
export function focusSearch({ select = true }: { select?: boolean } = {}): void {
  closeContextMenu();
  armTarget();
  syncBar();
  const bar = byId('app-search');
  const input = byId<HTMLInputElement>('app-search-input');
  if (bar.hidden) {
    navigateTo(searchPath(S.open ? S.query : ''));
    syncBar();
  }
  input.focus({ preventScroll: true });
  if (select) input.select();
}

function syncKbd(): void {
  const kbd = $('app-search-kbd');
  if (!kbd) return;
  kbd.textContent = isMac() ? '⌘K' : 'Ctrl K';
  kbd.hidden = !!byId<HTMLInputElement>('app-search-input').value;
}

// What was typed: the page follows, without a history entry per letter.
function applyInput({ now = false }: { now?: boolean } = {}): void {
  clearTimeout(typeTimer);
  const value = byId<HTMLInputElement>('app-search-input').value;
  const q = searchQueryOf(value);
  const run = () => {
    if (!S.open) {
      if (!q) return;
      navigateTo(searchPath(q)); // one entry: from the page you were on to the search
      return;
    }
    if (q === S.query) return;
    const path = searchPath(q);
    if (window.location.pathname + window.location.search !== path) history.replaceState(history.state, '', path);
    runQuery(q);
  };
  if (now) run();
  else typeTimer = setTimeout(run, linkInput(q) ? LINK_DELAY_MS : TYPE_DELAY_MS);
}

function onFieldKeydown(e: KeyboardEvent): void {
  // An IME is composing: its Enter / Escape belong to it.
  if (e.isComposing || e.keyCode === 229) return;
  const input = e.currentTarget as HTMLInputElement;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (input.value) {
      input.value = '';
      syncKbd();
      applyInput({ now: true });
    } else {
      input.blur();
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    applyInput({ now: true });
    const q = searchQueryOf(input.value);
    if (q && !linkInput(q)) searchYouTube(q, { reveal: true });
    return;
  }
  if (e.key === 'ArrowDown' && S.open) {
    const rows = resultRows();
    if (rows.length) { e.preventDefault(); applyInput({ now: true }); rows[0].focus(); }
  }
}

// ------------------------------------------------------------------ the page

/** The route opened /search?q=… (also Back / Forward). */
export function openSearchPage(query: string, { from = null }: { from?: string | null } = {}): void {
  const wasOpen = S.open;
  S.open = true;
  if (!wasOpen && from && !from.startsWith('/search')) S.from = from;
  const input = byId<HTMLInputElement>('app-search-input');
  if (searchQueryOf(input.value) !== query && document.activeElement !== input) input.value = query;
  syncKbd();
  syncBar();
  if (!playlistsLoaded()) loadPlaylists();
  if (!wasOpen || query !== S.query) runQuery(query, { force: !wasOpen });
  else render();
  if (!wasOpen && !query && document.activeElement !== input) input.focus({ preventScroll: true });
}

/** The route left the search page. */
export function closeSearchPage(): void {
  if (!S.open) return;
  S.open = false;
  clearTimeout(typeTimer);
  S.songSeq++; S.linkSeq++; S.yt.seq++; S.similar.seq++;
  document.title = 'listen-along';
}

/** Any route change: a search's playlist target lasts while its search does (keepTarget). */
export function searchRouteChanged(route: Route): void {
  if (!S.sessionTarget) return;
  S.sessionTarget = keepTarget(S.sessionTarget, route);
  if (!S.sessionTarget) refreshPlaceholder();
}

function setTitle(): void {
  document.title = S.query ? `${S.query} · ${t('search.title', 'Search')} · listen-along` : `${t('search.title', 'Search')} · listen-along`;
}

function runQuery(q: string, { force = false }: { force?: boolean } = {}): void {
  if (!force && q === S.query && S.mode !== 'empty') return;
  S.query = q;
  S.showAll = false;
  // Whatever was on its way for the last text is stale now.
  S.linkSeq++;
  S.songSeq++;
  S.similar = { query: '', songs: [], seq: S.similar.seq + 1 };
  setTitle();
  if (S.yt.query !== q) S.yt = { query: q, state: 'idle', videos: [], seq: S.yt.seq + 1 };
  const link = linkInput(q);
  if (!q) {
    S.mode = 'empty';
    S.songs = []; S.total = 0; S.songsState = 'idle'; S.artists = []; S.link = null;
    render();
    return;
  }
  if (link) {
    S.mode = 'link';
    S.songs = []; S.total = 0; S.songsState = 'idle'; S.artists = [];
    lookupLink(link, { bare: !/[/.]/.test(q) });
    return;
  }
  runText(q);
}

function runText(q: string): void {
  if (!q) return; // never a text search for nothing (the empty page is runQuery's)
  S.mode = 'text';
  S.link = null;
  S.songsState = 'loading';
  render();
  loadSongs(q);
  ensureArtists().then((all) => {
    if (!S.open || S.query !== q) return;
    S.artists = rankArtists(all, q);
    render();
  }).catch(() => {});
}

async function fetchSongs(q: string, limit: number): Promise<LibraryListResponse> {
  const params = new URLSearchParams({ q, sort: 'relevance', limit: String(limit) });
  const res = await fetch(`/api/library?${params}`, { credentials: 'same-origin' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return await res.json() as LibraryListResponse;
}

async function loadSongs(q: string): Promise<void> {
  const seq = ++S.songSeq;
  try {
    const data = await fetchSongs(q, SONGS_MAX);
    if (seq !== S.songSeq || !S.open) return;
    S.songs = data.songs || [];
    S.total = data.total || 0;
    S.songsState = 'ready';
  } catch (err) {
    if (seq !== S.songSeq) return;
    S.songsState = err && (err as { status?: number }).status === 429 ? 'rate' : 'error';
  }
  render();
}

// A refetch nobody asked for (the library changed): only a good answer is used,
// so a failure or 429 never replaces the results on screen.
async function refreshSongs(): Promise<void> {
  if (!S.open || S.mode !== 'text' || !S.query || S.songsState === 'loading') return;
  const q = S.query;
  const seq = ++S.songSeq;
  try {
    const data = await fetchSongs(q, SONGS_MAX);
    if (seq !== S.songSeq || !S.open || S.query !== q) return;
    S.songs = data.songs || [];
    S.total = data.total || 0;
    S.songsState = 'ready';
    render();
  } catch {}
}

// A pasted link: exactly what it points at (the server classifies it).
async function lookupLink(input: string, { bare = false }: { bare?: boolean } = {}): Promise<void> {
  const seq = ++S.linkSeq;
  const query = S.query;
  const spotify = isSpotifyLink(input);
  const cached = linkCache.get(input);
  S.link = { input, state: cached ? 'ready' : 'loading', outcome: cached || null, spotify };
  if (!cached) {
    render();
    let status = 0;
    let body: PicksAnswer | null = null;
    try {
      const res = await fetch('/api/jobs/picks', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotify ? { input, match_library: true } : { input }),
      });
      status = res.status;
      body = await res.json().catch(() => null) as PicksAnswer | null;
    } catch { status = 0; }
    if (seq !== S.linkSeq || !S.open || S.mode !== 'link' || S.query !== query) return;
    const outcome = linkOutcome(status, body, { spotify, bare });
    if (!['rate', 'error'].includes(outcome.kind)) linkCache.set(input, outcome);
    S.link = { input, state: 'ready', outcome, spotify };
  }
  // Set above: the cached answer, or the one just read.
  const outcome = S.link.outcome as LinkOutcome;
  if (outcome.kind === 'text') { runText(query); return; }
  render();
  const title = outcome.kind === 'video' ? outcome.video.title : outcome.kind === 'song' ? outcome.song.title : null;
  if (title) loadSimilar(similarQuery(title), outcome.kind === 'song' ? outcome.song.id : null);
}

// "Similar in the library": a hint under a pasted video, never in the way.
async function loadSimilar(q: string, exceptId: string | null): Promise<void> {
  const seq = ++S.similar.seq;
  S.similar = { query: q, songs: [], seq };
  if (!q) return;
  try {
    const data = await fetchSongs(q, SIMILAR_MAX + 1);
    if (seq !== S.similar.seq || !S.open) return;
    S.similar.songs = (data.songs || []).filter((s) => s.id !== exceptId).slice(0, SIMILAR_MAX);
    render();
  } catch {}
}

// From YouTube: only when asked (Enter, or the row / button).
async function searchYouTube(q: string, { reveal = false, retry = false }: { reveal?: boolean; retry?: boolean } = {}): Promise<void> {
  if (!q || linkInput(q)) return;
  if (!S.open) return;
  if (S.yt.query === q && (S.yt.state === 'loading' || (S.yt.state === 'ready' && !retry))) {
    if (reveal) revealYouTube();
    return;
  }
  const seq = S.yt.seq + 1;
  if (ytCache.has(q) && !retry) {
    S.yt = { query: q, state: 'ready', videos: ytCache.get(q) as PickVideo[], seq };
  } else {
    S.yt = { query: q, state: 'loading', videos: [], seq };
    render();
    if (reveal) revealYouTube();
    let status = 0;
    let body: PicksAnswer | null = null;
    try {
      const res = await fetch('/api/jobs/picks', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
      });
      status = res.status;
      body = await res.json().catch(() => null) as PicksAnswer | null;
    } catch { status = 0; }
    if (seq !== S.yt.seq || !S.open || S.query !== q) return;
    const o = youtubeOutcome(status, body);
    if (o.kind === 'results') ytCache.set(q, o.videos);
    const read: { kind: string; videos?: PickVideo[]; message?: string | null } = o; // every variant, its fields optional
    S.yt = { query: q, state: o.kind === 'results' ? 'ready' : o.kind, videos: read.videos || [], message: read.message || null, seq };
  }
  render();
  if (reveal) revealYouTube();
}

function revealYouTube(): void {
  const el = $('search-youtube');
  if (el) el.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

// --------------------------------------------------------------- rendering

const durationText = (sec: number | null): string => (sec != null && sec > 0 ? formatDuration(sec) : '');
const isCurrentSong = (id: string): boolean => !!player.track && (player.track.libraryId === id || player.track.url === `library:${id}`);
const sounding = (id: string): boolean => isCurrentSong(id) && player.isPlaying;

// A row's add / request button while its request is on its way: it stays
// focusable (focus is not lost), says it is busy and ignores presses.
const busyAttrs = (key: string): string => (S.busy.has(key) ? ' aria-disabled="true" aria-busy="true"' : '');

function setBusy(key: string, on: boolean): void {
  if (on) S.busy.add(key); else S.busy.delete(key);
  const root = $('search-results');
  if (!root) return;
  root.querySelectorAll(`[data-key="${CSS.escape(key)}"] :is(.search-add, .search-request)`).forEach((b) => {
    if (on) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-busy', 'true'); } else { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-busy'); }
  });
}

function addButtonHtml(title: string, key: string): string {
  const target = currentTarget();
  const name = target ? playlistName(target.playlist) : null;
  const label = name ? tf('search.addToNamed', 'Add {title} to {name}', { title, name }) : tf('search.addChoose', 'Add {title} to a playlist', { title });
  const tip = `${name ? tf('search.addTo', 'Add to {name}', { name }) : t('search.addToChoose', 'Add to a playlist…')} (${ADD_KEY.toUpperCase()})`;
  return `<button class="btn btn-sm search-add" type="button"${busyAttrs(key)} aria-label="${escapeHtml(label)}" title="${escapeHtml(tip)}" aria-keyshortcuts="${ADD_KEY.toUpperCase()}">${ICON.add}<span class="search-add-label">${escapeHtml(name ? t('search.add', 'Add') : t('search.addMenu', 'Add to…'))}</span></button>`;
}

/** A library song: plays here, adds in one step, the usual song menu. */
function songRowHtml(song: SearchSong, { badge = '' }: { badge?: string } = {}): string {
  const key = `song:${song.id}`;
  // A LinkedLibrarySong has no file_version (no ?v=) and its artist may be null (libraryTrack reads it as '').
  const track = libraryTrack(song as TrackSource);
  S.rows.set(key, { kind: 'song', song, track });
  const playing = isCurrentSong(song.id);
  const title = song.title || '';
  const meta = [song.artist, durationText(song.duration_sec)].filter(Boolean).join(' · ');
  const thumb = song.youtube_id ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(song.youtube_id)}/default.jpg" alt="" loading="lazy">` : ICON.note;
  const playLabel = sounding(song.id) ? tf('search.pauseNamed', 'Pause {title}', { title }) : tf('search.playNamed', 'Play {title}', { title });
  return `<li class="list-group-item search-row search-song${playing ? ' is-playing' : ''}${isUnplayable(track) ? ' is-unplayable' : ''}" tabindex="0" data-nav data-key="${escapeHtml(key)}"${playing ? ' aria-current="true"' : ''}>
    <span class="app-thumb search-thumb">${thumb}</span>
    <div class="min-w-0 flex-grow-1 search-text">
      <div class="text-truncate search-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="fs-sm fg-3 text-truncate search-meta">${escapeHtml(meta)}</div>
    </div>
    ${badge}
    <button class="btn-outline theme-secondary btn-icon btn-sm rounded-pill search-play" type="button" aria-label="${escapeHtml(playLabel)}" title="${escapeHtml(playLabel)}">${sounding(song.id) ? ICON.pause : ICON.play}</button>
    ${addButtonHtml(title, key)}
    ${songMenuButtonHtml(title)}
  </li>`;
}

/** A YouTube video the library has not got: request it, or open it on YouTube. */
function videoRowHtml(video: PickVideo): string {
  if (video.in_library) {
    return songRowHtml({ id: video.in_library.id, title: video.in_library.title, artist: video.in_library.artist, youtube_id: video.youtube_id, duration_sec: video.duration_sec },
      { badge: `<span class="badge badge-subtle theme-success search-badge">${escapeHtml(t('pick.inLibrary', 'In library'))}</span>` });
  }
  const key = `yt:${video.youtube_id}`;
  S.rows.set(key, { kind: 'video', video });
  const title = video.title || tf('pick.unknownVideo', 'YouTube video {id}', { id: video.youtube_id });
  const meta = [video.channel, durationText(video.duration_sec)].filter(Boolean).join(' · ') || t('search.noDetails', 'Could not look it up. You can still request it.');
  const target = currentTarget();
  const done = S.requested.has(video.youtube_id);
  const name = target ? playlistName(target.playlist) : null;
  const label = done ? t('search.requested', 'Requested')
    : name ? tf('search.requestAddTo', 'Request and add to {name}', { name }) : t('search.request', 'Request');
  const tip = done ? t('search.requestedHint', 'Asked for. It is downloaded by a downloader; progress is in Activity.')
    : `${name ? tf('search.requestAddToHint', 'A downloader fetches it, then it is added to {name}', { name }) : t('search.requestChoose', 'Choose where it goes once downloaded')} (${ADD_KEY.toUpperCase()})`;
  return `<li class="list-group-item search-row search-yt" tabindex="0" data-nav data-key="${escapeHtml(key)}">
    <span class="app-thumb pick-thumb search-yt-thumb"><img src="${escapeHtml(thumbUrl(video.youtube_id))}" alt="" loading="lazy"></span>
    <div class="min-w-0 flex-grow-1 search-text">
      <div class="text-truncate search-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="fs-sm fg-3 text-truncate search-meta">${escapeHtml(meta)}</div>
    </div>
    <button class="btn btn-sm search-request" type="button"${done ? ' disabled' : busyAttrs(key)} title="${escapeHtml(tip)}" aria-keyshortcuts="${ADD_KEY.toUpperCase()}">${ICON.request}<span class="search-request-label">${escapeHtml(label)}</span></button>
    <a class="btn-text theme-secondary btn-icon btn-sm search-open" href="${escapeHtml(watchUrl(video.youtube_id))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(tf('search.openNamed', 'Open {title} on YouTube', { title }))}" title="${escapeHtml(t('pick.openOnYoutube', 'Open on YouTube'))}">${ICON.open}</a>
    <button class="btn-text theme-secondary btn-icon btn-sm search-yt-menu" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(tf('search.moreNamed', 'More actions for {title}', { title }))}" title="${escapeHtml(t('search.more', 'More actions'))}">${ICON.more}</button>
  </li>`;
}

function artistRowHtml(a: Artist): string {
  const key = `artist:${a.key}`;
  S.rows.set(key, { kind: 'artist', artist: a });
  const cover = coverUrl(a.cover_youtube_id, 'default');
  return `<li class="list-group-item list-group-item-action search-row search-artist" tabindex="0" role="link" data-nav data-key="${escapeHtml(key)}">
    <span class="app-thumb search-thumb search-round">${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ICON.note}</span>
    <div class="min-w-0 flex-grow-1 search-text">
      <div class="text-truncate search-title">${escapeHtml(a.name)}</div>
      <div class="fs-sm fg-3 text-truncate search-meta">${escapeHtml(t('artists.kind', 'Artist'))} · ${escapeHtml(songCountText(a.count || 0))}</div>
    </div>
  </li>`;
}

function playlistRowHtml(p: PlaylistSummary): string {
  const key = `playlist:${p.id}`;
  S.rows.set(key, { kind: 'playlist', playlist: p });
  const name = playlistName(p);
  const owner = p.isOwner ? t('landing.byYou', 'by you') : p.ownerName ? tf('landing.byOwner', 'by {name}', { name: p.ownerName }) : t('landing.noOwner', 'shared');
  const count = Number(p.songCount) || 0;
  const parts = [owner, count === 1 ? t('artists.oneSong', '1 song') : tf('artists.songCount', '{count} songs', { count })];
  if (p.visibility === 'private') parts.push(t('landing.private', 'Private'));
  return `<li class="list-group-item list-group-item-action search-row search-playlist" tabindex="0" role="link" data-nav data-key="${escapeHtml(key)}">
    <span class="playlist-avatar cover-${playlistCoverIndex(p.id)}" aria-hidden="true">${escapeHtml(playlistInitials(name))}</span>
    <div class="min-w-0 flex-grow-1 search-text">
      <div class="text-truncate search-title">${escapeHtml(name)}</div>
      <div class="fs-sm fg-3 text-truncate search-meta">${escapeHtml(parts.join(' · '))}</div>
    </div>
  </li>`;
}

const sectionHtml = (id: string, title: string, body: string, { sub = '', extra = '' }: { sub?: string; extra?: string } = {}): string => `<section class="search-section" id="${id}" aria-labelledby="${id}-title">
    <div class="search-section-head"><h2 id="${id}-title" class="search-section-title">${escapeHtml(title)}</h2>${sub ? `<span class="fs-sm fg-3">${escapeHtml(sub)}</span>` : ''}</div>
    ${body}${extra}
  </section>`;

const listHtml = (rows: string[], label: string): string => `<ul class="list-group search-list" role="list" aria-label="${escapeHtml(label)}">${rows.join('')}</ul>`;
const noteHtml = (text: string): string => `<p class="fs-sm fg-3 mb-0 search-note">${escapeHtml(text)}</p>`;

function songsSection(): string {
  const label = t('search.songs', 'Songs');
  const sub = t('search.inLibrary', 'in the library');
  if (S.songsState === 'loading' && !S.songs.length) {
    return sectionHtml('search-songs', label, `<div class="app-empty search-status" role="status">${escapeHtml(t('landing.loading', 'Loading…'))}</div>`, { sub });
  }
  if (S.songsState === 'error' || S.songsState === 'rate') {
    const text = S.songsState === 'rate' ? t('search.libraryRate', 'Too many searches just now. Wait a moment, then try again.') : t('search.libraryFailed', 'Could not search the library. Check your connection.');
    return sectionHtml('search-songs', label, `<div class="alert ${S.songsState === 'rate' ? 'theme-warning' : 'theme-danger'} fs-sm mb-2" role="alert">${escapeHtml(text)}</div>
      <button type="button" class="btn btn-sm search-retry-songs">${escapeHtml(t('pick.retry', 'Try again'))}</button>`, { sub });
  }
  if (!S.songs.length) return '';
  const shown = S.showAll ? S.songs : S.songs.slice(0, SONGS_SHOWN);
  const more = S.songs.length > shown.length
    ? `<button type="button" class="btn-text theme-secondary btn-sm search-more" data-key="more">${escapeHtml(tf('search.showMore', 'Show {count} more', { count: S.songs.length - shown.length }))}</button>`
    : '';
  const capped = S.showAll && S.total > S.songs.length ? noteHtml(tf('search.capped', 'The best {shown} of {total}. Type more words to narrow it down.', { shown: S.songs.length, total: S.total })) : '';
  return sectionHtml('search-songs', label, noteHtml(t('search.repeatHint', 'A song played from here repeats until you choose something else.'))
    + listHtml(shown.map((s) => songRowHtml(s)), label), { sub, extra: `<div class="d-flex flex-wrap align-items-center gap-2 mt-2">${more}${capped}</div>` });
}

function artistsSection(): string {
  if (!S.artists.length) return '';
  const label = t('artists.title', 'Artists');
  return sectionHtml('search-artists', label, listHtml(S.artists.map(artistRowHtml), label));
}

function playlistsSection(): string {
  const found = rankPlaylists(getPlaylists(), S.query);
  if (!found.length) return '';
  const label = t('landing.playlists', 'Playlists');
  return sectionHtml('search-playlists', label, listHtml(found.map(playlistRowHtml), label));
}

function youtubeSection({ go = true }: { go?: boolean } = {}): string {
  const label = t('search.fromYoutube', 'From YouTube');
  const q = S.query;
  const y = S.yt;
  let body = '';
  const retry = `<button type="button" class="btn btn-sm search-yt-retry">${escapeHtml(t('pick.retry', 'Try again'))}</button>`;
  if (y.state === 'idle') {
    if (!go) return '';
    S.rows.set('ytgo', { kind: 'ytgo' });
    body = `<ul class="list-group search-list" role="list"><li class="list-group-item list-group-item-action search-row search-yt-go" tabindex="0" role="button" data-nav data-key="ytgo">
      <span class="search-go-icon" aria-hidden="true">${ICON.search}</span>
      <span class="min-w-0 flex-grow-1 text-truncate">${escapeHtml(tf('search.searchYoutube', 'Search YouTube for “{query}”', { query: q }))}</span>
      <kbd class="search-kbd">Enter</kbd>
    </li></ul>`;
  } else if (y.state === 'loading') {
    body = `<div class="app-empty search-status" role="status">${escapeHtml(t('pick.searching', 'Searching YouTube…'))}</div>`;
  } else if (y.state === 'rate') {
    body = `<div class="alert theme-warning fs-sm mb-2" role="alert">${escapeHtml(t('search.rateLimited', 'Too many YouTube searches from here just now. Wait a minute, then try again.'))}</div>${retry}`;
  } else if (y.state === 'error') {
    body = `<div class="alert theme-danger fs-sm mb-2" role="alert">${escapeHtml(t('search.youtubeFailed', 'The YouTube search did not work. Check your connection and try again.'))}</div>${retry}`;
  } else if (y.state === 'empty') {
    body = `<div class="app-empty search-status">${escapeHtml(tf('search.youtubeNone', 'YouTube found nothing for “{query}”.', { query: q }))}</div>`;
  } else {
    body = listHtml(y.videos.map(videoRowHtml), label);
  }
  return sectionHtml('search-youtube', label, body, { sub: y.state === 'ready' ? t('search.youtubeSub', 'not in the library yet, unless marked') : '' });
}

// A pasted link's own section.
function linkSection(): string {
  const l = S.link;
  const label = t('search.fromLink', 'From the link');
  if (!l || l.state === 'loading') {
    return sectionHtml('search-link', label, `<div class="app-empty search-status" role="status">${escapeHtml(t('search.lookingUp', 'Looking up the link…'))}</div>`);
  }
  // 'ready': always set; a 'text' answer is never rendered (lookupLink searches the words instead).
  const o = l.outcome as Exclude<LinkOutcome, { kind: 'text' }>;
  const retry = `<button type="button" class="btn btn-sm search-link-retry">${escapeHtml(t('pick.retry', 'Try again'))}</button>`;
  if (o.kind === 'rate') return sectionHtml('search-link', label, `<div class="alert theme-warning fs-sm mb-2" role="alert">${escapeHtml(t('search.rateLimited', 'Too many YouTube searches from here just now. Wait a minute, then try again.'))}</div>${retry}`);
  if (o.kind === 'error') return sectionHtml('search-link', label, `<div class="alert theme-danger fs-sm mb-2" role="alert">${escapeHtml(t('search.linkFailed', 'Could not look up that link. Check your connection and try again.'))}</div>${retry}`);
  if (o.kind === 'unsupported') return sectionHtml('search-link', label, `<div class="alert theme-warning fs-sm mb-0" role="alert">${escapeHtml(unsupportedText(o.message))}</div>`);
  if (o.kind === 'none') return sectionHtml('search-link', label, `<div class="app-empty search-status">${escapeHtml(tf('search.spotifyNone', 'YouTube found nothing for “{query}”.', { query: o.query }))}</div>`);
  if (o.kind === 'playlist') return importCardHtml(o);
  const via = o.query ? noteHtml(tf('search.spotifyAs', 'Spotify track: {query}', { query: o.query })) : '';
  const row = o.kind === 'song'
    ? songRowHtml(o.song, { badge: `<span class="badge badge-subtle theme-success search-badge">${escapeHtml(t('pick.inLibrary', 'In library'))}</span>` })
    : videoRowHtml(o.video);
  let html = sectionHtml('search-link', label, via + listHtml([row], label));
  if (S.similar.songs.length) {
    const sl = t('search.similar', 'Similar in the library');
    html += sectionHtml('search-similar', sl, noteHtml(t('search.similarHint', 'Already have it? Pick the library’s copy instead.')) + listHtml(S.similar.songs.map((s) => songRowHtml(s)), sl));
  }
  return html;
}

// The server's reason, in the page's language when it is one we know.
function unsupportedText(message: string | null): string {
  const m = String(message || '');
  if (/^Only Spotify track links/i.test(m)) return t('search.onlySpotifyTracks', 'Only Spotify track links are supported. Paste the link of a single song.');
  if (/^Unsupported link/i.test(m)) return t('search.unsupportedLink', 'That link is not supported. Paste a YouTube video or playlist link, or a Spotify track link.');
  if (/^Could not read that Spotify link/i.test(m)) return t('search.spotifyFailed', 'Could not read that Spotify link.');
  return m || t('search.unsupportedLink', 'That link is not supported. Paste a YouTube video or playlist link, or a Spotify track link.');
}

function importCardHtml(o: PlaylistOutcome): string {
  const name = o.title || t('search.importUntitled', 'YouTube playlist');
  const count = o.total > o.videos.length
    ? tf('search.importCapped', 'The first {shown} of {total} videos', { shown: o.videos.length, total: o.total })
    : o.videos.length === 1 ? t('search.importOne', '1 video') : tf('search.importCount', '{count} videos', { count: o.videos.length });
  const have = o.inLibrary === 1 ? t('search.importHaveOne', '1 already in the library') : tf('search.importHave', '{count} already in the library', { count: o.inLibrary });
  S.rows.set('import', { kind: 'import', outcome: o });
  return sectionHtml('search-link', t('search.youtubePlaylist', 'YouTube playlist'), `<div class="card search-import">
    <div class="card-body d-flex flex-wrap align-items-center gap-3">
      <span class="playlist-avatar cover-${playlistCoverIndex(o.title || 'yt')}" aria-hidden="true">${ICON.list}</span>
      <div class="min-w-0 flex-grow-1">
        <div class="fw-semibold text-truncate">${escapeHtml(name)}</div>
        <div class="fs-sm fg-3">${escapeHtml(count)} · ${escapeHtml(have)}</div>
      </div>
      <button type="button" class="btn-solid theme-primary search-import-btn" data-nav data-key="import"${o.videos.length ? '' : ' disabled'}${S.importing ? ' aria-disabled="true" aria-busy="true"' : ''}>${escapeHtml(t('search.import', 'Import…'))}</button>
    </div>
  </div>`);
}

function statusText(): string {
  if (S.mode === 'empty') return '';
  if (S.mode === 'link') {
    if (!S.link || S.link.state === 'loading') return t('search.lookingUp', 'Looking up the link…');
    return '';
  }
  if (S.songsState === 'loading') return t('landing.loading', 'Loading…');
  const playlists = rankPlaylists(getPlaylists(), S.query).length;
  const parts = [
    S.total === 1 ? t('search.countSong', '1 song') : tf('search.countSongs', '{count} songs', { count: S.total }),
    S.artists.length === 1 ? t('search.countArtist', '1 artist') : tf('search.countArtists', '{count} artists', { count: S.artists.length }),
    playlists === 1 ? t('search.countPlaylist', '1 playlist') : tf('search.countPlaylists', '{count} playlists', { count: playlists }),
  ];
  let text = parts.join(', ');
  if (S.yt.state === 'loading') text += `. ${t('pick.searching', 'Searching YouTube…')}`;
  else if (S.yt.state === 'ready') text += `. ${tf('search.countYoutube', '{count} from YouTube', { count: S.yt.videos.length })}`;
  return text;
}

function render(): void {
  if (!S.open) return;
  const root = $('search-results');
  if (!root) return;
  const focusKey = document.activeElement && root.contains(document.activeElement)
    ? document.activeElement.closest<HTMLElement>('[data-key]')?.dataset.key : null;
  const focusedButton = focusKey && (document.activeElement as Element).matches('button') && !(document.activeElement as Element).matches('[data-key]')
    ? [...(document.activeElement as Element).classList].find((c) => c.startsWith('search-')) : null;
  S.rows = new Map();
  let html = '';
  if (S.mode === 'empty') {
    html = `<div class="app-empty search-empty">
      <p class="mb-1">${escapeHtml(t('search.emptyTitle', 'Search the library, or paste a link'))}</p>
      <p class="fs-sm mb-0 hint">${escapeHtml(t('search.emptyHint', 'Songs, artists and playlists show as you type. Press Enter to search YouTube too. A YouTube or Spotify link shows exactly that song; a YouTube playlist link can be imported.'))}</p>
    </div>`;
  } else if (S.mode === 'link') {
    html = linkSection();
  } else {
    const songs = songsSection();
    const artists = artistsSection();
    const playlists = playlistsSection();
    const nothing = S.songsState === 'ready' && !S.songs.length && !artists && !playlists;
    if (nothing) {
      const going = S.yt.state !== 'idle';
      html = `<div class="app-empty search-empty">
        <p class="mb-3">${escapeHtml(tf('search.nothing', 'Nothing in the library matches “{query}”.', { query: S.query }))}</p>
        ${going ? '' : `<button type="button" class="btn btn-sm search-yt-go-btn" data-nav data-key="ytgo">${ICON.search}<span>${escapeHtml(tf('search.searchYoutube', 'Search YouTube for “{query}”', { query: S.query }))}</span></button>`}
      </div>`;
      if (!going) S.rows.set('ytgo', { kind: 'ytgo' });
      html += youtubeSection({ go: false });
    } else {
      html = songs + artists + playlists + youtubeSection();
    }
  }
  root.innerHTML = html;
  shownSignature = listSignature();
  root.setAttribute('aria-busy', String(S.songsState === 'loading' || S.yt.state === 'loading' || (S.mode === 'link' && S.link && S.link.state === 'loading')));
  const status = $('search-status');
  const text = statusText();
  if (status && status.textContent !== text) status.textContent = text;
  renderTarget();
  if (focusKey) {
    const row = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
    const button = row && focusedButton ? row.querySelector<HTMLButtonElement>(`.${focusedButton}`) : null;
    const target = button && !button.disabled ? button : row;
    if (target) target.focus({ preventScroll: true });
  }
}

// What the page shows from the playlists list and the add target.
function listSignature(): string {
  const target = currentTarget();
  const found = S.open && S.mode === 'text' ? rankPlaylists(getPlaylists(), S.query) : [];
  return JSON.stringify([target && target.playlist.id, target && target.playlist.name, target && target.session,
    found.map((p) => [p.id, p.name, p.songCount, p.visibility, p.ownerName])]);
}
let shownSignature = '';
function refreshIfChanged(): void {
  if (!S.open) return;
  const sig = listSignature();
  if (sig === shownSignature) return;
  if (isContextMenuOpen() || document.querySelector('.app-modal')) { setTimeout(refreshIfChanged, 1500); return; }
  render();
}

// The player moved on: the playing row and the play buttons follow, in place.
function paintPlaying(): void {
  if (!S.open) return;
  const root = $('search-results');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.search-song').forEach((row) => {
    const d = S.rows.get(row.dataset.key as string) as SongRow | undefined; // .search-song rows are songs
    if (!d) return;
    const playing = isCurrentSong(d.song.id);
    row.classList.toggle('is-playing', playing);
    if (playing) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
    const btn = row.querySelector('.search-play') as HTMLButtonElement;
    const on = sounding(d.song.id);
    const label = on ? tf('search.pauseNamed', 'Pause {title}', { title: d.song.title }) : tf('search.playNamed', 'Play {title}', { title: d.song.title });
    if (btn.getAttribute('aria-label') !== label) {
      btn.innerHTML = on ? ICON.pause : ICON.play;
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  });
}

// ------------------------------------------------------------------ actions

/** Play a library song from here: its own context, on repeat until something else is chosen. */
function playSong(d: SongRow): void {
  if (isCurrentSong(d.song.id) && player.context && player.context.type === 'search') {
    if (!player.isPlaying) player.play();
    return;
  }
  player.playFrom({ type: 'search', query: S.query, name: S.query }, [d.track], 0);
}

function togglePlay(d: SongRow): void {
  if (sounding(d.song.id)) player.pause();
  else playSong(d);
}

/** The one-step add (button, or the add key on a row: focus goes back to the row). */
function addOne(d: SearchRow, anchor: HTMLElement, returnFocus: HTMLElement = anchor): void {
  if (d.kind === 'video') { requestOne(d.video, anchor, returnFocus); return; }
  if (d.kind !== 'song') return;
  const key = `song:${d.song.id}`;
  if (S.busy.has(key)) return;
  const song = { songId: d.song.id, title: d.song.title, returnFocus };
  const target = currentTarget();
  if (!target) { openPlaylistChooser(anchor, song); return; }
  setBusy(key, true);
  addSongToPlaylist(target.playlist, song, { returnFocus }).finally(() => setBusy(key, false));
}

async function postJobs(body: JobsBody): Promise<{ status: number; body: JobsAnswer | null }> {
  const res = await fetch('/api/jobs', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as JobsAnswer | null };
}

/**
 * Request a YouTube video (POST /api/jobs { picks }): a download job; with a
 * playlist it lands there when uploaded, or now when the library has it by then.
 * playlist null = the library only.
 */
async function requestVideo(video: PickVideo, playlist: PlaylistSummary | null, anchor: HTMLElement): Promise<void> {
  const id = video.youtube_id;
  const key = `yt:${id}`;
  // The server does not dedupe jobs: one request per video from here, and
  // none while one is on its way (a double-click, A pressed twice).
  if (S.requested.has(id) || S.busy.has(key)) return;
  setBusy(key, true);
  const title = video.title || id;
  const name = playlist ? playlistName(playlist) : null;
  const body: JobsBody = playlist ? { picks: [id], playlist_id: playlist.id } : { picks: [id] };
  try {
    let r = await postJobs(body);
    let outcome = requestOutcome(r.status, r.body, id);
    let again = false;
    if (outcome === 'duplicate') {
      if (!(await confirmDuplicate(name as string, anchor))) return; // a duplicate needs a playlist
      r = await postJobs({ ...body, allow_duplicates: true });
      outcome = requestOutcome(r.status, r.body, id);
      again = true;
    }
    if (outcome === 'requested') {
      S.requested.add(id);
      render();
      showToast(name ? tf('search.requestedTo', 'Requested “{title}”. It is added to {name} once downloaded; see Activity.', { title, name })
        : tf('search.requestedLibrary', 'Requested “{title}” for the library; see Activity.', { title }), 'success', { duration: 5000 });
    } else if (outcome === 'added') {
      showToast(again ? tf('addTo.addedAgain', 'Added to “{name}” again', { name: name as string }) : tf('addTo.added', 'Added to “{name}”', { name: name as string }), 'success');
    } else if (outcome === 'library') {
      showToast(tf('search.alreadyLibrary', '“{title}” is already in the library', { title }), 'info');
    } else if (outcome === 'missing') {
      showToast(t('lobby.notFound', 'Playlist not found'), 'error');
    } else {
      throw new Error((r.body && r.body.error) || `HTTP ${r.status}`);
    }
  } catch (err) {
    showToast(tf('search.requestFailed', 'Could not request “{title}”: {error}', { title, error: (err as Error).message }), 'error');
  } finally {
    setBusy(key, false);
    scheduleReload(0);
  }
}

function editablePlaylists(): PlaylistSummary[] {
  const g = groupPlaylists(getPlaylists().filter((p) => p.canEdit), '');
  return [...g.pinned, ...g.mine, ...g.others];
}

// Where a requested video goes: the user's editable playlists, or the library only.
function requestTargets(video: PickVideo, anchor: HTMLElement): MenuItem[] {
  return [
    ...editablePlaylists().map((p) => ({ label: playlistName(p), description: p.visibility === 'private' ? t('landing.private', 'Private') : undefined, onSelect: () => requestVideo(video, p, anchor) })),
  ];
}

function requestOne(video: PickVideo, anchor: HTMLElement, returnFocus: HTMLElement = anchor): void {
  if (S.requested.has(video.youtube_id) || S.busy.has(`yt:${video.youtube_id}`)) return;
  const target = currentTarget();
  if (target) { requestVideo(video, target.playlist, returnFocus); return; }
  openRequestChooser(video, anchor);
}

function openRequestChooser(video: PickVideo, anchor: HTMLElement): void {
  const show = () => openContextMenu({ anchor }, [
    { header: t('search.requestAndAdd', 'Request and add to') },
    ...requestTargets(video, anchor),
    { divider: true },
    { label: t('search.libraryOnly', 'Library only'), icon: ICON.library, description: t('search.libraryOnlyHint', 'Downloaded into the library, no playlist'), onSelect: () => requestVideo(video, null, anchor) },
  ], { label: t('search.requestAndAdd', 'Request and add to'), trigger: anchor, returnFocus: anchor, sheet: true, focusFirst: true });
  if (getPlaylists().length) show(); else loadPlaylists().then(show);
}

function videoMenuItems(video: PickVideo, anchor: HTMLElement): MenuItem[] {
  const title = video.title || video.youtube_id;
  const done = S.requested.has(video.youtube_id);
  return [
    { header: title },
    done
      ? { label: t('search.requested', 'Requested'), icon: ICON.request, disabled: true }
      : {
        label: t('search.requestAndAdd', 'Request and add to'),
        icon: ICON.request,
        submenu: {
          label: t('search.requestAndAdd', 'Request and add to'),
          backLabel: t('addTo.back', 'Back'),
          emptyText: t('addTo.none', 'No playlists to add to'),
          onOpen: () => loadPlaylists(),
          items: () => requestTargets(video, anchor),
        },
      },
    ...(done ? [] : [{ label: t('search.libraryOnly', 'Library only'), icon: ICON.library, description: t('search.libraryOnlyHint', 'Downloaded into the library, no playlist'), onSelect: () => requestVideo(video, null, anchor) }]),
    { divider: true },
    { label: t('pick.openOnYoutube', 'Open on YouTube'), icon: ICON.open, onSelect: () => window.open(watchUrl(video.youtube_id), '_blank', 'noopener,noreferrer') },
    { label: t('songMenu.copyYoutubeLink', 'Copy YouTube link'), icon: ICON.link, onSelect: () => navigator.clipboard.writeText(watchUrl(video.youtube_id)).then(() => showToast(t('toast.linkCopied', 'Link copied to clipboard!'), 'success')).catch(() => showToast(t('toast.copyFailed', 'Could not copy link'), 'error')) },
  ];
}

async function loadPlaylistSongs(id: string): Promise<PlaylistSongsResponse['songs']> {
  const res = await fetch(`/api/playlists/${encodeURIComponent(id)}/songs`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json() as PlaylistSongsResponse).songs || [];
}

// "Import…": the checklist with a destination, then one request for the lot.
async function startImport(o: PlaylistOutcome, anchor: HTMLElement | null): Promise<void> {
  if (S.importing) return;
  S.importing = true;
  if (anchor) { anchor.setAttribute('aria-disabled', 'true'); anchor.setAttribute('aria-busy', 'true'); }
  try {
    await runImport(o, anchor);
  } finally {
    S.importing = false;
    const btn = document.querySelector('#search-results .search-import-btn');
    if (btn) { btn.removeAttribute('aria-disabled'); btn.removeAttribute('aria-busy'); }
  }
}

async function runImport(o: PlaylistOutcome, anchor: HTMLElement | null): Promise<void> {
  if (!playlistsLoaded()) await loadPlaylists();
  const newName = (o.title || t('search.importUntitled', 'YouTube playlist')).slice(0, 50).trim();
  const target = currentTarget();
  const result = await importPlaylist({
    playlist: { title: o.title, total: o.total, videos: o.videos },
    destinations: editablePlaylists().map((p) => ({ id: p.id, name: playlistName(p) })),
    loadSongs: loadPlaylistSongs,
    newName,
    initial: target && target.session ? target.playlist.id : null,
    returnFocus: anchor,
  });
  if (!result) return;
  let playlist: { id: string; name: string };
  let created = false;
  if (result.destination.kind === 'new') {
    const res = await fetch('/api/playlists', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: result.destination.name }),
    }).catch(() => null);
    const data = (res ? await res.json().catch(() => ({})) : {}) as Partial<PlaylistCreated> & Partial<ApiError>;
    if (!res || !res.ok) {
      showToast(res && res.status === 409
        ? tf('search.importNameTaken', 'A playlist named “{name}” already exists. Import again and choose it as the destination.', { name: result.destination.name })
        : tf('search.importFailed', 'Could not import: {error}', { error: (data && data.error) || t('error.generic', 'Something went wrong') }), 'error', { duration: 6000 });
      return;
    }
    playlist = { id: data.id as string, name: data.name || result.destination.name };
    created = true;
  } else {
    playlist = { id: result.destination.id, name: result.destination.name };
  }
  // What was ticked is what the user wants: rows already in the playlist were
  // unticked for them, so a ticked one is added again on purpose (only when the
  // playlist could be checked).
  const r = await postJobs({ picks: result.picks, playlist_id: playlist.id, ...(result.destination.checked === false ? {} : { allow_duplicates: true }) }).catch(() => ({ status: 0, body: null }));
  scheduleReload(0);
  if (!r.body || (r.status !== 200 && r.status !== 201)) {
    const error = (r.body && r.body.error) || t('error.generic', 'Something went wrong');
    // A playlist made for this import stays (never deleted from here: a lost
    // answer may have queued downloads that will land in it); the toast says so.
    if (created) {
      showToast(tf('search.importCreatedFailed', 'Made “{name}”, but its songs could not be queued: {error}. Import again into it.', { name: playlist.name, error }), 'error',
        { duration: 10000, action: { label: t('search.openPlaylist', 'Open'), onClick: () => navigateTo(playlistPath(playlist.id)) } });
    } else {
      showToast(tf('search.importFailed', 'Could not import: {error}', { error }), 'error');
    }
    return;
  }
  const added = r.body.added_to_playlist || 0;
  const requested = (r.body.jobs || []).length;
  for (const j of r.body.jobs || []) { const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(j.input || ''); if (m) S.requested.add(m[1]); }
  const failed = (r.body.failed || []).length;
  let msg = tf('search.importDone', '“{name}”: {added} added now, {requested} requested. Downloads are in Activity.', { name: playlist.name, added, requested });
  if (failed) msg += ` ${tf('search.importSomeFailed', '{count} could not be queued.', { count: failed })}`;
  showToast(msg, failed ? 'error' : 'success', { duration: 8000, action: { label: t('search.openPlaylist', 'Open'), onClick: () => navigateTo(playlistPath(playlist.id)) } });
  render();
}

function openRow(row: HTMLElement): void {
  const d = S.rows.get(row.dataset.key as string);
  if (!d) return;
  if (d.kind === 'song') playSong(d);
  else if (d.kind === 'artist') navigateTo(artistPath(d.artist.key));
  else if (d.kind === 'playlist') navigateTo(playlistPath(d.playlist.id));
  else if (d.kind === 'ytgo') searchYouTube(S.query, { reveal: true });
  else if (d.kind === 'import') startImport(d.outcome, row);
  else if (d.kind === 'video') openContextMenu({ anchor: row.querySelector<HTMLElement>('.search-yt-menu') || row }, videoMenuItems(d.video, row), { label: t('search.more', 'More actions'), returnFocus: row, focusFirst: true });
}

function resultRows(): HTMLElement[] {
  const root = $('search-results');
  return root ? [...root.querySelectorAll<HTMLElement>('[data-nav]')].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null) : [];
}

// ------------------------------------------------------------------- setup

export function setupSearch(): void {
  const bar = $('app-search');
  const input = $<HTMLInputElement>('app-search-input');
  if (!bar || !input) return;

  input.addEventListener('input', (e) => {
    syncKbd();
    if ((e as InputEvent).isComposing) return; // the compositionend input follows
    applyInput();
  });
  input.addEventListener('compositionend', () => applyInput());
  // Starting a search on an editable playlist page: it adds there.
  input.addEventListener('focus', armTarget);
  input.addEventListener('keydown', onFieldKeydown);
  bar.addEventListener('submit', (e) => e.preventDefault());

  // Ctrl+K / Cmd+K from anywhere, also from another input. Not over a dialog.
  window.addEventListener('keydown', (e) => {
    if (!isSearchShortcut(e, isMac())) return;
    if (!document.body.classList.contains('has-plnav') || document.querySelector('.app-modal')) return;
    const view = document.querySelector('.view.active');
    if (view && view.id === 'dashboard-view') return;
    e.preventDefault();
    focusSearch();
  }, true);

  // The phone row and the drawer: the search page, field focused.
  for (const id of ['places-search', 'plnav-nav-search']) {
    const link = $(id);
    if (link) link.addEventListener('click', (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      closeDrawer();
      armTarget(); // from an editable playlist page: adds there
      navigateTo(searchPath(S.open ? S.query : ''));
      byId('app-search-input').focus();
    });
  }

  const back = $('search-back');
  if (back) back.addEventListener('click', () => navigateTo(S.from || '/'));

  const target = $('search-target');
  if (target) target.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.search-target-clear')) return;
    S.sessionTarget = null;
    refreshPlaceholder();
    render();
    renderTarget();
    input.focus();
  });

  const root = byId('search-results');
  root.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; });
  root.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-retry-songs')) { S.songsState = 'loading'; render(); loadSongs(S.query); return; }
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-yt-retry')) { searchYouTube(S.query, { retry: true }); return; }
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-link-retry')) { linkCache.delete((S.link && S.link.input) as string); runQuery(S.query, { force: true }); return; }
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-more')) { S.showAll = true; render(); resultRows()[SONGS_SHOWN]?.focus(); return; }
    if (!row) return;
    const d = S.rows.get(row.dataset.key as string);
    if (!d) return;
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-play')) { togglePlay(d as SongRow); return; }
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-add')) { addOne(d, (e.target as HTMLElement).closest<HTMLElement>('.search-add') as HTMLElement); return; }
    if ((e.target as HTMLElement).closest<HTMLElement>('.search-request')) { requestOne((d as VideoRow).video, (e.target as HTMLElement).closest<HTMLElement>('.search-request') as HTMLElement); return; }
    if (d.kind === 'ytgo' || d.kind === 'import') { openRow(row); return; }
    if ((e.target as HTMLElement).closest<HTMLElement>('button, a[href]')) return;
    // Song rows: a click selects (a double-click plays), a tap plays.
    if (d.kind === 'song') {
      if (lastPointer === 'mouse') row.focus({ preventScroll: true });
      else playSong(d);
      return;
    }
    if (d.kind === 'video') { row.focus({ preventScroll: true }); return; }
    openRow(row);
  });
  root.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.search-song');
    if (!row || (e.target as HTMLElement).closest<HTMLElement>('button, a[href]')) return;
    const d = S.rows.get(row.dataset.key as string);
    if (d) playSong(d as SongRow); // .search-song rows are songs
  });
  root.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
    if (!row) return;
    const onRow = e.target === row;
    // (A button row, the import and the YouTube one, acts as a button does.)
    if (onRow && row.tagName !== 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) {
      if (e.repeat) return;
      e.preventDefault();
      openRow(row);
      return;
    }
    if (onRow && isAddKey(e)) {
      const d = S.rows.get(row.dataset.key as string);
      if (d && (d.kind === 'song' || d.kind === 'video')) {
        e.preventDefault();
        addOne(d, row.querySelector<HTMLElement>('.search-add, .search-request') || row, row);
      }
      return;
    }
    const rows = resultRows();
    const at = rows.indexOf(row);
    const to = at < 0 ? null : rowStep(at, e.key, rows.length);
    if (to === null || (!onRow && (e.key === 'Home' || e.key === 'End'))) return;
    e.preventDefault();
    if (to < 0) { input.focus(); return; }
    rows[to].focus();
    rows[to].scrollIntoView({ block: 'nearest' });
  });

  // The usual song menu on library rows; the YouTube rows' own.
  bindSongMenu(root, '.search-song', (row) => {
    const d = S.rows.get(row.dataset.key as string);
    return d && d.kind === 'song' ? { songId: d.song.id, url: d.track.url, title: d.song.title, artist: d.song.artist, youtubeId: d.song.youtube_id || null } : null;
  });
  bindContextMenu(root, {
    rowSelector: '.search-yt',
    triggerSelector: '.search-yt-menu',
    label: () => t('search.more', 'More actions'),
    getItems: (row) => {
      const d = S.rows.get(row.dataset.key as string);
      return d && d.kind === 'video' ? videoMenuItems(d.video, row.querySelector<HTMLElement>('.search-request') || row) : null;
    },
  });

  // Remember the playlist last played from (the one-step add's target).
  player.on('context', (ctx) => {
    const id = lastPlayedFrom(ctx);
    if (id) storageSet(LAST_PLAYED_KEY, id);
    refreshIfChanged();
  });
  player.on('track', paintPlaying);
  player.on('state', paintPlaying);
  // The list is refetched often (every 30s, on queue changes): re-render only
  // when what the page shows from it changed, so an open menu is left alone.
  onPlaylists(() => { refreshPlaceholder(); refreshIfChanged(); });

  document.addEventListener('app:viewchange', syncBar);
  // The playlist page's name or edit right changed (playlist.ts).
  document.addEventListener('app:playlistmeta', refreshPlaceholder);
  // An empty playlist's "Find songs" (queue.ts).
  document.addEventListener('app:focus-search', () => focusSearch());
  window.matchMedia('(width < 768px)').addEventListener('change', syncBar);
  window.addEventListener('languageChanged', () => { refreshPlaceholder(); syncKbd(); if (S.open) { setTitle(); render(); } });
  syncKbd();
  syncBar();
}

/**
 * library:updated: refetch the songs only when the change can touch them
 * (search-rules.ts libraryChangeMatters), coalesced, and only while the page
 * is on screen; otherwise once it is again.
 */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const pageVisible = (): boolean => S.open && document.visibilityState === 'visible' && !!$('search-view') && byId('search-view').classList.contains('active');
export function handleSearchLibraryUpdated(payload: LibraryChange | null | undefined): void {
  if (!S.open || S.mode !== 'text' || !S.query) return;
  if (!libraryChangeMatters(payload, S.songs.map((x) => x.id))) return;
  if (!pageVisible()) { S.stale = true; return; }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { S.stale = false; if (pageVisible()) refreshSongs(); else S.stale = true; }, LIBRARY_REFRESH_MS);
}
document.addEventListener('visibilitychange', () => {
  if (S.stale && pageVisible()) { S.stale = false; refreshSongs(); }
});
