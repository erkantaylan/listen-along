'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { main } = require('../src/cli');

const TOKEN = 'test-token-123456';

/**
 * Stub listen-along server implementing the library API contract.
 * Records every request in `state.calls` and every upload in `state.uploads`.
 */
async function startServer(overrides = {}) {
  const state = {
    me: { name: 'owner' },
    songs: [],
    requests: [],
    uploads: [],
    calls: [],
    dismissed: [],
    nextId: 1,
    failUpload: null, // (fields) => { status, body } | null
    // Playlists: [{ id, name, visibility, ownerId, songs: [{ entry_id, library_id, youtube_id, title }] }].
    // `me.userId` is the caller (null = legacy token). Same rules as the server.
    playlists: [],
    nextPlaylist: 1,
    nextEntry: 1,
    // POST /api/library/check exists only when true (false = an older server: 404).
    checkEnabled: false,
    checks: [], // bodies sent to /api/library/check
    replaces: [], // { id, fields, fileContent }
    failReplace: null, // (id, fields) => { status, body } | null
    ...overrides,
  };
  const legacy = () => !state.me.userId;
  const canSee = (p) => p.visibility === 'public' || (!legacy() && p.ownerId === state.me.userId);
  const isOwner = (p) => !legacy() && !!p.ownerId && p.ownerId === state.me.userId;
  const info = (p) => ({ id: p.id, name: p.name, visibility: p.visibility, ownerId: p.ownerId || null, ownerName: p.ownerName || null, isOwner: isOwner(p), canManage: isOwner(p), songCount: p.songs.length, createdAt: 1 });
  const songView = (p) => p.songs.map((x, i) => ({ position: i + 1, entry_id: x.entry_id, library_id: x.library_id, youtube_id: x.youtube_id, title: x.title, duration_sec: 200, added_by: 'owner', available: true }));
  const findSong = (ref) => {
    const yt = /^yt:(.+)$/.exec(ref);
    return state.songs.find((s) => (yt ? s.youtube_id === yt[1] : String(s.id) === String(ref)));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'invalid token' });

    if (req.method === 'GET' && url.pathname === '/api/me') return send(200, state.me);

    if (req.method === 'GET' && url.pathname === '/api/library') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') || 50);
      const offset = Number(url.searchParams.get('offset') || 0);
      const matched = state.songs.filter((s) => !q || `${s.title} ${s.artist} ${s.album || ''}`.toLowerCase().includes(q));
      return send(200, { songs: matched.slice(offset, offset + limit), total: matched.length });
    }

    if (req.method === 'POST' && url.pathname === '/api/library/check' && state.checkEnabled) {
      const q = JSON.parse(body.toString() || '{}');
      state.checks.push(q);
      const norm = (x) => String(x || '').toLowerCase().replace(/\(official [^)]*\)/g, '').trim();
      const matches = [];
      const add = (reason, exact, song) => { if (song && !matches.some((m) => m.song.id === song.id)) matches.push({ reason, exact, message: reason, song }); };
      if (q.youtube_id) add('already_in_library', true, state.songs.find((x) => x.youtube_id === q.youtube_id));
      if (q.sha256) add('duplicate_hash', true, state.songs.find((x) => x.sha256 === q.sha256));
      if (q.title && q.artist && q.duration_sec) {
        add('duplicate_metadata', false, state.songs.find((x) => norm(x.title) === norm(q.title) && norm(x.artist) === norm(q.artist)
          && x.duration_sec && Math.abs(x.duration_sec - q.duration_sec) <= 3));
      }
      return send(200, { duplicate: matches.length > 0, match: matches[0] || null, matches });
    }

    const rm = /^\/api\/library\/([^/]+)\/replace$/.exec(url.pathname);
    if (req.method === 'POST' && rm) {
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const fields = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
      const file = form.get('file');
      const fileContent = file ? Buffer.from(await file.arrayBuffer()).toString() : null;
      state.replaces.push({ id: rm[1], fields, fileContent });
      if (state.failReplace) {
        const f = state.failReplace(rm[1], fields);
        if (f) return send(f.status, f.body);
      }
      const song = state.songs.find((x) => String(x.id) === rm[1]);
      if (!song) return send(404, { error: 'Song not found', code: 'not_found' });
      const previous = { youtube_id: song.youtube_id, title: song.title, artist: song.artist };
      Object.assign(song, {
        title: fields.title, artist: fields.artist, album: fields.album || null, youtube_id: fields.youtube_id || null,
        source_url: fields.source_url || null, sha256: crypto.createHash('sha256').update(fileContent || '').digest('hex'),
      });
      return send(200, { song, previous });
    }

    if (req.method === 'POST' && url.pathname === '/api/library/upload') {
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const fields = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
      const file = form.get('file');
      const upload = { fields, fileName: file && file.name, fileType: file && file.type, fileContent: file ? Buffer.from(await file.arrayBuffer()).toString() : null };
      state.uploads.push(upload);
      if (state.failUpload) {
        const f = state.failUpload(fields);
        if (f) return send(f.status, f.body);
      }
      if (!file || !fields.title || !fields.artist) return send(400, { error: 'file, title and artist are required' });
      const dup = fields.youtube_id && state.songs.find((s) => s.youtube_id === fields.youtube_id);
      if (dup) return send(409, { error: 'duplicate', song: dup });
      const song = {
        id: state.nextId++, youtube_id: fields.youtube_id || null, title: fields.title, artist: fields.artist,
        album: fields.album || null, source_url: fields.source_url || null, duration_sec: fields.duration_sec ? Number(fields.duration_sec) : null,
        uploaded_by: state.me.name, created_at: new Date().toISOString(),
      };
      if (state.checkEnabled) song.sha256 = crypto.createHash('sha256').update(upload.fileContent || '').digest('hex');
      state.songs.push(song);
      if (fields.request_id) {
        const r = state.requests.find((x) => String(x.id) === fields.request_id);
        if (r) r.status = 'fulfilled';
      }
      return send(201, { song });
    }

    if (req.method === 'GET' && url.pathname === '/api/requests') {
      const status = url.searchParams.get('status') || 'pending';
      return send(200, { requests: state.requests.filter((r) => status === 'all' || r.status === status) });
    }

    const dm = /^\/api\/requests\/([^/]+)\/dismiss$/.exec(url.pathname);
    if (req.method === 'POST' && dm) {
      const r = state.requests.find((x) => String(x.id) === dm[1]);
      if (!r) return send(404, { error: 'request not found' });
      r.status = 'dismissed';
      state.dismissed.push(r.id);
      return send(200, { ok: true });
    }
    if (url.pathname === '/api/playlists' || url.pathname.startsWith('/api/playlists/')) {
      const json = body.length ? JSON.parse(body.toString()) : {};
      const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // [id, 'songs', ref, 'move']
      if (!parts.length) {
        if (req.method === 'GET') return send(200, { playlists: state.playlists.filter(canSee).map(info) });
        if (req.method === 'POST') {
          if (legacy() && json.visibility === 'private') return send(403, { error: 'legacy token: public only', code: 'FORBIDDEN' });
          if (state.playlists.some((p) => canSee(p) && p.name && p.name.toLowerCase() === String(json.name).toLowerCase())) return send(409, { error: 'A playlist with that name already exists', code: 'CONFLICT' });
          const p = { id: `pl${String(state.nextPlaylist++).padStart(6, '0')}`, name: json.name, visibility: json.visibility || 'public', ownerId: state.me.userId || null, songs: [] };
          state.playlists.push(p);
          return send(201, info(p));
        }
      }
      const p = state.playlists.find((x) => x.id === parts[0]);
      if (!p || !canSee(p)) return send(404, { error: 'Playlist not found', code: 'NOT_FOUND' });
      if (parts.length === 1) {
        if (req.method === 'PATCH') {
          if (json.visibility !== undefined && !isOwner(p)) return send(403, { error: 'Only the owner can change visibility', code: 'FORBIDDEN' });
          if (json.name !== undefined) p.name = json.name;
          if (json.visibility !== undefined) p.visibility = json.visibility;
          return send(200, info(p));
        }
        if (req.method === 'DELETE') {
          if (!isOwner(p)) return send(403, { error: 'Only the owner can delete this playlist', code: 'FORBIDDEN' });
          state.playlists = state.playlists.filter((x) => x !== p);
          return send(200, { success: true });
        }
      }
      if (parts[1] === 'songs' && parts.length === 2) {
        if (req.method === 'GET') return send(200, { playlist: info(p), songs: songView(p) });
        if (req.method === 'POST') {
          if (state.failPlaylistAdd) return send(state.failPlaylistAdd.status, state.failPlaylistAdd.body);
          const results = json.songs.map((ref) => {
            const s = findSong(ref);
            if (!s) return { input: ref, status: 'not_in_library', code: 'NOT_IN_LIBRARY', error: 'Not in the library' };
            if (!json.allow_duplicates && p.songs.some((x) => String(x.library_id) === String(s.id))) return { input: ref, status: 'already_in_playlist', song: s };
            const entry = { entry_id: `e${state.nextEntry++}`, library_id: s.id, youtube_id: s.youtube_id, title: `${s.title} - ${s.artist}` };
            p.songs.push(entry);
            return { input: ref, status: 'added', song: s, entry_id: entry.entry_id };
          });
          const count = (st) => results.filter((r) => r.status === st).length;
          return send(200, { playlist_id: p.id, summary: { total: results.length, added: count('added'), already_in_playlist: count('already_in_playlist'), not_in_library: count('not_in_library'), invalid: 0 }, results, song_count: p.songs.length });
        }
      }
      if (parts[1] === 'songs' && parts.length === 3 && req.method === 'DELETE') {
        const s = findSong(parts[2]);
        const hit = p.songs.filter((x) => x.entry_id === parts[2] || (s && String(x.library_id) === String(s.id)));
        if (!hit.length) return send(404, { error: 'That song is not in this playlist', code: 'SONG_NOT_FOUND' });
        p.songs = p.songs.filter((x) => !hit.includes(x));
        return send(200, { playlist_id: p.id, removed: hit.map((x) => ({ entry_id: x.entry_id, title: x.title })), song_count: p.songs.length });
      }
      if (parts[1] === 'songs' && parts[3] === 'move' && req.method === 'POST') {
        const i = p.songs.findIndex((x) => x.entry_id === parts[2]);
        if (i < 0) return send(404, { error: 'That song is not in this playlist', code: 'SONG_NOT_FOUND' });
        if (json.position < 1 || json.position > p.songs.length) return send(400, { error: 'bad position', code: 'BAD_REQUEST' });
        const [e] = p.songs.splice(i, 1);
        p.songs.splice(json.position - 1, 0, e);
        return send(200, { playlist_id: p.id, songs: songView(p) });
      }
    }

    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)) };
}

function tmpDir(prefix = 'la-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writable that accumulates into a string. */
function sink() {
  const s = { data: '', write(chunk) { s.data += chunk; return true; } };
  return s;
}

/**
 * Run the CLI in-process.
 * @returns {Promise<{ code, stdout, stderr, json }>}
 */
async function run(argv, { env = {}, deps = {}, server } = {}) {
  const stdout = sink();
  const stderr = sink();
  const configDir = tmpDir('la-cfg-');
  const fullEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LA_CONFIG: path.join(configDir, 'config.json'),
    ...(server ? { LA_SERVER: server.url, LA_TOKEN: TOKEN } : {}),
    ...env,
  };
  const code = await main(argv, { env: fullEnv, stdout, stderr, deps: { sleep: async () => {}, ...deps } });
  let json;
  try { json = JSON.parse(stdout.data); } catch { /* not json */ }
  return { code, stdout: stdout.data, stderr: stderr.data, json };
}

/**
 * Fake yt-dlp layer. `videos` maps id -> { title, artist, album, duration, fail? }.
 * `searches` maps query -> [entries]; `playlists` maps listId -> [ids].
 * download() writes a small fake m4a whose content is "AUDIO:<id>".
 */
function fakeYtdlp({ videos = {}, searches = {}, playlists = {}, missing = false } = {}) {
  const calls = { download: [], search: [], playlist: [], extraArgs: null };
  const factory = (opts) => {
    calls.extraArgs = opts.extraArgs;
    return {
      async version() {
        if (missing) {
          const { missingDependency } = require('../src/proc');
          throw missingDependency('yt-dlp', 'yt-dlp');
        }
        return '2026.01.01';
      },
      async search(query) {
        calls.search.push(query);
        return (searches[query] || []).map((e) => ({ url: `https://www.youtube.com/watch?v=${e.id}`, ...e }));
      },
      async playlist(url) {
        calls.playlist.push(url);
        const list = new URL(url).searchParams.get('list');
        return (playlists[list] || []).map((id) => ({ id, title: videos[id]?.title, url: `https://www.youtube.com/watch?v=${id}` }));
      },
      async download(url, { outDir }) {
        const id = new URL(url).searchParams.get('v');
        calls.download.push(id);
        const v = videos[id];
        if (!v || v.fail) {
          const { CliError } = require('../src/errors');
          throw new CliError(v?.fail || 'Video is unavailable', { code: v?.failCode || 'VIDEO_UNAVAILABLE' });
        }
        const file = path.join(outDir, `${id}.m4a`);
        fs.writeFileSync(file, `AUDIO:${id}`);
        const thumb = path.join(outDir, `${id}.jpg`);
        fs.writeFileSync(thumb, 'JPEG');
        return { file, thumbnail: thumb, info: { id, title: v.title, track: v.title, artist: v.artist, album: v.album, duration: v.duration, filepath: file, webpage_url: `https://www.youtube.com/watch?v=${id}` } };
      },
    };
  };
  return { factory, calls };
}

/**
 * Fake ffmpeg/ffprobe layer. Tags come from `tagsByContent` keyed by file
 * content, or are parsed from fake m4a content "AUDIO:<id>" via `videos`.
 */
function fakeMedia({ videos = {}, files = {}, missing = false } = {}) {
  const calls = { probe: [], toM4a: [], embedCover: [] };
  const factory = () => ({
    async check() {
      if (missing) {
        const { missingDependency } = require('../src/proc');
        throw missingDependency('ffmpeg', 'ffmpeg');
      }
    },
    async probe(file) {
      calls.probe.push(file);
      const content = fs.readFileSync(file, 'utf8');
      if (files[content]) return files[content];
      const m = /^AUDIO:(.+)$/.exec(content);
      if (m && videos[m[1]]) {
        const v = videos[m[1]];
        return {
          format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', duration: v.duration, hasCover: true,
          tags: { title: v.title, artist: v.artist, album: v.album, comment: `https://www.youtube.com/watch?v=${m[1]}` },
        };
      }
      return { format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', duration: 100, hasCover: false, tags: {} };
    },
    async toM4a(input, output, opts) {
      calls.toM4a.push({ input, output, opts });
      fs.writeFileSync(output, `CONVERTED:${fs.readFileSync(input, 'utf8')}`);
      return output;
    },
    async embedCover(file, cover) {
      calls.embedCover.push({ file, cover });
      return file;
    },
  });
  return { factory, calls };
}

module.exports = { startServer, run, tmpDir, fakeYtdlp, fakeMedia, TOKEN };
