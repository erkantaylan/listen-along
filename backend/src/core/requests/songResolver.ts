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
 *
 * `picks` (videos chosen in the web's pick dialog) skips every lookup above:
 * each id is a library song or a request for exactly that video.
 */

import * as realYtdlp from './ytdlp.ts';
import type { PlaylistEntry, SearchHit } from './ytdlp.ts';
import * as realSpotify from './spotify.ts';
import type { SpotifyLink, SpotifyTrack } from './spotify.ts';
import { library as realLibrary } from '../library/index.ts';
import type { LibrarySongRow } from '../../shared/types.ts';

export const MAX_PLAYLIST = 100;

function isSpotifyHost(text: string): boolean {
  try { return new URL(text).hostname.toLowerCase() === 'open.spotify.com'; } catch { return false; }
}

/** A request the resolver proposes (queueSockets makes it with requests.createRequest). */
export interface ProposedRequest {
  youtubeId: string | null;
  url: string | null;
  title: string | null;
  artist: string | null;
}

export type ResolvedItem =
  | { type: 'library'; song: LibrarySongRow }
  | { type: 'request'; request: ProposedRequest };

export type Resolved =
  | ResolvedItem
  | { type: 'playlist'; items: ResolvedItem[]; total: number }
  | { type: 'error'; message: string };

/** What the resolver reads of the library (tests pass their own). */
export interface ResolverLibrary {
  getById(id: string): Promise<LibrarySongRow | null>;
  getByYoutubeId(youtubeId: string): Promise<LibrarySongRow | null>;
  findByTitleArtist(title: string, artist: string | null): Promise<LibrarySongRow | null>;
  findBestTextMatch(text: string): Promise<LibrarySongRow | null>;
  resolveQueueUrl(url: string): Promise<LibrarySongRow | null>;
  youtubeUrl(youtubeId: string): string;
  parseYoutubeId(input: unknown): string | null;
}

/** What it asks of yt-dlp. */
export interface ResolverYtdlp {
  getOembed(videoId: string): Promise<{ title: string | null } | null>;
  getPlaylistEntries(url: string): Promise<Array<Pick<PlaylistEntry, 'id' | 'title'>>>;
  searchYoutube(query: string): Promise<Pick<SearchHit, 'id' | 'url' | 'title'> | null>;
  parsePlaylistId(target: unknown): string | null;
}

/** What it asks of Spotify. */
export interface ResolverSpotify {
  getTrack(url: string): Promise<Partial<SpotifyTrack>>;
  parseSpotifyUrl(url: unknown): SpotifyLink | null;
}

export interface ResolverDeps {
  library?: ResolverLibrary;
  ytdlp?: ResolverYtdlp;
  spotify?: ResolverSpotify;
  /** titles for chosen videos from the server's own lookups (picker.titles) */
  videoTitles?: (youtubeIds: string[]) => Promise<Map<string, string>>;
}

/** resolve()'s input. picks: valid, distinct YouTube ids (cleanPicks). */
export interface ResolveArgs {
  input?: unknown;
  libraryId?: string;
  title?: string | null;
  picks?: string[] | null;
}

export interface Resolver {
  resolve(args?: ResolveArgs): Promise<Resolved>;
}

export function createResolver({ library = realLibrary, ytdlp = realYtdlp, spotify = realSpotify, videoTitles = async () => new Map() }: ResolverDeps = {}): Resolver {
  async function byYoutubeId(youtubeId: string, fallback: { title?: string | null; artist?: string | null } = {}): Promise<ResolvedItem> {
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

  async function resolvePlaylist(input: string): Promise<Resolved> {
    let entries;
    try {
      entries = await ytdlp.getPlaylistEntries(input);
    } catch (err) {
      return { type: 'error', message: `Could not read that playlist: ${(err as Error).message}` };
    }
    if (!entries.length) return { type: 'error', message: 'No videos found in that playlist' };
    const items: ResolvedItem[] = [];
    for (const e of entries.slice(0, MAX_PLAYLIST)) {
      const song = await library.getByYoutubeId(e.id);
      items.push(song
        ? { type: 'library', song }
        : { type: 'request', request: { youtubeId: e.id, url: library.youtubeUrl(e.id), title: e.title || null, artist: null } });
    }
    return { type: 'playlist', items, total: entries.length };
  }

  async function resolveSpotify(input: string): Promise<Resolved> {
    let track;
    try {
      track = await spotify.getTrack(input);
    } catch (err) {
      return { type: 'error', message: `Failed to read Spotify link: ${(err as Error).message}` };
    }
    // getTrack always names the track (its title falls back to 'Unknown').
    const name = (track.name || track.title)!;
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

  async function resolveText(text: string): Promise<Resolved> {
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
   * Videos chosen in the web's pick dialog: exactly these, no search. Titles
   * are the server's own (videoTitles: features/picker, with oEmbed for what it no
   * longer knows), never the client's. Several are answered like a playlist.
   */
  async function resolvePicks(ids: string[]): Promise<Resolved> {
    const songs = new Map<string, LibrarySongRow | null>();
    for (const id of ids) songs.set(id, await library.getByYoutubeId(id));
    const titles = await videoTitles(ids.filter((id) => !songs.get(id)));
    const items = ids.map((id): ResolvedItem => {
      const song = songs.get(id);
      return song
        ? { type: 'library', song }
        : { type: 'request', request: { youtubeId: id, url: library.youtubeUrl(id), title: titles.get(id) || null, artist: null } };
    });
    return items.length === 1 ? items[0] : { type: 'playlist', items, total: items.length };
  }

  async function resolve({ input, libraryId, title, picks }: ResolveArgs = {}): Promise<Resolved> {
    if (picks) return resolvePicks(picks);
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
      // A Spotify album, playlist or artist page: say what is wrong with it.
      if (isSpotifyHost(text)) return { type: 'error', message: 'Only Spotify track links are supported. Paste the link of a single song.' };
      return { type: 'error', message: 'Unsupported link. Paste a YouTube or Spotify link, or search by name.' };
    }
    return resolveText(text);
  }

  return { resolve };
}
