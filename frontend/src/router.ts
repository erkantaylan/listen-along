// URL <-> view mapping for the single-page app. Pure functions only (no DOM),
// so they can be unit tested in Node (router.test.ts).
//
//   /                          landing (playlist list)
//   /playlist/<id>             playlist (internally the view is still "lobby")
//   /library                   music library (no playlist; Add is disabled)
//   /playlist/<id>/library     music library over a playlist (Add targets it)
//   /radio                     Radio: every song, shuffled (radio.js)
//   /artists                   every artist in the library (artists.js)
//   /artist/<key>              one artist's songs, read-only (artist-page.js)
//   /search?q=<text>           the global search (search.js): library songs,
//                              artists, playlists, YouTube on request, links
//   /app                       Android app: download, install, connect (app-page.js)
//   /profile                   own profile
//   /social                    chat + people (full-screen below 1010px; from
//                              1010px the column beside the current page)
//   /dashboard                 admin dashboard (its own login form; /admin 301s here)
//
// Old /lobby/<id>[/library] URLs map to /playlist/... (legacyRedirect; the
// server answers them with a 301 too).
//
// Library query params (defaults are left out of the URL):
//   tab=requests|downloads|broken ("Needs replacement": reported songs), status=fulfilled|dismissed|all (requests filter),
//   q=<search>, sort=title|artist, page=<n> (1-based)

export type LibraryTab = 'library' | 'requests' | 'downloads' | 'broken';
export type LibrarySort = 'recent' | 'title' | 'artist';
export type RequestStatus = 'pending' | 'fulfilled' | 'dismissed' | 'all';

export const LIBRARY_TABS: readonly LibraryTab[] = ['library', 'requests', 'downloads', 'broken'];
export const LIBRARY_SORTS: readonly LibrarySort[] = ['recent', 'title', 'artist'];
export const REQUEST_STATUSES: readonly RequestStatus[] = ['pending', 'fulfilled', 'dismissed', 'all'];

// The library overlay's state, as the URL carries it. page is 0-based.
export interface LibraryState {
  tab: LibraryTab;
  query: string;
  sort: LibrarySort;
  page: number;
  requestStatus: RequestStatus;
}

export const LIBRARY_DEFAULTS: Readonly<LibraryState> = Object.freeze({ tab: 'library', query: '', sort: 'recent', page: 0, requestStatus: 'pending' });

// The views the router knows ("lobby" is the playlist page).
export type View = 'landing' | 'lobby' | 'radio' | 'artists' | 'artist' | 'search' | 'app' | 'profile' | 'social' | 'dashboard';

export interface Route {
  view: View;
  lobbyId: string | null;
  library: LibraryState | null;
  artistKey?: string;
  searchQuery?: string;
}

function oneOf<T extends string>(list: readonly T[], value: string | null): value is T {
  return (list as readonly (string | null)[]).includes(value);
}

const LOBBY_RE = /^\/playlist\/([a-zA-Z0-9-]+)(\/library)?\/?$/;
const ARTIST_RE = /^\/artist\/([^/]+)\/?$/;
const LEGACY_LOBBY_RE = /^\/lobby\/([a-zA-Z0-9-]+)(\/library)?\/?$/;

// The /playlist/... path for an old /lobby/... path (search kept), else null.
export function legacyRedirect(pathname: string, search = ''): string | null {
  const m = LEGACY_LOBBY_RE.exec(pathname);
  if (!m) return null;
  return `/playlist/${m[1]}${m[2] ? '/library' : ''}${search || ''}`;
}

export function playlistPath(lobbyId: string): string {
  return `/playlist/${lobbyId}`;
}

// An artist's key is artistCredits.artistNameKey on the server (letters and digits, maybe not Latin).
export function artistPath(key: string): string {
  return `/artist/${encodeURIComponent(key)}`;
}

function decodeSegment(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

// pathname + search -> { view, lobbyId, library } (+ artistKey on the artist
// view). library is null when the library overlay is closed, else its state
// ({ tab, query, sort, page, requestStatus }).
export function parseRoute(pathname: string, search = ''): Route {
  const params = new URLSearchParams(search);
  let view: View = 'landing';
  let lobbyId: string | null = null;
  let withLibrary = false;

  const lobbyMatch = LOBBY_RE.exec(pathname);
  if (lobbyMatch) {
    view = 'lobby';
    lobbyId = lobbyMatch[1];
    withLibrary = !!lobbyMatch[2];
  } else if (/^\/library\/?$/.test(pathname)) {
    withLibrary = true;
  } else if (/^\/radio\/?$/.test(pathname)) {
    view = 'radio';
  } else if (/^\/artists\/?$/.test(pathname)) {
    view = 'artists';
  } else if (ARTIST_RE.test(pathname)) {
    const key = decodeSegment((ARTIST_RE.exec(pathname) as RegExpExecArray)[1]);
    if (key) return { view: 'artist', lobbyId: null, library: null, artistKey: key };
  } else if (/^\/search\/?$/.test(pathname)) {
    return { view: 'search', lobbyId: null, library: null, searchQuery: searchQueryOf(params.get('q')) };
  } else if (/^\/app\/?$/.test(pathname)) {
    view = 'app';
  } else if (/^\/profile\/?$/.test(pathname)) {
    view = 'profile';
  } else if (/^\/social\/?$/.test(pathname)) {
    view = 'social';
  } else if (/^\/dashboard\/?$/.test(pathname)) {
    view = 'dashboard';
  }

  return { view, lobbyId, library: withLibrary ? parseLibraryParams(params) : null };
}

// The search text as the URL carries it: whitespace collapsed, at most
// SEARCH_MAX characters (the server's bound for a library search).
export const SEARCH_MAX = 200;
export function searchQueryOf(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX);
}

// /search, with ?q= unless the text is empty.
export function searchPath(query = ''): string {
  const q = searchQueryOf(query);
  return q ? `/search?${new URLSearchParams({ q })}` : '/search';
}

function parseLibraryParams(params: URLSearchParams): LibraryState {
  const tab = params.get('tab');
  const sort = params.get('sort');
  const status = params.get('status');
  const page = parseInt(params.get('page') ?? '', 10);
  return {
    tab: oneOf(LIBRARY_TABS, tab) ? tab : LIBRARY_DEFAULTS.tab,
    query: (params.get('q') || '').trim(),
    sort: oneOf(LIBRARY_SORTS, sort) ? sort : LIBRARY_DEFAULTS.sort,
    page: Number.isFinite(page) && page > 1 ? page - 1 : 0,
    requestStatus: oneOf(REQUEST_STATUSES, status) ? status : LIBRARY_DEFAULTS.requestStatus,
  };
}

// The path for a view without the library overlay.
export function basePath({ view, lobbyId, artistKey }: { view: string; lobbyId?: string | null; artistKey?: string | null }): string {
  if (view === 'lobby' && lobbyId) return playlistPath(lobbyId);
  if (view === 'radio') return '/radio';
  if (view === 'artists') return '/artists';
  if (view === 'artist' && artistKey) return artistPath(artistKey);
  if (view === 'search') return '/search';
  if (view === 'app') return '/app';
  if (view === 'profile') return '/profile';
  if (view === 'social') return '/social';
  if (view === 'dashboard') return '/dashboard';
  return '/';
}

// The library URL for the given state; inside a playlist it stays under it.
export function libraryPath(lobbyId: string | null | undefined, lib: Partial<LibraryState> = {}): string {
  const s: LibraryState = { ...LIBRARY_DEFAULTS, ...lib };
  const params = new URLSearchParams();
  if (s.tab !== LIBRARY_DEFAULTS.tab) params.set('tab', s.tab);
  if (s.requestStatus !== LIBRARY_DEFAULTS.requestStatus) params.set('status', s.requestStatus);
  if (s.query) params.set('q', s.query);
  if (s.sort !== LIBRARY_DEFAULTS.sort) params.set('sort', s.sort);
  if (s.page > 0) params.set('page', String(s.page + 1));
  const qs = params.toString();
  return `${lobbyId ? `${playlistPath(lobbyId)}/library` : '/library'}${qs ? `?${qs}` : ''}`;
}
