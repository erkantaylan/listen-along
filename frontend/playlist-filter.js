// Pure helpers for the sidebar's list (no DOM, unit tested in
// backend/src/playlist-filter.test.js).

// Case- and accent-insensitive, and forgiving about Turkish: i, ı, I and İ are
// all the same letter here, and ş/ğ/ü/ö/ç match s/g/u/o/c, so "sarki" finds
// "Şarkı" and "istanbul" finds "İSTANBUL".
export function foldText(text) {
  return String(text ?? '')
    .replace(/[İIı]/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Every word of the query must appear in the name or the owner's name.
export function matchesQuery(playlist, query) {
  const words = foldText(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = foldText(`${playlist.name || ''} ${playlist.ownerName || ''}`);
  return words.every(w => hay.includes(w));
}

const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

// { pinned (last pinned first), mine, others (both newest first) }, filtered.
export function groupPlaylists(playlists, query = '') {
  const shown = playlists.filter(p => matchesQuery(p, query));
  return {
    pinned: shown.filter(p => p.pinnedByMe).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0)),
    mine: shown.filter(p => !p.pinnedByMe && p.isOwner).sort(byNewest),
    others: shown.filter(p => !p.pinnedByMe && !p.isOwner).sort(byNewest),
  };
}

// The sidebar's filter chips and sort choices. Ownership comes only from the
// server's `isOwner`, and `visibility` is the server's too.
export const PLAYLIST_FILTERS = ['all', 'mine', 'public', 'private'];
export const PLAYLIST_SORTS = ['date', 'name'];

export function matchesFilter(playlist, filter = 'all') {
  if (filter === 'mine') return playlist.isOwner === true;
  if (filter === 'public') return playlist.visibility !== 'private';
  if (filter === 'private') return playlist.visibility === 'private';
  return true;
}

// Turkish alphabet order (ç after c, ı before i, ş after s). Numbers compare as
// numbers. "Family: A" and "Family: B" stay next to each other.
const byName = (titleOf) => (a, b) => String(titleOf(a)).trim().localeCompare(String(titleOf(b)).trim(), 'tr', { numeric: true })
  || byDate(a, b);
const byDate = (a, b) => byNewest(a, b) || String(a.id).localeCompare(String(b.id));

// What the sidebar draws: [{ key, rows }], empty groups gone, plus the count.
// Pinned is always on top and takes the chosen sort too. By date the rest stays
// in Your / Public groups; by name it is one list, as groups would break A-Z.
// titleOf: the name as shown, for playlists without one.
export function arrangePlaylists(playlists, { query = '', filter = 'all', sort = 'date', titleOf = (p) => p.name || p.id || '' } = {}) {
  const shown = playlists.filter(p => matchesFilter(p, filter) && matchesQuery(p, query));
  const compare = sort === 'name' ? byName(titleOf) : byDate;
  const rest = shown.filter(p => !p.pinnedByMe).sort(compare);
  const groups = [
    { key: 'pinned', rows: shown.filter(p => p.pinnedByMe).sort(compare) },
    ...(sort === 'name'
      ? [{ key: 'rest', rows: rest }]
      : [{ key: 'mine', rows: rest.filter(p => p.isOwner) }, { key: 'others', rows: rest.filter(p => !p.isOwner) }]),
  ].filter(g => g.rows.length);
  return { groups, count: shown.length };
}

// One or two capitals for a playlist's rail avatar: first letters of the first
// two words, whole characters only (emoji), Turkish dotted İ for a Turkish "i".
export function playlistInitials(name, locale = 'tr') {
  const words = String(name || '').normalize('NFC').trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map(w => Array.from(w)[0]).join('');
  return letters.toLocaleUpperCase(locale) || '?';
}
