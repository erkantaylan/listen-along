// Radio: every song of the library in your own shuffled order, at /radio. It
// acts like a playlist (opening it plays nothing; Play or a row starts it) but
// is not one: no owner, no edit mode, nothing stored. A station is a list of
// songs from a rule on the server (backend/src/stations.js); "all" is the only
// one so far. The order is made here (radio-order.js) and stays while the view
// is open and for as long as Radio is what the player plays from; opening the
// page when it is not gives a fresh shuffle. When the list runs out the player
// asks for the next round (player.setRefill).
import { state } from './state.js';
import { escapeHtml, formatDuration, navigateTo, showToast, t } from './ui.js';
import { player } from './player.js';
import { libraryTrack } from './library.js';
import { playCellHtml, playCellLabel, statsHtml } from './queue.js';
import { closeDrawer } from './sidebar.js';
import { bindSongMenu, songMenuButtonHtml } from './song-reports.js';
import { isUnplayable, unplayableBadgeHtml, onFailuresChange } from './playback-failures.js';
import { createVirtualList } from './virtual-list.js';
import { nextRound, reconcile, reshuffledAround, shuffled } from './radio-order.js';

const STATION = 'all';
const CONTEXT = { type: 'radio', stationId: STATION };
const REFRESH_MS = 1000;

const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

const $ = (id) => document.getElementById(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const language = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || undefined;

const page = {
  open: false,
  loading: false,
  failed: false,
  order: [],  // the tracks on screen; the player's queue while Radio plays
  load: 0,    // the latest fetch; older answers are dropped
  autoplay: false, // play the top as soon as the list is here
};
let summary = null; // { count, duration_sec }
let stationIds = null; // the song ids the station held at the last look
let refreshTimer = null;

/** Radio is what the player plays from (playing or paused on a song). */
export const isRadioActive = () => !!player.track && !!player.context && player.context.type === 'radio';

const currentId = () => (isRadioActive() ? player.track.libraryId : null);

async function fetchJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchTracks() {
  const data = await fetchJson(`/api/stations/${STATION}/songs`);
  summary = { count: data.count, duration_sec: data.duration_sec };
  stationIds = new Set(data.songs.map((s) => s.id));
  renderSidebarRow();
  return data.songs.map(libraryTrack);
}

// ---------------------------------------------------------------- sidebar row

function renderSidebarRow() {
  const row = $('plnav-radio');
  if (!row) return;
  const meta = $('plnav-radio-meta');
  const count = summary ? summary.count : null;
  const text = count === null
    ? t('radio.subtitleLoading', 'All songs, shuffled')
    : count === 0
      ? t('radio.subtitleEmpty', 'No songs yet')
      : tf('radio.subtitle', 'All {count} songs, shuffled', { count: count.toLocaleString(language()) });
  if (meta.textContent !== text) meta.textContent = text;
  const here = window.location.pathname.replace(/\/+$/, '') === '/radio';
  const active = isRadioActive();
  row.classList.toggle('is-current', here || active);
  row.classList.toggle('is-playing', active && player.isPlaying);
  if (here) row.setAttribute('aria-current', 'page');
  else row.removeAttribute('aria-current');
  const name = t('radio.title', 'Radio');
  row.setAttribute('title', `${name}: ${text}`);
  row.setAttribute('aria-label', active ? `${name}, ${text}, ${t('radio.nowPlaying', 'playing')}` : `${name}, ${text}`);
}

async function loadSummary() {
  try {
    summary = await fetchJson(`/api/stations/${STATION}`);
    renderSidebarRow();
    if (page.open && !page.loading) renderHead();
  } catch { /* the row keeps its last line */ }
}

// ------------------------------------------------------------------- the page

function rowHtml(track, index) {
  const playing = track.libraryId === currentId();
  const title = escapeHtml(track.title);
  const artist = escapeHtml(track.artist);
  const duration = track.duration ? formatDuration(track.duration) : '';
  const label = escapeHtml(playCellLabel(track.title, playing && player.isPlaying));
  const thumb = track.youtubeId
    ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(track.youtubeId)}/default.jpg" alt="" loading="lazy">`
    : NOTE_ICON;
  return `<li class="list-group-item list-group-item-action queue-item${playing ? ' playing' : ''}${isUnplayable(track) ? ' is-unplayable' : ''}${index === page.order.length - 1 ? ' queue-item-last' : ''}" data-index="${index}" data-id="${escapeHtml(track.libraryId)}" tabindex="0"${playing ? ' aria-current="true"' : ''}>`
    + `<div class="queue-item-num"><button class="btn-text theme-secondary btn-icon btn-sm queue-item-play" type="button" data-position="${index + 1}" data-title="${title}" aria-label="${label}" title="${label}">${playCellHtml(index + 1, playing)}</button></div>`
    + `<div class="queue-item-main"><div class="app-thumb queue-item-thumb">${thumb}</div>`
    + `<div class="queue-item-info"><div class="queue-item-title" title="${title}">${title}</div>`
    + `<div class="queue-item-meta">${artist ? `<span class="queue-item-artist">${artist}</span>` : ''}<span class="queue-item-compact queue-item-duration">${duration}</span>${unplayableBadgeHtml(track)}</div></div></div>`
    + `<div class="queue-col-dur queue-cell">${duration}</div>`
    + `<div class="queue-item-actions">${songMenuButtonHtml(track.title)}</div></li>`;
}

function renderHead() {
  // Only what the song table's stats strip can say from a length: songs and total.
  const stats = page.order.length ? statsHtml(page.order.map((s) => ({ duration: s.duration }))) : '';
  const el = $('radio-stats');
  if (el.dataset.html !== stats) { el.innerHTML = stats; el.dataset.html = stats; }
  const sounding = isRadioActive() && player.isPlaying;
  const play = $('radio-play');
  play.disabled = !page.order.length;
  play.querySelector('path').setAttribute('d', sounding ? PAUSE_PATH : PLAY_PATH);
  $('radio-play-label').textContent = sounding ? t('player.pause', 'Pause') : t('player.play', 'Play');
  $('radio-reshuffle').disabled = page.order.length < 2;
  // With nothing loaded, the player bar's Play starts the list on screen too.
  state.viewPlay = page.open && page.order.length ? () => playAt(0) : null;
  const barPlay = $('play-btn');
  if (barPlay && !player.track) barPlay.disabled = !state.viewPlay;
}

let view = null;
function listView() {
  if (!view) {
    view = createVirtualList({
      list: $('radio-list'),
      scroller: $('radio-body'),
      stickyTop: () => $('radio-head').offsetHeight || 0,
    });
  }
  return view;
}

function emptyHtml(title, hint) {
  return `<li class="list-group-item app-empty queue-empty"><p class="mb-1">${escapeHtml(title)}</p>${hint ? `<p class="fs-sm mb-0 hint">${escapeHtml(hint)}</p>` : ''}</li>`;
}

function renderList({ anchor = true } = {}) {
  const head = $('radio-head');
  head.hidden = !page.order.length;
  if (!page.order.length) {
    let html;
    if (page.loading) html = emptyHtml(t('landing.loading', 'Loading…'));
    else if (page.failed) html = `<li class="list-group-item app-empty queue-empty"><p class="mb-3">${escapeHtml(t('radio.loadFailed', 'Could not load Radio'))}</p><button type="button" class="btn btn-sm radio-retry">${escapeHtml(t('radio.retry', 'Try again'))}</button></li>`;
    else html = emptyHtml(t('radio.emptyTitle', 'No songs to play yet'), t('radio.emptyHint', 'Songs land here as soon as they are in the music library.'));
    listView().clear(html);
    return;
  }
  const order = page.order;
  const positions = new Map(order.map((s, i) => [s.libraryId, i]));
  listView().setSource({
    count: order.length,
    keyOf: (pos) => order[pos].libraryId,
    indexOfKey: (key) => (positions.has(key) ? positions.get(key) : -1),
    renderRow: (pos) => rowHtml(order[pos], pos),
  }, { anchor });
}

function render(options) {
  renderHead();
  renderList(options);
  settleAutoplay();
}

function settleAutoplay() {
  if (!page.autoplay || page.loading) return;
  page.autoplay = false;
  if (page.order.length) playAt(0);
  else if (!page.failed) showToast(t('radio.emptyTitle', 'No songs to play yet'), 'info');
}

/** Double-click on the row: Radio already on air just resumes; else open it and play from the top. */
export function playRadioFromTop() {
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
function paintRow(row, pos) {
  const track = page.order[pos];
  if (!track) return;
  const playing = track.libraryId === currentId();
  if (row.classList.contains('playing') !== playing) {
    row.classList.toggle('playing', playing);
    if (playing) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  const btn = row.querySelector('.queue-item-play');
  const label = playCellLabel(track.title, playing && player.isPlaying);
  btn.innerHTML = playCellHtml(pos + 1, playing);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function refreshRows() {
  if (!page.open || !view) return;
  for (const [pos, row] of view.rendered()) {
    if (row.classList.contains('playing') || page.order[pos]?.libraryId === currentId()) paintRow(row, pos);
  }
}

function scrollToCurrent() {
  const id = currentId();
  const pos = id ? page.order.findIndex((s) => s.libraryId === id) : -1;
  if (pos >= 0) listView().scrollToIndex(pos, { align: 'center' });
}

// Play from a row, or from the top. The song already playing here is resumed if
// paused, never restarted.
function playAt(index) {
  const track = page.order[index];
  if (!track) return;
  if (track.libraryId === currentId()) {
    if (!player.isPlaying) player.play();
    return;
  }
  player.playFrom(CONTEXT, page.order, index);
}

function pressPlay() {
  if (isRadioActive()) player.toggle();
  else playAt(0);
}

function reshuffle() {
  const id = currentId();
  page.order = id ? reshuffledAround(page.order, id) : shuffled(page.order);
  if (isRadioActive()) player.replaceQueue(CONTEXT, page.order);
  $('radio-body').scrollTop = 0;
  render({ anchor: false });
}

async function loadFresh() {
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
export function openRadioPage() {
  const wasOpen = page.open;
  page.open = true;
  document.title = `${t('radio.title', 'Radio')} · listen-along`;
  renderSidebarRow();
  if (wasOpen) return;
  if (isRadioActive()) {
    page.order = player.queue.slice();
    page.loading = false;
    page.failed = false;
    render({ anchor: false });
    scrollToCurrent();
    return;
  }
  $('radio-body').scrollTop = 0;
  loadFresh();
}

/** The route left /radio. */
export function closeRadioPage() {
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
async function applyLibraryChange() {
  await loadSummary();
  if (!isRadioActive() && !page.open) return;
  const load = ++page.load;
  let fresh;
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
function dropLeftSongs() {
  if (!stationIds || !isRadioActive()) return;
  const id = currentId();
  const next = page.order.filter((s) => s.libraryId === id || stationIds.has(s.libraryId));
  if (next.length === page.order.length) return;
  page.order = next;
  player.replaceQueue(CONTEXT, next);
  if (page.open) render();
}

/** Socket library:updated. */
export function handleRadioLibraryUpdated() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(applyLibraryChange, REFRESH_MS);
}

/** Socket reconnected: what was missed meanwhile. */
export function refreshRadio() {
  handleRadioLibraryUpdated();
}

// ---------------------------------------------------------------------- setup

export function setupRadio() {
  const row = $('plnav-radio');
  row.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    closeDrawer();
    navigateTo('/radio');
  });

  $('radio-back').addEventListener('click', () => navigateTo('/'));
  $('radio-play').addEventListener('click', pressPlay);
  $('radio-reshuffle').addEventListener('click', reshuffle);

  const list = $('radio-list');
  const rowIndex = (el) => parseInt(el.dataset.index, 10);
  list.addEventListener('click', (e) => {
    if (e.target.closest('.radio-retry')) { loadFresh(); return; }
    const el = e.target.closest('.queue-item[data-index]');
    if (!el) return;
    if (e.target.closest('.queue-item-play')) {
      if (el.classList.contains('playing') && player.isPlaying) player.pause();
      else playAt(rowIndex(el));
      return;
    }
    if (e.target.closest('button, a[href]')) return;
    playAt(rowIndex(el));
  });
  list.addEventListener('keydown', (e) => {
    const el = e.target.closest('.queue-item[data-index]');
    if (!el || e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playAt(rowIndex(el)); return; }
    const v = listView();
    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: v.pageSize, PageUp: -v.pageSize };
    let to = null;
    if (e.key in steps) to = rowIndex(el) + steps[e.key];
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = page.order.length - 1;
    if (to === null) return;
    e.preventDefault();
    v.scrollToIndex(Math.max(0, Math.min(page.order.length - 1, to)))?.focus({ preventScroll: true });
  });
  bindSongMenu(list, '.queue-item[data-index]', (el) => {
    const track = page.order[rowIndex(el)];
    return track ? { songId: track.libraryId, url: track.url, title: track.title, artist: track.artist, youtubeId: track.youtubeId } : null;
  });

  // The list ran out: the next round, without the song that just ended on top.
  player.setRefill((ctx, track) => {
    if (!ctx || ctx.type !== 'radio' || !player.queue.length) return null;
    const songs = stationIds ? player.queue.filter((s) => stationIds.has(s.libraryId)) : player.queue;
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
  // The player bar's song, while this page is already open.
  document.addEventListener('app:reveal-playing', () => { if (page.open) scrollToCurrent(); });
  window.addEventListener('languageChanged', () => {
    renderSidebarRow();
    if (page.open) render();
  });
  loadSummary();
}
