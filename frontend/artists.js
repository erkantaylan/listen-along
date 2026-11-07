// Artists: every artist of the music library as a read-only "album" of their
// songs (backend/src/artists.js). The landing page has a shelf of the artists
// with the most songs (one row that scrolls sideways) and "Show all" opens
// /artists, every artist A-Z with a search. A card opens /artist/<key>
// (artist-page.js); its play button, or a double-click on it, plays the artist
// from the top. Nothing here edits anything.
import { elements } from './state.js';
import { escapeHtml, navigateTo, t } from './ui.js';
import { player } from './player.js';
import { artistPath } from './router.js';
import { closeDrawer } from './sidebar.js';
import { filterArtists, shelfArtists, sortByName } from './artist-rules.js';

const REFRESH_MS = 1500;
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

const $ = (id) => document.getElementById(id);
// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const language = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || undefined;

const store = {
  list: [],          // GET /api/artists, most songs first
  byKey: new Map(),
  loaded: false,
  loading: null,     // the fetch in flight
  failed: false,
  stale: true,
};
let playArtist = () => {};
let refreshTimer = null;
let pageOpen = false;

/** The artist with this key, as last listed (name, count, cover), or null. */
export function artistByKey(key) {
  return store.byKey.get(key) || null;
}

export function songCountText(count) {
  return count === 1 ? t('artists.oneSong', '1 song') : tf('artists.songCount', '{count} songs', { count: count.toLocaleString(language()) });
}

/** A YouTube thumbnail for the artist's cover; mqdefault has no letterbox bars. */
export function coverUrl(youtubeId, size = 'mqdefault') {
  return youtubeId ? `https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/${size}.jpg` : null;
}

async function loadArtists() {
  if (store.loading) return store.loading;
  store.loading = (async () => {
    try {
      const res = await fetch('/api/artists', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      store.list = Array.isArray(data.artists) ? data.artists : [];
      store.byKey = new Map(store.list.map((a) => [a.key, a]));
      store.loaded = true;
      store.failed = false;
      store.stale = false;
    } catch {
      store.failed = true;
    } finally {
      store.loading = null;
    }
    render();
  })();
  return store.loading;
}

const isActive = (view) => !!view && view.classList.contains('active');

// Fetch when something that shows artists is on screen and the list is old.
function loadIfShown() {
  if (!store.stale && !store.failed) return;
  if (isActive(elements.landingView) || pageOpen) loadArtists();
}

// ---------------------------------------------------------------- the cards

const currentKey = () => (player.track && player.context && player.context.type === 'artist' ? player.context.key : null);

function cardHtml(a) {
  const name = escapeHtml(a.name);
  const count = songCountText(a.count);
  const playing = a.key === currentKey();
  const cover = coverUrl(a.cover_youtube_id);
  const art = cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : NOTE_ICON;
  const playLabel = escapeHtml(tf('artists.play', 'Play {name}', { name: a.name }));
  const linkLabel = escapeHtml(`${a.name}, ${count}${playing ? `, ${t('radio.nowPlaying', 'playing')}` : ''}`);
  return `<li class="artist-card${playing ? ' is-current' : ''}" data-artist-key="${escapeHtml(a.key)}">`
    + `<div class="artist-card-media"><span class="app-thumb artist-card-art">${art}</span>`
    + `<button type="button" class="btn btn-icon artist-card-play" aria-label="${playLabel}" title="${playLabel}">${PLAY_ICON}</button></div>`
    + `<a class="artist-card-link" href="${escapeHtml(artistPath(a.key))}" aria-label="${linkLabel}"${playing ? ' aria-current="true"' : ''}><span class="artist-card-name" title="${name}">${name}</span></a>`
    + `<span class="artist-card-meta">${escapeHtml(count)}</span></li>`;
}

function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

// ------------------------------------------------------------ landing shelf

function renderShelf() {
  const section = $('artists-section');
  if (!section) return;
  const shown = shelfArtists(store.list);
  section.hidden = !shown.length;
  if (!shown.length) return;
  setHtml($('artists-shelf'), shown.map(cardHtml).join(''));
  const all = $('artists-show-all');
  all.hidden = store.list.length <= shown.length;
  updateShelfNav();
}

// The arrows: only with a mouse and only while the row does not fit.
function updateShelfNav() {
  const shelf = $('artists-shelf');
  const prev = $('artists-shelf-prev');
  const next = $('artists-shelf-next');
  if (!shelf || !prev) return;
  const overflow = shelf.scrollWidth - shelf.clientWidth > 1;
  prev.hidden = !overflow;
  next.hidden = !overflow;
  prev.disabled = shelf.scrollLeft <= 1;
  next.disabled = shelf.scrollLeft >= shelf.scrollWidth - shelf.clientWidth - 1;
}

function scrollShelf(direction) {
  const shelf = $('artists-shelf');
  const rtl = getComputedStyle(shelf).direction === 'rtl' ? -1 : 1;
  shelf.scrollBy({ left: direction * rtl * Math.max(shelf.clientWidth * 0.8, 160), behavior: 'smooth' });
}

// ----------------------------------------------------------- /artists page

function renderPage() {
  if (!pageOpen) return;
  const grid = $('artists-grid');
  const count = $('artists-count');
  if (!store.loaded) {
    count.textContent = '';
    if (store.failed) {
      setHtml(grid, `<li class="app-empty artists-empty"><p class="mb-3">${escapeHtml(t('artists.loadFailed', 'Could not load the artists'))}</p><button type="button" class="btn btn-sm artists-retry">${escapeHtml(t('radio.retry', 'Try again'))}</button></li>`);
    } else {
      setHtml(grid, `<li class="app-empty artists-empty fg-3">${escapeHtml(t('landing.loading', 'Loading…'))}</li>`);
    }
    return;
  }
  const query = $('artists-search').value;
  const shown = filterArtists(sortByName(store.list), query);
  const total = store.list.length;
  count.textContent = query.trim()
    ? tf('artists.matchCount', '{shown} of {total}', { shown: shown.length.toLocaleString(language()), total: total.toLocaleString(language()) })
    : total === 1 ? t('artists.oneArtist', '1 artist') : tf('artists.artistCount', '{count} artists', { count: total.toLocaleString(language()) });
  if (shown.length) {
    setHtml(grid, shown.map(cardHtml).join(''));
  } else if (total) {
    setHtml(grid, `<li class="app-empty artists-empty"><p class="mb-3">${escapeHtml(t('artists.noMatch', 'No artist matches your search'))}</p><button type="button" class="btn btn-sm artists-clear">${escapeHtml(t('sidebar.clearSearch', 'Clear search'))}</button></li>`);
  } else {
    setHtml(grid, `<li class="app-empty artists-empty"><p class="mb-1">${escapeHtml(t('artists.emptyTitle', 'No artists yet'))}</p><p class="fs-sm fg-3 mb-0">${escapeHtml(t('radio.emptyHint', 'Songs land here as soon as they are in the music library.'))}</p></li>`);
  }
}

function render() {
  renderShelf();
  renderPage();
}

/** The route opened /artists. */
export function openArtistsPage() {
  const wasOpen = pageOpen;
  pageOpen = true;
  document.title = `${t('artists.title', 'Artists')} · listen-along`;
  if (!wasOpen) {
    $('artists-search').value = '';
    delete $('artists-grid').dataset.html;
  }
  renderPage();
  if (!store.loaded || store.stale) loadArtists();
}

/** The route left /artists. */
export function closeArtistsPage() {
  if (!pageOpen) return;
  pageOpen = false;
  document.title = 'listen-along';
}

/** Socket library:updated (and a reconnect): counts and covers may have changed. */
export function handleArtistsLibraryUpdated() {
  store.stale = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadIfShown, REFRESH_MS);
}

// ---------------------------------------------------------------------- setup

// Clicks on cards anywhere (shelf and grid): the link opens the artist in the
// app (a modified click keeps the browser's own new tab), the button plays.
function onCardClick(e) {
  const play = e.target.closest('.artist-card-play');
  const card = e.target.closest('.artist-card[data-artist-key]');
  if (play && card) { playArtist(card.dataset.artistKey); return; }
  const link = e.target.closest('.artist-card-link');
  if (link && card) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    closeDrawer();
    navigateTo(artistPath(card.dataset.artistKey));
    return;
  }
  // The rest of the card is the link too (the cover, the count).
  if (card && !e.target.closest('button, a[href]')) navigateTo(artistPath(card.dataset.artistKey));
}

/** play(key): start an artist from the top (artist-page.js playArtistFromTop). */
export function setupArtists({ play }) {
  playArtist = play;
  for (const list of [$('artists-shelf'), $('artists-grid')]) list.addEventListener('click', onCardClick);
  $('artists-grid').addEventListener('click', (e) => {
    if (e.target.closest('.artists-retry')) loadArtists();
    if (e.target.closest('.artists-clear')) { const s = $('artists-search'); s.value = ''; renderPage(); s.focus(); }
  });
  $('artists-show-all').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateTo('/artists');
  });
  $('artists-back').addEventListener('click', () => navigateTo('/'));
  const search = $('artists-search');
  search.addEventListener('input', renderPage);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; renderPage(); }
  });

  const shelf = $('artists-shelf');
  shelf.addEventListener('scroll', updateShelfNav, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(updateShelfNav).observe(shelf);
  $('artists-shelf-prev').addEventListener('click', () => scrollShelf(-1));
  $('artists-shelf-next').addEventListener('click', () => scrollShelf(1));

  // The card of the artist playing is tinted, here as on any row.
  player.on('context', render);
  player.on('track', render);
  document.addEventListener('app:viewchange', loadIfShown);
  window.addEventListener('languageChanged', () => {
    for (const el of [$('artists-shelf'), $('artists-grid')]) delete el.dataset.html;
    render();
    if (pageOpen) document.title = `${t('artists.title', 'Artists')} · listen-along`;
  });
  loadIfShown();
}
