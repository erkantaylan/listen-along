// The song resolver (what a user typed -> library song or song request) with
// fake library, yt-dlp and Spotify lookups.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver, ytdlp, spotify } from './index.ts';
import type { Resolved, ResolverLibrary, ResolverSpotify, ResolverYtdlp } from './index.ts';
import { library } from '../library/index.ts';
import type { LibrarySongRow } from '../../shared/types.ts';

/** The proposed request of an answer (undefined for any other kind). */
const requestOf = (r: Resolved) => ('request' in r ? r.request : undefined);
/** A playlist answer's items (empty for any other kind). */
const itemsOf = (r: Resolved) => ('items' in r ? r.items : []);

describe('songResolver', () => {
  const song = { id: '11111111-1111-4111-8111-111111111111', youtube_id: 'dQw4w9WgXcQ', title: 'Never', artist: 'Rick' } as LibrarySongRow;
  type Over = { library?: Partial<ResolverLibrary>; ytdlp?: Partial<ResolverYtdlp>; spotify?: Partial<ResolverSpotify> };
  function fakes(over: Over = {}) {
    const library2: ResolverLibrary = {
      parseYoutubeId: library.parseYoutubeId,
      youtubeUrl: library.youtubeUrl,
      getById: async (id: string) => (id === song.id ? song : null),
      getByYoutubeId: async (id: string) => (id === song.youtube_id ? song : null),
      findBestTextMatch: async () => null,
      findByTitleArtist: async () => null,
      resolveQueueUrl: async () => null,
      ...over.library,
    };
    const fakeYtdlp: ResolverYtdlp = {
      parsePlaylistId: ytdlp.parsePlaylistId,
      searchYoutube: async () => null,
      getOembed: async () => ({ title: 'From oEmbed', channel: 'Chan' }),
      getPlaylistEntries: async () => [],
      ...over.ytdlp,
    };
    const fakeSpotify: ResolverSpotify = { parseSpotifyUrl: spotify.parseSpotifyUrl, getTrack: async () => ({}), ...over.spotify };
    return createResolver({ library: library2, ytdlp: fakeYtdlp, spotify: fakeSpotify });
  }

  it('resolves libraryId and in-library YouTube links to the library song', async () => {
    const r = fakes();
    assert.deepEqual(await r.resolve({ libraryId: song.id }), { type: 'library', song });
    assert.deepEqual(await r.resolve({ input: 'https://youtu.be/dQw4w9WgXcQ' }), { type: 'library', song });
    assert.equal((await r.resolve({ libraryId: '22222222-2222-4222-8222-222222222222' })).type, 'error');
  });

  it('turns a YouTube link not in the library into a request (title via oEmbed)', async () => {
    const r = await fakes().resolve({ input: 'https://www.youtube.com/watch?v=9bZkp7q19f0' });
    assert.deepEqual(r, {
      type: 'request',
      request: { youtubeId: '9bZkp7q19f0', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', title: 'From oEmbed', artist: null },
    });
  });

  it('free text: YouTube search hit in library > library text match > request', async () => {
    const hit = { id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Rick' };
    assert.equal((await fakes({ ytdlp: { searchYoutube: async () => hit } }).resolve({ input: 'rick' })).type, 'library');

    const other = { id: '9bZkp7q19f0', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', title: 'Gangnam' };
    const viaText = await fakes({ ytdlp: { searchYoutube: async () => other }, library: { findBestTextMatch: async () => song } }).resolve({ input: 'never' });
    assert.deepEqual(viaText, { type: 'library', song });

    const req = await fakes({ ytdlp: { searchYoutube: async () => other } }).resolve({ input: 'gangnam' });
    assert.deepEqual(requestOf(req), { youtubeId: '9bZkp7q19f0', url: other.url, title: 'Gangnam', artist: null });

    // search fails (IP blocked) and nothing matches -> text-only request
    const blocked = await fakes({ ytdlp: { searchYoutube: async () => { throw new Error('bot'); } } }).resolve({ input: 'some song' });
    assert.deepEqual(blocked, { type: 'request', request: { youtubeId: null, url: null, title: 'some song', artist: null } });
  });

  it('playlists split into library songs and requests', async () => {
    const r = await fakes({
      ytdlp: { getPlaylistEntries: async () => [{ id: 'dQw4w9WgXcQ', title: 'a' }, { id: '9bZkp7q19f0', title: 'b' }] },
    }).resolve({ input: 'https://www.youtube.com/playlist?list=PLabc' });
    assert.equal(r.type, 'playlist');
    assert.deepEqual(itemsOf(r).map((i) => i.type), ['library', 'request']);
    assert.equal(requestOf(itemsOf(r)[1])?.youtubeId, '9bZkp7q19f0');
  });

  it('spotify links match title+artist in the library, else request with title/artist', async () => {
    const track = { name: 'Never', artist: 'Rick', searchQuery: 'Never Rick' };
    const lib = await fakes({ spotify: { getTrack: async () => track }, library: { findByTitleArtist: async () => song } })
      .resolve({ input: 'https://open.spotify.com/track/abc123' });
    assert.equal(lib.type, 'library');
    const req = await fakes({ spotify: { getTrack: async () => track } }).resolve({ input: 'https://open.spotify.com/track/abc123' });
    assert.deepEqual(requestOf(req), { youtubeId: null, url: 'https://open.spotify.com/track/abc123', title: 'Never', artist: 'Rick' });
  });

  it('rejects unsupported links and empty input', async () => {
    assert.equal((await fakes().resolve({ input: 'https://example.com/song.mp3' })).type, 'error');
    assert.equal((await fakes().resolve({ input: '   ' })).type, 'error');
  });
});
