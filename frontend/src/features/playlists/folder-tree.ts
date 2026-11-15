// What the playlists sidebar draws once folders exist: the pure rules (no DOM),
// unit tested in folder-tree.test.ts. sidebar.ts renders the result.
//
// Folders are the user's own (GET /api/playlist-folders), one level deep, and
// the server lists in them only playlists the user can see now. The rules:
//
// - Pinned stays on top as a shortcut: a pinned playlist shows there even when
//   it is filed in a folder (and inside its folder too).
// - All and Mine (no search): a "Folders" section comes after Pinned and before
//   the groups (Your playlists / Public playlists, or the one A-Z list). A
//   filed playlist is shown inside its folder and NOT again in its group. The
//   sort applies inside each folder, and to the folders (Name: A-Z by folder
//   name; Date: newest folder first). Mine shows only your own playlists inside
//   a folder; a folder whose playlists are all filtered away is hidden there,
//   but an empty folder always shows (to be filled).
// - Public and Private: the flat groups as before (a folder is not public or
//   private); a filed playlist carries "in <folder>".
// - A search: flat. Every matching playlist in its group, with "in <folder>";
//   above them the folders whose NAME matches, open whatever their saved state
//   (one closed during that search stays closed for it), holding their
//   playlists (by the tab, not by the search), not repeated below (except in Pinned).
// - The rail lists everything (filter All, no search): folders are single
//   icons and their playlists are not repeated (except pinned).
// - A filed playlist the list does not have (gone, or not visible any more) is
//   ignored: the folder simply does not show it.
import { matchesFilter, matchesQuery, arrangePlaylists, sortPlaylists } from './playlist-filter.ts';
import type { FilterablePlaylist, PlaylistFilter, PlaylistGroup, PlaylistSort } from './playlist-filter.ts';
import type { PlaylistFolder } from '../../shared/types.ts';

/** What the rules read from a folder. */
export type FolderLike = Pick<PlaylistFolder, 'id' | 'name' | 'createdAt' | 'playlistIds'>;

export interface FolderNode<P, F extends FolderLike = FolderLike> {
  folder: F;
  /** Its playlists as shown (filtered by the tab, sorted). */
  rows: P[];
  /** Open: its rows are shown. Collapsed folders still carry their rows (counts, the equaliser). */
  expanded: boolean;
  /** Shown because its name matches the search. */
  nameMatch: boolean;
}

export type SidebarSection<P, F extends FolderLike = FolderLike> =
  | { kind: 'folders'; folders: FolderNode<P, F>[] }
  | ({ kind: 'group' } & PlaylistGroup<P>);

export interface SidebarTree<P, F extends FolderLike = FolderLike> {
  sections: SidebarSection<P, F>[];
  /** Playlists shown (each once, wherever it shows; collapsed folders count). */
  count: number;
  /** Folders shown. */
  folderCount: number;
  /** Nothing at all to show (no playlist, no folder). */
  empty: boolean;
  /** Flat: rows of filed playlists say which folder they are in. */
  flat: boolean;
  /** playlist id -> its folder (visible playlists only). */
  folderOf: Map<string, F>;
}

export interface TreeOptions<P> {
  query?: string;
  filter?: PlaylistFilter;
  sort?: PlaylistSort;
  titleOf?: (p: P) => string;
  /** Folder ids the user collapsed (remembered per browser). */
  collapsed?: ReadonlySet<string>;
  /** During a search (which opens matching folders): the ones the user closed again. */
  closedInSearch?: ReadonlySet<string>;
  /** The 72px rail: folders as icons, everything listed. */
  rail?: boolean;
}

type TreePlaylist = FilterablePlaylist & { id: string };

/** playlist id -> its folder, for the playlists in `known` only; a playlist in two folders keeps the first. */
export function folderIndex<F extends FolderLike>(folders: readonly F[], known: ReadonlySet<string>): Map<string, F> {
  const out = new Map<string, F>();
  for (const f of folders) {
    for (const id of f.playlistIds || []) if (known.has(id) && !out.has(id)) out.set(id, f);
  }
  return out;
}

/** Folders in the sidebar's sort: by name A-Z (Turkish order), or newest first. */
export function sortFolders<F extends FolderLike>(folders: readonly F[], sort: PlaylistSort = 'date'): F[] {
  const byNewest = (a: F, b: F) => (b.createdAt || 0) - (a.createdAt || 0) || String(a.id).localeCompare(String(b.id));
  return folders.slice().sort(sort === 'name'
    ? (a, b) => String(a.name).trim().localeCompare(String(b.name).trim(), 'tr', { numeric: true }) || byNewest(a, b)
    : byNewest);
}

/** Folders appear as folders in these tabs; the others are flat. */
export const showsFolders = (filter: PlaylistFilter): boolean => filter === 'all' || filter === 'mine';

export function buildSidebarTree<P extends TreePlaylist, F extends FolderLike>(
  playlists: readonly P[],
  folders: readonly F[],
  { query = '', filter = 'all', sort = 'date', titleOf = (p: P) => p.name || p.id || '', collapsed = new Set<string>(), closedInSearch = new Set<string>(), rail = false }: TreeOptions<P> = {}
): SidebarTree<P, F> {
  const tab: PlaylistFilter = rail ? 'all' : filter;
  const q = rail ? '' : query;
  const searching = !!q.trim();
  const byId = new Map(playlists.map((p) => [p.id, p]));
  const folderOf = folderIndex(folders, new Set(byId.keys()));
  const arrange = (list: P[]) => arrangePlaylists(list, { query: q, filter: tab, sort, titleOf }).groups;
  const membersOf = (f: F): P[] => (f.playlistIds || []).filter((id) => folderOf.get(id) === f).map((id) => byId.get(id) as P);
  const shown = new Set<string>();

  // Folders shown, with their rows.
  let nodes: FolderNode<P, F>[] = [];
  if (showsFolders(tab)) {
    const candidates = searching ? folders.filter((f) => matchesQuery({ name: f.name }, q)) : folders;
    nodes = sortFolders(candidates, sort).flatMap((f) => {
      const members = membersOf(f);
      const rows = sortPlaylists(members.filter((p) => matchesFilter(p, tab)), sort, titleOf);
      // Mine: a folder holding only other people's playlists is not "mine" to show.
      if (members.length && !rows.length) return [];
      const expanded = searching ? !closedInSearch.has(f.id) : !collapsed.has(f.id);
      return [{ folder: f, rows, expanded, nameMatch: searching }];
    });
  }
  const inShownFolders = new Set(nodes.flatMap((n) => n.rows.map((p) => p.id)));
  nodes.forEach((n) => n.rows.forEach((p) => shown.add(p.id)));

  // Pinned: every pinned playlist the tab and the search allow, filed or not.
  const pinnedRows = arrange(playlists.filter((p) => p.pinnedByMe)).flatMap((g) => g.rows);
  // The groups: the rest, minus what a folder on screen already holds.
  const flat = searching || !showsFolders(tab);
  const rest = playlists.filter((p) => !p.pinnedByMe && !inShownFolders.has(p.id) && (flat || !folderOf.has(p.id)));
  const groups = arrange(rest);
  pinnedRows.forEach((p) => shown.add(p.id));
  groups.forEach((g) => g.rows.forEach((p) => shown.add(p.id)));

  const sections: SidebarSection<P, F>[] = [];
  if (pinnedRows.length) sections.push({ kind: 'group', key: 'pinned', rows: pinnedRows });
  if (nodes.length) sections.push({ kind: 'folders', folders: nodes });
  for (const g of groups) sections.push({ kind: 'group', ...g });
  return { sections, count: shown.size, folderCount: nodes.length, empty: !shown.size && !nodes.length, flat, folderOf };
}

/** The folders a playlist can be moved to from its menu: every folder, by name, the current one marked. */
export function moveTargets<F extends FolderLike>(folders: readonly F[], playlistId: string, query = ''): { folder: F; current: boolean }[] {
  return sortFolders(folders.filter((f) => matchesQuery({ name: f.name }, query)), 'name')
    .map((folder) => ({ folder, current: (folder.playlistIds || []).includes(playlistId) }));
}

/** Collapsed folder ids from storage: an array of strings, unknown ids dropped once the folders are known. */
export function parseCollapsed(raw: string | null | undefined, known?: ReadonlySet<string>): Set<string> {
  let list: unknown;
  try { list = JSON.parse(raw || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((id): id is string => typeof id === 'string' && (!known || known.has(id))).slice(0, 500));
}

/** A folder name typed in a dialog: trimmed; an error key when it cannot be one (the server checks the same). */
export function folderNameError(name: string, max = 50): 'required' | 'tooLong' | 'invalid' | null {
  const v = name.trim();
  if (!v) return 'required';
  if (v.length > max) return 'tooLong';
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v)) return 'invalid';
  return null;
}
