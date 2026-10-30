'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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
    ...overrides,
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
