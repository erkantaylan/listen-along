/**
 * Relevance order for the web's global search (GET /api/library?sort=relevance).
 * Pure: no database. library.list() selects the candidates (every word of the
 * query somewhere in title, artist or album, folded the same way in SQL) and
 * rankSongs() puts them in order:
 *
 *   0  the title is the query
 *   1  the artist is the query, or "artist title" / "title artist" is
 *   2  the title starts with the query
 *   3  the artist starts with the query
 *   4  every word of the query starts a word of the title or artist
 *   5  the title or the artist contains the query
 *   6  the rest: every word somewhere (album included)
 *
 * then by title, artist (Turkish alphabet) and id, so equal songs keep a stable
 * order. Text is folded first (FOLD): case, Turkish i/ı/İ and the common
 * accents are one letter, so "sarki" finds "Şarkı".
 */

// One character each way, so SQL translate() and fold() agree exactly.
const FOLD_PAIRS = {
  İ: 'i', I: 'i', ı: 'i', Ş: 's', ş: 's', Ğ: 'g', ğ: 'g', Ü: 'u', ü: 'u', Ö: 'o', ö: 'o', Ç: 'c', ç: 'c',
  Â: 'a', â: 'a', Î: 'i', î: 'i', Û: 'u', û: 'u', Ê: 'e', ê: 'e', É: 'e', é: 'e', È: 'e', è: 'e', Ë: 'e', ë: 'e',
  Á: 'a', á: 'a', À: 'a', à: 'a', Ä: 'a', ä: 'a', Í: 'i', í: 'i', Ì: 'i', ì: 'i', Ï: 'i', ï: 'i',
  Ó: 'o', ó: 'o', Ò: 'o', ò: 'o', Ú: 'u', ú: 'u', Ù: 'u', ù: 'u', Ñ: 'n', ñ: 'n',
};
const FOLD_FROM = Object.keys(FOLD_PAIRS).join('');
const FOLD_TO = Object.values(FOLD_PAIRS).join('');
const FOLD_RE = new RegExp(`[${FOLD_FROM}]`, 'g');

const MAX_QUERY = 200;
const MAX_WORDS = 10;

/** Lower case, Turkish letters and accents folded, whitespace collapsed. */
function fold(text) {
  return String(text ?? '').replace(FOLD_RE, (c) => FOLD_PAIRS[c]).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** fold(), and punctuation as spaces: "AC/DC - T.N.T." -> "ac dc t n t". For comparing, not for SQL. */
function plain(text) {
  return fold(String(text ?? '').replace(/[^\p{L}\p{N}]+/gu, ' '));
}

/**
 * The words the SQL filter needs (folded; each must appear somewhere), at most
 * MAX_WORDS. A word without a letter or digit ("-", "&") is left out: it would
 * only hide songs that are written without it.
 */
function queryWords(q) {
  return fold(String(q ?? '').slice(0, MAX_QUERY)).split(' ')
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .slice(0, MAX_WORDS);
}

function tierOf(query, song) {
  const q = plain(query);
  if (!q) return 6;
  const title = plain(song.title);
  const artist = plain(song.artist);
  if (title === q) return 0;
  if (artist && (artist === q || `${artist} ${title}` === q || `${title} ${artist}` === q)) return 1;
  if (title.startsWith(q)) return 2;
  if (artist && artist.startsWith(q)) return 3;
  const starts = `${title} ${artist}`.split(' ').filter(Boolean);
  const words = q.split(' ');
  if (words.every((w) => starts.some((s) => s.startsWith(w)))) return 4;
  if (title.includes(q) || (artist && artist.includes(q))) return 5;
  return 6;
}

const collator = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });

/** The songs in relevance order for `query` (a new array; songs need title, artist, id). */
function rankSongs(query, songs) {
  return songs
    .map((song) => ({ song, tier: tierOf(query, song) }))
    .sort((a, b) => a.tier - b.tier
      || collator.compare(a.song.title || '', b.song.title || '')
      || collator.compare(a.song.artist || '', b.song.artist || '')
      || String(a.song.id).localeCompare(String(b.song.id)))
    .map((x) => x.song);
}

/** SQL for fold() of an expression, with the two translate() strings as parameters $from / $to. */
function foldSql(expr, fromParam, toParam) {
  return `lower(translate(${expr}, ${fromParam}, ${toParam}))`;
}

module.exports = { fold, plain, queryWords, tierOf, rankSongs, foldSql, FOLD_FROM, FOLD_TO, MAX_QUERY, MAX_WORDS };
