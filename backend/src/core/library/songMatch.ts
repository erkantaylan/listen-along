/**
 * Duplicate detection helpers for the music library (pure, no DB).
 *
 * A "metadata key" is the normalized "artist|title" of a song. Two songs with
 * the same key and durations within DURATION_TOLERANCE_SEC are a *probable*
 * duplicate (the same recording uploaded from another link). Exact
 * duplicates are a same youtube_id or the same file bytes (sha256); those are
 * checked separately (library.ts) and enforced by unique indexes.
 *
 * Bump META_KEY_VERSION whenever normalization changes: library.ts
 * recomputes every stored key with an older version in the background.
 */

export const META_KEY_VERSION = 1;
export const DURATION_TOLERANCE_SEC = 3;

// Letters NFKD does not decompose into base + combining mark.
const FOLD: Record<string, string> = {
  'ı': 'i', 'İ': 'i', 'ß': 'ss', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe',
  'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'ð': 'd', 'þ': 'th',
};

// Words that only describe the upload, not the recording.
const NOISE = [
  'official\\s+(?:music\\s+|lyrics?\\s+|hd\\s+|4k\\s+)?(?:video|audio|clip|visuali[sz]er|lyric\\s+video)',
  'official', 'music\\s+video', 'lyric\\s+video', 'lyrics?', 'audio', 'video', 'video\\s*clip', 'clip',
  'visuali[sz]er', 'hd', 'hq', '4k', '1080p', '720p', 'explicit', 'clean', 'mv', 'm\\/v',
  '(?:\\d{4}\\s+)?(?:digital(?:ly)?\\s+)?remaster(?:ed)?(?:\\s+(?:version|\\d{4}))?(?:\\s+\\d{4})?',
  'remastered\\s+version', 'album\\s+version', 'original\\s+mix', 'audio\\s+only', 'with\\s+lyrics',
  'sözleri', 'şarkı\\s+sözleri', 'klip', 'resmi\\s+(?:video|klip)', 'official\\s+video\\s+clip',
];
const NOISE_RE = new RegExp(`^(?:${NOISE.join('|')})$`, 'i');
// "feat. X", "ft. X", "featuring X", "with X" inside brackets, or "feat. X" to the end.
const FEAT_RE = /\b(?:feat\.?|ft\.?|featuring)\s/i;

/** Lower-case, fold accents and Turkish letters, keep letters/digits/spaces. */
export function fold(value: unknown): string {
  return String(value ?? '')
    .replace(/[ıİßæÆœŒøØłŁđĐðþ]/g, (c) => FOLD[c])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function squash(s: string): string {
  return s.replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Remove bracketed parts that are noise or credits; keep e.g. "(Live)", "(Remix)". */
function stripBrackets(s: string): string {
  return s.replace(/[(\[{]([^()\[\]{}]*)[)\]}]/g, (m, inner: string) => {
    const t = inner.trim();
    if (!t || FEAT_RE.test(`${t} `) || /^(?:with|w\/)\s/i.test(t)) return ' ';
    const words = squash(fold(t));
    return NOISE_RE.test(t) || NOISE_RE.test(words) ? ' ' : m;
  });
}

/** Remove trailing " - Remastered 2011", " - Official Video", " | Lyrics" etc. (repeatedly). */
function stripTrailingNoise(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s+[-–—|:]\s+([^-–—|:]+)$/u, (m, tail: string) => (NOISE_RE.test(tail.trim()) || NOISE_RE.test(squash(fold(tail))) ? '' : m));
  } while (s !== prev);
  return s;
}

function stripFeat(s: string): string {
  const m = FEAT_RE.exec(s);
  return m ? s.slice(0, m.index) : s;
}

/**
 * Normalize an artist: folded, featured artists dropped, YouTube channel
 * suffixes (" - Topic", "VEVO", "Official") removed, only the primary
 * artist kept ("A, B & C" -> "a"), a leading "the" and all spaces removed.
 */
export function normalizeArtist(artist: unknown): string {
  let s = String(artist ?? '').trim();
  s = s.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/\s+official(?:\s+channel)?$/i, '');
  s = stripBrackets(s);
  s = stripFeat(s);
  s = s.split(/\s*(?:,|;|\/|\s&\s|\s+x\s+|\s+and\s+|\s+ve\s+)\s*/i)[0] || s;
  // No spaces and no leading "the": "The Beatles" = "Beatles", "barismanco" = "Barış Manço".
  return squash(fold(s)).replace(/^the /, '').replace(/ /g, '');
}

/**
 * Normalize a title: bracketed/trailing noise ("(Official Video)",
 * "- Remastered 2011", "[HD]"), "feat. …" credits and a leading
 * "<artist> - " removed, accents/Turkish letters folded.
 */
export function normalizeTitle(title: unknown, artist: unknown): string {
  let s = String(title ?? '').trim();
  s = stripBrackets(s);
  s = stripBrackets(s); // nested leftovers after the first pass
  s = stripTrailingNoise(s);
  // "Artist - Title" uploaded with the channel as the artist.
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(s);
  if (dash) {
    const a = normalizeArtist(artist);
    if (a && normalizeArtist(dash[1]) === a) s = dash[2];
  }
  s = stripFeat(s);
  s = stripTrailingNoise(s);
  return squash(fold(s));
}

/** "artist|title", or null when either part normalizes to nothing. */
export function metaKey(title: unknown, artist: unknown): string | null {
  const t = normalizeTitle(title, artist);
  const a = normalizeArtist(artist);
  if (!t || !a) return null;
  return `${a}|${t}`;
}

/**
 * When the "artist" is just a YouTube channel and the title reads
 * "Artist - Title", split it. Used for search results before a download.
 */
export function splitArtistTitle(title: unknown, channel: unknown): { title: string; artist: string } {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(String(title || '').trim());
  if (m) return { artist: m[1], title: m[2] };
  return { artist: String(channel || '').replace(/\s*-\s*topic$/i, ''), title: String(title || '') };
}

export function durationsClose(a: unknown, b: unknown, tolerance = DURATION_TOLERANCE_SEC): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return false;
  return Math.abs(x - y) <= tolerance;
}

