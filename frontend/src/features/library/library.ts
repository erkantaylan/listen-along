// Music library page: every song in the library (searchable, with uploader)
// plus the list of song requests waiting for an upload. Songs are added to the
// current lobby's queue from here.
import { state } from '../../shared/state.ts';
import { showToast, formatDuration, notifyViewChange } from '../../shared/ui.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import { libraryPath, basePath } from '../../router.ts';
import type { LibraryState, LibraryTab, LibrarySort, RequestStatus } from '../../router.ts';
import { player } from '../../player/player.ts';
import { setupDownloads, showDownloads, hideDownloads } from './jobs.ts';
import { clearReplacedFailure } from '../../player/playback-failures.ts';
import { bindSongMenu, songMenuButtonHtml, reportIconHtml, reportLines, reportsFor, onReportsChange, reportedCount, reportsLoaded, handleReportsUpdated, isReportDialogOpen } from './song-reports.ts';
import { isContextMenuOpen } from '../../shared/context-menu.ts';
import { openReplaceDialog } from './replace-dialog.ts';
import { addSongToPlaylist } from '../playlists/add-to-playlist.ts';
import type { ApiError, LibraryListResponse, LibrarySong, LibraryUpdatedPayload, RequestListResponse, SongRequest, Track } from '../../shared/types.ts';

/** What libraryTrack needs of a song: a LibrarySong, or the lean StationSong / ArtistSong rows (Radio, the artist page). */
export type TrackSource = Pick<LibrarySong, 'id' | 'title' | 'artist' | 'youtube_id' | 'file_version' | 'duration_sec'>;

/** library:updated as read here: every LibraryUpdatedPayload variant fits, each field optional. */
export interface LibraryUpdatedView {
  removed?: string;
  reports?: { id: string };
  song?: LibrarySong;
  replaced?: Extract<LibraryUpdatedPayload, { replaced: unknown }>['replaced'];
  details?: Extract<LibraryUpdatedPayload, { details: unknown }>['details'];
}

// The overlay's own state: the URL's LibraryState plus what the page keeps.
interface LibraryPage extends LibraryState {
  open: boolean;
  songs: LibrarySong[];
  total: number;
  loading: boolean;
  searchTimer: ReturnType<typeof setTimeout> | undefined;
  loadSeq: number;
}

// Escapes for both text and attribute contexts (ui.ts escapeHtml leaves quotes).
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

const PAGE_SIZE = 20;

const lib: LibraryPage = {
  open: false,
  tab: 'library',
  songs: [],
  total: 0,
  page: 0,
  loading: false,
  query: '',
  sort: 'recent',
  requestStatus: 'pending',
  searchTimer: undefined,
  loadSeq: 0,
};

// --- Playing ----------------------------------------------------------------
// The ▶ button plays the song in the app-wide player (player.ts), like any
// other song: the bar shows it, it keeps playing across pages and lock-screen
// controls work. The context is the library page as shown (current search and
// sort), starting at the clicked song, so Next continues down the page and
// stops at its end (pages are fetched from the server one at a time). Playing
// from here replaces the current context (e.g. a lobby queue). Each row's
// button follows the player: the song that is playing shows pause.

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const REPLACE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

// Library songs as player tracks. Queue entries refer to library songs as
// `library:<id>`, so the same song playing from a lobby also counts.
export function libraryTrack(song: TrackSource): Track {
  return {
    libraryId: song.id,
    url: `library:${song.id}`,
    // The file version makes the url change when the audio is replaced.
    src: `/api/library/${encodeURIComponent(song.id)}/file${song.file_version ? `?v=${encodeURIComponent(song.file_version)}` : ''}`,
    title: song.title,
    artist: song.artist || '',
    youtubeId: song.youtube_id || null,
    thumbnail: song.youtube_id ? `https://i.ytimg.com/vi/${encodeURIComponent(song.youtube_id)}/hqdefault.jpg` : null,
    duration: song.duration_sec || 0,
  };
}

// songId: a row's data-id (always set on the rows this page renders).
function isCurrentSong(songId: string | undefined): boolean {
  const t = player.track;
  return !!t && (t.libraryId === songId || t.url === `library:${songId}`);
}

function songPlaying(songId: string | undefined): boolean {
  return isCurrentSong(songId) && player.isPlaying;
}

function playButtonHtml(songId: string): string {
  const playing = songPlaying(songId);
  return `<button class="btn-outline theme-secondary btn-icon btn-sm rounded-pill libpage-play${playing ? ' playing' : ''}" data-id="${escapeHtml(songId)}" type="button" aria-label="${playing ? 'Pause' : 'Play'}" title="${playing ? 'Pause' : 'Play'}">${playing ? PAUSE_ICON : PLAY_ICON}</button>`;
}

function updatePlayButtons(): void {
  document.querySelectorAll<HTMLElement>('.libpage-play').forEach((btn) => {
    const playing = songPlaying(btn.dataset.id);
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    btn.title = playing ? 'Pause' : 'Play';
  });
  document.querySelectorAll<HTMLElement>('#libpage-list .libpage-item').forEach((li) => {
    li.classList.toggle('is-playing', isCurrentSong(li.dataset.id));
  });
}

player.on('state', updatePlayButtons);
player.on('track', updatePlayButtons);

function playSong(songId: string): void {
  if (isCurrentSong(songId)) { player.toggle(); return; }
  const index = lib.songs.findIndex((s) => s.id === songId);
  if (index < 0) return;
  player.playFrom({ type: 'library' }, lib.songs.map(libraryTrack), index);
}

// A click on the row plays it (Spotify-like); the song already playing is
// resumed if paused, never restarted or paused (the ▶ button toggles).
function playRow(songId: string): void {
  if (isCurrentSong(songId)) { if (!player.isPlaying) player.play(); return; }
  playSong(songId);
}

function relativeDate(value: string | number): string {
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function thumbHtml(youtubeId: string | null): string {
  if (youtubeId) {
    return `<img class="app-thumb libpage-thumb" src="https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/default.jpg" alt="" loading="lazy">`;
  }
  return '<div class="app-thumb libpage-thumb"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>';
}

// "added by Ayşe", or "uploaded by living-room-pc (Ayşe)" when a downloader
// (`la worker`) did it; plus who asked for it, if anyone.
function uploaderHtml(song: LibrarySong): string {
  const who = escapeHtml(song.uploaded_by || 'unknown');
  const by = song.uploaded_by_worker ? `uploaded by ${escapeHtml(song.uploaded_by_worker)} (${who})` : `added by ${who}`;
  return song.requested_by ? `${by} · asked by ${escapeHtml(song.requested_by)}` : by;
}

function updateContext(): void {
  const el = maybeById('libpage-context');
  if (!el) return;
  if (state.lobbyId) {
    el.textContent = `Adding to: ${state.lobbyName || state.lobbyId}`;
    el.classList.remove('muted');
  } else {
    el.textContent = 'Open a playlist to add songs to it';
    el.classList.add('muted');
  }
}

// --- Songs ----------------------------------------------------------------

// Queue entries point at library songs by url: `library:<uuid>`, or the
// YouTube watch URL for songs with a YouTube id (backend library.queueUrlFor).
// Older entries may carry the song's source_url instead.
function youtubeIdFromUrl(url: string): string | null {
  const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

function queuedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const item of state.queue || []) {
    if (!item || !item.url) continue;
    keys.add(item.url);
    const yt = youtubeIdFromUrl(item.url);
    if (yt) keys.add(`yt:${yt}`);
  }
  return keys;
}

function isQueued(song: LibrarySong, keys: Set<string>): boolean {
  return keys.has(`library:${song.id}`)
    || (!!song.youtube_id && keys.has(`yt:${song.youtube_id}`))
    || (!!song.source_url && keys.has(song.source_url));
}

// Add button state: no lobby, already in this lobby's queue (it can still be
// added again, after a question), or addable.
function setAddButton(btn: HTMLButtonElement, song: LibrarySong, keys: Set<string>): void {
  const queued = !!state.lobbyId && isQueued(song, keys);
  btn.disabled = !state.lobbyId;
  btn.classList.toggle('added', queued);
  btn.textContent = queued ? 'Added' : 'Add';
  if (!state.lobbyId) btn.title = 'Open a playlist first';
  else if (queued) btn.title = 'Already in this playlist. Click to add it again';
  else btn.removeAttribute('title');
}

// Called whenever the queue (or the lobby) changes, so the buttons follow
// songs being added elsewhere or removed from the queue.
export function refreshLibraryAddButtons(): void {
  if (!lib.open) return;
  updateContext();
  const keys = queuedKeys();
  document.querySelectorAll<HTMLButtonElement>('#libpage-list .libpage-add').forEach((btn) => {
    const song = lib.songs.find((s) => s.id === btn.dataset.id);
    if (song) setAddButton(btn, song, keys);
  });
}

function renderSongs(): void {
  const list = maybeById('libpage-list');
  if (!list) return;
  const count = maybeById('libpage-count');
  if (count && lib.tab !== 'broken') count.textContent = lib.total ? String(lib.total) : '';
  renderBrokenCount();
  if (!lib.songs.length) {
    const empty = lib.tab === 'broken'
      ? (lib.query ? 'No reported songs match your search' : 'Nothing needs replacement. Right-click a song (or use its ⋮ button) to mark it as broken.')
      : (lib.query ? 'No songs match your search' : 'The library is empty. Songs appear here once they are uploaded.');
    list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${lib.loading ? 'Loading…' : empty}</li>`;
  } else {
    list.innerHTML = lib.songs.map((song) => {
      const sub = [song.artist, song.album].filter(Boolean).map(escapeHtml).join(' · ');
      // Open "needs replacement" reports: the live store, else what the list sent.
      const reports = reportsLoaded() ? reportsFor({ songId: song.id }) : (song.reports || []);
      const reportsHtml = lib.tab === 'broken' && reports.length
        ? `<ul class="list-unstyled fs-xs fg-2 mb-0 mt-1 libpage-reports">${reportLines(reports).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
        : '';
      const meta = [
        song.duration_sec ? formatDuration(song.duration_sec) : '',
        uploaderHtml(song),
        relativeDate(song.created_at),
      ].filter(Boolean).join(' · ');
      return `<li class="list-group-item list-group-item-action libpage-item${isCurrentSong(song.id) ? ' is-playing' : ''}" data-id="${escapeHtml(song.id)}" tabindex="0">
        ${thumbHtml(song.youtube_id)}
        <div class="libpage-info min-w-0">
          <div class="d-flex align-items-center gap-1 min-w-0 libpage-title-row"><div class="text-truncate libpage-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>${reportIconHtml(reports)}</div>
          <div class="fs-sm fg-2 text-truncate libpage-sub">${sub}</div>
          <div class="fs-xs fg-3 libpage-meta">${meta}</div>
          ${reportsHtml}
        </div>
        ${playButtonHtml(song.id)}
        <button class="btn-text theme-secondary btn-icon btn-sm libpage-replace" type="button" data-id="${escapeHtml(song.id)}" aria-label="Replace ${escapeHtml(song.title)} with…" title="Replace with…">${REPLACE_ICON}</button>
        <button class="btn-solid theme-primary btn-sm libpage-add" type="button" data-id="${escapeHtml(song.id)}">Add</button>
        ${songMenuButtonHtml(song.title)}
      </li>`;
    }).join('');
    const keys = queuedKeys();
    list.querySelectorAll<HTMLButtonElement>('.libpage-add').forEach((btn, i) => setAddButton(btn, lib.songs[i], keys));
  }
  renderPager();
}

function renderBrokenCount(): void {
  const el = maybeById('libpage-broken-count');
  if (!el) return;
  const n = reportedCount();
  el.textContent = n ? String(n) : '';
  el.hidden = !n;
}

// Marked / unmarked anywhere: badges and the tab count follow.
onReportsChange(() => { if (lib.open) renderSongs(); });

function pageCount(): number {
  return Math.max(1, Math.ceil(lib.total / PAGE_SIZE));
}

// Page numbers to show: first, last, and two (one on phones) either side of
// the current page, with null for each gap ("…").
function pageItems(current: number, count: number): (number | null)[] {
  const around = window.matchMedia('(max-width: 480px)').matches ? 1 : 2;
  const keep = new Set([0, count - 1]);
  for (let i = current - around; i <= current + around; i++) if (i >= 0 && i < count) keep.add(i);
  const items: (number | null)[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i - prev > 1) items.push(null);
    items.push(i);
    prev = i;
  }
  return items;
}

// Two pagers share one state: a compact "‹ Page 5 of 30 ›" above the list
// and the full numbered one below it. Both hide when there is one page.
function renderPager(): void {
  const pager = maybeById('libpage-pager');
  const top = maybeById('libpage-pager-top');
  if (!pager || !top) return;
  const count = pageCount();
  if (lib.total <= PAGE_SIZE) {
    pager.hidden = true; pager.innerHTML = '';
    top.hidden = true; top.innerHTML = '';
    return;
  }
  pager.hidden = false;
  top.hidden = false;
  const p = lib.page;
  const step = (page: number, label: string, aria: string, disabled: boolean): string =>
    `<button class="btn-outline theme-secondary btn-icon btn-sm libpage-page" type="button" data-page="${page}" aria-label="${aria}" title="${aria}"${disabled ? ' disabled' : ''}>${label}</button>`;
  top.innerHTML = `
    ${step(p - 1, '‹', 'Previous page', p === 0)}
    <span class="fs-sm fg-2 libpage-pager-label" aria-live="polite">Page ${(p + 1).toLocaleString()} of ${count.toLocaleString()}</span>
    ${step(p + 1, '›', 'Next page', p >= count - 1)}`;
  const from = p * PAGE_SIZE + 1;
  const to = Math.min(lib.total, (p + 1) * PAGE_SIZE);
  const item = (page: number, label: string | number, { current = false, disabled = false, aria = '' }: { current?: boolean; disabled?: boolean; aria?: string } = {}): string =>
    `<li class="page-item${current ? ' active' : ''}${disabled ? ' disabled' : ''}"><button class="page-link libpage-page" type="button" data-page="${page}"${disabled ? ' disabled' : ''}${current ? ' aria-current="page"' : ''}${aria ? ` aria-label="${aria}"` : ''}>${label}</button></li>`;
  pager.innerHTML = `
    <ul class="pagination pagination-sm mb-0 libpage-pages">
      ${item(p - 1, '‹', { disabled: p === 0, aria: 'Previous page' })}
      ${pageItems(p, count).map((i) => (i === null ? '<li class="page-item disabled" aria-hidden="true"><span class="page-link libpage-gap">…</span></li>' : item(i, i + 1, { current: i === p, aria: `Page ${i + 1}` }))).join('')}
      ${item(p + 1, '›', { disabled: p >= count - 1, aria: 'Next page' })}
    </ul>
    <span class="fs-sm fg-3 libpage-range">${from.toLocaleString()}–${to.toLocaleString()} of ${lib.total.toLocaleString()}</span>`;
}

function goToPage(page: number): void {
  if (page < 0 || page >= pageCount() || page === lib.page) return;
  loadSongs({ page });
  syncUrl('push');
  const list = maybeById('libpage-list');
  if (list) list.scrollTop = 0;
}

// refresh: reload the current page in place (library:updated) instead of
// blanking the list while it loads.
async function loadSongs({ page = 0, refresh = false }: { page?: number; refresh?: boolean } = {}): Promise<void> {
  const seq = ++lib.loadSeq;
  lib.loading = true;
  lib.page = page;
  if (!refresh) { lib.songs = []; renderSongs(); }
  const params = new URLSearchParams({
    q: lib.query,
    sort: lib.sort,
    ...(lib.tab === 'broken' ? { reported: '1' } : {}),
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  try {
    const res = await fetch(`/api/library?${params}`);
    const data = await res.json() as LibraryListResponse & Partial<ApiError>;
    if (seq !== lib.loadSeq) return; // a newer search superseded this one
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lib.songs = data.songs;
    lib.total = data.total;
    // The page can vanish under us (songs deleted, narrower search): step back.
    if (!lib.songs.length && page > 0 && page >= pageCount()) {
      loadSongs({ page: pageCount() - 1, refresh });
      if (lib.open) syncUrl('replace');
      return;
    }
  } catch (err) {
    if (seq !== lib.loadSeq) return;
    showToast(`Could not load the library: ${(err as Error).message}`, 'error');
  } finally {
    if (seq === lib.loadSeq) { lib.loading = false; renderSongs(); }
  }
}

// The same path as the song menu's Add to playlist: the server refuses the same
// song twice, and the user is asked before it is added again.
async function addToQueue(songId: string, btn: HTMLButtonElement | null): Promise<void> {
  if (!state.lobbyId) { showToast('Open a playlist first', 'error'); return; }
  const song = lib.songs.find((s) => s.id === songId);
  if (btn) btn.disabled = true;
  try {
    await addSongToPlaylist({ id: state.lobbyId, name: state.lobbyName }, { songId, title: song ? song.title : '' }, { returnFocus: btn });
  } finally {
    // The queue:update that follows marks it "Added".
    if (btn && document.contains(btn)) btn.disabled = !state.lobbyId;
  }
}

// --- Requests -------------------------------------------------------------

const STATUS_THEMES: Record<SongRequest['status'], string> = { pending: 'theme-warning', fulfilled: 'theme-success', dismissed: 'theme-secondary' };
function statusBadge(status: SongRequest['status']): string {
  const label = { pending: 'waiting', fulfilled: 'uploaded', dismissed: 'not found' }[status] || status;
  return `<span class="badge badge-subtle ${STATUS_THEMES[status] || 'theme-secondary'} libpage-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

async function loadRequests(): Promise<void> {
  const list = maybeById('libpage-requests');
  try {
    const res = await fetch(`/api/requests?status=${encodeURIComponent(lib.requestStatus)}`);
    const data = await res.json() as RequestListResponse & Partial<ApiError>;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const requests = data.requests || [];
    if (lib.requestStatus === 'pending') setRequestCount(requests.length);
    if (!list) return;
    if (!requests.length) {
      list.innerHTML = `<li class="list-group-item app-empty libpage-empty">${lib.requestStatus === 'pending' ? 'No songs are waiting. Anything you queue that is not in the library shows up here.' : 'Nothing here yet.'}</li>`;
      return;
    }
    list.innerHTML = requests.map((r) => {
      const title = r.title || r.youtube_id || r.url || 'Unknown song';
      const sub = [r.artist, r.youtube_id ? `YouTube ${r.youtube_id}` : (r.url || '')].filter(Boolean).map(escapeHtml).join(' · ');
      const link = r.youtube_id ? `https://www.youtube.com/watch?v=${encodeURIComponent(r.youtube_id)}` : (r.url && /^https?:\/\//.test(r.url) ? r.url : null);
      return `<li class="list-group-item libpage-item">
        ${thumbHtml(r.youtube_id)}
        <div class="libpage-info min-w-0">
          <div class="text-truncate libpage-title" title="${escapeHtml(title)}">${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>` : escapeHtml(title)}</div>
          <div class="fs-sm fg-2 text-truncate libpage-sub">${sub}</div>
          <div class="fs-xs fg-3 libpage-meta">requested by ${escapeHtml(r.requested_by)} · ${relativeDate(r.created_at)}</div>
        </div>
        ${statusBadge(r.status)}
      </li>`;
    }).join('');
  } catch (err) {
    if (list) list.innerHTML = `<li class="list-group-item app-empty libpage-empty">Could not load requests: ${escapeHtml((err as Error).message)}</li>`;
  }
}

function setRequestCount(n: number): void {
  const el = maybeById('libpage-requests-count');
  if (el) { el.textContent = n ? String(n) : ''; el.hidden = !n; }
}

async function refreshRequestCount(): Promise<void> {
  try {
    const res = await fetch('/api/requests?status=pending');
    if (!res.ok) return;
    const data = await res.json() as RequestListResponse;
    setRequestCount((data.requests || []).length);
  } catch {}
}

// --- URL ------------------------------------------------------------------
// The address bar follows the library state (frontend/src/router.ts has the
// scheme): tabs and pages push a history entry, search/sort/filter replace it.
// history.state.libDepth counts the library entries pushed since it was opened
// in-app, so closing it can step back past them instead of adding another.

function syncUrl(mode: 'push' | 'replace'): void {
  const url = libraryPath(state.lobbyId, lib);
  if (window.location.pathname + window.location.search === url) return;
  if (mode === 'push') {
    const depth: number | null | undefined = history.state && history.state.libDepth;
    history.pushState(depth ? { libDepth: depth + 1 } : null, '', url);
  } else {
    history.replaceState(history.state, '', url);
  }
}

function syncControls(): void {
  const search = maybeById<HTMLInputElement>('libpage-search');
  if (search && search.value.trim() !== lib.query) search.value = lib.query;
  const sort = maybeById<HTMLSelectElement>('libpage-sort');
  if (sort) sort.value = lib.sort;
  const status = maybeById<HTMLSelectElement>('libpage-request-status');
  if (status) status.value = lib.requestStatus;
}

export function isLibraryOpen(): boolean {
  return lib.open;
}

// Show the library in the state a URL asks for (direct load, Back/Forward).
// Leaves the address bar alone; it already says this.
export function showLibraryRoute(route: LibraryState): void {
  const page = maybeById('library-page');
  if (!page) return;
  const wasOpen = lib.open;
  const songsChanged = !wasOpen || route.query !== lib.query || route.sort !== lib.sort || route.page !== lib.page;
  const requestsChanged = route.requestStatus !== lib.requestStatus;
  clearTimeout(lib.searchTimer);
  lib.query = route.query;
  lib.sort = route.sort;
  lib.requestStatus = route.requestStatus;
  syncControls();
  if (!wasOpen) {
    lib.open = true;
    page.hidden = false;
    document.body.classList.add('libpage-open');
    refreshRequestCount();
    notifyViewChange();
  }
  updateContext();
  const tabChanged = route.tab !== lib.tab;
  const songsTabSwitch = tabChanged && ['library', 'broken'].includes(route.tab) && ['library', 'broken'].includes(lib.tab);
  if (!wasOpen || tabChanged || (route.tab === 'requests' && requestsChanged)) {
    // switchTab reloads on a Songs <-> Broken switch; do it once, at the right page.
    if (songsTabSwitch) { lib.tab = route.tab; switchTab(route.tab); }
    else switchTab(route.tab);
  }
  if (songsChanged || songsTabSwitch) loadSongs({ page: route.page });
}

// Close button / Escape: step back to the page the library was opened from,
// or (opened from a link) go to the view underneath it.
function requestCloseLibrary(): void {
  const depth: number | null | undefined = history.state && history.state.libDepth;
  closeLibraryPage();
  if (depth) history.go(-depth);
  else history.pushState(null, '', basePath({ view: state.lobbyId ? 'lobby' : 'landing', lobbyId: state.lobbyId }));
}

// --- Page -----------------------------------------------------------------

// "Broken" (needs replacement) is the Songs panel filtered to reported songs.
function switchTab(tab: LibraryTab): void {
  const songsMode = (t: LibraryTab) => (t === 'broken' ? 'broken' : t === 'library' ? 'library' : null);
  const reload = lib.open && songsMode(tab) && songsMode(lib.tab) && tab !== lib.tab;
  lib.tab = tab;
  document.querySelectorAll<HTMLElement>('#library-page .libpage-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.libtab === tab);
    if (b.dataset.libtab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  byId('libpage-songs-panel').hidden = tab !== 'library' && tab !== 'broken';
  const hint = maybeById('libpage-broken-hint');
  if (hint) hint.hidden = tab !== 'broken';
  byId('libpage-requests-panel').hidden = tab !== 'requests';
  byId('libpage-downloads-panel').hidden = tab !== 'downloads';
  if (tab === 'requests') loadRequests();
  if (tab === 'downloads') showDownloads(); else hideDownloads();
  if (reload) loadSongs();
}

export function openLibraryPage(tab: LibraryTab = 'library'): void {
  const page = maybeById('library-page');
  if (!page) return;
  lib.open = true;
  page.hidden = false;
  document.body.classList.add('libpage-open');
  notifyViewChange();
  updateContext();
  switchTab(tab);
  loadSongs();
  refreshRequestCount();
  syncControls();
  history.pushState({ libDepth: 1 }, '', libraryPath(state.lobbyId, lib));
  const search = maybeById<HTMLInputElement>('libpage-search');
  if (search && tab === 'library' && window.matchMedia('(pointer: fine)').matches) search.focus();
  const dlInput = maybeById<HTMLInputElement>('dl-input');
  if (dlInput && tab === 'downloads' && window.matchMedia('(pointer: fine)').matches) dlInput.focus();
}

export function closeLibraryPage(): void {
  const page = maybeById('library-page');
  if (!page) return;
  lib.open = false;
  page.hidden = true;
  document.body.classList.remove('libpage-open');
  hideDownloads();
  notifyViewChange();
}

// payload.replaced: a song's audio was replaced (same id). Whatever is
// playing it reloads the new file at the same position (player.ts).
// payload.details: only its title, artist or album changed; the audio plays on.
export function handleLibraryUpdated(payload: LibraryUpdatedView | null | undefined): void {
  if (payload && payload.replaced) { clearReplacedFailure(payload.replaced); player.reloadReplaced(payload.replaced, payload.song); }
  if (payload && payload.details) player.updateDetails(payload.details, payload.song);
  handleReportsUpdated();
  if (lib.open) loadSongs({ page: lib.page, refresh: true });
}

export function handleRequestsUpdated(): void {
  if (!lib.open) return;
  if (lib.tab === 'requests') loadRequests();
  else refreshRequestCount();
}

export function setupLibraryPage(): void {
  const page = maybeById('library-page');
  if (!page) return;
  byId('libpage-close').addEventListener('click', requestCloseLibrary);
  setupDownloads();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lib.open && !maybeById('replace-dialog') && !isReportDialogOpen() && !isContextMenuOpen()) requestCloseLibrary();
  });
  // Right-click / long-press / ⋮ on a song row: the song menu (song-reports.ts).
  bindSongMenu(byId('libpage-list'), '.libpage-item[data-id]', (row) => {
    const song = lib.songs.find((s) => s.id === row.dataset.id);
    return song ? { songId: song.id, title: song.title, artist: song.artist, youtubeId: song.youtube_id, sourceUrl: song.source_url } : null;
  });
  page.querySelectorAll<HTMLElement>('.libpage-tab').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.libtab === lib.tab) return;
    switchTab(b.dataset.libtab as LibraryTab);
    syncUrl('push');
  }));
  byId('libpage-search').addEventListener('input', (e) => {
    clearTimeout(lib.searchTimer);
    lib.searchTimer = setTimeout(() => { lib.query = (e.target as HTMLInputElement).value.trim(); loadSongs(); syncUrl('replace'); }, 250);
  });
  byId('libpage-sort').addEventListener('change', (e) => { lib.sort = (e.target as HTMLSelectElement).value as LibrarySort; loadSongs(); syncUrl('replace'); });
  const onPagerClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.libpage-page');
    if (btn && !btn.disabled) goToPage(Number(btn.dataset.page));
  };
  byId('libpage-pager').addEventListener('click', onPagerClick);
  byId('libpage-pager-top').addEventListener('click', onPagerClick);
  byId('libpage-request-status').addEventListener('change', (e) => { lib.requestStatus = (e.target as HTMLSelectElement).value as RequestStatus; loadRequests(); syncUrl('replace'); });
  byId('libpage-list').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const play = target.closest<HTMLElement>('.libpage-play');
    if (play) { playSong(play.dataset.id as string); return; }
    const replace = target.closest<HTMLElement>('.libpage-replace');
    if (replace) { openReplaceDialog({ songId: replace.dataset.id as string, returnFocus: replace }); return; }
    const btn = target.closest<HTMLButtonElement>('.libpage-add');
    if (btn) { addToQueue(btn.dataset.id as string, btn); return; }
    if (target.closest('button, a[href], input, select, textarea')) return;
    const row = target.closest<HTMLElement>('.libpage-item[data-id]');
    if (row) playRow(row.dataset.id as string);
  });
  byId('libpage-list').addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('.libpage-item[data-id]');
    if (!row || e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    playRow(row.dataset.id as string);
  });
}
