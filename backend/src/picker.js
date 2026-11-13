/**
 * What the web's "pick the video" dialog shows before a download job or a song
 * request is made: the first YouTube results for what was typed (or for a
 * Spotify track's "artist - title"), the one video of a link, or the videos of
 * a playlist link. Metadata only, through ytdlp.js (flat search, playlist
 * listing, oEmbed); results are kept a while so the same search does not go
 * to YouTube twice.
 *
 * lookup() answers one of
 *   { kind: 'library', song }                     nothing to pick: the library has it
 *   { kind: 'search',   query, results }          results: up to SEARCH_COUNT videos
 *   { kind: 'video',    results: [video] }        title null when the lookup failed
 *   { kind: 'playlist', results, total }          results: the first MAX_PICKS videos
 * with video = { youtube_id, title, channel, duration_sec, in_library },
 * in_library = { id, title, artist } | null.
 *
 * Every video handed out is remembered (known()), so that a job or request
 * made from a chosen id gets its title from here (titles(), with oEmbed for
 * one it no longer knows), not from the client.
 */

const realLibrary = require('./library');
const realYtdlp = require('./ytdlp');
const realSpotify = require('./spotify');
const { classifyInput } = require('./downloadJobs');

const SEARCH_COUNT = 5;
const MAX_PICKS = 100;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_SIZE = 200;
const KNOWN_SIZE = 5000;
const TITLE_CONCURRENCY = 4;
const TITLE_BUDGET_MS = 10 * 1000;

function pickError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** A chosen-videos list from a client: distinct ids, or null when it is not one. */
function cleanPicks(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PICKS) return null;
  if (!value.every(realLibrary.isYoutubeId)) return null;
  return [...new Set(value)];
}

function createPicker({ library = realLibrary, ytdlp = realYtdlp, spotify = realSpotify, cacheMs = CACHE_MS, now = Date.now } = {}) {
  const cache = new Map(); // key -> { at, promise }
  const knownVideos = new Map(); // youtube id -> { title, channel, duration_sec }

  // One lookup per key at a time and per cacheMs; a failure is not kept.
  function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.promise;
    cache.delete(key);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    const entry = { at: now(), promise: Promise.resolve().then(load) };
    cache.set(key, entry);
    entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return entry.promise;
  }

  function remember(v) {
    if (!v.title) return v;
    knownVideos.delete(v.youtube_id);
    if (knownVideos.size >= KNOWN_SIZE) knownVideos.delete(knownVideos.keys().next().value);
    knownVideos.set(v.youtube_id, { title: v.title, channel: v.channel, duration_sec: v.duration_sec });
    return v;
  }
  const toVideo = (e) => remember({
    youtube_id: e.id,
    title: e.title || null,
    channel: e.channel || null,
    duration_sec: Number(e.duration) > 0 ? Math.round(Number(e.duration)) : null,
  });

  /** The library can change between two lookups: marked on every answer, never cached. */
  async function mark(videos) {
    const have = await library.getByYoutubeIds(videos.map((v) => v.youtube_id));
    return videos.map((v) => {
      const song = have.get(v.youtube_id);
      return { ...v, in_library: song ? { id: song.id, title: song.title, artist: song.artist || null } : null };
    });
  }

  const searchVideos = (query) => cached(`search:${query.toLowerCase()}`, async () =>
    (await ytdlp.searchYoutubeMany(query, SEARCH_COUNT)).map(toVideo));

  /** Always a search, whatever the text looks like (a playlist item's alternatives). */
  async function search(text) {
    const query = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (!query) throw pickError(400, 'BAD_INPUT', 'Nothing to search for');
    if (query.length > 500) throw pickError(400, 'BAD_INPUT', 'That is too long');
    let videos;
    try { videos = await searchVideos(query); } catch (err) {
      throw pickError(502, 'LOOKUP_FAILED', `The YouTube search failed: ${err.message}`);
    }
    return { kind: 'search', query, results: await mark(videos) };
  }

  /**
   * @param {string} input - what was typed or pasted
   * @param {{matchLibrary?: boolean}} [opts] - the playlist's add-song box:
   *   what the library already has is the answer, as when adding without a dialog
   */
  async function lookup(input, { matchLibrary = false } = {}) {
    const what = classifyInput(input);
    if (what.error) throw pickError(400, 'BAD_INPUT', what.error);
    const inLibrary = (song) => ({ kind: 'library', song: library.toPublic(song) });

    if (what.kind === 'video') {
      const song = await library.getByYoutubeId(what.youtubeId);
      if (song) return inLibrary(song);
      const found = await cached(`video:${what.youtubeId}`, async () => {
        const v = await ytdlp.previewVideo(what.youtubeId);
        if (!v) throw new Error('no answer');
        return toVideo({ id: what.youtubeId, title: v.title, channel: v.channel, duration: v.duration_sec });
      }).catch(() => null);
      return { kind: 'video', results: [{ ...(found || { youtube_id: what.youtubeId, title: null, channel: null, duration_sec: null }), in_library: null }] };
    }

    if (what.kind === 'playlist') {
      let listing;
      try {
        // Only what can be picked is kept and remembered, however long the playlist.
        listing = await cached(`playlist:${what.input}`, async () => {
          const entries = await ytdlp.getPlaylistEntries(what.input);
          return { videos: entries.slice(0, MAX_PICKS).map(toVideo), total: entries.length };
        });
      } catch (err) {
        throw pickError(502, 'LOOKUP_FAILED', `Could not read that playlist: ${err.message}`);
      }
      return { kind: 'playlist', results: await mark(listing.videos), total: listing.total };
    }

    let query = what.input;
    if (what.kind === 'spotify') {
      let track;
      try { track = await cached(`spotify:${what.input}`, () => spotify.getTrack(what.input)); } catch (err) {
        throw pickError(400, 'BAD_INPUT', `Could not read that Spotify link: ${err.message}`);
      }
      const name = track && (track.name || track.title);
      if (!name) throw pickError(400, 'BAD_INPUT', 'That Spotify link has no track title');
      const artist = track.artist && track.artist !== 'Unknown Artist' ? track.artist : null;
      if (matchLibrary) {
        const exact = await library.findByTitleArtist(name, artist);
        if (exact) return inLibrary(exact);
      }
      query = artist ? `${artist} - ${name}` : name;
    }

    let videos = null;
    let failure = null;
    try { videos = await searchVideos(query); } catch (err) { failure = err; }
    if (matchLibrary) {
      // The same order as songResolver: the top hit, then a library text match.
      const top = videos && videos[0] ? await library.getByYoutubeId(videos[0].youtube_id) : null;
      if (top) return inLibrary(top);
      const byText = what.kind === 'search' ? await library.findBestTextMatch(query) : null;
      if (byText) return inLibrary(byText);
    }
    if (failure) throw pickError(502, 'LOOKUP_FAILED', `The YouTube search failed: ${failure.message}`);
    return { kind: 'search', query, results: await mark(videos) };
  }

  /** What a lookup said about a video: { title, channel, duration_sec } or null. */
  const known = (youtubeId) => knownVideos.get(youtubeId) || null;

  /**
   * Titles for chosen videos: Map youtube id -> title, for those that have one.
   * What a lookup said, else oEmbed (the answer may be gone: evicted, or the
   * server restarted between the lookup and the confirm). oEmbed runs a few at
   * a time and only until the budget is spent; what is left has no title.
   */
  async function titles(youtubeIds, { concurrency = TITLE_CONCURRENCY, budgetMs = TITLE_BUDGET_MS } = {}) {
    const found = new Map();
    const missing = [];
    for (const id of new Set(youtubeIds)) {
      const v = knownVideos.get(id);
      if (v) found.set(id, v.title); else missing.push(id);
    }
    if (!missing.length) return found;
    let timer;
    const spent = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
    let stopped = false;
    const worker = async () => {
      while (missing.length && !stopped) {
        const id = missing.shift();
        const info = await Promise.resolve().then(() => ytdlp.getOembed(id)).catch(() => null);
        if (info && info.title && !stopped) {
          remember({ youtube_id: id, title: info.title, channel: info.channel || null, duration_sec: null });
          found.set(id, info.title);
        }
      }
    };
    await Promise.race([Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker)), spent]);
    stopped = true;
    clearTimeout(timer);
    return found;
  }

  return { lookup, search, known, titles };
}

module.exports = { createPicker, cleanPicks, SEARCH_COUNT, MAX_PICKS };
