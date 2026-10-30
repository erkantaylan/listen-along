'use strict';

const { UsageError, CliError, EXIT } = require('../errors');
const { table, formatDuration } = require('../output');
const { findVideoId } = require('../youtube');
const { resolvePlaylist, UUID_RE, label } = require('../playlists');

const PLAYLIST_REF = 'Playlists are named by id or by exact (case-insensitive) name among the ones you\ncan see; an ambiguous name fails with exit 1 listing the ids (use the id then).';

const PERMISSIONS = `Permissions are the web app's: a public playlist can be seen and edited (songs,
rename) by every user; a private one only by its owner — to anyone else it does
not exist. Only the owner changes visibility or deletes. A legacy token (made
before tokens had owners) sees public playlists only, creates only public
playlists (with no owner) and cannot change visibility or delete.`;

const ERRORS = 'Exit 1 for a missing/ambiguous playlist (PLAYLIST_NOT_FOUND, NOT_FOUND, AMBIGUOUS),\nnot being allowed (FORBIDDEN), a name clash (CONFLICT) or a bad value (BAD_REQUEST).';

function want(positionals, n, usage) {
  if (positionals.length < n) throw new UsageError('Missing argument', `Usage: ${usage}`);
}

function playlistRow(p) {
  return {
    id: p.id, name: p.name, visibility: p.visibility, owner: p.ownerName || (p.ownerId ? p.ownerId : null),
    is_owner: !!p.isOwner, song_count: p.songCount ?? null, created_at: p.createdAt ?? null,
  };
}

/** A song argument: library id (uuid), yt:<id> or a YouTube URL. null for anything else. */
function songRef(arg) {
  const s = String(arg).trim();
  if (UUID_RE.test(s)) return s;
  const m = /^yt:([A-Za-z0-9_-]{11})$/.exec(s);
  if (m) return `yt:${m[1]}`;
  if (/^https?:\/\//i.test(s)) {
    const id = findVideoId(s);
    if (id) return `yt:${id}`;
  }
  return null;
}

function printSongs(out, songs) {
  out.print(table(songs, [
    { title: '#', key: 'position' },
    { title: 'TITLE', key: 'title', max: 50 },
    { title: 'LENGTH', get: (s) => formatDuration(s.duration_sec) },
    { title: 'LIBRARY_ID', get: (s) => s.library_id || (s.available === false ? '(not in library)' : '') },
    { title: 'YOUTUBE_ID', key: 'youtube_id' },
    { title: 'ADDED_BY', key: 'added_by', max: 20 },
    { title: 'ENTRY', key: 'entry_id' },
  ]));
}

const list = {
  name: 'list',
  summary: 'List the playlists you can see (public ones + your private ones)',
  usage: 'la playlist [list]',
  description: `GET /api/playlists as the token's user.\n\n${PERMISSIONS}`,
  output: `Human: a table (ID, NAME, VISIBILITY, OWNER, SONGS).
--json: { "playlists": [ { "id", "name", "visibility", "owner", "is_owner", "song_count", "created_at" } ] }`,
  examples: ['la playlist', 'la playlist list --json'],
  async run(ctx, values, positionals) {
    if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`, 'Subcommands: list, create, rename, visibility, delete, show, add, remove, move');
    const playlists = (await ctx.getApi().playlists()).map(playlistRow);
    ctx.out.result({ playlists }, () => {
      if (!playlists.length) { ctx.out.print('No playlists.'); return; }
      ctx.out.print(table(playlists, [
        { title: 'ID', key: 'id' },
        { title: 'NAME', get: (p) => p.name || '(unnamed)', max: 40 },
        { title: 'VISIBILITY', key: 'visibility' },
        { title: 'OWNER', get: (p) => (p.is_owner ? 'you' : p.owner || '-'), max: 24 },
        { title: 'SONGS', key: 'song_count' },
      ]));
    });
  },
};

const create = {
  name: 'create',
  summary: 'Create a playlist (public unless --private)',
  usage: 'la playlist create <name> [--private]',
  description: `Creates a playlist owned by the token's user. Words are joined into the name
(max 50 characters). Public by default, like the web app. A name you can already
see is refused (CONFLICT, exit 1).\n\n${PERMISSIONS}`,
  options: {
    private: { type: 'boolean', desc: 'Only you can see it' },
  },
  output: `--json: { "playlist": { "id", "name", "visibility", "owner", "is_owner", "song_count", "created_at" } }\n${ERRORS}`,
  examples: ['la playlist create "Road trip"', 'la playlist create Late night --private --json'],
  async run(ctx, values, positionals) {
    want(positionals, 1, create.usage);
    const name = positionals.join(' ').trim();
    if (!name) throw new UsageError('The playlist name is empty');
    const p = playlistRow(await ctx.getApi().createPlaylist({ name, visibility: values.private ? 'private' : 'public' }));
    ctx.out.result({ playlist: p }, () => ctx.out.print(`Created ${p.visibility} playlist ${label(p)}`));
  },
};

const rename = {
  name: 'rename',
  summary: 'Rename a playlist',
  usage: 'la playlist rename <id-or-name> <new name>',
  description: `${PLAYLIST_REF}\nWords after the playlist are joined into the new name.`,
  output: `--json: { "playlist": { ... } }\n${ERRORS}`,
  examples: ['la playlist rename "Road trip" Road trip 2026', 'la playlist rename 1a2b3c4d "Chill"'],
  async run(ctx, values, positionals) {
    want(positionals, 2, rename.usage);
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    const p = playlistRow(await api.updatePlaylist(target.id, { name: positionals.slice(1).join(' ').trim() }));
    ctx.out.result({ playlist: p }, () => ctx.out.print(`Renamed ${target.id} to "${p.name}"`));
  },
};

const visibility = {
  name: 'visibility',
  summary: 'Make a playlist public or private (owner only)',
  usage: 'la playlist visibility <id-or-name> public|private',
  description: `${PLAYLIST_REF}\nOnly the owner may change it (FORBIDDEN, exit 1, otherwise). Going private
removes it from everyone else's view at once.`,
  output: `--json: { "playlist": { ... } }\n${ERRORS}`,
  examples: ['la playlist visibility "Road trip" private', 'la playlist visibility 1a2b3c4d public --json'],
  async run(ctx, values, positionals) {
    want(positionals, 2, visibility.usage);
    if (positionals.length > 2) throw new UsageError(`Unexpected argument: ${positionals[2]}`);
    const vis = positionals[1].toLowerCase();
    if (vis !== 'public' && vis !== 'private') throw new UsageError(`Visibility must be public or private, got: ${positionals[1]}`);
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    const p = playlistRow(await api.updatePlaylist(target.id, { visibility: vis }));
    ctx.out.result({ playlist: p }, () => ctx.out.print(`${label(p)} is now ${p.visibility}`));
  },
};

const del = {
  name: 'delete',
  summary: 'Delete a playlist (owner only; needs --yes)',
  usage: 'la playlist delete <id-or-name> --yes',
  description: `${PLAYLIST_REF}\nDeletes the playlist and its song list (the songs stay in the library). Only the
owner may delete (FORBIDDEN, exit 1). Without --yes nothing happens (exit 2).`,
  options: {
    yes: { type: 'boolean', short: 'y', desc: 'Really delete' },
  },
  output: `--json: { "deleted": { "id", "name" } }\n${ERRORS}`,
  examples: ['la playlist delete "Old stuff" --yes', 'la playlist delete 1a2b3c4d -y --json'],
  async run(ctx, values, positionals) {
    want(positionals, 1, del.usage);
    if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`, 'Quote a playlist name with spaces');
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    if (!values.yes) throw new UsageError(`Refusing to delete ${label(target)} without --yes`);
    await api.deletePlaylist(target.id);
    ctx.out.result({ deleted: { id: target.id, name: target.name } }, () => ctx.out.print(`Deleted ${label(target)}`));
  },
};

const show = {
  name: 'show',
  summary: "Show a playlist's songs",
  usage: 'la playlist show <id-or-name>',
  description: `${PLAYLIST_REF}\nLists the songs in order, with the library song id, YouTube id and the entry
id (what \`la playlist remove\` / \`move\` also accept besides positions).`,
  output: `Human: the playlist line, then a table (#, TITLE, LENGTH, LIBRARY_ID, YOUTUBE_ID, ADDED_BY, ENTRY).
--json: { "playlist": { ... }, "songs": [ { "position", "entry_id", "library_id", "youtube_id",
          "title", "artist", "duration_sec", "url", "added_by", "added_at", "available" } ] }
${ERRORS}`,
  examples: ['la playlist show "Road trip"', 'la playlist show 1a2b3c4d --json'],
  async run(ctx, values, positionals) {
    want(positionals, 1, show.usage);
    if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`, 'Quote a playlist name with spaces');
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    const data = await api.playlistSongs(target.id);
    const playlist = playlistRow(data.playlist || target);
    const songs = data.songs || [];
    ctx.out.result({ playlist, songs }, () => {
      ctx.out.print(`${label(playlist)} — ${playlist.visibility}, ${songs.length} song(s)${playlist.is_owner ? '' : playlist.owner ? `, owner ${playlist.owner}` : ''}`);
      if (songs.length) { ctx.out.print(''); printSongs(ctx.out, songs); }
    });
  },
};

const add = {
  name: 'add',
  summary: 'Add library songs to a playlist (library id, yt:<id>, YouTube URL, or a library search)',
  usage: ['la playlist add <playlist> <library-id|yt:ID|youtube-url>...', 'la playlist add <playlist> <search words...> [--first]'],
  description: `${PLAYLIST_REF}

Only songs already in the library can be added (use \`la download --playlist\` to
fetch new ones). If every argument after the playlist is a library song id, a
"yt:<11-char id>" or a YouTube URL, those songs are added. Otherwise the words are
one library search (like \`la library\`): exactly one match is added; several
matches fail with exit 1 listing them, unless --first takes the top one.
Songs already in the playlist are skipped unless --allow-duplicates.`,
  options: {
    first: { type: 'boolean', desc: 'For a search with several matches, add the first one' },
    'allow-duplicates': { type: 'boolean', desc: 'Add even if the song is already in the playlist' },
  },
  output: `--json: { "playlist": { "id", "name" }, "summary": { "total", "added", "already_in_playlist",
          "not_in_library", "invalid" }, "results": [ { "input", "status": "added|already_in_playlist|
          not_in_library|invalid", "song"?, "entry_id"?, "error"? } ], "song_count" }
Exit 0 if every song was added or already there, 1 otherwise (or NO_MATCH / AMBIGUOUS
for a search). ${ERRORS.replace('Exit 1 for', 'Also exit 1 for')}`,
  examples: [
    'la playlist add "Road trip" yt:dQw4w9WgXcQ',
    'la playlist add "Road trip" 0b6c3f7e-1d2a-4c55-9a77-3f2e1c0d9b88 yt:aaaaaaaaaaa',
    'la playlist add "Road trip" daft punk digital love',
    'la playlist add 1a2b3c4d teardrop --first --json',
  ],
  async run(ctx, values, positionals) {
    want(positionals, 2, add.usage[0]);
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    const args = positionals.slice(1);
    let refs = args.map(songRef);
    if (refs.some((r) => !r)) {
      const q = args.join(' ').trim();
      const { songs, total } = await api.library({ q, limit: 10 });
      if (!songs.length) throw new CliError(`No library song matches "${q}"`, { exitCode: EXIT.FAILURE, code: 'NO_MATCH', hint: 'Download it first: la download --playlist ...' });
      if (songs.length > 1 && !values.first) {
        const lines = songs.map((s) => `  ${s.id}  ${s.artist} - ${s.title}${s.youtube_id ? `  [yt:${s.youtube_id}]` : ''}`).join('\n');
        throw new CliError(`"${q}" matches ${total} library songs:\n${lines}${total > songs.length ? '\n  …' : ''}`, {
          exitCode: EXIT.FAILURE, code: 'AMBIGUOUS', hint: 'Pass a library id / yt:<id>, more words, or --first',
        });
      }
      refs = [songs[0].id];
    }
    const res = await api.addPlaylistSongs(target.id, refs, { allowDuplicates: !!values['allow-duplicates'] });
    const doc = { playlist: { id: target.id, name: target.name }, summary: res.summary, results: res.results, song_count: res.song_count };
    ctx.out.result(doc, () => {
      for (const r of res.results) {
        const what = r.song ? `${r.song.artist} - ${r.song.title}` : (typeof r.input === 'string' ? r.input : JSON.stringify(r.input));
        ctx.out.print(`[${r.status.replace(/_/g, ' ')}] ${what}${r.error ? ` — ${r.error}` : ''}`);
      }
      ctx.out.print(`${label(target)} now has ${res.song_count} song(s)`);
    });
    return res.results.every((r) => r.status === 'added' || r.status === 'already_in_playlist') ? EXIT.OK : EXIT.FAILURE;
  },
};

/** Map remove/move song arguments to what the server takes; positions need the current list. */
async function songTargets(api, playlistId, args) {
  let songs = null;
  const out = [];
  for (const arg of args) {
    const s = String(arg).trim();
    if (/^#?\d+$/.test(s)) {
      if (!songs) songs = (await api.playlistSongs(playlistId)).songs || [];
      const pos = Number(s.replace('#', ''));
      const hit = songs.find((x) => x.position === pos);
      out.push(hit ? { input: arg, ref: hit.entry_id } : { input: arg, error: `No song at position ${pos} (the playlist has ${songs.length})` });
    } else {
      out.push({ input: arg, ref: songRef(s) || s }); // entry id passes through
    }
  }
  return out;
}

const remove = {
  name: 'remove',
  summary: 'Remove songs from a playlist (position, entry id, library id or yt:<id>)',
  usage: 'la playlist remove <playlist> <song>...',
  description: `${PLAYLIST_REF}

Each <song> is a position from \`la playlist show\` (1, 2, … or #3), an entry id
(removes that one entry), or a library song id / yt:<id> / YouTube URL (removes
every entry of that song). Positions refer to the list before any removal.`,
  output: `--json: { "playlist": { "id", "name" }, "summary": { "total", "removed", "failed" },
          "results": [ { "input", "status": "removed|failed", "removed"?: [ { "entry_id", "title" } ],
                         "error"?, "code"? } ], "song_count" }
Exit 0 if every song was removed, 1 otherwise (SONG_NOT_FOUND). ${ERRORS.replace('Exit 1 for', 'Also exit 1 for')}`,
  examples: ['la playlist remove "Road trip" 3', 'la playlist remove "Road trip" yt:dQw4w9WgXcQ #1 --json'],
  async run(ctx, values, positionals) {
    want(positionals, 2, remove.usage);
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    const targets = await songTargets(api, target.id, positionals.slice(1));
    const results = [];
    let songCount = null;
    for (const t of targets) {
      if (t.error) { results.push({ input: t.input, status: 'failed', error: t.error, code: 'SONG_NOT_FOUND' }); continue; }
      try {
        const r = await api.removePlaylistSong(target.id, t.ref);
        songCount = r.song_count;
        results.push({ input: t.input, status: 'removed', removed: (r.removed || []).map(({ entry_id, title }) => ({ entry_id, title })) });
      } catch (err) {
        if (err.exitCode !== EXIT.FAILURE) throw err;
        results.push({ input: t.input, status: 'failed', error: err.message, code: err.code });
      }
    }
    const removed = results.filter((r) => r.status === 'removed').length;
    const doc = { playlist: { id: target.id, name: target.name }, summary: { total: results.length, removed, failed: results.length - removed }, results, song_count: songCount };
    ctx.out.result(doc, () => {
      for (const r of results) {
        ctx.out.print(r.status === 'removed' ? `[removed] ${r.input}: ${r.removed.map((x) => x.title).join(', ')}` : `[FAILED] ${r.input} — ${r.error}`);
      }
    });
    return removed === results.length ? EXIT.OK : EXIT.FAILURE;
  },
};

const move = {
  name: 'move',
  summary: 'Move a song to another position in a playlist',
  usage: 'la playlist move <playlist> <song> <position>',
  description: `${PLAYLIST_REF}\n<song> is a position or an entry id (see \`la playlist show\`); <position> is the new 1-based position.`,
  output: `--json: { "playlist": { "id", "name" }, "songs": [ ... same as show ... ] }\nExit 1 for an unknown song (SONG_NOT_FOUND) or position (BAD_REQUEST).`,
  examples: ['la playlist move "Road trip" 5 1', 'la playlist move 1a2b3c4d 7f0e…(entry id) 2 --json'],
  async run(ctx, values, positionals) {
    want(positionals, 3, move.usage);
    if (positionals.length > 3) throw new UsageError(`Unexpected argument: ${positionals[3]}`);
    const to = Number(positionals[2].replace('#', ''));
    if (!Number.isInteger(to) || to < 1) throw new UsageError(`Position must be a whole number >= 1, got: ${positionals[2]}`);
    const api = ctx.getApi();
    const target = await resolvePlaylist(api, positionals[0]);
    const [t] = await songTargets(api, target.id, [positionals[1]]);
    if (t.error) throw new CliError(t.error, { exitCode: EXIT.FAILURE, code: 'SONG_NOT_FOUND' });
    const res = await api.movePlaylistSong(target.id, t.ref, to);
    ctx.out.result({ playlist: { id: target.id, name: target.name }, songs: res.songs }, () => printSongs(ctx.out, res.songs || []));
  },
};

module.exports = {
  name: 'playlist',
  aliases: ['playlists', 'pl'],
  summary: 'List, create, rename, share, delete playlists and edit their songs',
  usage: [
    'la playlist [list]',
    'la playlist create <name> [--private]',
    'la playlist rename <id-or-name> <new name>',
    'la playlist visibility <id-or-name> public|private',
    'la playlist delete <id-or-name> --yes',
    'la playlist show <id-or-name>',
    'la playlist add <playlist> <library-id|yt:ID|search...>',
    'la playlist remove <playlist> <song>...',
    'la playlist move <playlist> <song> <position>',
  ],
  description: `Server playlists, as the token's user. Without a subcommand: \`la playlist list\`.
${PLAYLIST_REF}

${PERMISSIONS}

Changes show up live in open web app tabs. To download/upload songs straight into
a playlist use \`la download --playlist <p>\` / \`la upload --playlist <p>\`.`,
  subcommands: [list, create, rename, visibility, del, show, add, remove, move],
  examples: [
    'la playlist',
    'la playlist create "Road trip" --private',
    'la playlist show "Road trip"',
    'la playlist add "Road trip" yt:dQw4w9WgXcQ',
    'la playlist remove "Road trip" 2',
    'la playlist visibility "Road trip" public',
    'la playlist delete "Road trip" --yes',
  ],
  run: list.run,
  songRef,
};
