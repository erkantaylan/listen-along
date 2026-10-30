'use strict';

const { CliError, EXIT } = require('./errors');
const { isFatal } = require('./pipeline');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function label(p) {
  return p.name ? `"${p.name}" (${p.id})` : p.id;
}

/**
 * Find a playlist the token can see by id or by name: an exact id match wins,
 * else an exact case-insensitive name match. No match -> PLAYLIST_NOT_FOUND
 * (or null with allowMissing); several -> AMBIGUOUS listing the ids. Both exit 1.
 * @returns {Promise<object|null>} the playlist (as GET /api/playlists lists it)
 */
async function resolvePlaylist(api, ref, { allowMissing = false } = {}) {
  const wanted = String(ref || '').trim();
  const all = await api.playlists();
  const byId = all.find((p) => p.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const named = all.filter((p) => p.name && p.name.trim().toLowerCase() === lower);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new CliError(`Playlist name "${wanted}" is ambiguous: ${named.map((p) => `${p.id} (${p.visibility}${p.ownerName ? `, ${p.ownerName}` : ''})`).join(', ')}`, {
      exitCode: EXIT.FAILURE, code: 'AMBIGUOUS', hint: 'Use the playlist id instead of its name',
    });
  }
  if (allowMissing) return null;
  throw new CliError(`No playlist "${wanted}" (by id or name) among the playlists you can see`, {
    exitCode: EXIT.FAILURE, code: 'PLAYLIST_NOT_FOUND', hint: 'List them with `la playlist list`',
  });
}

/** Options shared by `la download` and `la upload`. */
const PLAYLIST_OPTIONS = {
  playlist: { type: 'string', value: 'ID|NAME', desc: 'Add every uploaded or already-present (skipped) song to this playlist' },
  'create-playlist': { type: 'boolean', desc: 'Create the --playlist (by name) if it does not exist (public unless --private)' },
  private: { type: 'boolean', desc: 'With --create-playlist: create it private (default: public, like the web app)' },
};

/**
 * Resolve (or create) the --playlist target before a batch starts.
 * @returns {Promise<object|null>} state reported as the JSON "playlist" key, or null without --playlist
 */
async function preparePlaylistTarget(ctx, values, { dryRun = false } = {}) {
  const { UsageError } = require('./errors');
  if (values.playlist === undefined) {
    if (values['create-playlist'] || values.private) throw new UsageError('--create-playlist / --private need --playlist <name>');
    return null;
  }
  if (!String(values.playlist).trim()) throw new UsageError('--playlist needs a playlist id or name');
  if (values.private && !values['create-playlist']) throw new UsageError('--private only applies with --create-playlist');
  const api = ctx.getApi();
  let p = await resolvePlaylist(api, values.playlist, { allowMissing: !!values['create-playlist'] });
  let created = false;
  if (!p) {
    const visibility = values.private ? 'private' : 'public';
    if (dryRun) {
      ctx.out.info(`Would create ${visibility} playlist "${values.playlist}"`);
      return { id: null, name: String(values.playlist).trim(), visibility, created: false, would_create: true, added: 0, already_in_playlist: 0, failed: 0 };
    }
    p = await api.createPlaylist({ name: String(values.playlist).trim(), visibility });
    created = true;
    ctx.out.info(`Created ${p.visibility} playlist ${label(p)}`);
  }
  return { id: p.id, name: p.name, visibility: p.visibility, created, added: 0, already_in_playlist: 0, failed: 0 };
}

/**
 * Hook a batch so every uploaded or skipped song is added to the playlist
 * (one request per song, in order, while the batch keeps going). Adds a
 * `playlist_status` (added | already_in_playlist | failed) and, on failure,
 * `playlist_error` to each such result, and counts into `target`.
 */
function attachPlaylist(batch, api, target, out) {
  if (!target || !target.id) return;
  let chain = Promise.resolve();
  batch.onAdd = (result) => {
    if (result.status !== 'uploaded' && result.status !== 'skipped') return null;
    chain = chain.then(async () => {
      const ref = (result.song && result.song.id) || (result.youtube_id ? `yt:${result.youtube_id}` : null);
      const fail = (msg) => {
        result.playlist_status = 'failed';
        result.playlist_error = msg;
        target.failed++;
        out.warn(`${result.label || result.input || result.file}: not added to playlist: ${msg}`);
      };
      if (!ref) return fail('no library id or youtube_id for this song');
      try {
        const res = await api.addPlaylistSongs(target.id, [String(ref)]);
        const r = (res && res.results && res.results[0]) || {};
        if (r.status === 'added' || r.status === 'already_in_playlist') {
          result.playlist_status = r.status;
          target[r.status]++;
          out.debug(`  playlist: ${r.status}`);
        } else {
          fail(r.error || r.status || 'unexpected server answer');
        }
      } catch (err) {
        fail(err.message);
        if (isFatal(err)) out.debug('  (auth/network problem while adding to the playlist)');
      }
    });
    return chain;
  };
}

/** One line for the human summary. */
function playlistSummaryLine(t) {
  if (!t) return null;
  if (t.would_create) return `Playlist "${t.name}": would be created (${t.visibility}); nothing added (dry run)`;
  const name = t.name ? `"${t.name}"` : t.id;
  return `Playlist ${name}${t.created ? ' (created)' : ''}: ${t.added} added, ${t.already_in_playlist} already there${t.failed ? `, ${t.failed} failed` : ''}`;
}

module.exports = { resolvePlaylist, preparePlaylistTarget, attachPlaylist, playlistSummaryLine, PLAYLIST_OPTIONS, UUID_RE, label };
