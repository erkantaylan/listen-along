/**
 * Turn what a web user asked to queue into library songs or song requests.
 * Never downloads anything: metadata lookups (YouTube search, oEmbed, Spotify
 * page scrape, playlist listing) are best-effort and only used to find a
 * YouTube id/title for the library lookup or the request.
 *
 * Result shapes:
 *   { type: 'library', song }                      — playable now
 *   { type: 'request', request: {youtubeId, url, title, artist} }
 *   { type: 'playlist', items: [library|request...], total }
 *   { type: 'error', message }
 */

const realLibrary = require('./library');
const realYtdlp = require('./ytdlp');
const realSpotify = require('./spotify');

const MAX_PLAYLIST = 100;

function createResolver({ library = realLibrary, ytdlp = realYtdlp, spotify = realSpotify } = {}) {
  async function byYoutubeId(youtubeId, fallback = {}) {
    const song = await library.getByYoutubeId(youtubeId);
    if (song) return { type: 'library', song };
    let title = fallback.title || null;
    if (!title) {
      const info = await ytdlp.getOembed(youtubeId).catch(() => null);
      if (info) title = info.title;
    }
    return {
      type: 'request',
      request: { youtubeId, url: library.youtubeUrl(youtubeId), title, artist: fallback.artist || null },
    };
  }

  async function resolvePlaylist(input) {
    let entries;
    try {
      entries = await ytdlp.getPlaylistEntries(input);
    } catch (err) {
      return { type: 'error', message: `Could not read that playlist: ${err.message}` };
    }
    if (!entries.length) return { type: 'error', message: 'No videos found in that playlist' };
    const items = [];
    for (const e of entries.slice(0, MAX_PLAYLIST)) {
      const song = await library.getByYoutubeId(e.id);
      items.push(song
        ? { type: 'library', song }
        : { type: 'request', request: { youtubeId: e.id, url: library.youtubeUrl(e.id), title: e.title || null, artist: null } });
    }
    return { type: 'playlist', items, total: entries.length };
  }

  async function resolveSpotify(input) {
    let track;
    try {
      track = await spotify.getTrack(input);
    } catch (err) {
      return { type: 'error', message: `Failed to read Spotify link: ${err.message}` };
    }
    const name = track.name || track.title;
    const artist = track.artist && track.artist !== 'Unknown Artist' ? track.artist : null;
    const exact = await library.findByTitleArtist(name, artist);
    if (exact) return { type: 'library', song: exact };
    const hit = await ytdlp.searchYoutube(track.searchQuery || `${name} ${artist || ''}`).catch(() => null);
    if (hit) {
      const song = await library.getByYoutubeId(hit.id);
      if (song) return { type: 'library', song };
    }
    return {
      type: 'request',
      request: {
        youtubeId: hit ? hit.id : null,
        url: hit ? hit.url : input,
        title: name,
        artist,
      },
    };
  }

  async function resolveText(text) {
    const hit = await ytdlp.searchYoutube(text).catch(() => null);
    if (hit) {
      const song = await library.getByYoutubeId(hit.id);
      if (song) return { type: 'library', song };
    }
    const textMatch = await library.findBestTextMatch(text);
    if (textMatch) return { type: 'library', song: textMatch };
    if (hit) {
      return { type: 'request', request: { youtubeId: hit.id, url: hit.url, title: hit.title || text, artist: null } };
    }
    return { type: 'request', request: { youtubeId: null, url: null, title: text, artist: null } };
  }

  /**
   * @param {{input?: string, libraryId?: string, title?: string}} args
   */
  async function resolve({ input, libraryId, title } = {}) {
    if (libraryId) {
      const song = await library.getById(libraryId);
      return song ? { type: 'library', song } : { type: 'error', message: 'That song is no longer in the library' };
    }
    const text = typeof input === 'string' ? input.trim() : '';
    if (!text) return { type: 'error', message: 'Nothing to add' };
    if (text.length > 2000) return { type: 'error', message: 'Input too long' };

    if (text.startsWith('library:')) return resolve({ libraryId: text.slice('library:'.length) });
    if (ytdlp.parsePlaylistId(text)) return resolvePlaylist(text);
    if (spotify.parseSpotifyUrl(text)) return resolveSpotify(text);

    const ytId = library.parseYoutubeId(text);
    if (ytId) return byYoutubeId(ytId, { title });

    if (/^https?:\/\//i.test(text)) {
      // A legacy cache URL might still be registered (source_url).
      const legacy = await library.resolveQueueUrl(text);
      if (legacy) return { type: 'library', song: legacy };
      return { type: 'error', message: 'Unsupported link. Paste a YouTube or Spotify link, or search by name.' };
    }
    return resolveText(text);
  }

  return { resolve };
}

module.exports = { createResolver, MAX_PLAYLIST };
