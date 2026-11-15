// Radio: every song of the library in your own shuffled order, at /radio. It
// acts like a playlist (opening it plays nothing; Play or a row starts it) but
// is not one: no owner, no edit mode, nothing stored. A station is a list of
// songs from a rule on the server (backend/src/stations.js); "all" is the only
// one so far. The order is made here (radio-order.ts) and stays while the view
// is open and for as long as Radio is what the player plays from; opening the
// page when it is not gives a fresh shuffle. When the list runs out the player
// asks for the next round (player.setRefill).
// The search field filters what the page shows (radio-search.ts). It never
// touches the order or the player: a song picked from the results plays from
// its place in the full order, and Radio goes on through the whole station.
import { state } from '../../shared/state.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import { escapeHtml, formatDuration, navigateTo, showToast, t } from '../../shared/ui.ts';
import { player } from '../../player/player.ts';
import type { PlayerContextInput } from '../../player/player.ts';
import { libraryTrack } from '../library/library.ts';
import { playCellHtml, playCellLabel, statsHtml } from '../queue/queue.ts';
import { closeDrawer } from '../playlists/sidebar.ts';
import { bindSongMenu, songMenuButtonHtml } from '../library/song-reports.ts';
import { isUnplayable, unplayableBadgeHtml, onFailuresChange } from '../../player/playback-failures.ts';
import { createVirtualList } from '../../shared/virtual-list.ts';
import type { VirtualList } from '../../shared/virtual-list.ts';
import { nextRound, reconcile, reshuffledAround, shuffled } from './radio-order.ts';
import { firstShown, matchingPositions, searchStatus, songHaystack } from './radio-search.ts';
import type { Station, StationWithSongs, Track } from '../../shared/types.ts';

const STATION = 'all';
const CONTEXT: PlayerContextInput = { type: 'radio', stationId: STATION };
const REFRESH_MS = 1000;

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
const language = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || undefined;

interface RadioPage {
  open: boolean;
  loading: boolean;
  failed: boolean;
  order: Track[];
  load: number;
  autoplay: boolean;
  query: string;
  shown: number[];
}

const page: RadioPage = {
  open: false,
  loading: false,
  failed: false,
  order: [],  // the tracks on screen; the player's queue while Radio plays
  load: 0,    // the latest fetch; older answers are dropped
  autoplay: false, // play the top as soon as the list is here
  query: '',  // the search field
  shown: [],  // positions in order the list shows (all of them without a search)
};
let summary: Pick<Station, 'count' | 'duration_sec'> | null = null; // { count, duration_sec }
let stationIds: Set<string | undefined> | null = null; // the song ids the station held at the last look
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
// Search: each song's album (the station list has it, the track does not) and
// its folded text, made once per song rather than per keystroke.
const albums = new Map<string, string>();
const haystacks = new Map<string, string>();
const haystackOf = (track: Track): string => {
  const id = track.libraryId || track.url;
  let hay = haystacks.get(id);
  if (hay === undefined) { hay = songHaystack(track, albums.get(id)); haystacks.set(id, hay); }
  return hay;
};

/** Radio is what the player plays from (playing or paused on a song). */
export const isRadioActive = (): boolean => !!player.track && !!player.context && player.context.type === 'radio';

const currentId = (): string | null | undefined => (isRadioActive() ? (player.track as Track).libraryId : null);

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchTracks(): Promise<Track[]> {
  const data = await fetchJson<StationWithSongs>(`/api/stations/${STATION}/songs`);
  summary = { count: data.count, duration_sec: data.duration_sec };
  stationIds = new Set(data.songs.map((s) => s.id));
  albums.clear();
  haystacks.clear();
  for (const s of data.songs) if (s.album) albums.set(s.id, s.album);
  renderSidebarRow();
  return data.songs.map(libraryTrack);
}

// ---------------------------------------------------------------- sidebar row

function renderSidebarRow(): void {
  const row = maybeById('plnav-radio');
  if (!row) return;
  const meta = byId('plnav-radio-meta');
  const count = summary ? summary.count : null;
  const text = count === null
    ? t('radio.subtitleLoading', 'All songs, shuffled')
    : count === 0
      ? t('radio.subtitleEmpty', 'No songs yet')
      : tf('radio.subtitle', 'All {count} songs, shuffled', { count: count.toLocaleString(language()) });
  if (meta.textContent !== text) meta.textContent = text;
  // The library overlay over this page is the place on screen then (sidebar.ts).
  const here = window.location.pathname.replace(/\/+$/, '') === '/radio' && !document.body.classList.contains('libpage-open');
  const active = isRadioActive();
  row.classList.toggle('is-current', here || active);
  row.classList.toggle('is-playing', active && player.isPlaying);
  if (here) row.setAttribute('aria-current', 'page');
  else row.removeAttribute('aria-current');
  const name = t('radio.title', 'Radio');
  row.setAttribute('title', `${name}: ${text}`);
  row.setAttribute('aria-label', active ? `${name}, ${text}, ${t('radio.nowPlaying', 'playing')}` : `${name}, ${text}`);
}

async function loadSummary(): Promise<void> {
  try {
    summary = await fetchJson<Station>(`/api/stations/${STATION}`);
    renderSidebarRow();
    if (page.open && !page.loading) renderHead();
  } catch { /* the row keeps its last line */ }
}

// ------------------------------------------------------------------- the page

function rowHtml(track: Track, index: number, last: boolean): string {
  const playing = track.libraryId === currentId();
  const title = escapeHtml(track.title);
  const artist = escapeHtml(track.artist);
  const duration = track.duration ? formatDuration(track.duration) : '';
  const label = escapeHtml(playCellLabel(track.title, playing && player.isPlaying));
  const thumb = track.youtubeId
    ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(track.youtubeId)}/default.jpg" alt="" loading="lazy">`
    : NOTE_ICON;
  return `<li class="list-group-item list-group-item-action queue-item${playing ? ' playing' : ''}${isUnplayable(track) ? ' is-unplayable' : ''}${last ? ' queue-item-last' : ''}" data-index="${index}" data-id="${escapeHtml(track.libraryId)}" tabindex="0"${playing ? ' aria-current="true"' : ''}>`
    + `<div class="queue-item-num"><button class="btn-text theme-secondary btn-icon btn-sm queue-item-play" type="button" data-position="${index + 1}" data-title="${title}" aria-label="${label}" title="${label}">${playCellHtml(index + 1, playing)}</button></div>`
    + `<div class="queue-item-main"><div class="app-thumb queue-item-thumb">${thumb}</div>`
    + `<div class="queue-item-info"><div class="queue-item-title" title="${title}">${title}</div>`
    + `<div class="queue-item-meta">${artist ? `<span class="queue-item-artist">${artist}</span>` : ''}<span class="queue-item-compact queue-item-duration">${duration}</span>${unplayableBadgeHtml(track)}</div></div></div>`
    + `<div class="queue-col-dur queue-cell">${duration}</div>`
    + `<div class="queue-item-actions">${songMenuButtonHtml(track.title)}</div></li>`;
}

function renderHead(): void {
  // Only what the song table's stats strip can say from a length: songs and total.
  const stats = page.order.length ? statsHtml(page.order.map((s) => ({ duration: s.duration }))) : '';
  const el = byId('radio-stats');
  if (el.dataset.html !== stats) { el.innerHTML = stats; el.dataset.html = stats; }
  const sounding = isRadioActive() && player.isPlaying;
  const play = byId<HTMLButtonElement>('radio-play');
  play.disabled = !page.order.length || (!isRadioActive() && !page.shown.length);
  (play.querySelector('path') as SVGPathElement).setAttribute('d', sounding ? PAUSE_PATH : PLAY_PATH);
  byId('radio-play-label').textContent = sounding ? t('player.pause', 'Pause') : t('player.play', 'Play');
  byId<HTMLButtonElement>('radio-reshuffle').disabled = page.order.length < 2;
  // With nothing loaded, the player bar's Play starts the list on screen too.
  state.viewPlay = page.open && page.shown.length ? () => playAt(firstShown(page.shown)) : null;
  const barPlay = maybeById<HTMLButtonElement>('play-btn');
  if (barPlay && !player.track) barPlay.disabled = !state.viewPlay;
  renderSearchStatus();
}

// "3 of 2,108 songs" next to the field while there is a search; the field only
// once there is a list to search.
function renderSearchStatus(): void {
  byId('radio-toolbar').hidden = !page.order.length;
  const status = searchStatus(page.query, page.shown.length, page.order.length);
  const n = (v: number) => v.toLocaleString(language());
  const text = status.kind === 'some'
    ? tf('radio.matchCount', '{shown} of {total} songs', { shown: n(status.shown), total: n(status.total) })
    : status.kind === 'empty' ? t('radio.noMatchShort', 'No matches') : '';
  const el = byId('radio-count');
  if (el.textContent !== text) el.textContent = text;
}

let view: VirtualList | null = null;
function listView(): VirtualList {
  if (!view) {
    view = createVirtualList({
      list: byId('radio-list'),
      scroller: byId('radio-body'),
      stickyTop: () => byId('radio-head').offsetHeight || 0,
    });
  }
  return view;
}

function emptyHtml(title: string, hint?: string): string {
  return `<li class="list-group-item app-empty queue-empty"><p class="mb-1">${escapeHtml(title)}</p>${hint ? `<p class="fs-sm mb-0 hint">${escapeHtml(hint)}</p>` : ''}</li>`;
}

interface RenderOptions {
  anchor?: boolean;
}

function renderList({ anchor = true }: RenderOptions = {}): void {
  const head = byId('radio-head');
  page.shown = matchingPositions(page.order, page.query, haystackOf);
  head.hidden = !page.shown.length;
  if (!page.order.length) {
    let html: string;
    if (page.loading) html = emptyHtml(t('landing.loading', 'Loading…'));
    else if (page.failed) html = `<li class="list-group-item app-empty queue-empty"><p class="mb-3">${escapeHtml(t('radio.loadFailed', 'Could not load Radio'))}</p><button type="button" class="btn btn-sm radio-retry">${escapeHtml(t('radio.retry', 'Try again'))}</button></li>`;
    else html = emptyHtml(t('radio.emptyTitle', 'No songs to play yet'), t('radio.emptyHint', 'Songs land here as soon as they are in the music library.'));
    listView().clear(html);
    return;
  }
  if (!page.shown.length) {
    const text = tf('radio.noMatch', 'No songs match “{query}”', { query: page.query.trim() });
    listView().clear(`<li class="list-group-item app-empty queue-empty"><p class="mb-3 text-break">${escapeHtml(text)}</p><button type="button" class="btn btn-sm radio-clear">${escapeHtml(t('sidebar.clearSearch', 'Clear search'))}</button></li>`);
    return;
  }
  // The list shows page.shown; each row keeps its place in the full order
  // (data-index, its # number), which is what plays.
  const order = page.order;
  const shown = page.shown;
  const positions = new Map(shown.map((index, pos) => [order[index].libraryId, pos]));
  listView().setSource({
    count: shown.length,
    keyOf: (pos) => order[shown[pos]].libraryId,
    indexOfKey: (key) => (positions.has(key) ? positions.get(key) as number : -1),
    renderRow: (pos) => rowHtml(order[shown[pos]], shown[pos], pos === shown.length - 1),
  }, { anchor });
}

function render(options?: RenderOptions): void {
  renderList(options);
  renderHead();
  settleAutoplay();
}

function settleAutoplay(): void {
  if (!page.autoplay || page.loading) return;
  page.autoplay = false;
  if (page.order.length) playAt(Math.max(0, firstShown(page.shown)));
  else if (!page.failed) showToast(t('radio.emptyTitle', 'No songs to play yet'), 'info');
}

/** Double-click on the row: Radio already on air just resumes; else open it and play from the top. */
export function playRadioFromTop(): void {
  if (isRadioActive()) {
    if (!player.isPlaying) player.play();
    return;
  }
  page.autoplay = true;
  if (!page.open) navigateTo('/radio');
  settleAutoplay();
}

// A song change touches two rows and play / pause one cell, in place: a re-render
// would close an open song menu.
function paintRow(row: HTMLElement, index: number): void {
  const track = page.order[index];
  if (!track) return;
  const playing = track.libraryId === currentId();
  if (row.classList.contains('playing') !== playing) {
    row.classList.toggle('playing', playing);
    if (playing) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  const btn = row.querySelector('.queue-item-play') as HTMLElement;
  const label = playCellLabel(track.title, playing && player.isPlaying);
  btn.innerHTML = playCellHtml(index + 1, playing);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function refreshRows(): void {
  if (!page.open || !view) return;
  for (const row of view.rendered().values()) {
    const index = rowIndex(row);
    if (row.classList.contains('playing') || page.order[index]?.libraryId === currentId()) paintRow(row, index);
  }
}

// A row's place in the full order (data-index), whatever the search shows.
const rowIndex = (el: HTMLElement): number => parseInt(el.dataset.index as string, 10);

function scrollToCurrent(): void {
  const id = currentId();
  const index = id ? page.order.findIndex((s) => s.libraryId === id) : -1;
  // Filtered out by the search: nothing to bring into view.
  const pos = index >= 0 ? page.shown.indexOf(index) : -1;
  if (pos >= 0) listView().scrollToIndex(pos, { align: 'center' });
}

// Play from a row, or from the top. The song already playing here is resumed if
// paused, never restarted.
function playAt(index: number): void {
  const track = page.order[index];
  if (!track) return;
  if (track.libraryId === currentId()) {
    if (!player.isPlaying) player.play();
    return;
  }
  player.playFrom(CONTEXT, page.order, index);
}

// Play starts at the top of what is shown: the first result while searching,
// then Radio goes on through the whole order from there.
function pressPlay(): void {
  if (isRadioActive()) player.toggle();
  else if (page.shown.length) playAt(firstShown(page.shown));
}

// ------------------------------------------------------------------- search

// Typing filters the rows only: the player, its queue and the order stay.
function setQuery(value: string): void {
  const input = byId<HTMLInputElement>('radio-search');
  if (input.value !== value) input.value = value;
  if (value === page.query) return;
  page.query = value;
  if (!page.open) return;
  // Scrolled past the field: back to it, so the first results are in view.
  const body = byId('radio-body');
  const fieldTop = byId('radio-toolbar').getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  if (body.scrollTop > fieldTop) body.scrollTop = Math.max(0, fieldTop);
  renderList({ anchor: false });
  renderHead();
}

function reshuffle(): void {
  const id = currentId();
  page.order = id ? reshuffledAround(page.order, id) : shuffled(page.order);
  if (isRadioActive()) player.replaceQueue(CONTEXT, page.order);
  byId('radio-body').scrollTop = 0;
  render({ anchor: false });
}

async function loadFresh(): Promise<void> {
  const load = ++page.load;
  page.loading = true;
  page.failed = false;
  page.order = [];
  render();
  try {
    const tracks = await fetchTracks();
    if (load !== page.load || !page.open) return;
    page.order = shuffled(tracks);
  } catch {
    if (load !== page.load) return;
    page.failed = true;
  }
  page.loading = false;
  render();
}

/** The route opened /radio. */
export function openRadioPage(): void {
  const wasOpen = page.open;
  page.open = true;
  document.title = `${t('radio.title', 'Radio')} · listen-along`;
  renderSidebarRow();
  if (wasOpen) return;
  // A new opening starts without a search, as the artists page does.
  page.query = '';
  byId<HTMLInputElement>('radio-search').value = '';
  if (isRadioActive()) {
    // The albums the search matches come with the station list (a reload may have lost it).
    if (!stationIds) fetchTracks().then(() => { if (page.open && page.query) render(); }).catch(() => {});
    page.order = player.queue.slice();
    page.loading = false;
    page.failed = false;
    render({ anchor: false });
    scrollToCurrent();
    return;
  }
  byId('radio-body').scrollTop = 0;
  loadFresh();
}

/** The route left /radio. */
export function closeRadioPage(): void {
  if (!page.open) return;
  page.open = false;
  page.autoplay = false;
  page.load++;
  page.loading = false;
  if (!isRadioActive()) page.order = [];
  state.viewPlay = null;
  document.title = 'listen-along';
  renderSidebarRow();
}

// ------------------------------------------------------------ library changes

// The library changed (upload, removal, a song marked broken or unmarked): the
// playing order follows, wherever the listener is. A list on screen does too.
async function applyLibraryChange(): Promise<void> {
  await loadSummary();
  if (!isRadioActive() && !page.open) return;
  const load = ++page.load;
  let fresh: Track[];
  try { fresh = await fetchTracks(); } catch { return; }
  if (load !== page.load) return;
  if (isRadioActive()) {
    const next = reconcile(player.queue, fresh, currentId());
    page.order = next;
    player.replaceQueue(CONTEXT, next);
  } else {
    page.order = reconcile(page.order, fresh);
  }
  page.loading = false;
  if (page.open) render();
}

// A song that left the station while on air was kept to mark the place. Once the
// player has moved on it goes too (a re-render, only when there is one).
function dropLeftSongs(): void {
  if (!stationIds || !isRadioActive()) return;
  const ids = stationIds;
  const id = currentId();
  const next = page.order.filter((s) => s.libraryId === id || ids.has(s.libraryId));
  if (next.length === page.order.length) return;
  page.order = next;
  player.replaceQueue(CONTEXT, next);
  if (page.open) render();
}

/** Socket library:updated. */
export function handleRadioLibraryUpdated(): void {
  clearTimeout(refreshTimer ?? undefined);
  refreshTimer = setTimeout(applyLibraryChange, REFRESH_MS);
}

/** Socket reconnected: what was missed meanwhile. */
export function refreshRadio(): void {
  handleRadioLibraryUpdated();
}

// ---------------------------------------------------------------------- setup

export function setupRadio(): void {
  const row = byId('plnav-radio');
  row.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    closeDrawer();
    navigateTo('/radio');
  });

  byId('radio-back').addEventListener('click', () => navigateTo('/'));
  byId('radio-play').addEventListener('click', pressPlay);
  byId('radio-reshuffle').addEventListener('click', reshuffle);

  const search = byId<HTMLInputElement>('radio-search');
  search.addEventListener('input', () => setQuery(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); setQuery(''); return; }
    // Down from the field: the first song shown.
    if (e.key === 'ArrowDown' && page.shown.length) { e.preventDefault(); listView().scrollToIndex(0)?.focus({ preventScroll: true }); }
  });

  const list = byId('radio-list');
  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.radio-retry')) { loadFresh(); return; }
    if (target.closest('.radio-clear')) { setQuery(''); search.focus(); return; }
    const el = target.closest<HTMLElement>('.queue-item[data-index]');
    if (!el) return;
    if (target.closest('.queue-item-play')) {
      if (el.classList.contains('playing') && player.isPlaying) player.pause();
      else playAt(rowIndex(el));
      return;
    }
    if (target.closest('button, a[href]')) return;
    playAt(rowIndex(el));
  });
  list.addEventListener('keydown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.queue-item[data-index]');
    if (!el || e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playAt(rowIndex(el)); return; }
    // The keys walk the rows shown (the search's results), by list position.
    const v = listView();
    const pos = v.positionOf(el);
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: v.pageSize, PageUp: -v.pageSize };
    let to: number | null = null;
    if (e.key in steps) to = pos + steps[e.key];
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = v.count - 1;
    if (to === null) return;
    e.preventDefault();
    // Up from the first row goes back to the search field.
    if (to < 0 && e.key === 'ArrowUp') { search.focus(); return; }
    v.scrollToIndex(Math.max(0, Math.min(v.count - 1, to)))?.focus({ preventScroll: true });
  });
  bindSongMenu(list, '.queue-item[data-index]', (el) => {
    const track = page.order[rowIndex(el)];
    return track ? { songId: track.libraryId, url: track.url, title: track.title, artist: track.artist, youtubeId: track.youtubeId } : null;
  });

  // The list ran out: the next round, without the song that just ended on top.
  player.setRefill((ctx, track) => {
    if (!ctx || ctx.type !== 'radio' || !player.queue.length) return null;
    const ids = stationIds;
    const songs = ids ? player.queue.filter((s) => ids.has(s.libraryId)) : player.queue;
    return nextRound(songs, track && track.libraryId);
  });

  player.on('track', () => { dropLeftSongs(); refreshRows(); renderSidebarRow(); if (page.open) renderHead(); });
  // A song failed to play, or plays again: its row greys or clears.
  onFailuresChange(() => { if (page.open) render(); });
  player.on('state', () => { refreshRows(); renderSidebarRow(); if (page.open) renderHead(); });
  player.on('context', () => { refreshRows(); renderSidebarRow(); if (page.open) renderHead(); });
  player.on('queue', (songs) => {
    if (!isRadioActive() || songs === page.order) return;
    const sameList = songs.length === page.order.length && songs.every((s, i) => s === page.order[i]);
    page.order = songs;
    if (page.open && !sameList) render();
  });
  window.addEventListener('popstate', renderSidebarRow);
  // The library opening over this page changes the address without a popstate:
  // the sidebar's current place moves to the library.
  document.addEventListener('app:viewchange', renderSidebarRow);
  // The player bar's song, while this page is already open.
  document.addEventListener('app:reveal-playing', () => { if (page.open) scrollToCurrent(); });
  window.addEventListener('languageChanged', () => {
    renderSidebarRow();
    if (page.open) render();
  });
  loadSummary();
}
