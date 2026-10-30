// Playlist actions shared by the landing rows and the playlist page header:
// the ⋮ menu items (context-menu.js) and the Rename / Delete dialogs
// (.app-modal, DESIGN.md "Modal dialogs"). Owner-only actions (Rename, Make
// private / public, Delete) only appear for the owner (`canManage`); the
// server enforces the same rule.
//
// pl = { id, name, visibility, canManage, songCount }
import { escapeHtml, showToast, t, trapFocus, copyToClipboard } from './ui.js';
import { playlistPath } from './router.js';

const MAX_NAME = 50;
const CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
export const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
export const GLOBE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
const PEN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

/** The current visibility as a badge: "Private" (lock) only; public shows nothing. */
export function privateBadgeHtml(extraClass = '') {
  return `<span class="badge badge-subtle theme-secondary playlist-private-badge ${extraClass}">${LOCK_SVG.replace('<svg ', '<svg class="icon-sm" ')}${escapeHtml(t('landing.private', 'Private'))}</span>`;
}

const api = (id, init) => fetch(`/api/playlists/${encodeURIComponent(id)}`, { credentials: 'same-origin', ...init })
  .then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(body.error || 'Request failed'); err.status = res.status; throw err; }
    return body;
  });

export function setPlaylistVisibility(id, visibility) {
  return api(id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }) })
    .catch(() => { showToast(t('lobbyVisibilityError', 'Failed to update visibility'), 'error'); return null; });
}

/**
 * ⋮ menu items for a playlist.
 * hooks: { onPlay?, onChanged(info), onDeleted(), returnFocus }
 */
export function playlistMenuItems(pl, hooks = {}) {
  const items = [];
  if (hooks.onPlay && pl.songCount > 0) items.push({ label: t('playlistMenu.play', 'Play'), icon: PLAY_SVG, onSelect: hooks.onPlay });
  items.push({
    label: t('playlistMenu.copyLink', 'Copy link'), icon: LINK_SVG,
    onSelect: () => copyToClipboard(`${window.location.origin}${playlistPath(pl.id)}`),
  });
  if (pl.canManage) {
    const priv = pl.visibility === 'private';
    items.push({ divider: true });
    items.push({ label: t('lobby.renamePlaylist', 'Rename'), icon: PEN_SVG, onSelect: () => openRenameDialog(pl, hooks) });
    items.push({
      label: priv ? t('lobby.makePublic', 'Make public') : t('lobby.makePrivate', 'Make private'),
      description: priv ? t('playlistMenu.publicHint', 'Every signed-in user can see and edit it.') : t('playlistMenu.privateHint', 'Only you can see it.'),
      icon: priv ? GLOBE_SVG : LOCK_SVG,
      onSelect: () => setPlaylistVisibility(pl.id, priv ? 'public' : 'private').then((info) => {
        if (!info) return;
        showToast(priv ? t('toast.nowPublic', 'Playlist is now public.') : t('toast.nowPrivate', 'Playlist is now private. Only you can see it.'), 'success');
        if (hooks.onChanged) hooks.onChanged(info);
      }),
    });
    items.push({ label: t('lobby.deletePlaylist', 'Delete playlist'), icon: TRASH_SVG, theme: 'danger', onSelect: () => openDeleteDialog(pl, hooks) });
  }
  return items;
}

// ------------------------------------------------------------- dialogs

function openDialog({ id, title, body, submitLabel, submitClass, busyLabel, returnFocus, onSubmit, focus }) {
  document.getElementById(id)?.remove();
  const d = document.createElement('div');
  d.id = id;
  d.className = 'app-modal';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('aria-labelledby', `${id}-title`);
  const back = returnFocus || document.activeElement;
  d.innerHTML = `<form class="card app-modal-card" novalidate>
    <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
      <h2 id="${id}-title" class="h6 mb-0">${escapeHtml(title)}</h2>
      <button class="btn-text theme-secondary btn-icon btn-sm" type="button" data-dialog-close aria-label="${escapeHtml(t('landing.cancel', 'Cancel'))}" title="${escapeHtml(t('landing.cancel', 'Cancel'))}">${CLOSE_SVG}</button>
    </div>
    <div class="card-body vstack gap-5">${body}<div class="alert theme-danger fs-sm mb-0" data-dialog-error role="alert" hidden></div></div>
    <div class="card-footer d-flex justify-content-end gap-2">
      <button class="btn" type="button" data-dialog-close>${escapeHtml(t('landing.cancel', 'Cancel'))}</button>
      <button class="${submitClass}" type="submit" data-dialog-submit>${escapeHtml(submitLabel)}</button>
    </div>
  </form>`;
  document.body.appendChild(d);
  const close = ({ restore = true } = {}) => {
    d.remove();
    const target = typeof back === 'function' ? back() : back;
    if (restore && target && document.contains(target)) target.focus({ preventScroll: true });
  };
  const form = d.querySelector('form');
  const submit = d.querySelector('[data-dialog-submit]');
  const errEl = d.querySelector('[data-dialog-error]');
  const ctl = {
    d, close,
    error(msg) { errEl.textContent = msg || ''; errEl.hidden = !msg; },
    busy(on) { submit.disabled = on; submit.textContent = on ? busyLabel : submitLabel; form.setAttribute('aria-busy', String(on)); },
  };
  d.querySelectorAll('[data-dialog-close]').forEach(b => b.addEventListener('click', () => close()));
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    trapFocus(d, e);
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); if (!submit.disabled) onSubmit(ctl); });
  (focus ? d.querySelector(focus) : submit).focus();
  return ctl;
}

export function openRenameDialog(pl, hooks = {}) {
  const ctl = openDialog({
    id: 'rename-playlist-dialog',
    title: t('lobby.renamePlaylist', 'Rename playlist'),
    body: `<div><label for="rename-playlist-name" class="form-label fw-medium">${escapeHtml(t('landing.playlistName', 'Playlist name'))}</label>
      <input type="text" id="rename-playlist-name" class="form-control" maxlength="${MAX_NAME}" required autocomplete="off" value="${escapeHtml(pl.name || '')}" aria-describedby="rename-playlist-error">
      <div id="rename-playlist-error" class="fs-sm mt-1 new-playlist-field-error" aria-live="polite"></div></div>`,
    submitLabel: t('playlistMenu.save', 'Save'),
    busyLabel: t('playlistMenu.saving', 'Saving…'),
    submitClass: 'btn-solid theme-primary',
    returnFocus: hooks.returnFocus,
    focus: '#rename-playlist-name',
    onSubmit: async (c) => {
      const input = c.d.querySelector('#rename-playlist-name');
      const fieldErr = c.d.querySelector('#rename-playlist-error');
      const fail = (msg) => { fieldErr.textContent = msg; input.classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); };
      const name = input.value.trim();
      if (!name) return fail(t('landing.nameRequired', 'Give the playlist a name.'));
      if (name === pl.name) return c.close();
      c.busy(true);
      try {
        const info = await api(pl.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        c.close();
        if (hooks.onChanged) hooks.onChanged(info);
      } catch (err) {
        c.busy(false);
        if (err.status === 400 || err.status === 409) fail(err.message);
        else c.error(err.message || t('error.generic', 'Something went wrong'));
      }
    },
  });
  ctl.d.querySelector('#rename-playlist-name').select();
}

export function openDeleteDialog(pl, hooks = {}) {
  const name = pl.name || pl.id;
  openDialog({
    id: 'delete-playlist-dialog',
    title: t('lobby.deletePlaylist', 'Delete playlist'),
    body: `<p class="mb-0">${escapeHtml(t('playlistMenu.confirmDelete', `Delete “${name}”? It is removed for everyone, permanently.`, { name }))}</p>`,
    submitLabel: t('playlistMenu.delete', 'Delete'),
    busyLabel: t('playlistMenu.deleting', 'Deleting…'),
    submitClass: 'btn-solid theme-danger',
    returnFocus: hooks.returnFocus,
    // Focus the safe choice first.
    focus: '.card-footer .btn',
    onSubmit: async (c) => {
      c.busy(true);
      try {
        await api(pl.id, { method: 'DELETE' });
        c.close({ restore: false });
        showToast(t('toast.playlistDeleted', 'Playlist deleted'), 'success');
        if (hooks.onDeleted) hooks.onDeleted();
      } catch (err) {
        c.busy(false);
        c.error(err.message || t('lobbyDeleteError', 'Failed to delete playlist'));
      }
    },
  });
}
