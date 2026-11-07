/**
 * Artist credits -> individual artists, for the Artists pages (artists.js).
 * Pure, no DB. A song crediting several artists is listed on each one's page,
 * as on Spotify. This is NOT duplicate detection: songMatch.normalizeArtist
 * (the primary artist only, part of meta_key) stays as it is.
 *
 * Library credits come mostly from YouTube Music via yt-dlp, which joins the
 * artists with ", " ("RAYE, 070 Shake"); uploads by hand add " & ", "feat."
 * and friends. Band names contain the same separators ("Earth, Wind & Fire",
 * "Simon & Garfunkel", "Mor ve Ötesi"), so the rule, in this order:
 *
 *  1. Channel suffixes go (" - Topic", "VEVO", " Official"), on the credit and
 *     on each artist.
 *  2. Bracketed credits "(feat. X)", "[ft. X]", "(with X)" become artists of
 *     their own; other brackets are dropped from artist names.
 *  3. Always split on the feat family (" feat. ", " ft. ", " featuring "),
 *     " vs. ", a lower-case " x " or " × " between names, ";" and " / ".
 *  4. Names in BANDS are never split, whatever punctuation or "&" / "and"
 *     they are written with (compared by key: "Earth Wind and Fire" matches).
 *  5. Always split on ",": it is YouTube Music's own separator.
 *  6. Split on " & ", " and ", " ve " only when
 *     - the right side is not a band tail: it does not start with "the",
 *       "his", "her", "their", ... ("Kool & the Gang", "Buddy Johnson And His
 *       Orchestra") and is not one word like "Sons", "Friends", "Orchestra",
 *       "Dostlar" ("Mumford & Sons", "Edip Akbayram & Dostlar"), and
 *     - at least one side is a known artist: credited on its own, or as one
 *       of a ","/"feat." list, somewhere in the library (`knownArtistKeys`).
 *     So "Barış Manço & Kurtalan Ekspres" splits in a library with other
 *     Barış Manço songs, and "Hall & Oates" stays one artist.
 *
 * Keys are artistNameKey: folded, "&" read as "and", letters and digits only,
 * no leading "the" — for a single artist the same key normalizeArtist gives,
 * so /artist/barismanco keeps working.
 */
const { fold } = require('./songMatch');

const MAX_KEY = 200;

// Band names containing a separator, compared by key. Only names the rules
// above would get wrong: "X & the Ys", "X & Sons" and the like need no entry.
const BANDS = [
  'Earth, Wind & Fire', 'Tyler, The Creator', 'Crosby, Stills, Nash & Young', 'Crosby, Stills & Nash',
  'Emerson, Lake & Palmer', 'Blood, Sweat & Tears', 'Peter, Paul and Mary', 'Lambert, Hendricks & Ross',
  'Dave Dee, Dozy, Beaky, Mick & Tich', 'Simon & Garfunkel', 'Hall & Oates', 'Daryl Hall & John Oates',
  'Ike & Tina Turner', 'Sonny & Cher', 'Sam & Dave', 'Brooks & Dunn', 'Ashford & Simpson',
  'Captain & Tennille', 'Angus & Julia Stone', 'Chase & Status', 'Above & Beyond', 'Belle & Sebastian',
  'Iron & Wine', 'Zager & Evans', 'Mor ve Ötesi', 'Of Monsters and Men',
];

// A right side starting with one of these is the rest of a band name.
const TAIL_WORDS = new Set(['the', 'his', 'her', 'their', 'its', 'my', 'our', 'your', 'los', 'las', 'la', 'le', 'les', 'die', 'der', 'il']);
// A right side that is only one of these words is the rest of a band name.
const TAIL_ALONE = new Set([
  'sons', 'daughters', 'friends', 'family', 'brothers', 'sisters', 'gang', 'crew', 'band', 'orchestra',
  'company', 'co', 'men', 'boys', 'girls', 'dostlar', 'arkadaslari', 'orkestrasi', 'orkestra', 'grubu',
]);

function squash(s) {
  return s.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** One artist's key: "Barış Manço" -> "barismanco", "The Beatles" -> "beatles". */
function artistNameKey(name) {
  return squash(fold(name)).replace(/^the /, '').replace(/ /g, '').slice(0, MAX_KEY);
}

const BAND_KEYS = new Set(BANDS.map(artistNameKey));

function stripSuffixes(s) {
  return s.trim()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*vevo$/i, '')
    .replace(/\s+official(?:\s+channel)?$/i, '')
    .trim();
}

const FEAT_INNER_RE = /^(?:feat\.?|ft\.?|featuring|with|w\/)\s+(.+)$/i;
// Always a boundary between two artists (step 3). "x" only in lower case and
// between names: "Lil Nas X & …" and "lil nas x, …" have none.
const STRONG_RE = /\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+|\s*;\s*|\s+\/\s+/iu;
const X_RE = /(?<=[\p{L}\p{N}.)])\s+[x×]\s+(?=[\p{L}\p{N}])/u;
// "," (step 5) or "&" / "and" / "ve" (step 6), captured so we know which.
const LIST_RE = /(\s*,\s*|\s+&\s+|\s+and\s+|\s+ve\s+)/i;

/** Step 2: the credit without brackets, plus the bracketed credits. */
function takeBrackets(credit) {
  const extra = [];
  const rest = credit.replace(/[(\[{]([^()\[\]{}]*)[)\]}]/g, (m, inner) => {
    const f = FEAT_INNER_RE.exec(inner.trim());
    if (f) extra.push(f[1]);
    return ' ';
  });
  return [rest.replace(/\s+/g, ' ').trim() || credit, ...extra];
}

/**
 * One strong piece (no feat / vs / x / ;) -> units: [{ text, sep }], where sep
 * is the separator before the unit (null for the first). Runs of tokens that
 * spell a name in BANDS are merged into one unit first (longest run wins).
 */
function units(piece) {
  const parts = piece.split(LIST_RE);
  const tokens = [];
  for (let i = 0; i < parts.length; i += 2) tokens.push({ text: parts[i], sep: i ? parts[i - 1] : null });
  const out = [];
  for (let i = 0; i < tokens.length;) {
    let end = i;
    for (let j = tokens.length - 1; j > i; j--) {
      const joined = tokens.slice(i, j + 1).map((t, k) => (k ? t.sep : '') + t.text).join('');
      if (BAND_KEYS.has(artistNameKey(joined))) { end = j; break; }
    }
    const text = tokens.slice(i, end + 1).map((t, k) => (k ? t.sep : '') + t.text).join('');
    out.push({ text, sep: tokens[i].sep });
    i = end + 1;
  }
  return out.filter((u) => u.text.trim());
}

const isComma = (sep) => sep.trim() === ',';

function isBandTail(text) {
  const words = squash(fold(text)).split(' ').filter(Boolean);
  if (!words.length) return true;
  return TAIL_WORDS.has(words[0]) || (words.length === 1 && TAIL_ALONE.has(words[0]));
}

function cleanName(text) {
  return stripSuffixes(text.replace(/[(\[{][^()\[\]{}]*[)\]}]/g, ' ').replace(/\s+/g, ' ')) || text.trim();
}

/** Steps 1-3: the credit as strong pieces (bracketed credits included). */
function strongPieces(credit) {
  const out = [];
  for (const part of takeBrackets(stripSuffixes(String(credit ?? '')))) {
    for (const piece of part.split(STRONG_RE).flatMap((p) => p.split(X_RE))) {
      if (piece && piece.trim()) out.push(stripSuffixes(piece));
    }
  }
  return out;
}

/**
 * The individual artists a library knows on their own (step 6): every credit
 * cut at the always-split separators only; a part still holding "&" / "and"
 * / "ve" (and not a name in BANDS) is not an individual, so it does not count.
 * @param {Iterable<string>} credits
 * @returns {Set<string>} keys
 */
function knownArtistKeys(credits) {
  const known = new Set();
  for (const credit of credits) {
    for (const piece of strongPieces(credit)) {
      let group = [];
      const flush = () => {
        if (group.length === 1) {
          const key = artistNameKey(cleanName(group[0].text));
          if (key) known.add(key);
        }
        group = [];
      };
      for (const u of units(piece)) {
        if (u.sep && isComma(u.sep)) flush();
        group.push(u);
      }
      flush();
    }
  }
  return known;
}

/**
 * A credit -> its artists, in credit order, one per key:
 * [{ key, name }] (name: as written, channel suffixes dropped).
 * @param {string} credit
 * @param {(key: string) => boolean} [isKnown] known individual artists (knownArtistKeys)
 */
function splitArtistCredit(credit, isKnown = () => false) {
  const names = [];
  for (const piece of strongPieces(credit)) {
    let current = null; // the artist being built
    let last = null;    // its last unit: the left side of an "&"
    const known = (text) => isKnown(artistNameKey(cleanName(text)));
    for (const u of units(piece)) {
      if (current === null) { current = last = u.text; continue; }
      const split = isComma(u.sep) || (!isBandTail(u.text) && (known(u.text) || known(last)));
      if (split) { names.push(current); current = u.text; } else current += u.sep + u.text;
      last = u.text;
    }
    if (current !== null) names.push(current);
  }
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = cleanName(raw);
    const key = artistNameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name });
  }
  return out;
}

module.exports = { splitArtistCredit, knownArtistKeys, artistNameKey, BANDS, MAX_KEY };
