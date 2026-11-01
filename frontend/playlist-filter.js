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

// One or two capitals for a playlist's rail avatar: first letters of the first
// two words, whole characters only (emoji), Turkish dotted İ for a Turkish "i".
export function playlistInitials(name, locale = 'tr') {
  const words = String(name || '').normalize('NFC').trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map(w => Array.from(w)[0]).join('');
  return letters.toLocaleUpperCase(locale) || '?';
}
