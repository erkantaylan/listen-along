'use strict';

const YT_HOST = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Classify a `la download` input.
 * @param {string} input
 * @returns {{ kind: 'video', id: string, url: string }
 *         | { kind: 'playlist', listId: string, url: string }
 *         | { kind: 'url', url: string }
 *         | { kind: 'search', query: string }}
 */
function classify(input, { noPlaylist = false } = {}) {
  const s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) {
    // A bare 11-char id is ambiguous with a one-word query; only accept it
    // with an explicit "yt:" prefix.
    const m = /^yt:([A-Za-z0-9_-]{11})$/.exec(s);
    if (m) return { kind: 'video', id: m[1], url: watchUrl(m[1]) };
    return { kind: 'search', query: s };
  }
  let u;
  try { u = new URL(s); } catch { return { kind: 'search', query: s }; }
  if (!YT_HOST.test(u.hostname)) return { kind: 'url', url: s };

  const list = u.searchParams.get('list');
  const id = videoIdFromUrl(u);
  // Any list= param means "import the playlist" (a watch URL carrying list=
  // included) unless it's an auto-generated radio/mix (RD...), which is not a
  // real playlist, or the caller asked for single videos (--no-playlist).
  if (list && !/^RD/i.test(list) && !(noPlaylist && id)) {
    return { kind: 'playlist', listId: list, url: `https://www.youtube.com/playlist?list=${list}` };
  }
  if (id) return { kind: 'video', id, url: watchUrl(id) };
  return { kind: 'url', url: s };
}

/** Extract an 11-char video id from a YouTube URL object, or null. */
function videoIdFromUrl(u) {
  if (/youtu\.be$/i.test(u.hostname)) {
    const id = u.pathname.split('/')[1];
    return ID_RE.test(id || '') ? id : null;
  }
  const v = u.searchParams.get('v');
  if (v && ID_RE.test(v)) return v;
  const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
  return m ? m[1] : null;
}

function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Find a YouTube video id inside arbitrary text (tags, file names). */
function findVideoId(text) {
  if (!text) return null;
  const s = String(text);
  const urlMatch = /(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s);
  if (urlMatch) return urlMatch[1];
  // yt-dlp's default filename template: "Title [VIDEOID].ext"
  const bracket = /\[([A-Za-z0-9_-]{11})\](?:\.[A-Za-z0-9]+)?$/.exec(s);
  return bracket ? bracket[1] : null;
}

const BAD_WORDS = ['live', 'cover', 'remix', 'karaoke', 'instrumental', 'reaction', 'sped up', 'slowed', 'nightcore', '8d', 'lyrics', 'lyric video', 'full album', 'hour', 'loop', 'tutorial', 'reverb'];

/**
 * Score a search result: prefer YouTube Music "Topic" channels and official
 * audio uploads; penalise live/cover/remix/etc. unless the query asked for it.
 */
function scoreResult(entry, query) {
  const title = String(entry.title || '').toLowerCase();
  const channel = String(entry.channel || entry.uploader || '').toLowerCase();
  const q = String(query || '').toLowerCase();
  let score = 0;
  if (/ - topic$/.test(channel)) score += 6;
  if (/official (audio|music)|\(audio\)|\[audio\]/.test(title)) score += 4;
  else if (/official (video|music video)/.test(title)) score += 1;
  if (/vevo$/.test(channel)) score += 1;
  for (const w of BAD_WORDS) {
    if (title.includes(w) && !q.includes(w)) score -= 3;
  }
  const d = Number(entry.duration);
  if (d && d > 15 * 60) score -= 5; // compilations / full albums
  if (d && d < 60) score -= 2; // shorts / snippets
  return score;
}

/**
 * Pick the best entry from yt-dlp search results. Stable: on ties the
 * original (YouTube relevance) order wins.
 */
function pickBest(entries, query) {
  const usable = (entries || []).filter((e) => e && e.id);
  if (!usable.length) return null;
  let best = usable[0];
  let bestScore = scoreResult(best, query);
  for (const e of usable.slice(1)) {
    const s = scoreResult(e, query);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

module.exports = { classify, videoIdFromUrl, watchUrl, findVideoId, scoreResult, pickBest, ID_RE };
