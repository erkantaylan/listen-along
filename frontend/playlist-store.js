// The playlists this user can see, as GET /api/playlists says, and their own
// pins. One copy for the sidebar, the landing rows and the playlist page's pin
// button. It stays fresh from the playlists:changed socket signal (app.js),
// queue updates and a slow poll for song counts changed elsewhere.
import { showToast, t } from './ui.js';

let playlists = [];
let loaded = false;
const listeners = new Set();
let reloadTimer = null;
let loadSeq = 0;
let writes = 0; // pin requests in flight: a list fetched meanwhile may predate them

const emit = () => listeners.forEach(fn => fn(playlists));

export const getPlaylists = () => playlists;
export const isLoaded = () => loaded;
export const getPlaylist = (id) => playlists.find(p => p.id === id) || null;
export const isPinned = (id) => !!getPlaylist(id)?.pinnedByMe;

export function onPlaylists(fn) {
  listeners.add(fn);
}

export async function loadPlaylists() {
  const seq = ++loadSeq;
  try {
    const res = await fetch('/api/playlists', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (seq !== loadSeq || writes > 0) return; // a newer load, or a pin settling, wins
    playlists = data.playlists || [];
    loaded = true;
    emit();
  } catch {
    // Offline: keep the last list; the reconnect reloads.
  }
}

// Bursts of signals (a queue being reordered) become one request.
export function scheduleReload(delay = 400) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadPlaylists, delay);
}

export async function togglePlaylistPin(id, { toast = false } = {}) {
  const pl = getPlaylist(id);
  if (!pl) return;
  const next = !pl.pinnedByMe;
  const undo = { pinnedByMe: pl.pinnedByMe, pinnedAt: pl.pinnedAt };
  const patch = (fields) => { playlists = playlists.map(p => p.id === id ? { ...p, ...fields } : p); emit(); };
  patch({ pinnedByMe: next, pinnedAt: next ? Date.now() : null });
  writes++;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(id)}/pin`, { method: next ? 'PUT' : 'DELETE', credentials: 'same-origin' });
    if (res.status === 404) showToast(t('lobby.notFound', 'Playlist not found'), 'error');
    else if (!res.ok) throw new Error(String(res.status));
    else if (toast) showToast(next ? t('sidebar.pinnedToast', 'Pinned') : t('sidebar.unpinnedToast', 'Unpinned'), 'success');
  } catch {
    patch(undo);
    showToast(t('sidebar.pinError', 'Could not update the pin'), 'error');
  } finally {
    writes--;
    scheduleReload(0);
  }
}
