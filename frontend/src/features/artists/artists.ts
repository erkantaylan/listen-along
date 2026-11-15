// Artists: every artist of the music library as a read-only "album" of their
// songs (backend/src/artists.js). The landing page has a shelf of the artists
// with the most songs (one row that scrolls sideways) and "Show all" opens
// /artists, every artist A-Z with a search. A card opens /artist/<key>
// (artist-page.ts); its play button, or a double-click on it, plays the artist
// from the top. Nothing here edits anything.
import { elements } from '../../shared/state.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import { escapeHtml, navigateTo, t } from '../../shared/ui.ts';
import { player } from '../../player/player.ts';
import { artistPath } from '../../router.ts';
import { closeDrawer } from '../playlists/sidebar.ts';
import { filterArtists, shelfArtists, sortByName } from './artist-rules.ts';
import type { Artist, ArtistListResponse } from '../../shared/types.ts';

const REFRESH_MS = 1500;
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
const language = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || undefined;

interface ArtistStore {
  list: Artist[];
  byKey: Map<string, Artist>;
  loaded: boolean;
  loading: Promise<void> | null;
  failed: boolean;
  stale: boolean;
}

const store: ArtistStore = {
  list: [],          // GET /api/artists, most songs first
  byKey: new Map(),
  loaded: false,
  loading: null,     // the fetch in flight
  failed: false,
  stale: true,
};
let playArtist: (key: string) => void = () => {};
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pageOpen = false;

/** Every artist (name, key, count, cover), loading the list when it is not here or old (the search page). */
export async function ensureArtists(): Promise<Artist[]> {
  if (!store.loaded || store.stale) await loadArtists();
  return store.list;
}

/** The artist with this key, as last listed (name, count, cover), or null. */
export function artistByKey(key: string): Artist | null {
  return store.byKey.get(key) || null;
}

export function songCountText(count: number): string {
  return count === 1 ? t('artists.oneSong', '1 song') : tf('artists.songCount', '{count} songs', { count: count.toLocaleString(language()) });
}

/** A YouTube thumbnail for the artist's cover; mqdefault has no letterbox bars. */
export function coverUrl(youtubeId: string | null | undefined, size = 'mqdefault'): string | null {
  return youtubeId ? `https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/${size}.jpg` : null;
}

async function loadArtists(): Promise<void> {
  if (store.loading) return store.loading;
  store.loading = (async () => {
    try {
      const res = await fetch('/api/artists', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ArtistListResponse;
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

const isActive = (view: HTMLElement | null | undefined): boolean => !!view && view.classList.contains('active');

// Fetch when something that shows artists is on screen and the list is old.
function loadIfShown(): void {
  if (!store.stale && !store.failed) return;
  if (isActive(elements.landingView) || pageOpen) loadArtists();
}

// ---------------------------------------------------------------- the cards

const currentKey = (): string | null => (player.track && player.context && player.context.type === 'artist' ? player.context.key : null);

function cardHtml(a: Artist): string {
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

function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

// ------------------------------------------------------------ landing shelf

function renderShelf(): void {
  const section = maybeById('artists-section');
  if (!section) return;
  const shown = shelfArtists(store.list);
  section.hidden = !shown.length;
  if (!shown.length) return;
  setHtml(byId('artists-shelf'), shown.map(cardHtml).join(''));
  const all = byId('artists-show-all');
  all.hidden = store.list.length <= shown.length;
  updateShelfNav();
}

// The arrows: only with a mouse and only while the row does not fit.
function updateShelfNav(): void {
  const shelf = maybeById('artists-shelf');
  const prev = maybeById<HTMLButtonElement>('artists-shelf-prev');
  const next = byId<HTMLButtonElement>('artists-shelf-next');
  if (!shelf || !prev) return;
  const overflow = shelf.scrollWidth - shelf.clientWidth > 1;
  prev.hidden = !overflow;
  next.hidden = !overflow;
  prev.disabled = shelf.scrollLeft <= 1;
  next.disabled = shelf.scrollLeft >= shelf.scrollWidth - shelf.clientWidth - 1;
}

function scrollShelf(direction: number): void {
  const shelf = byId('artists-shelf');
  const rtl = getComputedStyle(shelf).direction === 'rtl' ? -1 : 1;
  shelf.scrollBy({ left: direction * rtl * Math.max(shelf.clientWidth * 0.8, 160), behavior: 'smooth' });
}

// ----------------------------------------------------------- /artists page

function renderPage(): void {
  if (!pageOpen) return;
  const grid = byId('artists-grid');
  const count = byId('artists-count');
  if (!store.loaded) {
    count.textContent = '';
    if (store.failed) {
      setHtml(grid, `<li class="app-empty artists-empty"><p class="mb-3">${escapeHtml(t('artists.loadFailed', 'Could not load the artists'))}</p><button type="button" class="btn btn-sm artists-retry">${escapeHtml(t('radio.retry', 'Try again'))}</button></li>`);
    } else {
      setHtml(grid, `<li class="app-empty artists-empty fg-3">${escapeHtml(t('landing.loading', 'Loading…'))}</li>`);
    }
    return;
  }
  const query = byId<HTMLInputElement>('artists-search').value;
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

function render(): void {
  renderShelf();
  renderPage();
}

/** The route opened /artists. */
export function openArtistsPage(): void {
  const wasOpen = pageOpen;
  pageOpen = true;
  document.title = `${t('artists.title', 'Artists')} · listen-along`;
  if (!wasOpen) {
    byId<HTMLInputElement>('artists-search').value = '';
    delete byId('artists-grid').dataset.html;
  }
  renderPage();
  if (!store.loaded || store.stale) loadArtists();
}

/** The route left /artists. */
export function closeArtistsPage(): void {
  if (!pageOpen) return;
  pageOpen = false;
  document.title = 'listen-along';
}

/** Socket library:updated (and a reconnect): counts and covers may have changed. */
export function handleArtistsLibraryUpdated(): void {
  store.stale = true;
  clearTimeout(refreshTimer ?? undefined);
  refreshTimer = setTimeout(loadIfShown, REFRESH_MS);
}

// ---------------------------------------------------------------------- setup

// Clicks on cards anywhere (shelf and grid): the link opens the artist in the
// app (a modified click keeps the browser's own new tab), the button plays.
function onCardClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const play = target.closest('.artist-card-play');
  const card = target.closest<HTMLElement>('.artist-card[data-artist-key]');
  if (play && card) { playArtist(card.dataset.artistKey as string); return; }
  const link = target.closest('.artist-card-link');
  if (link && card) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    closeDrawer();
    navigateTo(artistPath(card.dataset.artistKey as string));
    return;
  }
  // The rest of the card is the link too (the cover, the count).
  if (card && !target.closest('button, a[href]')) navigateTo(artistPath(card.dataset.artistKey as string));
}

/** play(key): start an artist from the top (artist-page.ts playArtistFromTop). */
export function setupArtists({ play }: { play: (key: string) => void }): void {
  playArtist = play;
  for (const list of [byId('artists-shelf'), byId('artists-grid')]) list.addEventListener('click', onCardClick);
  byId('artists-grid').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.artists-retry')) loadArtists();
    if ((e.target as HTMLElement).closest('.artists-clear')) { const s = byId<HTMLInputElement>('artists-search'); s.value = ''; renderPage(); s.focus(); }
  });
  byId('artists-show-all').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigateTo('/artists');
  });
  byId('artists-back').addEventListener('click', () => navigateTo('/'));
  const search = byId<HTMLInputElement>('artists-search');
  search.addEventListener('input', renderPage);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; renderPage(); }
  });

  const shelf = byId('artists-shelf');
  shelf.addEventListener('scroll', updateShelfNav, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(updateShelfNav).observe(shelf);
  byId('artists-shelf-prev').addEventListener('click', () => scrollShelf(-1));
  byId('artists-shelf-next').addEventListener('click', () => scrollShelf(1));

  // The card of the artist playing is tinted, here as on any row.
  player.on('context', render);
  player.on('track', render);
  document.addEventListener('app:viewchange', loadIfShown);
  window.addEventListener('languageChanged', () => {
    for (const el of [byId('artists-shelf'), byId('artists-grid')]) delete el.dataset.html;
    render();
    if (pageOpen) document.title = `${t('artists.title', 'Artists')} · listen-along`;
  });
  loadIfShown();
}
