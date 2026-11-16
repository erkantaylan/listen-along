// The user's own playlist folders (GET /api/playlist-folders): one copy for the
// sidebar and the playlist menus. Changes apply here at once and go to the
// server; a refusal puts them back and says so. It stays fresh from the
// playlists:changed socket signal (app.ts; the server sends it to the user's own
// sockets after every folder change, so other tabs follow), a reconnect and the
// sidebar's slow poll. The server decides what is listed: only playlists the
// user can see now.
import { showToast, t } from '../../shared/ui.ts';
import type { PlaylistFolder, PlaylistFolderList } from '../../shared/types.ts';

export type FoldersListener = (folders: PlaylistFolder[]) => void;

/** A refused request: the server's `error` and `code`, and the HTTP status. */
export type FolderApiError = Error & { status?: number; code?: string };

let folders: PlaylistFolder[] = [];
let loaded = false;
const listeners = new Set<FoldersListener>();
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let loadSeq = 0;
let writes = 0; // requests in flight: a list fetched meanwhile may predate them

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const emit = () => listeners.forEach((fn) => fn(folders));

export const getFolders = (): PlaylistFolder[] => folders;
export const foldersLoaded = (): boolean => loaded;
export const getFolder = (id: string): PlaylistFolder | null => folders.find((f) => f.id === id) || null;
/** The folder a playlist is filed in (for this user), or null. */
export const folderOfPlaylist = (playlistId: string): PlaylistFolder | null => folders.find((f) => f.playlistIds.includes(playlistId)) || null;

export function onFolders(fn: FoldersListener): void {
  listeners.add(fn);
}

export async function loadFolders(): Promise<void> {
  const seq = ++loadSeq;
  try {
    const res = await fetch('/api/playlist-folders', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json() as PlaylistFolderList;
    if (seq !== loadSeq || writes > 0) return; // a newer load, or a change settling, wins
    folders = Array.isArray(data.folders) ? data.folders : [];
    loaded = true;
    emit();
  } catch {
    // Offline: keep the last list; the reconnect reloads.
  }
}

/** Bursts of signals become one request. */
export function scheduleFolderReload(delay = 400): void {
  clearTimeout(reloadTimer ?? undefined);
  reloadTimer = setTimeout(loadFolders, delay);
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!res.ok) {
    const err: FolderApiError = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

const base = '/api/playlist-folders';
const folderUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;

function set(next: PlaylistFolder[]): void {
  folders = next;
  emit();
}

// Run a change: apply it here, send it, put it back when refused. The toast for
// a refusal names what went wrong; a 404 (the folder or the playlist is gone
// or no longer visible) reloads.
async function change(apply: () => void, undo: () => void, send: () => Promise<unknown>, failText: string): Promise<boolean> {
  apply();
  writes++;
  try {
    await send();
    return true;
  } catch (e) {
    const err = e as FolderApiError;
    undo();
    if (err.status === 404) showToast(err.code === 'NOT_FOUND' ? t('playlist.notFound', 'Playlist not found') : t('folders.notFound', 'That folder is gone'), 'error');
    else showToast(failText, 'error');
    return false;
  } finally {
    writes--;
    scheduleFolderReload(0);
  }
}

/** Create a folder (optionally with a playlist in it). Throws the server's refusal (the dialog shows it). */
export async function createFolder(name: string, playlistId: string | null = null): Promise<PlaylistFolder> {
  writes++;
  try {
    const { folder } = await api<{ folder: PlaylistFolder }>('POST', base, playlistId ? { name, playlistId } : { name });
    // Filed in the new folder: out of any other one here, as on the server.
    set([...folders.map((f) => ({ ...f, playlistIds: f.playlistIds.filter((id) => !folder.playlistIds.includes(id)) })), folder]);
    return folder;
  } finally {
    writes--;
    scheduleFolderReload(0);
  }
}

export function renameFolder(id: string, name: string): Promise<boolean> {
  const before = getFolder(id);
  if (!before) return Promise.resolve(false);
  const rename = (to: string) => set(folders.map((f) => (f.id === id ? { ...f, name: to } : f)));
  return change(() => rename(name), () => rename(before.name), () => api('PATCH', folderUrl(id), { name }), t('folders.renameFailed', 'Could not rename the folder'));
}

/** Delete a folder: its playlists go back to the top level (the server never deletes a playlist here). */
export function deleteFolder(id: string): Promise<boolean> {
  const at = folders.findIndex((f) => f.id === id);
  if (at < 0) return Promise.resolve(false);
  const before = folders[at];
  return change(
    () => set(folders.filter((f) => f.id !== id)),
    () => { if (!getFolder(id)) set([...folders.slice(0, at), before, ...folders.slice(at)]); },
    () => api('DELETE', folderUrl(id)),
    t('folders.deleteFailed', 'Could not delete the folder'),
  );
}

// Where a playlist is filed here: out of every folder, then (folderId) at the end of one.
function place(playlistId: string, folderId: string | null): void {
  set(folders.map((f) => {
    const without = f.playlistIds.filter((id) => id !== playlistId);
    return { ...f, playlistIds: f.id === folderId ? [...without, playlistId] : without };
  }));
}

/** File a playlist in a folder (out of any other). */
export async function moveToFolder(playlistId: string, folderId: string, { toast = true }: { toast?: boolean } = {}): Promise<boolean> {
  const target = getFolder(folderId);
  if (!target) return false;
  const from = folderOfPlaylist(playlistId);
  if (from && from.id === folderId) return true;
  const ok = await change(
    () => place(playlistId, folderId),
    () => place(playlistId, from ? from.id : null),
    () => api('PUT', `${folderUrl(folderId)}/playlists/${encodeURIComponent(playlistId)}`),
    tf('folders.moveFailed', 'Could not move it to “{name}”', { name: target.name }),
  );
  if (ok && toast) showToast(tf('folders.moved', 'Moved to “{name}”', { name: target.name }), 'success');
  return ok;
}

/** Take a playlist out of its folder, back to the top level. */
export async function removeFromFolder(playlistId: string, { toast = true }: { toast?: boolean } = {}): Promise<boolean> {
  const from = folderOfPlaylist(playlistId);
  if (!from) return true;
  const ok = await change(
    () => place(playlistId, null),
    () => place(playlistId, from.id),
    () => api('DELETE', `${folderUrl(from.id)}/playlists/${encodeURIComponent(playlistId)}`),
    tf('folders.removeFailed', 'Could not take it out of “{name}”', { name: from.name }),
  );
  if (ok && toast) showToast(tf('folders.removed', 'Removed from “{name}”', { name: from.name }), 'success');
  return ok;
}
