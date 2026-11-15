// One artist's songs at /artist/<key>, read-only: no owner, no edit mode,
// nothing stored (backend/src/artists.js groups the library by artist). It acts
// like Radio without the shuffle: opening it plays nothing, Play starts at the
// top, a row plays from there, in title order. The player context is
// { type: 'artist', key, name }, so the player's own shuffle and repeat apply.
// While the artist plays, the list on screen is the player's queue.
import { state } from '../../shared/state.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import { escapeHtml, formatDuration, navigateTo, showToast, t } from '../../shared/ui.ts';
import { player } from '../../player/player.ts';
import type { PlayerContext, PlayerContextInput } from '../../player/player.ts';
import { libraryTrack } from '../library/library.ts';
import { artistPath } from '../../router.ts';
import { playCellHtml, playCellLabel, statsHtml } from '../queue/queue.ts';
import { bindSongMenu, songMenuButtonHtml } from '../library/song-reports.ts';
import { isUnplayable, unplayableBadgeHtml, onFailuresChange } from '../../player/playback-failures.ts';
import { createVirtualList } from '../../shared/virtual-list.ts';
import type { VirtualList } from '../../shared/virtual-list.ts';
import { keepCurrent } from './artist-rules.ts';
import { artistByKey, coverUrl } from './artists.ts';
import type { ArtistWithSongs, Track } from '../../shared/types.ts';

const REFRESH_MS = 1000;
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

interface ArtistPage {
  open: boolean;
  key: string | null;
  name: string;
  cover: string | null;
  loading: boolean;
  failed: boolean;
  missing: boolean;
  songs: Track[];
  load: number;
  autoplay: string | null;
}

const page: ArtistPage = {
  open: false,
  key: null,
  name: '',
  cover: null,
  loading: false,
  failed: false,
  missing: false,  // no song has this artist (any more)
  songs: [],       // the tracks on screen; the player's queue while this artist plays
  load: 0,         // the latest fetch; older answers are dropped
  autoplay: null,  // the key to play from the top once its list is here
};
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let backPath = '/'; // where the back button goes: /artists when opened from there
let liveIds: Set<string | undefined> | null = null; // the playing artist's song ids at the last look (songs that left drop once the player moves on)

const activeKey = (): string | null => (player.track && player.context && player.context.type === 'artist' ? player.context.key : null);
const isActive = (key: string | null | undefined): boolean => !!key && activeKey() === key;
const currentId = (): string | null | undefined => (isActive(page.key) ? (player.track as Track).libraryId : null);
const contextFor = (key: string | null, name: string | null | undefined): PlayerContextInput => ({ type: 'artist', key, name: name || key });

async function fetchArtist(key: string): Promise<ArtistWithSongs | null> {
  const res = await fetch(`/api/artists/${encodeURIComponent(key)}/songs`, { credentials: 'same-origin' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ArtistWithSongs>;
}

// ------------------------------------------------------------------- the page

function rowHtml(track: Track, index: number): string {
  const playing = track.libraryId === currentId();
  const title = escapeHtml(track.title);
  const artist = escapeHtml(track.artist);
  const duration = track.duration ? formatDuration(track.duration) : '';
  const label = escapeHtml(playCellLabel(track.title, playing && player.isPlaying));
  const thumb = track.youtubeId
    ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(track.youtubeId)}/default.jpg" alt="" loading="lazy">`
    : NOTE_ICON;
  return `<li class="list-group-item list-group-item-action queue-item${playing ? ' playing' : ''}${isUnplayable(track) ? ' is-unplayable' : ''}${index === page.songs.length - 1 ? ' queue-item-last' : ''}" data-index="${index}" data-id="${escapeHtml(track.libraryId)}" tabindex="0"${playing ? ' aria-current="true"' : ''}>`
    + `<div class="queue-item-num"><button class="btn-text theme-secondary btn-icon btn-sm queue-item-play" type="button" data-position="${index + 1}" data-title="${title}" aria-label="${label}" title="${label}">${playCellHtml(index + 1, playing)}</button></div>`
    + `<div class="queue-item-main"><div class="app-thumb queue-item-thumb">${thumb}</div>`
    + `<div class="queue-item-info"><div class="queue-item-title" title="${title}">${title}</div>`
    + `<div class="queue-item-meta">${artist ? `<span class="queue-item-artist">${artist}</span>` : ''}<span class="queue-item-compact queue-item-duration">${duration}</span>${unplayableBadgeHtml(track)}</div></div></div>`
    + `<div class="queue-col-dur queue-cell">${duration}</div>`
    + `<div class="queue-item-actions">${songMenuButtonHtml(track.title)}</div></li>`;
}

function renderHead(): void {
  const name = page.name || page.key || '';
  const h1 = byId('artist-name');
  if (h1.textContent !== name) { h1.textContent = name; h1.title = name; }
  document.title = `${name} · listen-along`;
  const cover = coverUrl(page.cover, 'default');
  const coverEl = byId('artist-cover');
  const coverHtml = cover ? `<img src="${escapeHtml(cover)}" alt="" referrerpolicy="no-referrer">` : NOTE_ICON;
  if (coverEl.dataset.html !== coverHtml) { coverEl.innerHTML = coverHtml; coverEl.dataset.html = coverHtml; }
  // Songs and total length; the artists and "top artist" facts would only repeat the name.
  const stats = page.songs.length ? statsHtml(page.songs.map((s) => ({ duration: s.duration }))) : '';
  const el = byId('artist-stats');
  if (el.dataset.html !== stats) { el.innerHTML = stats; el.dataset.html = stats; }
  const sounding = isActive(page.key) && player.isPlaying;
  const play = byId<HTMLButtonElement>('artist-play');
  play.disabled = !page.songs.length;
  (play.querySelector('path') as SVGPathElement).setAttribute('d', sounding ? PAUSE_PATH : PLAY_PATH);
  byId('artist-play-label').textContent = sounding ? t('player.pause', 'Pause') : t('player.play', 'Play');
  // With nothing loaded, the player bar's Play starts the list on screen too.
  state.viewPlay = page.open && page.songs.length ? () => playAt(0) : null;
  const barPlay = maybeById<HTMLButtonElement>('play-btn');
  if (barPlay && !player.track) barPlay.disabled = !state.viewPlay;
}

let view: VirtualList | null = null;
function listView(): VirtualList {
  if (!view) {
    view = createVirtualList({
      list: byId('artist-list'),
      scroller: byId('artist-body'),
      stickyTop: () => byId('artist-head').offsetHeight || 0,
    });
  }
  return view;
}

function emptyHtml(title: string, hint?: string, extra = ''): string {
  return `<li class="list-group-item app-empty queue-empty"><p class="${hint || extra ? 'mb-3' : 'mb-0'}">${escapeHtml(title)}</p>${hint ? `<p class="fs-sm mb-0 hint">${escapeHtml(hint)}</p>` : ''}${extra}</li>`;
}

interface RenderOptions {
  anchor?: boolean;
}

function renderList({ anchor = true }: RenderOptions = {}): void {
  byId('artist-head').hidden = !page.songs.length;
  if (!page.songs.length) {
    let html: string;
    if (page.loading) html = emptyHtml(t('landing.loading', 'Loading…'));
    else if (page.failed) html = emptyHtml(t('artists.loadOneFailed', 'Could not load this artist'), '', `<button type="button" class="btn btn-sm artist-retry">${escapeHtml(t('radio.retry', 'Try again'))}</button>`);
    else html = emptyHtml(t('artists.notFound', 'No songs by this artist'), '', `<a class="btn btn-sm artist-all" href="/artists">${escapeHtml(t('artists.showAllArtists', 'All artists'))}</a>`);
    listView().clear(html);
    return;
  }
  const songs = page.songs;
  const positions = new Map(songs.map((s, i) => [s.libraryId, i]));
  listView().setSource({
    count: songs.length,
    keyOf: (pos) => songs[pos].libraryId,
    indexOfKey: (key) => (positions.has(key) ? positions.get(key) as number : -1),
    renderRow: (pos) => rowHtml(songs[pos], pos),
  }, { anchor });
}

function render(options?: RenderOptions): void {
  renderHead();
  renderList(options);
  settleAutoplay();
}

function settleAutoplay(): void {
  if (!page.autoplay || page.autoplay !== page.key || page.loading) return;
  page.autoplay = null;
  if (page.songs.length) playAt(0);
  else if (!page.failed) showToast(t('artists.notFound', 'No songs by this artist'), 'info');
}

/** A card's play button or a double-click: the artist already on air just resumes; else open it and play from the top. */
export function playArtistFromTop(key: string | null | undefined): void {
  if (!key) return;
  if (isActive(key)) {
    if (!player.isPlaying) player.play();
    return;
  }
  page.autoplay = key;
  if (!page.open || page.key !== key) navigateTo(artistPath(key));
  settleAutoplay();
}

// A song change touches two rows and play / pause one cell, in place: a re-render
// would close an open song menu.
function paintRow(row: HTMLElement, pos: number): void {
  const track = page.songs[pos];
  if (!track) return;
  const playing = track.libraryId === currentId();
  if (row.classList.contains('playing') !== playing) {
    row.classList.toggle('playing', playing);
    if (playing) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  const btn = row.querySelector('.queue-item-play') as HTMLElement;
  const label = playCellLabel(track.title, playing && player.isPlaying);
  btn.innerHTML = playCellHtml(pos + 1, playing);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function refreshRows(): void {
  if (!page.open || !view) return;
  for (const [pos, row] of view.rendered()) {
    if (row.classList.contains('playing') || page.songs[pos]?.libraryId === currentId()) paintRow(row, pos);
  }
}

function scrollToCurrent(): void {
  const id = currentId();
  const pos = id ? page.songs.findIndex((s) => s.libraryId === id) : -1;
  if (pos >= 0) listView().scrollToIndex(pos, { align: 'center' });
}

// Play from a row, or from the top. The song already playing here is resumed if
// paused, never restarted.
function playAt(index: number): void {
  const track = page.songs[index];
  if (!track) return;
  if (track.libraryId === currentId()) {
    if (!player.isPlaying) player.play();
    return;
  }
  player.playFrom(contextFor(page.key, page.name), page.songs, index);
}

function pressPlay(): void {
  if (isActive(page.key)) player.toggle();
  else playAt(0);
}

function applyData(data: ArtistWithSongs | null): Track[] {
  page.missing = !data;
  if (data) {
    page.name = data.name;
    page.cover = data.cover_youtube_id || null;
  }
  return data ? data.songs.map(libraryTrack) : [];
}

async function loadFresh(): Promise<void> {
  const load = ++page.load;
  const key = page.key;
  page.loading = true;
  page.failed = false;
  page.songs = [];
  render();
  try {
    const data = await fetchArtist(key as string);
    if (load !== page.load || !page.open) return;
    page.songs = applyData(data);
  } catch {
    if (load !== page.load) return;
    page.failed = true;
  }
  page.loading = false;
  render();
}

/** The route opened /artist/<key>; from = the path it was opened from. */
export function openArtistPage(key: string, { from = null }: { from?: string | null } = {}): void {
  if (page.open && page.key === key) { renderHead(); return; }
  // Artist to artist keeps the way back; otherwise /artists only when opened from there.
  if (!(from && from.startsWith('/artist/'))) backPath = from === '/artists' ? '/artists' : '/';
  page.open = true;
  page.key = key;
  page.load++;
  const known = artistByKey(key);
  page.name = (isActive(key) && (player.context as PlayerContext).name) || (known && known.name) || key;
  page.cover = known ? known.cover_youtube_id : null;
  page.missing = false;
  page.failed = false;
  byId('artist-body').scrollTop = 0;
  if (isActive(key)) {
    // What the player plays from, in its order, also while it is paused.
    page.songs = player.queue.slice();
    page.loading = false;
    render({ anchor: false });
    scrollToCurrent();
    // The name and cover may not be known yet (a reload on the page).
    if (!known) fetchArtist(key).then((data) => { if (data && page.open && page.key === key) { page.name = data.name; page.cover = data.cover_youtube_id || null; renderHead(); } }).catch(() => {});
    return;
  }
  loadFresh();
}

/** The route left /artist/<key>. */
export function closeArtistPage(): void {
  if (!page.open) return;
  page.open = false;
  page.autoplay = null;
  page.load++;
  page.loading = false;
  page.songs = [];
  page.key = null;
  state.viewPlay = null;
  document.title = 'listen-along';
}

// ------------------------------------------------------------ library changes

// The library changed (upload, removal, a new name, a song marked broken or
// unmarked): the artist on air and the one on screen follow.
async function applyLibraryChange(): Promise<void> {
  const playing = activeKey();
  const keys = [...new Set([playing, page.open ? page.key : null].filter(Boolean) as string[])];
  const load = ++page.load;
  for (const key of keys) {
    let data: ArtistWithSongs | null;
    try {
      data = await fetchArtist(key);
    } catch {
      if (load !== page.load) return;
      if (page.open && page.key === key && !page.songs.length) page.failed = true;
      continue;
    }
    if (load !== page.load) return;
    if (page.open && page.key === key) page.failed = false;
    const fresh = data ? data.songs.map(libraryTrack) : [];
    if (key === activeKey()) {
      liveIds = new Set(fresh.map((s) => s.libraryId));
      const next = keepCurrent(fresh, player.queue, (player.track as Track).libraryId);
      player.replaceQueue(contextFor(key, data ? data.name : (player.context as PlayerContext).name), next);
      if (page.open && page.key === key) { applyData(data); page.songs = next; }
    } else if (page.open && page.key === key) {
      page.songs = applyData(data);
    }
  }
  if (load !== page.load) return;
  page.loading = false;
  if (page.open) render();
}

// A song that left the artist while on air was kept to mark the place. Once the
// player has moved on it goes too.
function dropLeftSongs(): void {
  const key = activeKey();
  if (!liveIds || !key) return;
  const ids = liveIds;
  const id = (player.track as Track).libraryId;
  const next = player.queue.filter((s) => s.libraryId === id || ids.has(s.libraryId));
  if (next.length === player.queue.length) return;
  player.replaceQueue(player.context, next);
}

/** Socket library:updated, or a reconnect. */
export function handleArtistLibraryUpdated(): void {
  if (!page.open && !activeKey()) return;
  clearTimeout(refreshTimer ?? undefined);
  refreshTimer = setTimeout(applyLibraryChange, REFRESH_MS);
}

// ---------------------------------------------------------------------- setup

export function setupArtistPage(): void {
  byId('artist-back').addEventListener('click', () => navigateTo(backPath));
  byId('artist-play').addEventListener('click', pressPlay);

  const list = byId('artist-list');
  const rowIndex = (el: HTMLElement) => parseInt(el.dataset.index as string, 10);
  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.artist-retry')) { loadFresh(); return; }
    const all = target.closest('.artist-all');
    if (all) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigateTo('/artists');
      return;
    }
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
    const v = listView();
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: v.pageSize, PageUp: -v.pageSize };
    let to: number | null = null;
    if (e.key in steps) to = rowIndex(el) + steps[e.key];
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = page.songs.length - 1;
    if (to === null) return;
    e.preventDefault();
    v.scrollToIndex(Math.max(0, Math.min(page.songs.length - 1, to)))?.focus({ preventScroll: true });
  });
  // The usual song menu (Add to playlist, source link, broken, Replace with…):
  // it acts on the library song, never on this list.
  bindSongMenu(list, '.queue-item[data-index]', (el) => {
    const track = page.songs[rowIndex(el)];
    return track ? { songId: track.libraryId, url: track.url, title: track.title, artist: track.artist, youtubeId: track.youtubeId } : null;
  });

  const repaint = () => { refreshRows(); if (page.open) renderHead(); };
  player.on('track', () => { dropLeftSongs(); repaint(); });
  // A song failed to play, or plays again: its row greys or clears.
  onFailuresChange(() => { if (page.open) render(); });
  player.on('state', repaint);
  player.on('context', () => { if (!activeKey()) liveIds = null; repaint(); });
  player.on('queue', (songs) => {
    if (!page.open || !isActive(page.key) || songs === page.songs) return;
    const sameList = songs.length === page.songs.length && songs.every((s, i) => s === page.songs[i]);
    page.songs = songs.slice();
    if (!sameList) render();
  });
  // The player bar's song, while this page is already open.
  document.addEventListener('app:reveal-playing', () => { if (page.open) scrollToCurrent(); });
  window.addEventListener('languageChanged', () => { if (page.open) render(); });
}
