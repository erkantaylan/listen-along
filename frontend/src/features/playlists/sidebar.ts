// The playlists sidebar ("Your Library"): a fixed left column from 768px, a
// drawer opened from the navbars below that, plus the row of places above the
// page there (#app-places; DESIGN.md "Playlists sidebar").
// Two panels: the places (Home, Radio, Artists, Music library; links handled by
// app-page.ts's data-spa-link, the library by app.ts) over the playlists.
// The column is expanded or a 72px rail of avatars: the user's choice, else
// automatic by the room left for the page (panel-widths.ts, layout-rules.ts).
// The list comes from playlist-store.ts, so everything here only navigates,
// pins and filters; the server decides what may be seen.
import { escapeHtml, navigateTo, t, trapFocus } from '../../shared/ui.ts';
import { parseRoute, playlistPath } from '../../router.ts';
import { PLAYLIST_FILTERS, PLAYLIST_SORTS, arrangePlaylists, playlistCoverIndex, playlistInitials } from './playlist-filter.ts';
import type { PlaylistFilter, PlaylistGroupKey, PlaylistSort } from './playlist-filter.ts';
import { player } from '../../player/player.ts';
import { applyColumns, isSidebarRail, setupPanelWidths, toggleSidebarRail } from '../../shared/panel-widths.ts';
import { storageGet, storageSet } from '../../shared/state.ts';
import { getPlaylist, getPlaylists, isLoaded, loadPlaylists, onPlaylists, togglePlaylistPin } from './playlist-store.ts';
import { LOCK_SVG, playlistMenuItems } from './playlist-actions.ts';
import { bindContextMenu, closeContextMenu, isContextMenuOpen, openContextMenu } from '../../shared/context-menu.ts';
import type { MenuItem } from '../../shared/context-menu.ts';
import { ownerText, playlistTitle, quickPlayPlaylist } from './playlist.ts';
import { openNewPlaylistDialog } from './new-playlist.ts';
import { byId, maybeById } from '../../shared/dom.ts';
import type { PlaylistSummary } from '../../shared/types.ts';

const PIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>';
const MORE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

const POLL_MS = 30000;
const DRAWER_MQ = '(width < 768px)';
const FILTER_KEY = 'listen-sidebarFilter';
const SORT_KEY = 'listen-sidebarSort';

const EQ_HTML = '<span class="person-eq playlist-eq" aria-hidden="true"><i></i><i></i><i></i></span>';

// index.html has every element looked up with $ (maybeById where it may be missing).
const $ = byId;
// The playlist the player is playing from right now (equaliser + accent name), or null.
const playingId = (): string | null => (player.isPlaying && player.track && player.context && player.context.type === 'lobby' ? player.context.lobbyId : null);
let query = '';
let filter: PlaylistFilter = 'all';
let sort: PlaylistSort = 'date';
let lastHtml: string | null = null;
let drawerReturnFocus: HTMLElement | null = null;

function rowHtml(p: PlaylistSummary, currentId: string | null, nowId: string | null): string {
  const title = playlistTitle(p.name, p.id);
  const current = p.id === currentId;
  const playing = p.id === nowId;
  const pinLabel = p.pinnedByMe
    ? t('sidebar.unpinNamed', `Unpin ${title}`, { name: title })
    : t('sidebar.pinNamed', `Pin ${title}`, { name: title });
  const menuLabel = t('playlistMenu.labelFor', `Actions for ${title}`, { name: title });
  const songs = p.songCount === 1
    ? t('sidebar.oneSong', '1 song')
    : t('sidebar.songs', `${p.songCount} songs`, { count: p.songCount });
  const meta = [ownerText(p), songs].filter(Boolean).join(' · ');
  const privateMark = p.visibility === 'private'
    ? `${LOCK_SVG.replace('<svg ', `<svg class="icon-sm flex-shrink-0" `)}<span class="visually-hidden">${escapeHtml(t('landing.private', 'Private'))}: </span>` : '';
  const label = [title, p.visibility === 'private' ? t('landing.private', 'Private') : '', meta, playing ? t('radio.nowPlaying', 'playing') : ''].filter(Boolean).join(', ');
  return `<li class="list-group-item plnav-row${current ? ' is-current' : ''}${playing ? ' is-playing' : ''}${p.pinnedByMe ? ' is-pinned' : ''}" data-playlist-id="${escapeHtml(p.id)}">`
    + `<div class="plnav-link" role="link" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}"${current ? ' aria-current="page"' : ''}>`
    + `<span class="playlist-avatar plnav-avatar cover-${playlistCoverIndex(p.id)}" aria-hidden="true">${escapeHtml(playlistInitials(title))}</span>`
    + `<span class="text-truncate plnav-name">${escapeHtml(title)}</span>`
    + `<span class="fs-xs fg-3 plnav-meta">${playing ? EQ_HTML : ''}${privateMark}<span class="text-truncate">${escapeHtml(meta)}</span></span>`
    + `</div>`
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-pin${p.pinnedByMe ? ' active' : ''}" aria-pressed="${p.pinnedByMe ? 'true' : 'false'}" aria-label="${escapeHtml(pinLabel)}" title="${escapeHtml(pinLabel)}">${PIN_SVG}</button>`
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(menuLabel)}" title="${escapeHtml(menuLabel)}">${MORE_SVG}</button>`
    + `</li>`;
}

function groupHtml(key: PlaylistGroupKey, heading: string, rows: PlaylistSummary[], currentId: string | null): string {
  const id = `plnav-group-${key}`;
  return `<h3 id="${id}" class="fs-xs fw-semibold fg-3 text-uppercase people-heading">${escapeHtml(heading)}</h3>`
    + listGroupHtml(`aria-labelledby="${id}"`, rows, currentId);
}

const listGroupHtml = (label: string, rows: PlaylistSummary[], currentId: string | null): string => {
  const nowId = playingId();
  return `<ul class="list-group list-group-flush plnav-list" ${label}>${rows.map(p => rowHtml(p, currentId, nowId)).join('')}</ul>`;
};

// The rail has no chips to show or reset a filter, so it lists everything.
const activeFilter = (): PlaylistFilter => (document.body.classList.contains('plnav-rail') ? 'all' : filter);
const arranged = () => arrangePlaylists(getPlaylists(), { query, filter: activeFilter(), sort, titleOf: (p: PlaylistSummary) => playlistTitle(p.name, p.id) });

function newPlaylistButton(): string {
  return `<button type="button" class="btn plnav-empty-new" aria-haspopup="dialog">${PLUS_SVG}${escapeHtml(t('landing.newPlaylist', 'New playlist'))}</button>`;
}

function noResultsHtml(): string {
  const f = activeFilter();
  const messages: Partial<Record<PlaylistFilter, string>> = {
    mine: t('sidebar.emptyMine', 'You have no playlists yet'),
    public: t('sidebar.emptyPublic', 'No public playlists'),
    private: t('sidebar.emptyPrivate', 'You have no private playlists'),
  };
  const text = query ? t('sidebar.noMatches', `No playlists match “${query}”`, { query }) : messages[f];
  const buttons = [
    !query && f !== 'public' ? newPlaylistButton() : '',
    query ? `<button type="button" class="btn btn-sm plnav-empty-clear">${escapeHtml(t('sidebar.clearSearch', 'Clear search'))}</button>` : '',
    f !== 'all' ? `<button type="button" class="btn btn-sm plnav-empty-all">${escapeHtml(t('sidebar.showAll', 'Show all'))}</button>` : '',
  ].join('');
  return `<div class="app-empty plnav-empty"><p class="fs-sm fg-3 mb-3 text-break">${escapeHtml(text)}</p>`
    + `<div class="d-flex flex-wrap justify-content-center gap-2">${buttons}</div></div>`;
}

function listHtml(currentId: string | null): string {
  if (!isLoaded()) return `<p class="fs-sm fg-3 app-empty plnav-empty">${escapeHtml(t('landing.loading', 'Loading…'))}</p>`;
  if (!getPlaylists().length) {
    return `<div class="app-empty plnav-empty"><p class="fw-medium fg-1 mb-1">${escapeHtml(t('landing.noPlaylists', 'No playlists yet'))}</p>`
      + `<p class="fs-sm fg-3 mb-4">${escapeHtml(t('landing.emptyHint', 'Make one, add songs, and share the link to listen together.'))}</p>`
      + `${newPlaylistButton()}</div>`;
  }
  const { groups, count } = arranged();
  if (!count) return noResultsHtml();
  const headings: Record<PlaylistGroupKey, string> = {
    pinned: t('sidebar.pinned', 'Pinned'),
    mine: t('landing.yourPlaylists', 'Your playlists'),
    others: t('landing.publicPlaylists', 'Public playlists'),
    rest: t('landing.playlists', 'Playlists'),
  };
  // Under the section title, one A-Z list needs no heading of its own.
  if (groups.length === 1 && groups[0].key === 'rest') return listGroupHtml('aria-labelledby="plnav-title"', groups[0].rows, currentId);
  return groups.map(g => groupHtml(g.key, headings[g.key], g.rows, currentId)).join('');
}

// Re-renders only when something changed: polling must not disturb focus or an
// open menu. Focus follows the control across a re-render (a pinned row moves).
function render(): void {
  const list = maybeById('plnav-list');
  if (!list) return;
  const currentId = parseRoute(window.location.pathname).lobbyId;
  const html = listHtml(currentId);
  if (html === lastHtml) return;
  // Only read when it is inside the list (so an element).
  const active = document.activeElement as HTMLElement;
  const focusedRow = list.contains(active) ? active.closest<HTMLElement>('.plnav-row') : null;
  const hadFocus = list.contains(active);
  const part = !focusedRow ? null : ['plnav-pin', 'plnav-menu-btn', 'plnav-link'].find(c => active.classList.contains(c));
  const focusedId = focusedRow && focusedRow.dataset.playlistId;
  const scroll = list.scrollTop;
  list.innerHTML = html;
  lastHtml = html;
  list.scrollTop = scroll;
  if (focusedId && part) {
    const el = list.querySelector<HTMLElement>(`.plnav-row[data-playlist-id="${CSS.escape(focusedId)}"] .${part}`);
    if (el) el.focus({ preventScroll: true });
    else listFallback().focus({ preventScroll: true });
  } else if (hadFocus) {
    listFallback().focus({ preventScroll: true });
  }
  const status = maybeById('plnav-status');
  if (status) {
    const n = arranged().count;
    status.textContent = query || activeFilter() !== 'all' ? t('sidebar.resultCount', `Playlists found: ${n}`, { count: n }) : '';
  }
}

// The places in the upper panel and in the phone row (#app-places): the one on
// screen is aria-current="page" (CSS tints it). The sidebar's Radio marks itself
// (radio.ts), as it also shows what is playing; the phone row's only follows the page.
function syncPlaces(): void {
  const route = parseRoute(window.location.pathname, window.location.search);
  const library = !!route.library || document.body.classList.contains('libpage-open');
  const home = !library && route.view === 'landing';
  const artists = !library && (route.view === 'artists' || route.view === 'artist');
  const search = !library && route.view === 'search';
  const current: Record<string, boolean> = {
    'plnav-nav-search': search,
    'places-search': search,
    'plnav-nav-home': home,
    'plnav-nav-artists': artists,
    'plnav-nav-library': library,
    'places-home': home,
    'places-radio': !library && route.view === 'radio',
    'places-artists': artists,
    'places-library': library,
  };
  for (const [id, on] of Object.entries(current)) {
    const el = maybeById(id);
    if (!el) continue;
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function refresh(): void {
  syncPlaces();
  render();
}

// Where focus goes when its row is gone; the rail has no search box.
function listFallback(): HTMLElement {
  return document.body.classList.contains('plnav-rail') ? $('plnav-new') : $('plnav-search');
}

function setQuery(value: string): void {
  query = value;
  const input = $<HTMLInputElement>('plnav-search');
  if (input.value !== value) input.value = value;
  $('plnav-search-clear').hidden = !value;
  render();
}

// ------------------------------------------------------------- filter and sort

function syncChips(): void {
  const chips = $('plnav-chips');
  chips.querySelectorAll<HTMLElement>('[data-plnav-filter]').forEach((chip) => {
    const on = chip.dataset.plnavFilter === filter;
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on) return;
    // Only the chips scroll: scrollIntoView could also move the page or a closed drawer.
    if (chip.offsetLeft < chips.scrollLeft) chips.scrollLeft = chip.offsetLeft - chips.offsetLeft;
    else if (chip.offsetLeft + chip.offsetWidth > chips.scrollLeft + chips.clientWidth) chips.scrollLeft = chip.offsetLeft + chip.offsetWidth - chips.clientWidth;
  });
}

function syncSortButton(): void {
  const name = sort === 'name' ? t('sidebar.sortName', 'Name') : t('sidebar.sortDate', 'Date');
  const label = t('sidebar.sortLabel', `Sort playlists: ${name}`, { sort: name });
  const btn = $('plnav-sort');
  $('plnav-sort-label').textContent = name;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
}

function setFilter(value: PlaylistFilter): void {
  filter = value;
  storageSet(FILTER_KEY, filter);
  syncChips();
  $('plnav-list').scrollTop = 0;
  render();
}

function setSort(value: PlaylistSort): void {
  sort = value;
  storageSet(SORT_KEY, sort);
  syncSortButton();
  $('plnav-list').scrollTop = 0;
  render();
}

function openSortMenu(btn: HTMLElement, keyboard: boolean): void {
  const choice = (value: PlaylistSort, label: string): MenuItem => ({ label, checked: sort === value, onSelect: () => setSort(value) });
  openContextMenu({ anchor: btn }, [
    { header: t('sidebar.sortBy', 'Sort by') },
    choice('name', t('sidebar.sortNameLong', 'Name (A–Z)')),
    choice('date', t('sidebar.sortDateLong', 'Date created')),
  ], { label: t('sidebar.sortBy', 'Sort by'), trigger: btn, focusFirst: keyboard, className: 'plnav-sort-menu' });
}

function setupFilterAndSort(): void {
  const savedFilter = storageGet(FILTER_KEY);
  const savedSort = storageGet(SORT_KEY);
  if ((PLAYLIST_FILTERS as readonly (string | null)[]).includes(savedFilter)) filter = savedFilter as PlaylistFilter;
  if ((PLAYLIST_SORTS as readonly (string | null)[]).includes(savedSort)) sort = savedSort as PlaylistSort;
  const chips = $('plnav-chips');
  chips.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-plnav-filter]');
    if (!chip) return;
    // The chips in index.html carry one of PLAYLIST_FILTERS.
    const value = chip.dataset.plnavFilter as PlaylistFilter;
    setFilter(value === filter ? 'all' : value); // tapping the active chip resets
  });
  // The scrollbar is hidden: a mouse wheel moves the line sideways.
  chips.addEventListener('wheel', (e) => {
    if (!e.deltaY || chips.scrollWidth <= chips.clientWidth) return;
    e.preventDefault();
    chips.scrollLeft += e.deltaY;
  }, { passive: false });
  $('plnav-sort').addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    if (isContextMenuOpen() && btn.getAttribute('aria-expanded') === 'true') { closeContextMenu(); return; }
    openSortMenu(btn, e.detail === 0);
  });
  syncChips();
  syncSortButton();
  window.addEventListener('languageChanged', syncSortButton);
}

// ------------------------------------------------------------- rail

function syncRail(): void {
  const rail = isSidebarRail();
  const toggle = $('plnav-toggle');
  const label = rail ? t('sidebar.expand', 'Expand playlists') : t('sidebar.collapse', 'Collapse playlists');
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
  toggle.setAttribute('aria-expanded', rail ? 'false' : 'true');
  if (rail && query) setQuery(''); // nowhere to see or clear it
  else render(); // the rail lists everything; expanding brings the filter back
}

function setupRail(): void {
  setupPanelWidths();
  $('plnav-toggle').addEventListener('click', toggleSidebarRail);
  document.addEventListener('app:railchange', syncRail); // a toggle, a drag, the window or the chat panel
  window.addEventListener('languageChanged', syncRail);
  applyColumns();
  syncRail();
}

// ------------------------------------------------------------- drawer

const isDrawerMode = (): boolean => window.matchMedia(DRAWER_MQ).matches;

function setDrawerExpanded(open: boolean): void {
  document.querySelectorAll('[data-plnav-open]').forEach(b => b.setAttribute('aria-expanded', open ? 'true' : 'false'));
}

function openDrawer(trigger: HTMLElement | null): void {
  drawerReturnFocus = trigger || null;
  document.body.classList.add('plnav-open');
  $('plnav-backdrop').hidden = false;
  setDrawerExpanded(true);
  $('plnav-close').focus({ preventScroll: true });
}

export function closeDrawer({ restoreFocus = false }: { restoreFocus?: boolean } = {}): void {
  if (!document.body.classList.contains('plnav-open')) return;
  document.body.classList.remove('plnav-open');
  $('plnav-backdrop').hidden = true;
  setDrawerExpanded(false);
  const back = drawerReturnFocus;
  drawerReturnFocus = null;
  if (restoreFocus && back && document.contains(back)) back.focus({ preventScroll: true });
}

function goTo(id: string): void {
  closeDrawer();
  navigateTo(playlistPath(id));
}

function menuItemsFor(row: HTMLElement): MenuItem[] | null {
  // Rows are rendered with data-playlist-id.
  const id = row.dataset.playlistId as string;
  const pl = getPlaylist(id);
  if (!pl) return null;
  const returnFocus = () => document.querySelector<HTMLElement>(`.plnav-row[data-playlist-id="${CSS.escape(id)}"] .plnav-menu-btn`) || listFallback();
  return playlistMenuItems(pl, {
    returnFocus,
    onPlay: () => { closeDrawer(); quickPlayPlaylist(id); },
    onTogglePin: () => togglePlaylistPin(id),
    onChanged: () => loadPlaylists(),
    onDeleted: () => {
      loadPlaylists();
      if (parseRoute(window.location.pathname).lobbyId === id) navigateTo('/');
    },
  });
}

export function setupSidebar(): void {
  document.body.classList.add('has-plnav');
  setupFilterAndSort();
  setupRail();
  onPlaylists(render);
  loadPlaylists();
  setInterval(() => { if (!document.hidden) loadPlaylists(); }, POLL_MS);

  const list = $('plnav-list');
  const search = $<HTMLInputElement>('plnav-search');
  search.addEventListener('input', () => setQuery(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
  });
  $('plnav-search-clear').addEventListener('click', () => { setQuery(''); search.focus(); });

  $('plnav-new').addEventListener('click', (e) => { closeDrawer(); openNewPlaylistDialog(isDrawerMode() ? null : e.currentTarget as HTMLElement); });
  $('plnav-home').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    closeDrawer();
    navigateTo('/');
  });
  $('plnav-profile').addEventListener('click', () => { closeDrawer(); navigateTo('/profile'); });

  // Rows are rendered with data-playlist-id; the "all" chip is in index.html.
  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.plnav-empty-new')) { closeDrawer(); openNewPlaylistDialog(null); return; }
    if (target.closest('.plnav-empty-clear')) { setQuery(''); search.focus(); return; }
    if (target.closest('.plnav-empty-all')) { setFilter('all'); ($('plnav-chips').querySelector('[data-plnav-filter="all"]') as HTMLElement).focus(); return; }
    const row = target.closest<HTMLElement>('.plnav-row');
    if (!row) return;
    if (target.closest('.plnav-pin')) { togglePlaylistPin(row.dataset.playlistId as string); return; }
    if (target.closest('.plnav-menu-btn')) return;
    goTo(row.dataset.playlistId as string);
  });
  list.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if ((e.key !== 'Enter' && e.key !== ' ') || !target.classList.contains('plnav-link')) return;
    e.preventDefault();
    goTo((target.closest('.plnav-row') as HTMLElement).dataset.playlistId as string);
  });
  bindContextMenu(list, {
    rowSelector: '.plnav-row',
    triggerSelector: '.plnav-menu-btn',
    label: (row) => { const p = getPlaylist(row.dataset.playlistId as string); const name = p ? playlistTitle(p.name, p.id) : ''; return t('playlistMenu.labelFor', `Actions for ${name}`, { name }); },
    getItems: menuItemsFor,
  });

  // Drawer (below 768px).
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-plnav-open]');
    if (btn) openDrawer(btn);
  });
  $('plnav-close').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  $('plnav-backdrop').addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  $('app-sidebar').addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('plnav-open')) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeDrawer({ restoreFocus: true }); return; }
    trapFocus($('app-sidebar'), e);
  });
  window.matchMedia(DRAWER_MQ).addEventListener('change', () => closeDrawer());

  // The current row and place follow the address bar; any navigation closes the drawer.
  window.addEventListener('popstate', () => { closeDrawer(); refresh(); });
  document.addEventListener('app:viewchange', refresh);
  window.addEventListener('languageChanged', () => { lastHtml = null; render(); });
  // The playlist playing right now has the equaliser.
  for (const event of ['state', 'context', 'track'] as const) player.on(event, render);
  syncPlaces();
}
