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
 *   { kind: 'playlist', results, total, title }   results: the first MAX_PICKS videos; title: the
 *                                                 playlist's name (null when YouTube gave none)
 * with video = { youtube_id, title, channel, duration_sec, in_library },
 * in_library = { id, title, artist } | null.
 *
 * Every video handed out is remembered (known()), so that a job or request
 * made from a chosen id gets its title from here (titles(), with oEmbed for
 * one it no longer knows), not from the client.
 */

import { library as realLibrary } from '../../core/library/index.ts';
import { ytdlp as realYtdlp, spotify as realSpotify, cleanPicks, MAX_PICKS } from '../../core/requests/index.ts';
import { classifyInput as classifyInputJs } from '../../downloadJobs.js';
import type { LibrarySongRow } from '../../shared/types.ts';

export const SEARCH_COUNT = 5;
// The chosen-videos list is checked where it arrives (core: jobs, queue).
export { cleanPicks, MAX_PICKS };
const CACHE_MS = 10 * 60 * 1000;
const CACHE_SIZE = 200;
const KNOWN_SIZE = 5000;
const TITLE_CONCURRENCY = 4;
const TITLE_BUDGET_MS = 10 * 1000;

/** A video as the dialog shows it. */
export interface PickVideo {
  youtube_id: string;
  title: string | null;
  channel: string | null;
  duration_sec: number | null;
}
/** ...with what the library has of it, looked up on every answer. */
export interface MarkedVideo extends PickVideo {
  in_library: { id: string; title: string; artist: string | null } | null;
}
/** What a lookup said about a video (known()). */
export type KnownVideo = Omit<PickVideo, 'youtube_id'>;

/** lookup() / search(): POST /api/jobs/picks's answer. `song` is library.toPublic's view. */
export type PickAnswer =
  | { kind: 'library'; song: unknown }
  | { kind: 'search'; query: string; results: MarkedVideo[] }
  | { kind: 'video'; results: MarkedVideo[] }
  | { kind: 'playlist'; results: MarkedVideo[]; total: number; title: string | null };

/** A refused lookup: `status` is the HTTP status jobRoutes.js answers with, `code` the body's code. */
export type PickError = Error & { status: number; code: 'BAD_INPUT' | 'LOOKUP_FAILED' };

/** The library row fields the picker reads. */
export type PickerSong = Pick<LibrarySongRow, 'id' | 'title'> & { youtube_id?: string | null; artist: string | null };

/** What the picker uses of library.js (CommonJS until core/ moves). */
export interface PickerLibrary {
  getByYoutubeId(youtubeId: string): Promise<PickerSong | null>;
  getByYoutubeIds(youtubeIds: string[]): Promise<Map<string, PickerSong>>;
  findBestTextMatch(text: string): Promise<PickerSong | null>;
  findByTitleArtist(title: string, artist: string | null): Promise<PickerSong | null>;
  toPublic(song: PickerSong): unknown;
}

/** A yt-dlp search or playlist entry (ytdlp.js). */
export interface YtEntry {
  id: string;
  title?: string | null;
  channel?: string | null;
  duration?: number | string | null;
}

/** What the picker uses of ytdlp.js (metadata only). */
export interface PickerYtdlp {
  searchYoutubeMany(query: string, count: number): Promise<YtEntry[]>;
  previewVideo(youtubeId: string): Promise<{ title: string | null; channel: string | null; duration_sec: number | null } | null>;
  /** the playlist's name is on the array (`title`) */
  getPlaylistEntries(url: string): Promise<YtEntry[] & { title?: string | null }>;
  getOembed(youtubeId: string): Promise<{ title?: string | null; channel?: string | null } | null>;
}

/** What the picker uses of spotify.js. */
export interface PickerSpotify {
  getTrack(url: string): Promise<{ name?: string | null; title?: string | null; artist?: string | null } | null>;
}

export interface PickerDeps {
  library?: PickerLibrary;
  ytdlp?: PickerYtdlp;
  spotify?: PickerSpotify;
  /** how long an answer is reused */
  cacheMs?: number;
  now?: () => number;
}

export interface Picker {
  /**
   * @param input - what was typed or pasted
   * @param opts - the playlist's add-song box:
   *   what the library already has is the answer, as when adding without a dialog
   */
  lookup(input: unknown, opts?: { matchLibrary?: boolean }): Promise<PickAnswer>;
  /** Always a search, whatever the text looks like (a playlist item's alternatives). */
  search(text: unknown): Promise<PickAnswer>;
  /** What a lookup said about a video, or null. */
  known(youtubeId: string): KnownVideo | null;
  /** Titles for chosen videos: Map youtube id -> title, for those that have one. */
  titles(youtubeIds: Iterable<string>, opts?: { concurrency?: number; budgetMs?: number }): Promise<Map<string, string>>;
}

/** downloadJobs.classifyInput: what a typed or pasted text is. */
type Classified =
  | { error: string }
  | { kind: 'video'; input: string; youtubeId: string }
  | { kind: 'playlist' | 'spotify' | 'search'; input: string };
// Typed here: its JavaScript source infers a looser shape.
const classifyInput = classifyInputJs as (input: unknown) => Classified;

function pickError(status: number, code: PickError['code'], message: string): PickError {
  return Object.assign(new Error(message), { status, code });
}


export function createPicker({ library = realLibrary, ytdlp = realYtdlp, spotify = realSpotify, cacheMs = CACHE_MS, now = Date.now }: PickerDeps = {}): Picker {
  const cache = new Map<string, { at: number; promise: Promise<unknown> }>(); // key -> { at, promise }
  const knownVideos = new Map<string, KnownVideo>(); // youtube id -> { title, channel, duration_sec }

  // One lookup per key at a time and per cacheMs; a failure is not kept.
  function cached<T>(key: string, load: () => T | Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.promise as Promise<T>;
    cache.delete(key);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    const entry = { at: now(), promise: Promise.resolve().then(load) };
    cache.set(key, entry);
    entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return entry.promise;
  }

  function remember<V extends PickVideo>(v: V): V {
    if (!v.title) return v;
    knownVideos.delete(v.youtube_id);
    if (knownVideos.size >= KNOWN_SIZE) knownVideos.delete(knownVideos.keys().next().value as string);
    knownVideos.set(v.youtube_id, { title: v.title, channel: v.channel, duration_sec: v.duration_sec });
    return v;
  }
  const toVideo = (e: YtEntry): PickVideo => remember({
    youtube_id: e.id,
    title: e.title || null,
    channel: e.channel || null,
    duration_sec: Number(e.duration) > 0 ? Math.round(Number(e.duration)) : null,
  });

  /** The library can change between two lookups: marked on every answer, never cached. */
  async function mark(videos: PickVideo[]): Promise<MarkedVideo[]> {
    const have = await library.getByYoutubeIds(videos.map((v) => v.youtube_id));
    return videos.map((v) => {
      const song = have.get(v.youtube_id);
      return { ...v, in_library: song ? { id: song.id, title: song.title, artist: song.artist || null } : null };
    });
  }

  const searchVideos = (query: string) => cached(`search:${query.toLowerCase()}`, async () =>
    (await ytdlp.searchYoutubeMany(query, SEARCH_COUNT)).map(toVideo));

  /** Always a search, whatever the text looks like (a playlist item's alternatives). */
  async function search(text: unknown): Promise<PickAnswer> {
    const query = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
    if (!query) throw pickError(400, 'BAD_INPUT', 'Nothing to search for');
    if (query.length > 500) throw pickError(400, 'BAD_INPUT', 'That is too long');
    let videos;
    try { videos = await searchVideos(query); } catch (err) {
      throw pickError(502, 'LOOKUP_FAILED', `The YouTube search failed: ${(err as Error).message}`);
    }
    return { kind: 'search', query, results: await mark(videos) };
  }

  async function lookup(input: unknown, { matchLibrary = false }: { matchLibrary?: boolean } = {}): Promise<PickAnswer> {
    const what = classifyInput(input);
    if ('error' in what) throw pickError(400, 'BAD_INPUT', what.error);
    const inLibrary = (song: PickerSong): PickAnswer => ({ kind: 'library', song: library.toPublic(song) });

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
          return { videos: entries.slice(0, MAX_PICKS).map(toVideo), total: entries.length, title: entries.title || null };
        });
      } catch (err) {
        throw pickError(502, 'LOOKUP_FAILED', `Could not read that playlist: ${(err as Error).message}`);
      }
      return { kind: 'playlist', results: await mark(listing.videos), total: listing.total, title: listing.title || null };
    }

    let query = what.input;
    if (what.kind === 'spotify') {
      let track;
      try { track = await cached(`spotify:${what.input}`, () => spotify.getTrack(what.input)); } catch (err) {
        throw pickError(400, 'BAD_INPUT', `Could not read that Spotify link: ${(err as Error).message}`);
      }
      const name = track && (track.name || track.title);
      if (!name) throw pickError(400, 'BAD_INPUT', 'That Spotify link has no track title');
      const artist = track!.artist && track!.artist !== 'Unknown Artist' ? track!.artist : null;
      if (matchLibrary) {
        const exact = await library.findByTitleArtist(name, artist);
        if (exact) return inLibrary(exact);
      }
      query = artist ? `${artist} - ${name}` : name;
    }

    let videos: PickVideo[] | null = null;
    let failure: Error | null = null;
    try { videos = await searchVideos(query); } catch (err) { failure = err as Error; }
    if (matchLibrary) {
      // The same order as songResolver: the top hit, then a library text match.
      const top = videos && videos[0] ? await library.getByYoutubeId(videos[0].youtube_id) : null;
      if (top) return inLibrary(top);
      const byText = what.kind === 'search' ? await library.findBestTextMatch(query) : null;
      if (byText) return inLibrary(byText);
    }
    if (failure) throw pickError(502, 'LOOKUP_FAILED', `The YouTube search failed: ${failure.message}`);
    return { kind: 'search', query, results: await mark(videos as PickVideo[]) };
  }

  /** What a lookup said about a video: { title, channel, duration_sec } or null. */
  const known = (youtubeId: string): KnownVideo | null => knownVideos.get(youtubeId) || null;

  /**
   * Titles for chosen videos: Map youtube id -> title, for those that have one.
   * What a lookup said, else oEmbed (the answer may be gone: evicted, or the
   * server restarted between the lookup and the confirm). oEmbed runs a few at
   * a time and only until the budget is spent; what is left has no title.
   */
  async function titles(youtubeIds: Iterable<string>, { concurrency = TITLE_CONCURRENCY, budgetMs = TITLE_BUDGET_MS }: { concurrency?: number; budgetMs?: number } = {}): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const missing: string[] = [];
    for (const id of new Set(youtubeIds)) {
      const v = knownVideos.get(id);
      if (v) found.set(id, v.title as string); else missing.push(id);
    }
    if (!missing.length) return found;
    let timer: NodeJS.Timeout | undefined;
    const spent = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
    let stopped = false;
    const worker = async () => {
      while (missing.length && !stopped) {
        const id = missing.shift() as string;
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

