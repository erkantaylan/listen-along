// Pure helpers for the sidebar's list (no DOM, unit tested in
// playlist-filter.test.ts).
import type { PlaylistSummary } from '../../shared/types.ts';

/**
 * What these helpers read from a playlist: a PlaylistSummary from
 * GET /api/playlists, or any part of one (every field may be missing).
 */
export type FilterablePlaylist = Partial<Pick<PlaylistSummary,
  'id' | 'name' | 'ownerName' | 'isOwner' | 'visibility' | 'pinnedByMe' | 'pinnedAt' | 'createdAt'>>;

// Case- and accent-insensitive, and forgiving about Turkish: i, ı, I and İ are
// all the same letter here, and ş/ğ/ü/ö/ç match s/g/u/o/c, so "sarki" finds
// "Şarkı" and "istanbul" finds "İSTANBUL".
export function foldText(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/[İIı]/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Every word of the query must appear in the name or the owner's name.
export function matchesQuery(playlist: Pick<FilterablePlaylist, 'name' | 'ownerName'>, query: string | null | undefined): boolean {
  const words = foldText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = foldText(`${playlist.name || ''} ${playlist.ownerName || ''}`);
  return words.every(w => hay.includes(w));
}

const byNewest = (a: FilterablePlaylist, b: FilterablePlaylist): number => (b.createdAt || 0) - (a.createdAt || 0);

// { pinned (last pinned first), mine, others (both newest first) }, filtered.
export interface PlaylistGroups<P> {
  pinned: P[];
  mine: P[];
  others: P[];
}

export function groupPlaylists<P extends FilterablePlaylist>(playlists: P[], query = ''): PlaylistGroups<P> {
  const shown = playlists.filter(p => matchesQuery(p, query));
  return {
    pinned: shown.filter(p => p.pinnedByMe).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0)),
    mine: shown.filter(p => !p.pinnedByMe && p.isOwner).sort(byNewest),
    others: shown.filter(p => !p.pinnedByMe && !p.isOwner).sort(byNewest),
  };
}

// The sidebar's filter chips and sort choices. Ownership comes only from the
// server's `isOwner`, and `visibility` is the server's too.
export const PLAYLIST_FILTERS = ['all', 'mine', 'public', 'private'] as const;
export const PLAYLIST_SORTS = ['date', 'name'] as const;
export type PlaylistFilter = typeof PLAYLIST_FILTERS[number];
export type PlaylistSort = typeof PLAYLIST_SORTS[number];

export function matchesFilter(playlist: Pick<FilterablePlaylist, 'isOwner' | 'visibility'>, filter: PlaylistFilter = 'all'): boolean {
  if (filter === 'mine') return playlist.isOwner === true;
  if (filter === 'public') return playlist.visibility !== 'private';
  if (filter === 'private') return playlist.visibility === 'private';
  return true;
}

// Turkish alphabet order (ç after c, ı before i, ş after s). Numbers compare as
// numbers. "Family: A" and "Family: B" stay next to each other.
const byName = <P extends FilterablePlaylist>(titleOf: (p: P) => string) => (a: P, b: P): number => String(titleOf(a)).trim().localeCompare(String(titleOf(b)).trim(), 'tr', { numeric: true })
  || byDate(a, b);
const byDate = (a: FilterablePlaylist, b: FilterablePlaylist): number => byNewest(a, b) || String(a.id).localeCompare(String(b.id));

// What the sidebar draws: [{ key, rows }], empty groups gone, plus the count.
// Pinned is always on top and takes the chosen sort too. By date the rest stays
// in Your / Public groups; by name it is one list, as groups would break A-Z.
// titleOf: the name as shown, for playlists without one.
export type PlaylistGroupKey = 'pinned' | 'mine' | 'others' | 'rest';
export interface PlaylistGroup<P> {
  key: PlaylistGroupKey;
  rows: P[];
}
export interface ArrangeOptions<P> {
  query?: string;
  filter?: PlaylistFilter;
  sort?: PlaylistSort;
  titleOf?: (p: P) => string;
}
export interface ArrangedPlaylists<P> {
  groups: PlaylistGroup<P>[];
  count: number;
}

export function arrangePlaylists<P extends FilterablePlaylist>(playlists: P[], { query = '', filter = 'all', sort = 'date', titleOf = (p: P) => p.name || p.id || '' }: ArrangeOptions<P> = {}): ArrangedPlaylists<P> {
  const shown = playlists.filter(p => matchesFilter(p, filter) && matchesQuery(p, query));
  const compare: (a: P, b: P) => number = sort === 'name' ? byName(titleOf) : byDate;
  const rest = shown.filter(p => !p.pinnedByMe).sort(compare);
  const groups: PlaylistGroup<P>[] = [
    { key: 'pinned' as const, rows: shown.filter(p => p.pinnedByMe).sort(compare) },
    ...(sort === 'name'
      ? [{ key: 'rest' as const, rows: rest }]
      : [{ key: 'mine' as const, rows: rest.filter(p => p.isOwner) }, { key: 'others' as const, rows: rest.filter(p => !p.isOwner) }]),
  ].filter(g => g.rows.length);
  return { groups, count: shown.length };
}

// One or two capitals for a playlist's rail avatar: first letters of the first
// two words, whole characters only (emoji), Turkish dotted İ for a Turkish "i".
export function playlistInitials(name: string | null | undefined, locale = 'tr'): string {
  const words = String(name || '').normalize('NFC').trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map(w => Array.from(w)[0]).join('');
  return letters.toLocaleUpperCase(locale) || '?';
}

// Which placeholder cover colour (1..COVER_COLOURS, --app-cover-N in theme.css)
// a playlist gets: a hash of its id, so it stays the same everywhere and across
// renames.
export const COVER_COLOURS = 6;
export function playlistCoverIndex(id: string | null | undefined): number {
  let h = 0;
  // A character from for...of always has a code point.
  for (const ch of String(id ?? '')) h = (h * 31 + (ch.codePointAt(0) as number)) >>> 0;
  return (h % COVER_COLOURS) + 1;
}
