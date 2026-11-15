// The playlists sidebar ("Your Library"): a fixed left column from 768px, a
// drawer opened from the navbars below that, plus the row of places above the
// page there (#app-places; DESIGN.md "Playlists sidebar").
// Two panels: the places (Home, Radio, Artists, Music library; links handled by
// app-page.ts's data-spa-link, the library by app.ts) over the playlists.
// The column is expanded or a 72px rail of avatars: the user's choice, else
// automatic by the room left for the page (panel-widths.ts, layout-rules.ts).
// The list comes from playlist-store.ts and the user's own folders from
// folder-store.ts; what goes where is folder-tree.ts. Everything here only
// navigates, pins, files and filters; the server decides what may be seen.
import { escapeHtml, navigateTo, t, trapFocus } from '../../shared/ui.ts';
import { parseRoute, playlistPath } from '../../router.ts';
import { PLAYLIST_FILTERS, PLAYLIST_SORTS, playlistCoverIndex, playlistInitials } from './playlist-filter.ts';
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
import { buildSidebarTree, parseCollapsed } from './folder-tree.ts';
import type { FolderNode, SidebarTree } from './folder-tree.ts';
import { folderOfPlaylist, getFolder, getFolders, foldersLoaded, loadFolders, moveToFolder, onFolders, removeFromFolder } from './folder-store.ts';
import { FOLDER_OPEN_SVG, FOLDER_SVG, folderCountText, folderMenuItems, moveToFolderItem, openNewFolderDialog } from './folder-actions.ts';
import type { PlaylistFolder, PlaylistSummary } from '../../shared/types.ts';

const PIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>';
const MORE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';

const POLL_MS = 30000;
const DRAWER_MQ = '(width < 768px)';
// Dragging a row onto a folder: a mouse only (touch keeps scrolling and the long-press menu).
const DRAG_MQ = '(hover: hover) and (pointer: fine)';
const FILTER_KEY = 'listen-sidebarFilter';
const SORT_KEY = 'listen-sidebarSort';
const COLLAPSED_KEY = 'listen-sidebarFolders';
const DRAG_TYPE = 'application/x-listen-playlist';

const EQ_HTML = '<span class="person-eq playlist-eq" aria-hidden="true"><i></i><i></i><i></i></span>';

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

// index.html has every element looked up with $ (maybeById where it may be missing).
const $ = byId;
// The playlist the player is playing from right now (equaliser + accent name), or null.
const playingId = (): string | null => (player.isPlaying && player.track && player.context && player.context.type === 'lobby' ? player.context.lobbyId : null);
let query = '';
let filter: PlaylistFilter = 'all';
let sort: PlaylistSort = 'date';
let collapsed = new Set<string>(); // folder ids the user closed, in this browser
let closedInSearch = new Set<string>(); // matching folders closed during the current search (a search opens them)
let lastHtml: string | null = null;
let drawerReturnFocus: HTMLElement | null = null;
let dragging: { id: string; from: string | null } | null = null;
let renderDeferred = false;

const isRail = (): boolean => document.body.classList.contains('plnav-rail');
const canDrag = (): boolean => !isRail() && window.matchMedia(DRAG_MQ).matches;

interface RowOptions {
  /** Where the row is ("pinned", "mine", "f:<folder id>"…): a playlist can show twice (Pinned and its folder). */
  section: string;
  /** "in <folder>" on the meta line. */
  folder?: PlaylistFolder | null;
  draggable?: boolean;
}

function rowHtml(p: PlaylistSummary, currentId: string | null, nowId: string | null, { section, folder = null, draggable = false }: RowOptions): string {
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
  const where = folder ? tf('folders.inFolder', 'in {name}', { name: folder.name }) : '';
  const meta = [ownerText(p), songs, where].filter(Boolean).join(' · ');
  const privateMark = p.visibility === 'private'
    ? `${LOCK_SVG.replace('<svg ', `<svg class="icon-sm flex-shrink-0" `)}<span class="visually-hidden">${escapeHtml(t('landing.private', 'Private'))}: </span>` : '';
  const label = [title, p.visibility === 'private' ? t('landing.private', 'Private') : '', meta, playing ? t('radio.nowPlaying', 'playing') : ''].filter(Boolean).join(', ');
  const key = `${section}:${p.id}`;
  return `<li class="list-group-item plnav-row${current ? ' is-current' : ''}${playing ? ' is-playing' : ''}${p.pinnedByMe ? ' is-pinned' : ''}" data-playlist-id="${escapeHtml(p.id)}" data-row-key="${escapeHtml(key)}"${draggable ? ' draggable="true"' : ''}>`
    + `<div class="plnav-link" role="link" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}"${current ? ' aria-current="page"' : ''}>`
    + `<span class="playlist-avatar plnav-avatar cover-${playlistCoverIndex(p.id)}" aria-hidden="true">${escapeHtml(playlistInitials(title))}</span>`
    + `<span class="text-truncate plnav-name">${escapeHtml(title)}</span>`
    + `<span class="fs-xs fg-3 plnav-meta">${playing ? EQ_HTML : ''}${privateMark}<span class="text-truncate">${escapeHtml(meta)}</span></span>`
    + `</div>`
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-pin${p.pinnedByMe ? ' active' : ''}" aria-pressed="${p.pinnedByMe ? 'true' : 'false'}" aria-label="${escapeHtml(pinLabel)}" title="${escapeHtml(pinLabel)}">${PIN_SVG}</button>`
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(menuLabel)}" title="${escapeHtml(menuLabel)}">${MORE_SVG}</button>`
    + `</li>`;
}

function groupHtml(key: PlaylistGroupKey, heading: string, rows: PlaylistSummary[], currentId: string | null, tree: SidebarTree<PlaylistSummary, PlaylistFolder>): string {
  const id = `plnav-group-${key}`;
  return `<h3 id="${id}" class="fs-xs fw-semibold fg-3 text-uppercase people-heading">${escapeHtml(heading)}</h3>`
    + listGroupHtml(`aria-labelledby="${id}"`, key, rows, currentId, tree);
}

// A filed playlist says where it is when it shows outside its folder: in Pinned
// and in a flat list (a search, Public, Private).
function listGroupHtml(label: string, key: string, rows: PlaylistSummary[], currentId: string | null, tree: SidebarTree<PlaylistSummary, PlaylistFolder>): string {
  const nowId = playingId();
  const drag = canDrag();
  const hint = (p: PlaylistSummary) => (key === 'pinned' || tree.flat ? tree.folderOf.get(p.id) || null : null);
  return `<ul class="list-group list-group-flush plnav-list" data-drop="top" ${label}>${rows.map((p) => rowHtml(p, currentId, nowId, { section: key, folder: hint(p), draggable: drag })).join('')}</ul>`;
}

// A folder: a disclosure button (icon, name, count, chevron) and ⋮, then its
// playlists indented in a list of their own. In the rail it is one icon that
// opens the sidebar with the folder open.
function folderHtml(node: FolderNode<PlaylistSummary, PlaylistFolder>, currentId: string | null, nowId: string | null, rail: boolean): string {
  const { folder, rows, expanded } = node;
  const listId = escapeHtml(`plnav-folder-${folder.id}`);
  const count = folderCountText(rows.length);
  const playingInside = !expanded && !!nowId && rows.some((p) => p.id === nowId);
  const menuLabel = tf('folders.labelFor', 'Actions for folder {name}', { name: folder.name });
  const name = escapeHtml(folder.name);
  const toggleLabel = rail
    ? tf('folders.railLabel', '{name}, folder, {count}. Opens the sidebar.', { name: folder.name, count })
    : tf('folders.toggleLabel', '{name}, folder, {count}', { name: folder.name, count }) + (playingInside ? `, ${t('radio.nowPlaying', 'playing')}` : '');
  const drag = canDrag();
  const toggle = `<button type="button" class="plnav-folder-toggle" ${rail ? '' : `aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${listId}" `}aria-label="${escapeHtml(toggleLabel)}" title="${rail ? escapeHtml(toggleLabel) : name}">`
    + `<span class="plnav-folder-icon" aria-hidden="true">${expanded && !rail ? FOLDER_OPEN_SVG : FOLDER_SVG}</span>`
    + `<span class="text-truncate plnav-name">${name}</span>`
    + `<span class="fs-xs fg-3 plnav-meta">${playingInside ? EQ_HTML : ''}<span class="text-truncate">${escapeHtml(count)}</span></span>`
    + `<span class="plnav-folder-chevron" aria-hidden="true">${CHEVRON_SVG}</span>`
    + `</button>`;
  const head = `<div class="plnav-row plnav-folder-row${playingInside ? ' is-playing' : ''}" data-folder-id="${escapeHtml(folder.id)}" data-row-key="${escapeHtml(`folder:${folder.id}`)}">`
    + toggle
    + `<button type="button" class="btn-text theme-secondary btn-icon btn-sm plnav-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(menuLabel)}" title="${escapeHtml(menuLabel)}">${MORE_SVG}</button>`
    + `</div>`;
  if (rail) return `<li class="plnav-folder" data-folder-id="${escapeHtml(folder.id)}" data-drop="folder">${head}</li>`;
  const empty = `<li class="plnav-folder-empty fs-xs fg-3">${escapeHtml(drag
    ? t('folders.emptyHintDrag', 'Nothing here yet. Drag a playlist here, or use “Move to folder” in its menu.')
    : t('folders.emptyHint', 'Nothing here yet. Use “Move to folder” in a playlist’s menu.'))}</li>`;
  const body = rows.length ? rows.map((p) => rowHtml(p, currentId, nowId, { section: `f:${folder.id}`, draggable: drag })).join('') : empty;
  return `<li class="plnav-folder${expanded ? ' is-open' : ''}" data-folder-id="${escapeHtml(folder.id)}" data-drop="folder">${head}`
    + `<ul id="${listId}" class="list-group list-group-flush plnav-list plnav-folder-list" aria-label="${name}"${expanded ? '' : ' hidden'}>${body}</ul></li>`;
}

function foldersHtml(nodes: FolderNode<PlaylistSummary, PlaylistFolder>[], currentId: string | null): string {
  const nowId = playingId();
  const rail = isRail();
  return `<h3 id="plnav-group-folders" class="fs-xs fw-semibold fg-3 text-uppercase people-heading">${escapeHtml(t('folders.heading', 'Folders'))}</h3>`
    + `<ul class="list-group list-group-flush plnav-list plnav-folders" aria-labelledby="plnav-group-folders">${nodes.map((n) => folderHtml(n, currentId, nowId, rail)).join('')}</ul>`;
}

// The rail has no chips to show or reset a filter, so it lists everything.
const activeFilter = (): PlaylistFilter => (isRail() ? 'all' : filter);
const tree = (): SidebarTree<PlaylistSummary, PlaylistFolder> => buildSidebarTree(getPlaylists(), getFolders(), {
  query, filter: activeFilter(), sort, rail: isRail(), collapsed, closedInSearch, titleOf: (p: PlaylistSummary) => playlistTitle(p.name, p.id),
});

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
  if (!getPlaylists().length && !getFolders().length) {
    return `<div class="app-empty plnav-empty"><p class="fw-medium fg-1 mb-1">${escapeHtml(t('landing.noPlaylists', 'No playlists yet'))}</p>`
      + `<p class="fs-sm fg-3 mb-4">${escapeHtml(t('landing.emptyHint', 'Make one, add songs, and share the link to listen together.'))}</p>`
      + `${newPlaylistButton()}</div>`;
  }
  const arranged = tree();
  if (arranged.empty) return noResultsHtml();
  const headings: Record<PlaylistGroupKey, string> = {
    pinned: t('sidebar.pinned', 'Pinned'),
    mine: t('landing.yourPlaylists', 'Your playlists'),
    others: t('landing.publicPlaylists', 'Public playlists'),
    rest: t('landing.playlists', 'Playlists'),
  };
  const { sections } = arranged;
  // Under the section title, one A-Z list needs no heading of its own.
  if (sections.length === 1 && sections[0].kind === 'group' && sections[0].key === 'rest') {
    return listGroupHtml('aria-labelledby="plnav-title"', 'rest', sections[0].rows, currentId, arranged);
  }
  return sections.map((s) => (s.kind === 'folders' ? foldersHtml(s.folders, currentId) : groupHtml(s.key, headings[s.key], s.rows, currentId, arranged))).join('')
    + (sections.some((s) => s.kind === 'folders') && !sections.some((s) => s.kind === 'group' && s.key !== 'pinned') && canDrag()
      // Somewhere to drop a playlist out of its folder when every playlist is filed.
      ? `<div class="plnav-drop-top fs-xs fg-3" data-drop="top">${escapeHtml(t('folders.dropTop', 'Drop here to take a playlist out of its folder'))}</div>` : '');
}

// The control focus is on, as a row key plus which part, to find it again
// after a re-render (rows re-render; a playlist can show twice).
const FOCUS_PARTS = ['plnav-pin', 'plnav-menu-btn', 'plnav-link', 'plnav-folder-toggle'];
function focusedControl(list: HTMLElement): { key: string; part: string } | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !list.contains(active)) return null;
  const row = active.closest<HTMLElement>('[data-row-key]');
  const part = FOCUS_PARTS.find((c) => active.classList.contains(c));
  return row && part ? { key: row.dataset.rowKey as string, part } : null;
}
function controlFor(key: string, part: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#plnav-list [data-row-key="${CSS.escape(key)}"] .${part}`);
}

// Re-renders only when something changed: polling must not disturb focus or an
// open menu. Focus follows the control across a re-render (a pinned row moves).
function render(): void {
  const list = maybeById('plnav-list');
  if (!list) return;
  // Never under a drag: the dragged row must stay where the browser holds it.
  if (dragging) { renderDeferred = true; return; }
  const currentId = parseRoute(window.location.pathname).lobbyId;
  const html = listHtml(currentId);
  if (html === lastHtml) return;
  const hadFocus = list.contains(document.activeElement);
  const focused = focusedControl(list);
  const scroll = list.scrollTop;
  list.innerHTML = html;
  lastHtml = html;
  list.scrollTop = scroll;
  if (focused) {
    // The same control, else the row's main control (a folder's ⋮ after a rename…), else the box.
    const el = controlFor(focused.key, focused.part)
      || controlFor(focused.key, focused.key.startsWith('folder:') ? 'plnav-folder-toggle' : 'plnav-link');
    (el || listFallback()).focus({ preventScroll: true });
  } else if (hadFocus) {
    listFallback().focus({ preventScroll: true });
  }
  const status = maybeById('plnav-status');
  if (status) {
    const n = isLoaded() ? tree().count : 0;
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
  return isRail() ? $('plnav-new') : $('plnav-search');
}

function setQuery(value: string): void {
  if (value.trim() !== query.trim()) closedInSearch = new Set();
  query = value;
  const input = $<HTMLInputElement>('plnav-search');
  if (input.value !== value) input.value = value;
  $('plnav-search-clear').hidden = !value;
  render();
}

// ------------------------------------------------------------- folders

function saveCollapsed(): void {
  storageSet(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

function setFolderOpen(id: string, open: boolean): void {
  // A search opens the folders whose name matches; closing one lasts for that search.
  if (query.trim() && !isRail()) {
    if (open) closedInSearch.delete(id);
    else closedInSearch.add(id);
    render();
    return;
  }
  if (open === !collapsed.has(id)) return;
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  saveCollapsed();
  render();
}

// The rail's folder icon: the sidebar expands with that folder open and focused.
function openFolderFromRail(id: string): void {
  setFolderOpen(id, true);
  toggleSidebarRail();
  requestAnimationFrame(() => {
    const el = controlFor(`folder:${id}`, 'plnav-folder-toggle');
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  });
}

// A new folder: open, in view, focused (the dialog gives focus back to its opener first).
function revealFolder(folder: PlaylistFolder): void {
  setFolderOpen(folder.id, true);
  setTimeout(() => {
    render();
    const el = controlFor(`folder:${folder.id}`, 'plnav-folder-toggle');
    if (el && !isRail()) el.scrollIntoView({ block: 'nearest' });
  }, 0);
}

// Collapsed ids of folders that are gone are forgotten (once the list is known).
function pruneCollapsed(): void {
  if (!foldersLoaded()) return;
  const known = new Set(getFolders().map((f) => f.id));
  const next = parseCollapsed(JSON.stringify([...collapsed]), known);
  if (next.size !== collapsed.size) { collapsed = next; saveCollapsed(); }
}

// ------------------------------------------------------------- drag and drop
// A playlist row dragged (mouse) onto a folder files it there; onto the rest
// of the list takes it out of its folder. The drop target is tinted with a full
// outline (never an edge). The menu ("Move to folder") does the same for the
// keyboard and touch.

function dropTargetOf(el: EventTarget | null): { kind: 'folder'; id: string; el: HTMLElement } | { kind: 'top'; el: HTMLElement } | null {
  const list = $('plnav-list');
  const target = el instanceof Element ? el : null;
  if (!target || !list.contains(target)) return null;
  const folder = target.closest<HTMLElement>('[data-drop="folder"]');
  if (folder) return { kind: 'folder', id: folder.dataset.folderId as string, el: folder };
  // Anywhere else in the list (a group, a heading, the space below): out of its folder.
  return { kind: 'top', el: list };
}

function clearDropMarks(): void {
  document.querySelectorAll('#plnav-list .is-drop-target, #plnav-list.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
}

function setupDragAndDrop(list: HTMLElement): void {
  list.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest?.<HTMLElement>('.plnav-row[data-playlist-id]');
    if (!row || !e.dataTransfer || !canDrag()) { e.preventDefault(); return; }
    const id = row.dataset.playlistId as string;
    dragging = { id, from: folderOfPlaylist(id)?.id || null };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, id);
    e.dataTransfer.setData('text/plain', `${window.location.origin}${playlistPath(id)}`);
    closeContextMenu();
    requestAnimationFrame(() => { row.classList.add('is-dragging'); document.body.classList.add('plnav-dragging'); });
  });
  list.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const target = dropTargetOf(e.target);
    const useful = target && (target.kind === 'folder' ? target.id !== dragging.from : dragging.from !== null);
    clearDropMarks();
    if (!target || !useful) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    target.el.classList.add('is-drop-target');
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget as Node | null)) clearDropMarks();
  });
  list.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const { id, from } = dragging;
    const target = dropTargetOf(e.target);
    endDrag();
    if (!target) return;
    if (target.kind === 'folder' && target.id !== from) moveToFolder(id, target.id);
    else if (target.kind === 'top' && from) removeFromFolder(id);
  });
  list.addEventListener('dragend', endDrag);
}

function endDrag(): void {
  dragging = null;
  clearDropMarks();
  document.body.classList.remove('plnav-dragging');
  document.querySelectorAll('#plnav-list .is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  if (renderDeferred) { renderDeferred = false; render(); }
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
  collapsed = parseCollapsed(storageGet(COLLAPSED_KEY));
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
  const key = row.dataset.rowKey as string;
  const returnFocus = () => controlFor(key, 'plnav-menu-btn') || listFallback();
  if (row.dataset.folderId) {
    const folder = getFolder(row.dataset.folderId);
    return folder ? folderMenuItems(folder, returnFocus) : null;
  }
  // Rows are rendered with data-playlist-id.
  const id = row.dataset.playlistId as string;
  const pl = getPlaylist(id);
  if (!pl) return null;
  return playlistMenuItems(pl, {
    returnFocus,
    onPlay: () => { closeDrawer(); quickPlayPlaylist(id); },
    onTogglePin: () => togglePlaylistPin(id),
    folderItem: moveToFolderItem(id, { returnFocus, onCreated: revealFolder }),
    onChanged: () => loadPlaylists(),
    onDeleted: () => {
      loadPlaylists();
      loadFolders();
      if (parseRoute(window.location.pathname).lobbyId === id) navigateTo('/');
    },
  });
}

function menuLabelFor(row: HTMLElement): string {
  if (row.dataset.folderId) {
    const folder = getFolder(row.dataset.folderId);
    return tf('folders.labelFor', 'Actions for folder {name}', { name: folder ? folder.name : '' });
  }
  const p = getPlaylist(row.dataset.playlistId as string);
  const name = p ? playlistTitle(p.name, p.id) : '';
  return t('playlistMenu.labelFor', `Actions for ${name}`, { name });
}

export function setupSidebar(): void {
  document.body.classList.add('has-plnav');
  setupFilterAndSort();
  setupRail();
  onPlaylists(render);
  onFolders(() => { pruneCollapsed(); render(); });
  loadPlaylists();
  loadFolders();
  setInterval(() => { if (!document.hidden) { loadPlaylists(); loadFolders(); } }, POLL_MS);

  const list = $('plnav-list');
  const search = $<HTMLInputElement>('plnav-search');
  search.addEventListener('input', () => setQuery(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
  });
  $('plnav-search-clear').addEventListener('click', () => { setQuery(''); search.focus(); });

  $('plnav-new').addEventListener('click', (e) => { closeDrawer(); openNewPlaylistDialog(isDrawerMode() ? null : e.currentTarget as HTMLElement); });
  $('plnav-new-folder').addEventListener('click', (e) => {
    openNewFolderDialog({ returnFocus: e.currentTarget as HTMLElement, onCreated: revealFolder });
  });
  $('plnav-home').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    closeDrawer();
    navigateTo('/');
  });
  $('plnav-profile').addEventListener('click', () => { closeDrawer(); navigateTo('/profile'); });

  // Rows are rendered with data-playlist-id or data-folder-id; the "all" chip is in index.html.
  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.plnav-empty-new')) { closeDrawer(); openNewPlaylistDialog(null); return; }
    if (target.closest('.plnav-empty-clear')) { setQuery(''); search.focus(); return; }
    if (target.closest('.plnav-empty-all')) { setFilter('all'); ($('plnav-chips').querySelector('[data-plnav-filter="all"]') as HTMLElement).focus(); return; }
    const folderRow = target.closest<HTMLElement>('.plnav-folder-row');
    if (folderRow) {
      if (target.closest('.plnav-menu-btn')) return;
      const id = folderRow.dataset.folderId as string;
      if (isRail()) { openFolderFromRail(id); return; }
      const toggle = folderRow.querySelector('.plnav-folder-toggle');
      setFolderOpen(id, toggle?.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const row = target.closest<HTMLElement>('.plnav-row');
    if (!row) return;
    if (target.closest('.plnav-pin')) { togglePlaylistPin(row.dataset.playlistId as string); return; }
    if (target.closest('.plnav-menu-btn')) return;
    goTo(row.dataset.playlistId as string);
  });
  list.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    // A folder: ← closes it, → opens it (Enter and Space are the button's own).
    if (target.classList.contains('plnav-folder-toggle') && !isRail() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      setFolderOpen((target.closest('.plnav-folder-row') as HTMLElement).dataset.folderId as string, e.key === 'ArrowRight');
      return;
    }
    if ((e.key !== 'Enter' && e.key !== ' ') || !target.classList.contains('plnav-link')) return;
    e.preventDefault();
    goTo((target.closest('.plnav-row') as HTMLElement).dataset.playlistId as string);
  });
  bindContextMenu(list, {
    rowSelector: '.plnav-row',
    triggerSelector: '.plnav-menu-btn',
    label: menuLabelFor,
    getItems: menuItemsFor,
  });
  setupDragAndDrop(list);

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
  // A mouse plugged in or out: rows become draggable or not.
  window.matchMedia(DRAG_MQ).addEventListener('change', render);

  // The current row and place follow the address bar; any navigation closes the drawer.
  window.addEventListener('popstate', () => { closeDrawer(); refresh(); });
  document.addEventListener('app:viewchange', refresh);
  window.addEventListener('languageChanged', () => { lastHtml = null; render(); });
  // The playlist playing right now has the equaliser.
  for (const event of ['state', 'context', 'track'] as const) player.on(event, render);
  syncPlaces();
}
