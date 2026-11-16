// Folder actions: the New folder / Rename / Delete dialogs (the usual dialog,
// playlist-actions.ts openDialog), a folder's ⋮ menu, and a playlist's
// "Move to folder ▸" submenu (context-menu.ts, like "Add to playlist ▸").
// Every change goes through folder-store.ts; the server checks everything again.
import { escapeHtml, showToast, t } from '../../shared/ui.ts';
import { refreshSubmenu } from '../../shared/context-menu.ts';
import type { MenuItem } from '../../shared/context-menu.ts';
import { openDialog } from './playlist-actions.ts';
import type { ReturnFocus } from './playlist-actions.ts';
import { createFolder, deleteFolder, folderOfPlaylist, getFolders, loadFolders, moveToFolder, onFolders, removeFromFolder, renameFolder } from './folder-store.ts';
import type { FolderApiError } from './folder-store.ts';
import { folderNameError, moveTargets } from './folder-tree.ts';
import type { PlaylistFolder } from '../../shared/types.ts';

const MAX_NAME = 50;

export const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
export const FOLDER_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>';
export const NEW_FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>';
const MOVE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12v-3h-4v-4h4V8l5 5-5 5z"/></svg>';
const OUT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-8 4 4 4h-3v4h-2v-4H8l4-4z"/></svg>';
const PEN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number>): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

// A submenu open on screen follows the folders as they load.
onFolders(() => refreshSubmenu());

/** "3 playlists", "1 playlist", "Empty". */
export function folderCountText(n: number): string {
  if (!n) return t('folders.empty', 'Empty');
  return n === 1 ? t('folders.onePlaylist', '1 playlist') : tf('folders.playlists', '{count} playlists', { count: n });
}

function nameError(code: ReturnType<typeof folderNameError>): string {
  if (code === 'required') return t('folders.nameRequired', 'Give the folder a name.');
  if (code === 'tooLong') return tf('folders.nameTooLong', 'At most {max} characters.', { max: MAX_NAME });
  return t('folders.nameInvalid', 'No line breaks or control characters.');
}

// The name dialog for New folder and Rename.
function nameDialog({ id, title, value, submitLabel, busyLabel, returnFocus, save }: {
  id: string; title: string; value: string; submitLabel: string; busyLabel: string; returnFocus?: ReturnFocus;
  save: (name: string) => Promise<void>;
}): void {
  const ctl = openDialog({
    id,
    title,
    body: `<div><label for="${id}-name" class="form-label fw-medium">${escapeHtml(t('folders.name', 'Folder name'))}</label>
      <input type="text" id="${id}-name" class="form-control" maxlength="${MAX_NAME}" required autocomplete="off" spellcheck="false" value="${escapeHtml(value)}" aria-describedby="${id}-error">
      <div id="${id}-error" class="fs-sm mt-1 new-playlist-field-error" aria-live="polite"></div></div>`,
    submitLabel,
    busyLabel,
    submitClass: 'btn-solid theme-primary',
    returnFocus,
    focus: `#${id}-name`,
    onSubmit: async (c) => {
      const input = c.d.querySelector(`#${id}-name`) as HTMLInputElement;
      const fieldErr = c.d.querySelector(`#${id}-error`) as HTMLElement;
      const fail = (msg: string) => { fieldErr.textContent = msg; input.classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); };
      const code = folderNameError(input.value, MAX_NAME);
      if (code) return fail(nameError(code));
      c.busy(true);
      try {
        await save(input.value.trim());
        c.close();
      } catch (e) {
        const err = e as FolderApiError;
        c.busy(false);
        if (err.code === 'FOLDER_LIMIT') c.error(t('folders.limit', 'You have 100 folders, the most there can be. Delete one to make room.'));
        else if (err.code === 'NOT_FOUND') c.error(t('playlist.notFound', 'Playlist not found'));
        else if (err.status === 400) fail(err.message);
        else c.error(err.message || t('error.generic', 'Something went wrong'));
      }
    },
  });
  (ctl.d.querySelector(`#${id}-name`) as HTMLInputElement).select();
}

/**
 * New folder. With a playlist (its menu's "New folder…"), the playlist goes in
 * at once. onCreated: the new folder (the sidebar brings it into view).
 */
export function openNewFolderDialog({ playlistId = null, returnFocus = null, onCreated }: { playlistId?: string | null; returnFocus?: ReturnFocus; onCreated?: (f: PlaylistFolder) => void } = {}): void {
  nameDialog({
    id: 'new-folder-dialog',
    title: t('folders.newTitle', 'New folder'),
    value: '',
    submitLabel: playlistId ? t('folders.createAndMove', 'Create and move') : t('folders.create', 'Create folder'),
    busyLabel: t('folders.creating', 'Creating…'),
    returnFocus,
    save: async (name) => {
      const folder = await createFolder(name, playlistId);
      showToast(playlistId ? tf('folders.moved', 'Moved to “{name}”', { name: folder.name }) : tf('folders.created', 'Folder “{name}” created', { name: folder.name }), 'success');
      if (onCreated) onCreated(folder);
    },
  });
}

export function openRenameFolderDialog(folder: PlaylistFolder, returnFocus: ReturnFocus = null): void {
  nameDialog({
    id: 'rename-folder-dialog',
    title: t('folders.renameTitle', 'Rename folder'),
    value: folder.name,
    submitLabel: t('playlistMenu.save', 'Save'),
    busyLabel: t('playlistMenu.saving', 'Saving…'),
    returnFocus,
    // Applied at once; a refusal puts the old name back with a toast.
    save: async (name) => { if (name !== folder.name) renameFolder(folder.id, name); },
  });
}

export function openDeleteFolderDialog(folder: PlaylistFolder, returnFocus: ReturnFocus = null): void {
  const n = folder.playlistIds.length;
  openDialog({
    id: 'delete-folder-dialog',
    title: t('folders.deleteTitle', 'Delete folder'),
    body: `<p class="mb-0">${escapeHtml(n
      ? tf('folders.confirmDelete', 'Delete “{name}”? Its {count} playlists go back to the list. No playlist is deleted.', { name: folder.name, count: n })
      : tf('folders.confirmDeleteEmpty', 'Delete the empty folder “{name}”?', { name: folder.name }))}</p>`,
    submitLabel: t('playlistMenu.delete', 'Delete'),
    busyLabel: t('playlistMenu.deleting', 'Deleting…'),
    submitClass: 'btn-solid theme-danger',
    returnFocus,
    focus: '.card-footer .btn',
    onSubmit: (c) => {
      c.close({ restore: false });
      deleteFolder(folder.id).then((ok) => { if (ok) showToast(t('folders.deleted', 'Folder deleted'), 'success'); });
    },
  });
}

/** A folder row's ⋮ / right-click menu. */
export function folderMenuItems(folder: PlaylistFolder, returnFocus: ReturnFocus = null): MenuItem[] {
  return [
    { label: t('folders.rename', 'Rename'), icon: PEN_SVG, onSelect: () => openRenameFolderDialog(folder, returnFocus) },
    { divider: true },
    { label: t('folders.delete', 'Delete folder'), icon: TRASH_SVG, theme: 'danger', onSelect: () => openDeleteFolderDialog(folder, returnFocus) },
  ];
}

/** A playlist menu's "Move to folder ▸": the user's folders (the current one checked), New folder…, Remove from folder. */
export function moveToFolderItem(playlistId: string, { returnFocus = null, onCreated }: { returnFocus?: ReturnFocus; onCreated?: (f: PlaylistFolder) => void } = {}): MenuItem {
  const label = t('folders.moveTo', 'Move to folder');
  const current = folderOfPlaylist(playlistId);
  const footer: MenuItem[] = [{
    label: t('folders.newEllipsis', 'New folder…'),
    icon: NEW_FOLDER_SVG,
    onSelect: () => openNewFolderDialog({ playlistId, returnFocus, onCreated }),
  }];
  if (current) footer.push({ label: tf('folders.removeFrom', 'Remove from “{name}”', { name: current.name }), icon: OUT_SVG, onSelect: () => { removeFromFolder(playlistId); } });
  return {
    label,
    icon: MOVE_SVG,
    submenu: {
      label,
      backLabel: t('addTo.back', 'Back'),
      // A search box only once there are enough folders to need one.
      searchLabel: getFolders().length > 7 ? t('folders.search', 'Search folders') : undefined,
      emptyText: t('folders.none', 'No folders yet'),
      onOpen: () => { loadFolders(); },
      items: (query) => moveTargets(getFolders(), playlistId, query).map(({ folder, current: here }) => ({
        label: folder.name,
        checked: here,
        onSelect: () => { if (!here) moveToFolder(playlistId, folder.id); },
      })),
      footer,
    },
  };
}
