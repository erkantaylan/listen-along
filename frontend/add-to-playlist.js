// "Add to playlist" in the song menu (song-reports.js): a submenu of the
// playlists this user can edit (a sheet on phones, context-menu.js), with search,
// and "New playlist", which creates one and adds the song without leaving the page.
// The server decides: POST /api/playlists/:id/songs says added, already in it, or
// not in the library, and refuses what the user may not touch.
import { state } from './state.js';
import { showToast, t } from './ui.js';
import { player } from './player.js';
import { refreshSubmenu } from './context-menu.js';
import { getPlaylists, loadPlaylists, onPlaylists, scheduleReload } from './playlist-store.js';
import { groupPlaylists } from './playlist-filter.js';
import { openNewPlaylistDialog } from './new-playlist.js';

const ADD_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

const nameOf = (pl) => pl.name || `Playlist ${pl.id}`;

onPlaylists(() => refreshSubmenu());

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function matchesEntry(entry, song) {
  if (!entry || !entry.url) return false;
  if (entry.url === `library:${song.songId}` || (song.url && entry.url === song.url) || (song.sourceUrl && entry.url === song.sourceUrl)) return true;
  return !!song.youtubeId && entry.url.includes(song.youtubeId);
}

// Only the queues this page already holds are known; for any other playlist the
// server answers "already in it" when the song is added.
function knownToContain(playlistId, song) {
  const held = [];
  if (playlistId === state.lobbyId) held.push(state.queue);
  if (player.context && player.context.lobbyId === playlistId) held.push(player.queue);
  return held.some((queue) => (queue || []).some((entry) => matchesEntry(entry, song)));
}

async function addTo(playlist, song) {
  const name = nameOf(playlist);
  try {
    const { res, data } = await postJson(`/api/playlists/${encodeURIComponent(playlist.id)}/songs`, { songs: [song.songId] });
    if (res.status === 404) { showToast(t('lobby.notFound', 'Playlist not found'), 'error'); return; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const status = data.results && data.results[0] ? data.results[0].status : null;
    if (status === 'added') showToast(tf('addTo.added', 'Added to “{name}”', { name }), 'success');
    else if (status === 'already_in_playlist') showToast(tf('addTo.already', 'Already in “{name}”', { name }), 'info');
    else if (status === 'not_in_library') showToast(t('addTo.notInLibrary', 'This song is not in the library any more'), 'error');
    else throw new Error(status || 'unexpected answer');
  } catch (err) {
    showToast(tf('addTo.failed', 'Could not add to “{name}”: {error}', { name, error: err.message }), 'error');
  } finally {
    scheduleReload(0);
  }
}

async function createAndAdd({ name, visibility }, song) {
  let res;
  let data;
  try {
    ({ res, data } = await postJson('/api/playlists', { name, visibility }));
  } catch {
    throw new Error(t('error.generic', 'Something went wrong'));
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  await addTo(data, song);
}

function rows(playlists, song) {
  return playlists.map((pl) => {
    const owner = pl.isOwner ? t('landing.byYou', 'by you') : pl.ownerName ? tf('landing.byOwner', 'by {name}', { name: pl.ownerName }) : t('landing.noOwner', 'shared');
    const parts = [owner];
    if (pl.visibility === 'private') parts.push(t('landing.private', 'Private'));
    const has = knownToContain(pl.id, song);
    if (has) parts.push(t('addTo.alreadyMark', 'Already added'));
    return { label: nameOf(pl), description: parts.join(' · '), disabled: has, onSelect: () => addTo(pl, song) };
  });
}

function section(header, playlists, song) {
  return playlists.length ? [{ header }, ...rows(playlists, song)] : [];
}

/** The menu item. song: { songId, url?, youtubeId?, sourceUrl?, title }. No songId: disabled. */
export function addToPlaylistItem(song) {
  const label = t('addTo.label', 'Add to playlist');
  if (!song.songId) return { label, icon: ADD_ICON, description: t('addTo.notYet', 'Not in the library yet'), disabled: true };
  return {
    label,
    icon: ADD_ICON,
    submenu: {
      label,
      backLabel: t('addTo.back', 'Back'),
      searchLabel: t('sidebar.search', 'Search playlists'),
      emptyText: t('addTo.none', 'No playlists to add to'),
      onOpen: () => loadPlaylists(),
      items: (query) => {
        const g = groupPlaylists(getPlaylists().filter((p) => p.canEdit), query);
        return [
          ...section(t('sidebar.pinned', 'Pinned'), g.pinned, song),
          ...section(t('landing.yourPlaylists', 'Your playlists'), g.mine, song),
          ...section(t('landing.publicPlaylists', 'Public playlists'), g.others, song),
        ];
      },
      footer: [{
        label: t('landing.newPlaylist', 'New playlist'),
        icon: PLUS_ICON,
        onSelect: () => openNewPlaylistDialog(null, {
          submitLabel: t('addTo.createAndAdd', 'Create and add'),
          create: (fields) => createAndAdd(fields, song),
        }),
      }],
    },
  };
}
