// URL <-> view mapping for the single-page app. Pure functions only (no DOM),
// so they can be unit tested in Node (backend/src/router.test.js).
//
//   /                          landing (playlist list)
//   /playlist/<id>             playlist (internally the view is still "lobby")
//   /library                   music library (no playlist; Add is disabled)
//   /playlist/<id>/library     music library over a playlist (Add targets it)
//   /profile                   own profile
//   /social                    chat + people (full-screen on phones; on
//                              desktop the sidebar, over the landing page)
//   /dashboard                 admin dashboard
//
// Old /lobby/<id>[/library] URLs map to /playlist/... (legacyRedirect; the
// server answers them with a 301 too).
//
// Library query params (defaults are left out of the URL):
//   tab=requests|downloads|broken ("Needs replacement": reported songs), status=fulfilled|dismissed|all (requests filter),
//   q=<search>, sort=title|artist, page=<n> (1-based)

export const LIBRARY_TABS = ['library', 'requests', 'downloads', 'broken'];
export const LIBRARY_SORTS = ['recent', 'title', 'artist'];
export const REQUEST_STATUSES = ['pending', 'fulfilled', 'dismissed', 'all'];

export const LIBRARY_DEFAULTS = Object.freeze({ tab: 'library', query: '', sort: 'recent', page: 0, requestStatus: 'pending' });

const LOBBY_RE = /^\/playlist\/([a-zA-Z0-9-]+)(\/library)?\/?$/;
const LEGACY_LOBBY_RE = /^\/lobby\/([a-zA-Z0-9-]+)(\/library)?\/?$/;

// The /playlist/... path for an old /lobby/... path (search kept), else null.
export function legacyRedirect(pathname, search = '') {
  const m = LEGACY_LOBBY_RE.exec(pathname);
  if (!m) return null;
  return `/playlist/${m[1]}${m[2] ? '/library' : ''}${search || ''}`;
}

export function playlistPath(lobbyId) {
  return `/playlist/${lobbyId}`;
}

// pathname + search -> { view, lobbyId, library }. library is null when the
// library overlay is closed, else its state ({ tab, query, sort, page, requestStatus }).
export function parseRoute(pathname, search = '') {
  const params = new URLSearchParams(search);
  let view = 'landing';
  let lobbyId = null;
  let withLibrary = false;

  const lobbyMatch = LOBBY_RE.exec(pathname);
  if (lobbyMatch) {
    view = 'lobby';
    lobbyId = lobbyMatch[1];
    withLibrary = !!lobbyMatch[2];
  } else if (/^\/library\/?$/.test(pathname)) {
    withLibrary = true;
  } else if (/^\/profile\/?$/.test(pathname)) {
    view = 'profile';
  } else if (/^\/social\/?$/.test(pathname)) {
    view = 'social';
  } else if (/^\/dashboard\/?$/.test(pathname)) {
    view = 'dashboard';
  }

  return { view, lobbyId, library: withLibrary ? parseLibraryParams(params) : null };
}

function parseLibraryParams(params) {
  const tab = params.get('tab');
  const sort = params.get('sort');
  const status = params.get('status');
  const page = parseInt(params.get('page'), 10);
  return {
    tab: LIBRARY_TABS.includes(tab) ? tab : LIBRARY_DEFAULTS.tab,
    query: (params.get('q') || '').trim(),
    sort: LIBRARY_SORTS.includes(sort) ? sort : LIBRARY_DEFAULTS.sort,
    page: Number.isFinite(page) && page > 1 ? page - 1 : 0,
    requestStatus: REQUEST_STATUSES.includes(status) ? status : LIBRARY_DEFAULTS.requestStatus,
  };
}

// The path for a view without the library overlay.
export function basePath({ view, lobbyId }) {
  if (view === 'lobby' && lobbyId) return playlistPath(lobbyId);
  if (view === 'profile') return '/profile';
  if (view === 'social') return '/social';
  if (view === 'dashboard') return '/dashboard';
  return '/';
}

// The library URL for the given state; inside a playlist it stays under it.
export function libraryPath(lobbyId, lib = {}) {
  const s = { ...LIBRARY_DEFAULTS, ...lib };
  const params = new URLSearchParams();
  if (s.tab !== LIBRARY_DEFAULTS.tab) params.set('tab', s.tab);
  if (s.requestStatus !== LIBRARY_DEFAULTS.requestStatus) params.set('status', s.requestStatus);
  if (s.query) params.set('q', s.query);
  if (s.sort !== LIBRARY_DEFAULTS.sort) params.set('sort', s.sort);
  if (s.page > 0) params.set('page', String(s.page + 1));
  const qs = params.toString();
  return `${lobbyId ? `${playlistPath(lobbyId)}/library` : '/library'}${qs ? `?${qs}` : ''}`;
}
