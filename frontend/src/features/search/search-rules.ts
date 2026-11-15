// The global search (search.ts): the pure rules, no DOM. Unit tested in
// search-rules.test.ts.
import { isVideoId } from '../picker/pick-rules.ts';
import type { PicksAnswer } from '../picker/pick-rules.ts';
import { foldText, matchesQuery } from '../playlists/playlist-filter.ts';
import type { ApiError, LibrarySong, PickVideo } from '../../shared/types.ts';
import type { Route } from '../../router.ts';

// What the library section shows at first, and at most ("Show more").
export const SONGS_SHOWN = 10;
export const SONGS_MAX = 50;
// Artists and playlists: a short list each.
export const ARTISTS_MAX = 6;
export const PLAYLISTS_MAX = 6;
// The one-step "Add to <current playlist>" key on a focused row.
export const ADD_KEY = 'a';

// Ctrl+K (Cmd+K on a Mac) focuses the search field from anywhere, also from
// another input. Not while an IME is composing, not with other modifiers.
/** What the key rules read of a KeyboardEvent. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>;

export function isSearchShortcut(e: KeyLike | null | undefined, mac = false): boolean {
  if (!e || e.isComposing || e.altKey || e.shiftKey) return false;
  if (String(e.key).toLowerCase() !== 'k') return false;
  return mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
}

// The add key on a focused row: a plain "a", nothing held, no IME.
export function isAddKey(e: KeyLike | null | undefined): boolean {
  return !!e && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && String(e.key).toLowerCase() === ADD_KEY;
}

// Hosts that may be pasted without "https://".
const BARE_HOST_RE = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\/|^open\.spotify\.com\//i;

/**
 * What to look up when the text is a link, or null when it is a search.
 * A link is http(s)://…, a YouTube / Spotify address without the scheme, or
 * a bare 11-character YouTube id (only when it has a digit, "-" or "_" next to
 * letters: "despacitooo" stays a word). Never fuzzy: the server's classifyInput
 * (POST /api/jobs/picks { input }) has the last word.
 */
export function linkInput(text: unknown): string | null {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (BARE_HOST_RE.test(s)) return `https://${s}`;
  if (isVideoId(s) && /[0-9_-]/.test(s) && /[A-Za-z]/.test(s)) return s;
  return null;
}

export const isSpotifyLink = (input: string | null | undefined): boolean => /^https?:\/\/open\.spotify\.com\//i.test(String(input || ''));

/**
 * What POST /api/jobs/picks { input } said about a pasted link, for the page:
 *   { kind: 'song', song }                 the library has that video (or the Spotify track)
 *   { kind: 'video', video, query? }       exactly one video, not in the library
 *                                          (query: the Spotify track's "artist - title")
 *   { kind: 'none', query }                a Spotify track that YouTube does not find
 *   { kind: 'playlist', title, total, videos, inLibrary }
 *   { kind: 'unsupported', message }       the server refused the link (its own words)
 *   { kind: 'rate' } / { kind: 'error', message }   try again later
 *   { kind: 'text' }                       not a link after all: search the words
 */
/** A Spotify track's top hit the library has, as a song (linkOutcome). */
export interface LinkedLibrarySong {
  id: string;
  title: string;
  artist: string | null;
  youtube_id: string;
  duration_sec: number | null;
}

export type LinkOutcome =
  | { kind: 'song'; song: LibrarySong | LinkedLibrarySong; query?: string }
  | { kind: 'video'; video: PickVideo; query?: string }
  | { kind: 'none'; query: string }
  | { kind: 'playlist'; title: string | null; total: number; videos: PickVideo[]; inLibrary: number }
  | { kind: 'unsupported'; message: string | null }
  | { kind: 'rate' }
  | { kind: 'error'; message: string | null }
  | { kind: 'text' };

// bare: the text was a bare id; one YouTube cannot name is taken as words.
export function linkOutcome(status: number, body: PicksAnswer | null | undefined, { spotify = false, bare = false }: { spotify?: boolean; bare?: boolean } = {}): LinkOutcome {
  if (bare && status === 200 && body && body.kind === 'video' && !(body.results && body.results[0] && body.results[0].title)) {
    return { kind: 'text' };
  }
  if (status === 429) return { kind: 'rate' };
  if (!status || status >= 500) return { kind: 'error', message: (body && body.error) || null };
  if (status === 400 || status === 404) {
    return { kind: 'unsupported', message: (body && body.error) || null };
  }
  if (status !== 200 || !body) return { kind: 'error', message: (body && body.error) || null };
  if (body.kind === 'library' && body.song) return { kind: 'song', song: body.song };
  const results = Array.isArray(body.results) ? body.results.filter((v) => v && isVideoId(v.youtube_id)) : [];
  if (body.kind === 'video') return results[0] ? { kind: 'video', video: results[0] } : { kind: 'error', message: null };
  if (body.kind === 'playlist') {
    return {
      kind: 'playlist',
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null,
      total: Number.isFinite(body.total) ? body.total as number : results.length,
      videos: results,
      inLibrary: results.filter((v) => v.in_library).length,
    };
  }
  if (body.kind === 'search' && spotify) {
    // The track as it resolves today: the top hit (marked when the library has it).
    const top = results[0];
    if (!top) return { kind: 'none', query: body.query || '' };
    if (top.in_library) return { kind: 'song', song: { id: top.in_library.id, title: top.in_library.title, artist: top.in_library.artist, youtube_id: top.youtube_id, duration_sec: top.duration_sec }, query: body.query || '' };
    return { kind: 'video', video: top, query: body.query || '' };
  }
  return { kind: 'text' };
}

/** What POST /api/jobs/picks { query } (the YouTube section) came to. */
export type YoutubeOutcome =
  | { kind: 'rate' }
  | { kind: 'results'; videos: PickVideo[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string | null };

export function youtubeOutcome(status: number, body: PicksAnswer | null | undefined): YoutubeOutcome {
  if (status === 429) return { kind: 'rate' };
  if (status === 200 && body && Array.isArray(body.results)) {
    const videos = body.results.filter((v) => v && isVideoId(v.youtube_id));
    return videos.length ? { kind: 'results', videos } : { kind: 'empty' };
  }
  return { kind: 'error', message: (body && body.error) || null };
}

// Words a video title carries that are not the song's.
const NOISE_RE = /\b(?:official(?:\s+(?:music|lyric|audio|hd))?(?:\s+video)?|music\s+video|lyric(?:s)?(?:\s+video)?|video\s*clip|audio|hd|hq|4k|mv|remastered(?:\s+\d{4})?|klip|resmi(?:\s+video)?|şarkı\s+sözleri)\b/giu;

/**
 * Library words for "Similar in the library" under a pasted video: the song's
 * title from a YouTube title. "TARKAN - Şımarık (Official Video)" -> "Şımarık";
 * "Song | Artist" -> "Song". Brackets, "feat. …" and the usual video words go.
 */
export function similarQuery(title: string | null | undefined): string {
  let s = String(title ?? '');
  s = s.replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, ' ');
  s = s.replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, ' ');
  const parts = s.split(/\s[-–—|]\s|\s\/\/\s/).map((p) => p.trim()).filter(Boolean);
  // "Artist - Title": the part after the first dash; "Title | Channel": the first.
  let pick = parts.length > 1 && /\s[-–—]\s/.test(s) ? parts[1] : parts[0] || '';
  pick = pick.replace(NOISE_RE, ' ').replace(/["“”'‘’]/g, ' ');
  return pick.replace(/[^\p{L}\p{N}&'’ ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * The playlist page on screen as a search's add target: its id when it is the
 * page showing (not under the library overlay, which has its own Add) and the
 * viewer may edit it; else null.
 */
export function pageTarget({ view = null, lobbyId = null, canEdit = false, libraryOpen = false }: { view?: string | null; lobbyId?: string | null; canEdit?: boolean; libraryOpen?: boolean } = {}): string | null {
  return view === 'lobby' && !libraryOpen && canEdit && typeof lobbyId === 'string' && lobbyId ? lobbyId : null;
}

/**
 * The search is started (the field focused, Ctrl+K, the Search place): on an
 * editable playlist page that playlist becomes this search's target; anywhere
 * else the search keeps the target it has (none, or the page it was started on).
 */
export function startTarget(sessionId: string | null = null, pageId: string | null = null): string | null {
  return pageId || sessionId || null;
}

/**
 * A route change: a search's target lasts while its search does, on the search
 * page and on its own playlist page (not that playlist's library). Anywhere
 * else it ends. Returns the target to keep, or null.
 */
export function keepTarget(sessionId: string | null, route: Pick<Route, 'view'> & Partial<Pick<Route, 'lobbyId' | 'library'>> | null | undefined): string | null {
  if (!sessionId || !route) return null;
  if (route.view === 'search') return sessionId;
  return route.view === 'lobby' && route.lobbyId === sessionId && !route.library ? sessionId : null;
}

/**
 * The playlist a one-step add goes to: the one this search was started on (an
 * editable playlist page, see startTarget), else the one last played from.
 * Only if it is still in the viewer's list (it exists and they can see it) and
 * they may edit it; otherwise there is none.
 * playlists: GET /api/playlists rows ({ id, name, canEdit }).
 */
export interface TargetPlaylist {
  id: string;
  canEdit: boolean;
}

export function addTarget<P extends TargetPlaylist>({ sessionId = null, lastPlayedId = null, playlists = [] }: { sessionId?: string | null; lastPlayedId?: string | null; playlists?: readonly (P | null | undefined)[] | null } = {}): { playlist: P; session: boolean } | null {
  const usable = (id: string | null): P | null => (id ? (playlists || []).find((p) => p && p.id === id && p.canEdit) || null : null);
  const session = usable(sessionId);
  if (session) return { playlist: session, session: true };
  const last = usable(lastPlayedId);
  return last ? { playlist: last, session: false } : null;
}

/**
 * The playlist the field's placeholder names ("Find songs to add to <name>"):
 * the one a search started now would add to in one step because of the page
 * (or this search's own target), never the last-played fallback. Null = the
 * plain placeholder.
 */
export function placeholderTarget<P extends TargetPlaylist>({ sessionId = null, pageId = null, playlists = [] }: { sessionId?: string | null; pageId?: string | null; playlists?: readonly (P | null | undefined)[] | null } = {}): P | null {
  const target = addTarget({ sessionId: startTarget(sessionId, pageId), playlists });
  return target && target.session ? target.playlist : null;
}

/** The playlist to remember as "last played from", or null for any other context. */
export function lastPlayedFrom(context: { type: string; lobbyId?: unknown } | null | undefined): string | null {
  return context && context.type === 'lobby' && typeof context.lobbyId === 'string' && context.lobbyId ? context.lobbyId : null;
}

/** POST /api/playlists/:id/songs as addOutcome reads the answer: PlaylistAddResponse (200) or an ApiError. */
export interface AddAnswer extends Partial<ApiError> {
  results?: readonly { status: string }[];
}

/**
 * POST /api/playlists/:id/songs { songs: [one] } answered:
 *   'added' | 'duplicate' (the same song is in it: ask, then send allow_duplicates)
 *   | 'notInLibrary' | 'missing' (no such playlist for this viewer) | 'error'
 */
export function addOutcome(status: number, body: AddAnswer | null | undefined): 'added' | 'duplicate' | 'notInLibrary' | 'missing' | 'error' {
  if (status === 404) return 'missing';
  const r = status === 200 && body && Array.isArray(body.results) ? body.results[0] : null;
  if (!r) return 'error';
  if (r.status === 'added') return 'added';
  if (r.status === 'already_in_playlist') return 'duplicate';
  if (r.status === 'not_in_library' || r.status === 'invalid') return 'notInLibrary';
  return 'error';
}

/** POST /api/jobs { picks } as requestOutcome reads the answer: CreatePickedJobsResponse (2xx) or an ApiError. */
export interface RequestAnswer extends Partial<ApiError> {
  jobs?: readonly unknown[];
  existing?: readonly unknown[];
  added_to_playlist?: number;
  already_in_playlist?: readonly string[];
  playlist_id?: string | null;
  failed?: readonly string[];
}

/**
 * POST /api/jobs { picks: [id], playlist_id? } for one video answered:
 *   'requested' (a download job), 'added' (the library had it: in the playlist
 *   now), 'library' (the library has it, no playlist was asked for),
 *   'duplicate' (the library has it and the playlist already does: ask, then
 *   send allow_duplicates), 'missing', 'error'.
 */
export function requestOutcome(status: number, body: RequestAnswer | null | undefined, youtubeId: string): 'requested' | 'added' | 'library' | 'duplicate' | 'missing' | 'error' {
  if (status === 404) return 'missing';
  if ((status !== 200 && status !== 201) || !body) return 'error';
  if (Array.isArray(body.failed) && body.failed.includes(youtubeId)) return 'error';
  if (Array.isArray(body.already_in_playlist) && body.already_in_playlist.includes(youtubeId)) return 'duplicate';
  if (Array.isArray(body.jobs) && body.jobs.length) return 'requested';
  if (body.playlist_id && (body.added_to_playlist ?? 0) > 0) return 'added';
  if (Array.isArray(body.existing) && body.existing.length) return body.playlist_id ? 'error' : 'library';
  return 'error';
}

/**
 * Keyboard movement over the result rows (every section in page order):
 * the next index, -1 for the search field (Up from the first row), or null
 * when the key is not ours.
 */
export function rowStep(index: number, key: string, count: number, page = 5): number | null {
  if (!(count > 0)) return null;
  const clamp = (n: number): number => Math.min(count - 1, Math.max(0, n));
  switch (key) {
    case 'ArrowDown': return clamp(index + 1);
    case 'ArrowUp': return index <= 0 ? -1 : index - 1;
    case 'PageDown': return clamp(index + page);
    case 'PageUp': return clamp(index - page);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

// How well a name answers the query: 0 the name, 1 starts with it, 2 every
// word starts a word of it, 3 contains every word somewhere (else no match).
function nameTier(name: string, query: string): number {
  const q = foldText(query);
  const n = foldText(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  const parts = n.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = q.split(' ').filter(Boolean);
  if (words.every((w) => parts.some((p) => p.startsWith(w)))) return 2;
  return words.every((w) => n.includes(w)) ? 3 : -1;
}

const trCompare = (a: string | null | undefined, b: string | null | undefined): number => String(a || '').localeCompare(String(b || ''), 'tr', { numeric: true, sensitivity: 'base' });

/** Artists (GET /api/artists rows: { key, name, count }) matching every word, best first, then most songs. */
export function rankArtists<A extends { name: string; count?: number | null }>(artists: readonly A[] | null | undefined, query: string, limit = ARTISTS_MAX): A[] {
  if (!foldText(query)) return [];
  return (artists || [])
    .map((a) => ({ a, tier: nameTier(a.name, query) }))
    .filter((x) => x.tier >= 0)
    .sort((x, y) => x.tier - y.tier || (y.a.count || 0) - (x.a.count || 0) || trCompare(x.a.name, y.a.name))
    .slice(0, limit)
    .map((x) => x.a);
}

/** What the playlist search reads of a GET /api/playlists row (PlaylistSummary). */
export interface RankablePlaylist {
  name?: string | null;
  ownerName?: string | null;
  pinnedByMe?: boolean;
}

/**
 * Playlists matching every word of the query in the name or the owner's name
 * (the sidebar's search), best name match first, then pinned, then A-Z. Only
 * what the server listed for this viewer is ever here, so nothing private leaks.
 */
export function rankPlaylists<P extends RankablePlaylist>(playlists: readonly (P | null | undefined)[] | null | undefined, query: string, limit = PLAYLISTS_MAX): P[] {
  if (!foldText(query)) return [];
  return (playlists || [])
    .filter((p): p is P => !!p && matchesQuery(p, query))
    .map((p) => { const tier = nameTier(p.name || '', query); return { p, tier: tier < 0 ? 4 : tier }; })
    .sort((x, y) => x.tier - y.tier || Number(!!y.p.pinnedByMe) - Number(!!x.p.pinnedByMe) || trCompare(x.p.name, y.p.name))
    .slice(0, limit)
    .map((x) => x.p);
}

/** library:updated as read here: every LibraryUpdatedPayload variant fits, each field optional. */
export interface LibraryChange {
  removed?: string;
  song?: object;
  details?: object;
  replaced?: object;
  reports?: object;
}

/**
 * library:updated: can the page's song results have changed? A new song, a
 * removed one (only when it is on screen), new details or new audio (title,
 * artist) can; reports alone cannot (search rows show none).
 */
export function libraryChangeMatters(payload: LibraryChange | null | undefined, shownIds: readonly string[] = []): boolean {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.removed) return shownIds.includes(payload.removed);
  if (payload.details || payload.replaced) return true;
  if (payload.reports && !payload.song) return false;
  return !!payload.song;
}
