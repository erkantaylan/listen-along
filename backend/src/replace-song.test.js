// "Replace with…": details-only edits, replace jobs and capability routing,
// against the real server on Postgres (testcontainers), with workers speaking
// the WebSocket protocol and uploading like `la worker`.
//   - PATCH /api/library/:id: access, audit, meta_key, queues, library:updated
//   - POST /api/jobs/replace: permissions, refusals, active-job refusal
//   - routing: an old worker (no capability) never gets a replace job, and the
//     job waits for a capable one without holding up other jobs
//   - worker upload: details forced by the job, reports closed, old file gone,
//     duration from the file; failures; deleted song; restart; reclaim
//   - migration on a database from before these columns
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { cookieFor, adminCookie, startServer, requester } = require('./testServer');
const { planAssignments } = require('./workerHub');
const { durationDiffers } = require('./jobRoutes');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available'
  : !has('ffmpeg -version') || !has('ffprobe -version') ? 'ffmpeg/ffprobe not available'
  : typeof WebSocket !== 'function' ? 'no global WebSocket (Node >= 22)' : false;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(25);
  }
}

describe('planAssignments: replace jobs', () => {
  const w = (name, canReplace, userId = 'u', idleSince = 0) => ({ name, canReplace, userId, idleSince });
  const j = (id, replace, requester = null) => ({ id, replace_song_id: replace ? 's' : null, requested_by_user_id: requester });

  it('never gives a replace job to a worker without the capability', () => {
    assert.deepEqual(planAssignments([j('1', true)], [w('old', false), w('old2', undefined)]), []);
  });
  it('not even to the requester\'s own old worker', () => {
    const plan = planAssignments([j('1', true, 'me')], [w('mine-old', false, 'me', 1), w('new', true, 'other', 2)]);
    assert.deepEqual(plan.map((p) => p.worker.name), ['new']);
  });
  it('a waiting replace job does not hold up other jobs', () => {
    const plan = planAssignments([j('1', true), j('2', false)], [w('old', false)]);
    assert.deepEqual(plan.map((p) => [p.job.id, p.worker.name]), [['2', 'old']]);
  });
  it('an old worker stays available for ordinary jobs', () => {
    const plan = planAssignments([j('1', true), j('2', false)], [w('old', false, 'x', 1), w('new', true, 'y', 2)]);
    assert.deepEqual(plan.map((p) => [p.job.id, p.worker.name]).sort(), [['1', 'new'], ['2', 'old']]);
  });
});

describe('durationDiffers', () => {
  it('more than 15 seconds and more than 10%', () => {
    assert.equal(durationDiffers(200, 210), false);
    assert.equal(durationDiffers(200, 225), true);
    assert.equal(durationDiffers(600, 650), false);
    assert.equal(durationDiffers(600, 700), true);
    assert.equal(durationDiffers(null, 100), false);
    assert.equal(durationDiffers(100, null), false);
  });
});

describe('replace with… on Postgres', { skip, timeout: 300_000 }, () => {
  let container;
  let dbUrl;
  let pg;
  let srv;
  let req;
  let tmp;
  let stubDir;
  const ids = {};
  const cookies = {};
  const tok = {};
  const workers = [];
  const sockets = [];
  let toneN = 0;
  let videoN = 0;
  const NEW_VIDEO = () => `newvideo${String(videoN++).padStart(3, '0')}`.slice(0, 11);

  async function boot() {
    srv = await startServer({
      DATABASE_URL: dbUrl, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
      WORKER_REQUEUE_GRACE_MS: '300', WORKER_HEARTBEAT_MS: '60000',
      PATH: `${stubDir}:${process.env.PATH}`, NODE_OPTIONS: `--require ${path.join(stubDir, 'oembed-stub.cjs')}`,
    });
    req = requester(srv.base);
  }

  function connectWorker(token, name, { capabilities = ['replace'], ...extra } = {}) {
    const ws = new WebSocket(srv.base.replace(/^http/, 'ws') + '/api/workers/connect');
    const w = { ws, name, jobs: [], closed: null };
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'job') w.jobs.push(msg.job);
      if (msg.type === 'welcome') w.id = msg.worker.id;
    });
    ws.addEventListener('close', (ev) => { w.closed = ev.code; });
    w.ready = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({
        type: 'hello', protocol: 1, token, name, hostname: `${name}.lan`, platform: 'linux', arch: 'x64',
        cli_version: capabilities ? '0.2.0' : '0.1.0', node_version: '24.0.0', ytdlp_version: '2026.10.26',
        ...(capabilities ? { capabilities } : {}), ...extra,
      })));
      const check = setInterval(() => {
        if (w.id) { clearInterval(check); resolve(w); }
        if (w.closed !== null) { clearInterval(check); reject(new Error(`closed ${w.closed}`)); }
      }, 10);
    });
    w.send = (m) => ws.send(JSON.stringify(m));
    w.nextJob = (n = 1) => until(() => w.jobs.length >= n && w.jobs[n - 1], `${name} job #${n}`);
    w.disconnect = async () => { ws.close(); await until(() => w.closed !== null, 'close'); };
    workers.push(w);
    return w;
  }

  function tone(seconds = 1) {
    const file = path.join(tmp, `tone-${toneN++}.m4a`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + toneN * 37}:duration=${seconds}`, '-c:a', 'aac', file]);
    return file;
  }

  async function multipart(url, { token, cookie, fields = {}, file }) {
    const f = new FormData();
    f.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mp4' }), 'x.m4a');
    for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    const res = await fetch(srv.base + url, { method: 'POST', body: f, headers });
    return { status: res.status, body: await res.json() };
  }

  async function makeSong(fields = {}) {
    const n = toneN;
    const r = await multipart('/api/library/upload', {
      token: tok.alice, file: tone(),
      fields: { title: `Song ${n}`, artist: `Band ${n}`, album: `Album ${n}`, youtube_id: `oldsong${String(n).padStart(4, '0')}`, ...fields },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.song;
  }

  const replaceJob = (who, song, input, extra = {}) => req('POST', '/api/jobs/replace', { cookie: cookies[who], body: { song_id: song.id, input, ...extra } });
  const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
  const myJob = async (who, id) => (await req('GET', '/api/jobs', { cookie: cookies[who] })).body.jobs.find((j) => j.id === id);
  const songRow = async (id) => (await pg.query('SELECT * FROM library_songs WHERE id = $1', [id])).rows[0];

  /** What `la worker` does for a replace job. */
  const workerUpload = (w, job, { file, fields = {}, token = tok.bob } = {}) => multipart(`/api/library/${job.replace.song_id}/replace`, {
    token, file: file || tone(3),
    fields: { title: 'Video Title (Official)', artist: 'Video Channel', album: 'Video Album', youtube_id: 'dQw4w9WgXcQ', duration_sec: 9999, job_id: job.id, worker_id: w.id, ...fields },
  });

  function socketFor(who) {
    const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: cookies[who] } });
    sockets.push(s);
    return new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
  }

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_replace').withUsername('test').withPassword('test').start();
    dbUrl = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-replace-'));
    stubDir = path.join(tmp, 'stub');
    fs.mkdirSync(stubDir);
    // The server's metadata lookups, without YouTube: a flat search that knows
    // one 60-second video, and oEmbed answering for ids that start with "known".
    fs.writeFileSync(path.join(stubDir, 'yt-dlp'), `#!/bin/sh
for a in "$@"; do last="$a"; done
id="\${last#ytsearch1:}"
case "$id" in
  known*) printf '{"entries":[{"id":"%s","title":"Search %s","duration":60,"channel":"Ch"}]}' "$id" "$id" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, 'oembed-stub.cjs'), `
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://www.youtube.com/oembed')) {
    const id = decodeURIComponent(String(url)).split('v=')[1];
    if (!id.startsWith('known')) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ title: 'Oembed ' + id, author_name: 'Channel' }), { status: 200 });
  }
  return real(url, opts);
};`);
    await boot();
    const { Client } = require('pg');
    pg = new Client({ connectionString: dbUrl });
    await pg.connect();
    for (const key of ['alice', 'bob', 'pending', 'denied']) {
      const status = key === 'pending' ? 'pending' : key === 'denied' ? 'denied' : 'approved';
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $3, $4, 1) RETURNING id`,
        [key, key, key[0].toUpperCase() + key.slice(1), status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    for (const key of ['alice', 'bob']) {
      const r = await req('POST', '/api/tokens', { cookie: cookies[key], body: { label: 'x' } });
      assert.equal(r.status, 201, r.text);
      tok[key] = r.body.token;
    }
  });

  after(async () => {
    for (const s of sockets) s.close();
    for (const w of workers) { try { w.ws.close(); } catch {} }
    if (pg) await pg.end().catch(() => {});
    if (srv) await srv.stop();
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('PATCH /api/library/:id (details only)', () => {
    it('saves, audits, recomputes meta_key, leaves the audio and reports alone', async () => {
      const song = await makeSong();
      const before = await songRow(song.id);
      await req('POST', `/api/library/${song.id}/report`, { cookie: cookies.bob, body: { reason: 'wrong name' } });
      const r = await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.bob, body: { title: 'Fixed  Title', artist: 'Fixed Band', album: '' } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.song.title, 'Fixed Title');
      assert.equal(r.body.song.artist, 'Fixed Band');
      assert.equal(r.body.song.album, null);
      assert.equal(r.body.song.file_version, song.file_version);
      assert.equal(r.body.song.report_count, 1, 'a details edit does not close reports');
      const row = await songRow(song.id);
      assert.equal(row.file_path, before.file_path);
      assert.equal(row.sha256, before.sha256);
      assert.equal(row.replaced_at, null);
      assert.notEqual(row.meta_key, before.meta_key);
      const audit = (await pg.query('SELECT * FROM library_song_replacements WHERE song_id = $1', [song.id])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].kind, 'details');
      assert.equal(audit[0].replaced_by, 'Bob');
      assert.equal(audit[0].old_title, before.title);
      assert.equal(audit[0].new_title, 'Fixed Title');
      assert.equal(audit[0].old_sha256, audit[0].new_sha256);
    });

    it('keeps what is left out; a partial edit of the album only', async () => {
      const song = await makeSong();
      const r = await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.alice, body: { album: 'New Album' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.song.title, song.title);
      assert.equal(r.body.song.album, 'New Album');
    });

    it('refuses empty and unchanged values, and unknown songs', async () => {
      const song = await makeSong();
      assert.equal((await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.alice, body: { title: '  ' } })).status, 400);
      const same = await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.alice, body: { title: song.title } });
      assert.equal(same.status, 400);
      assert.equal(same.body.code, 'nothing_changed');
      assert.equal((await req('PATCH', '/api/library/not-a-uuid', { cookie: cookies.alice, body: { title: 'x' } })).status, 404);
      assert.equal((await req('PATCH', '/api/library/00000000-0000-4000-8000-000000000000', { cookie: cookies.alice, body: { title: 'x' } })).status, 404);
    });

    it('same access as replace: a token yes; nobody else', async () => {
      const song = await makeSong();
      assert.equal((await req('PATCH', `/api/library/${song.id}`, { headers: { Authorization: `Bearer ${tok.bob}` }, body: { title: 'By token' } })).status, 200);
      assert.equal((await req('PATCH', `/api/library/${song.id}`, { body: { title: 'x' } })).status, 401);
      assert.equal((await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.pending, body: { title: 'x' } })).status, 403);
      assert.equal((await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.denied, body: { title: 'x' } })).status, 403);
      assert.equal((await req('PATCH', `/api/library/${song.id}`, { headers: { Authorization: 'Bearer la_nope' }, body: { title: 'x' } })).status, 401);
    });

    it('a probable duplicate name is allowed, as on replace', async () => {
      const a = await makeSong();
      const b = await makeSong();
      const r = await req('PATCH', `/api/library/${b.id}`, { cookie: cookies.alice, body: { title: a.title, artist: a.artist } });
      assert.equal(r.status, 200, r.text);
    });

    it('rewrites queues of every playlist and emits library:updated { details }, not { replaced }', async () => {
      const song = await makeSong();
      const made = await req('POST', '/api/playlists', { cookie: cookies.alice, body: { name: `Details ${song.id.slice(0, 6)}` } });
      assert.ok([200, 201].includes(made.status), made.text);
      const id = made.body.id || made.body.playlist.id;
      const add = await req('POST', `/api/playlists/${id}/songs`, { cookie: cookies.alice, body: { songs: [song.id] } });
      assert.ok([200, 201].includes(add.status), add.text);
      const s = await socketFor('bob');
      const seen = [];
      s.on('library:updated', (p) => seen.push(p));
      const r = await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.alice, body: { title: 'New Name' } });
      assert.equal(r.status, 200);
      const p = await until(() => seen.find((x) => x.details && x.details.id === song.id), 'library:updated details');
      assert.equal(p.replaced, undefined);
      assert.equal(p.song.title, 'New Name');
      const q = await until(async () => {
        const rows = (await pg.query('SELECT title FROM queue_songs WHERE lobby_id = $1', [id])).rows;
        return rows[0] && rows[0].title.startsWith('New Name') ? rows : null;
      }, 'queue rewrite');
      assert.equal(q.length, 1);
    });
  });

  describe('preview', () => {
    it('resolves a video through the metadata helpers and warns about a different length', async () => {
      const song = await makeSong();
      const r = await req('POST', '/api/jobs/replace/preview', { cookie: cookies.alice, body: { song_id: song.id, input: watch('knownvideo1') } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.resolved, true);
      assert.equal(r.body.title, 'Oembed knownvideo1');
      assert.equal(r.body.duration_sec, 60);
      assert.equal(r.body.duration_differs, true, '1s song, 60s video');
      assert.equal(r.body.problem, null);
    });
    it('an unresolved video may still be submitted', async () => {
      const song = await makeSong();
      const r = await req('POST', '/api/jobs/replace/preview', { cookie: cookies.alice, body: { song_id: song.id, input: watch('unknownvid1') } });
      assert.equal(r.status, 200);
      assert.equal(r.body.resolved, false);
      assert.equal(r.body.problem, null);
    });
    it('names the refusal the real thing would give', async () => {
      const a = await makeSong();
      const b = await makeSong();
      const same = await req('POST', '/api/jobs/replace/preview', { cookie: cookies.alice, body: { song_id: a.id, input: `https://youtu.be/${a.youtube_id}` } });
      assert.equal(same.body.problem.code, 'same_video');
      const other = await req('POST', '/api/jobs/replace/preview', { cookie: cookies.alice, body: { song_id: a.id, input: watch(b.youtube_id) } });
      assert.equal(other.body.problem.code, 'already_in_library');
      assert.match(other.body.problem.message, new RegExp(b.title));
      const bad = await req('POST', '/api/jobs/replace/preview', { cookie: cookies.alice, body: { song_id: a.id, input: 'https://soundcloud.com/x/y' } });
      assert.equal(bad.body.problem.code, 'BAD_INPUT');
    });
    it('approved users only', async () => {
      const a = await makeSong();
      assert.equal((await req('POST', '/api/jobs/replace/preview', { body: { song_id: a.id, input: watch('knownvideo1') } })).status, 401);
      assert.equal((await req('POST', '/api/jobs/replace/preview', { cookie: cookies.pending, body: { song_id: a.id, input: watch('knownvideo1') } })).status, 403);
    });
  });

  describe('POST /api/jobs/replace', () => {
    it('permissions: any approved web user; not pending, denied, anonymous or a token', async () => {
      const song = await makeSong();
      const body = { song_id: song.id, input: watch(NEW_VIDEO()) };
      assert.equal((await req('POST', '/api/jobs/replace', { body })).status, 401);
      assert.equal((await req('POST', '/api/jobs/replace', { cookie: cookies.pending, body })).status, 403);
      assert.equal((await req('POST', '/api/jobs/replace', { cookie: cookies.denied, body })).status, 403);
      assert.equal((await req('POST', '/api/jobs/replace', { headers: { Authorization: `Bearer ${tok.bob}` }, body })).status, 401);
    });

    it('validates: not a video, unknown song, own video, another song\'s video', async () => {
      const a = await makeSong();
      const b = await makeSong();
      const search = await replaceJob('alice', a, 'some song name');
      assert.equal(search.status, 400);
      assert.equal(search.body.code, 'BAD_INPUT');
      assert.equal((await replaceJob('alice', a, 'https://www.youtube.com/playlist?list=PLabc')).status, 400);
      assert.equal((await req('POST', '/api/jobs/replace', { cookie: cookies.alice, body: { song_id: '00000000-0000-4000-8000-000000000000', input: watch('knownvideo2') } })).status, 404);
      const own = await replaceJob('alice', a, watch(a.youtube_id));
      assert.equal(own.status, 409);
      assert.equal(own.body.code, 'same_video');
      const other = await replaceJob('alice', a, watch(b.youtube_id));
      assert.equal(other.status, 409);
      assert.equal(other.body.code, 'already_in_library');
      assert.equal(other.body.song.id, b.id);
      assert.match(other.body.error, new RegExp(b.title));
      assert.equal((await replaceJob('alice', a, watch('knownvideo2'), { title: ' ' })).status, 400);
    });

    it('a second replace of the same song while one is active: 409 replace_job_active', async () => {
      const song = await makeSong();
      const first = await replaceJob('alice', song, watch(NEW_VIDEO()));
      assert.equal(first.status, 201, first.text);
      const second = await replaceJob('bob', song, watch(NEW_VIDEO()));
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'replace_job_active');
      assert.equal(second.body.error.includes('Alice'), false);
      await req('POST', `/api/jobs/${first.body.job.id}/cancel`, { cookie: cookies.alice });
    });

    it('privacy: only the requester gets the job; others learn that one is active, no user ids anywhere', async () => {
      const song = await makeSong();
      const made = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const mine = await req('GET', `/api/jobs/replace/${song.id}`, { cookie: cookies.alice });
      assert.equal(mine.body.job.id, made.body.job.id);
      const theirs = await req('GET', `/api/jobs/replace/${song.id}`, { cookie: cookies.bob });
      assert.equal(theirs.body.job, null);
      assert.equal(theirs.body.active, true);
      assert.ok(!(await req('GET', '/api/jobs', { cookie: cookies.bob })).body.jobs.some((j) => j.id === made.body.job.id));
      assert.ok(!JSON.stringify(mine.body).includes(ids.alice));
      assert.equal((await req('POST', `/api/jobs/${made.body.job.id}/cancel`, { cookie: cookies.bob })).status, 409);
      await req('POST', `/api/jobs/${made.body.job.id}/cancel`, { cookie: cookies.alice });
    });
  });

  describe('routing and the job flow', () => {
    it('an old worker never gets it, and takes other jobs; it waits for a capable worker, which gets the song to replace', async () => {
      const song = await makeSong();
      const made = await replaceJob('alice', song, watch(NEW_VIDEO()));
      assert.equal(made.body.job.status, 'queued');
      const old = await connectWorker(tok.bob, 'old-box', { capabilities: null }).ready;
      const other = await req('POST', '/api/jobs', { cookie: cookies.alice, body: { input: watch(NEW_VIDEO()) } });
      const got = await old.nextJob();
      assert.equal(got.id, other.body.job.id, 'the ordinary job, not the older replace job');
      assert.equal(got.replace, undefined);
      old.send({ type: 'job:done', job_id: got.id, result: { summary: { total: 1, skipped: 1 }, results: [{ status: 'skipped' }] } });
      await until(async () => (await myJob('alice', got.id)).status === 'done', 'other job done');
      await tick(150);
      assert.equal(old.jobs.length, 1, 'still nothing else for the old worker');
      assert.equal((await myJob('alice', made.body.job.id)).status, 'queued');
      const stats = (await req('GET', '/api/jobs', { cookie: cookies.alice })).body.workers;
      assert.equal(stats.can_replace, 0);
      assert.equal(stats.online, 1);
      await old.disconnect();

      const fresh = await connectWorker(tok.bob, 'new-box').ready;
      const job = await fresh.nextJob();
      assert.equal(job.id, made.body.job.id);
      assert.deepEqual(job.replace, { song_id: song.id, title: song.title, artist: song.artist, album: song.album });
      assert.equal(job.no_playlist, true);
      fresh.send({ type: 'drain' });
      fresh.send({ type: 'job:release', job_id: job.id, reason: 'test' });
      await until(async () => (await myJob('alice', made.body.job.id)).status !== 'assigned', 'released');
      await req('POST', `/api/jobs/${made.body.job.id}/cancel`, { cookie: cookies.alice });
      await fresh.disconnect();
    });

    it('a worker\'s upload replaces the song: the job\'s details and video, duration from the file, reports closed, old file gone, players told', async () => {
      const song = await makeSong();
      const video = NEW_VIDEO();
      const old = await songRow(song.id);
      await req('POST', `/api/library/${song.id}/report`, { cookie: cookies.bob, body: { reason: 'wrong' } });
      const made = await replaceJob('alice', song, watch(video), { title: 'Kept Title' });
      const s = await socketFor('alice');
      const events = [];
      const jobEvents = [];
      s.on('library:updated', (p) => events.push(p));
      s.on('jobs:update', (p) => jobEvents.push(p.job));
      const w = await connectWorker(tok.bob, 'flow-box').ready;
      const job = await w.nextJob();
      assert.equal((await songRow(song.id)).sha256, old.sha256, 'old audio until done');
      assert.equal((await songRow(song.id)).title, song.title, 'edited details wait for the job too');

      w.send({ type: 'job:progress', job_id: job.id, stage: 'uploading', message: 'Uploading x… 42%' });
      await until(() => jobEvents.find((j) => j.progress === 'Uploading x… 42%'), 'progress');

      const up = await workerUpload(w, job);
      assert.equal(up.status, 200, JSON.stringify(up.body));
      assert.equal(up.body.song.id, song.id);
      assert.equal(up.body.song.title, 'Kept Title', 'not the video\'s title');
      assert.equal(up.body.song.artist, song.artist);
      assert.equal(up.body.song.album, song.album);
      assert.equal(up.body.song.youtube_id, video);
      assert.equal(up.body.song.source_url, watch(video));
      assert.ok(up.body.song.duration_sec > 2 && up.body.song.duration_sec < 4, `from the file, got ${up.body.song.duration_sec}`);
      assert.equal(up.body.resolved_reports, 1);
      assert.ok(!fs.existsSync(old.file_path));

      const done = await until(async () => { const j = await myJob('alice', job.id); return j.status === 'done' ? j : null; }, 'done');
      assert.equal(done.song.id, song.id);
      assert.equal(done.worker.name, 'flow-box');
      await until(() => events.find((p) => p.replaced && p.replaced.id === song.id), 'library:updated replaced');

      // A late report from the worker changes nothing, and it is free again.
      w.send({ type: 'job:done', job_id: job.id, result: { summary: { total: 1, failed: 1 }, results: [{ status: 'failed', error: 'late' }] } });
      await tick(100);
      assert.equal((await myJob('alice', job.id)).status, 'done');

      const audit = (await pg.query(`SELECT * FROM library_song_replacements WHERE song_id = $1 AND kind = 'audio'`, [song.id])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].job_id, job.id);
      assert.equal(audit[0].worker_name, 'flow-box');
      assert.equal(audit[0].requested_by, 'Alice');
      assert.equal(audit[0].replaced_by, 'Bob');
      assert.equal((await songRow(song.id)).meta_key !== old.meta_key, true);
      assert.equal(await until(async () => (await pg.query(`SELECT count(*)::int AS n FROM library_songs WHERE youtube_id = 'dQw4w9WgXcQ'`)).rows[0].n === 0, 'no new song'), true);
      await w.disconnect();
    });

    it('a details edit while the job waits is what the job keeps', async () => {
      const song = await makeSong();
      const made = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const edit = await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.bob, body: { title: 'Edited Meanwhile' } });
      assert.equal(edit.status, 200);
      assert.equal((await myJob('alice', made.body.job.id)).replace.title, 'Edited Meanwhile');
      const w = await connectWorker(tok.bob, 'edit-box').ready;
      const job = await w.nextJob();
      assert.equal(job.replace.title, 'Edited Meanwhile');
      const up = await workerUpload(w, job);
      assert.equal(up.body.song.title, 'Edited Meanwhile');
      await w.disconnect();
    });

    it('refuses what a worker must not do: an ordinary upload for the job, another song, a job it does not hold', async () => {
      const a = await makeSong();
      const b = await makeSong();
      const count = async () => (await pg.query('SELECT count(*)::int AS n FROM library_songs')).rows[0].n;
      const made = await replaceJob('alice', a, watch(NEW_VIDEO()));
      const w = await connectWorker(tok.bob, 'strict-box').ready;
      const job = await w.nextJob();
      const n = await count();
      const plain = await multipart('/api/library/upload', {
        token: tok.bob, file: tone(), fields: { title: 'Dup', artist: 'Dup', youtube_id: 'dupdupdup01', job_id: job.id, worker_id: w.id },
      });
      assert.equal(plain.status, 409);
      assert.equal(plain.body.code, 'replace_job_upload');
      assert.equal(await count(), n, 'no new song');
      const wrong = await multipart(`/api/library/${b.id}/replace`, { token: tok.bob, file: tone(), fields: { title: 'T', artist: 'A', job_id: job.id, worker_id: w.id } });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.code, 'replace_job_stale');
      const foreign = await multipart(`/api/library/${a.id}/replace`, { token: tok.alice, file: tone(), fields: { title: 'T', artist: 'A', job_id: job.id, worker_id: w.id } });
      assert.equal(foreign.status, 409, 'another owner\'s worker id');
      w.send({ type: 'drain' });
      w.send({ type: 'job:release', job_id: job.id, reason: 'test' });
      await until(async () => (await myJob('alice', made.body.job.id)).status !== 'assigned', 'released');
      await req('POST', `/api/jobs/${made.body.job.id}/cancel`, { cookie: cookies.alice });
      await w.disconnect();
    });

    it('a duplicate file is a failed job with a clear error, and nothing changes; retry works', async () => {
      const a = await makeSong();
      const file = tone(2);
      const clash = await multipart('/api/library/upload', { token: tok.alice, file, fields: { title: 'Has this file', artist: 'Band', youtube_id: 'hasthisfile' } });
      assert.equal(clash.status, 201);
      const before = await songRow(a.id);
      const made = await replaceJob('alice', a, watch(NEW_VIDEO()));
      const w = await connectWorker(tok.bob, 'dup-box').ready;
      const job = await w.nextJob();
      const up = await workerUpload(w, job, { file });
      assert.equal(up.status, 409);
      assert.equal(up.body.code, 'duplicate_hash');
      // What the CLI reports for that upload.
      w.send({ type: 'job:done', job_id: job.id, result: { summary: { total: 1, failed: 1 }, results: [{ status: 'failed', code: up.body.code, error: up.body.error }] } });
      const failed = await until(async () => { const j = await myJob('alice', job.id); return j.status === 'failed' ? j : null; }, 'failed');
      assert.equal(failed.error_code, 'duplicate_hash');
      assert.match(failed.error_message, /another song/);
      const after = await songRow(a.id);
      assert.equal(after.sha256, before.sha256);
      assert.equal(after.title, before.title);
      assert.equal(after.youtube_id, before.youtube_id);

      const retried = await req('POST', `/api/jobs/${job.id}/retry`, { cookie: cookies.alice });
      assert.equal(retried.status, 200, retried.text);
      const again = await w.nextJob(2);
      assert.equal(again.id, job.id);
      assert.equal(again.replace.song_id, a.id);
      const ok = await workerUpload(w, again);
      assert.equal(ok.status, 200);
      await w.disconnect();
      assert.equal((await myJob('alice', made.body.job.id)).status, 'done');
    });

    it('a retry while another job is active for the song is refused', async () => {
      const song = await makeSong();
      const one = await replaceJob('alice', song, watch(NEW_VIDEO()));
      await req('POST', `/api/jobs/${one.body.job.id}/cancel`, { cookie: cookies.alice });
      const two = await replaceJob('bob', song, watch(NEW_VIDEO()));
      assert.equal(two.status, 201);
      const retry = await req('POST', `/api/jobs/${one.body.job.id}/retry`, { cookie: cookies.alice });
      assert.equal(retry.status, 409);
      await req('POST', `/api/jobs/${two.body.job.id}/cancel`, { cookie: cookies.bob });
    });

    it('a worker that says a job ended with an upload, not a replace, has failed it', async () => {
      const song = await makeSong();
      const made = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const w = await connectWorker(tok.bob, 'odd-box').ready;
      const job = await w.nextJob();
      w.send({ type: 'job:done', job_id: job.id, result: { summary: { total: 1, uploaded: 1 }, results: [{ status: 'uploaded' }] } });
      const j = await until(async () => { const x = await myJob('alice', made.body.job.id); return x.status === 'failed' ? x : null; }, 'failed');
      assert.equal(j.status, 'failed');
      await w.disconnect();
    });

    it('a file by hand drops a waiting job; while a job runs it is refused', async () => {
      const song = await makeSong();
      const made = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const up = await multipart(`/api/library/${song.id}/replace`, { cookie: cookies.bob, file: tone(), fields: { title: song.title, artist: song.artist } });
      assert.equal(up.status, 200, JSON.stringify(up.body));
      const dropped = await myJob('alice', made.body.job.id);
      assert.equal(dropped.status, 'cancelled');
      assert.match(dropped.progress, /uploaded file/);

      const next = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const w = await connectWorker(tok.bob, 'busy-box').ready;
      const job = await w.nextJob();
      assert.equal(job.id, next.body.job.id);
      const refused = await multipart(`/api/library/${song.id}/replace`, { cookie: cookies.bob, file: tone(), fields: { title: song.title, artist: song.artist } });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'replace_job_active');
      const stillOk = await workerUpload(w, job);
      assert.equal(stillOk.status, 200);
      await w.disconnect();
    });

    it('the song deleted: waiting and running jobs fail cleanly, a late upload is refused, no song comes back', async () => {
      const admin = adminCookie();
      const song = await makeSong();
      const waiting = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const del = await req('DELETE', `/api/admin/library/${song.id}`, { cookie: admin });
      assert.equal(del.status, 200, del.text);
      const failed = await until(async () => { const j = await myJob('alice', waiting.body.job.id); return j.status === 'failed' ? j : null; }, 'failed');
      assert.equal(failed.error_code, 'SONG_DELETED');
      // Retrying it fails again, without bothering a worker.
      const retry = await req('POST', `/api/jobs/${waiting.body.job.id}/retry`, { cookie: cookies.alice });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.job.status, 'failed');
      assert.equal(retry.body.job.error_code, 'SONG_DELETED');

      const song2 = await makeSong();
      const running = await replaceJob('alice', song2, watch(NEW_VIDEO()));
      const w = await connectWorker(tok.bob, 'del-box').ready;
      const job = await w.nextJob();
      assert.equal(job.id, running.body.job.id);
      await req('DELETE', `/api/admin/library/${song2.id}`, { cookie: admin });
      await until(async () => (await myJob('alice', job.id)).status === 'failed', 'running job failed');
      const late = await workerUpload(w, job);
      assert.equal(late.status, 409);
      assert.equal(late.body.code, 'replace_job_stale');
      assert.equal(await songRow(song2.id), undefined);
      await w.disconnect();

      // Deleted behind the server's back (no hook): dispatch notices.
      const song3 = await makeSong();
      const gone = await replaceJob('alice', song3, watch(NEW_VIDEO()));
      await pg.query('DELETE FROM library_songs WHERE id = $1', [song3.id]);
      const w2 = await connectWorker(tok.bob, 'del-box-2').ready;
      await until(async () => (await myJob('alice', gone.body.job.id)).status === 'failed', 'dispatch failed it');
      assert.equal(w2.jobs.length, 0);
      await w2.disconnect();
    });

    it('a reconnecting worker reclaims it; a worker that vanishes loses it to another; an old one cannot reclaim it', async () => {
      const song = await makeSong();
      const made = await replaceJob('alice', song, watch(NEW_VIDEO()));
      const w = await connectWorker(tok.bob, 'net-box').ready;
      const job = await w.nextJob();
      await w.disconnect();
      const back = await connectWorker(tok.bob, 'net-box', { current_job_id: job.id }).ready;
      assert.equal((await myJob('alice', job.id)).status, 'assigned');
      await tick(450); // past the grace
      assert.equal((await myJob('alice', job.id)).status, 'assigned', 'still running on the reconnected worker');
      assert.equal((await workerUpload(back, job)).status, 200);
      await back.disconnect();

      const song2 = await makeSong();
      const made2 = await replaceJob('alice', song2, watch(NEW_VIDEO()));
      const gone = await connectWorker(tok.bob, 'gone-box').ready;
      const job2 = await gone.nextJob();
      await gone.disconnect();
      await until(async () => (await myJob('alice', made2.body.job.id)).status === 'queued', 'requeued');
      const old = await connectWorker(tok.bob, 'old-box-2', { capabilities: null, current_job_id: job2.id }).ready;
      await tick(100);
      const row = (await pg.query('SELECT worker_name, status FROM download_jobs WHERE id = $1', [job2.id])).rows[0];
      assert.equal(row.status, 'queued', 'an old worker cannot claim a replace job');
      await old.disconnect();
      const next = await connectWorker(tok.bob, 'next-box').ready;
      const again = await next.nextJob();
      assert.equal(again.id, job2.id);
      assert.equal(again.replace.song_id, song2.id);
      assert.equal((await workerUpload(next, again)).status, 200);
      await next.disconnect();
      assert.equal((await myJob('alice', made.body.job.id)).status, 'done');
    });

    it('a restart keeps waiting jobs and requeues running ones, with their song and details', async () => {
      const a = await makeSong();
      const b = await makeSong();
      const running = await replaceJob('alice', a, watch(NEW_VIDEO()), { title: 'Through a Restart' });
      const w = await connectWorker(tok.bob, 'restart-box').ready;
      const job = await w.nextJob();
      assert.equal(job.id, running.body.job.id);
      const waiting = await replaceJob('alice', b, watch(NEW_VIDEO()));
      await w.disconnect();
      await srv.stop();
      await boot();
      for (const id of [running.body.job.id, waiting.body.job.id]) {
        assert.equal((await myJob('alice', id)).status, 'queued');
      }
      const blocked = await replaceJob('bob', a, watch(NEW_VIDEO()));
      assert.equal(blocked.body.code, 'replace_job_active', 'still one active job per song');
      await req('POST', `/api/jobs/${waiting.body.job.id}/cancel`, { cookie: cookies.alice });
      const after = await connectWorker(tok.bob, 'restart-box').ready;
      const again = await after.nextJob();
      assert.equal(again.replace.title, 'Through a Restart');
      const up = await workerUpload(after, again);
      assert.equal(up.status, 200);
      assert.equal(up.body.song.title, 'Through a Restart');
      await after.disconnect();
    });

    it('profile activity and the dashboard show replace jobs; requester and worker only by name', async () => {
      const song = await makeSong();
      const made = await replaceJob('bob', song, watch(NEW_VIDEO()));
      const act = await req('GET', '/api/profile/activity', { cookie: cookies.bob });
      assert.equal(act.status, 200, act.text);
      const row = act.body.downloads.find((j) => j.id === made.body.job.id);
      assert.ok(row);
      assert.equal(row.replace.song_id, song.id);
      assert.ok(act.body.counts.downloads >= 1);
      const theirs = await req('GET', '/api/profile/activity', { cookie: cookies.alice });
      assert.ok(!theirs.body.downloads.some((j) => j.id === made.body.job.id));
      const adm = await req('GET', '/api/admin/jobs?status=active', { cookie: adminCookie() });
      assert.ok(adm.body.jobs.find((j) => j.id === made.body.job.id).replace);
      assert.equal(await req('GET', `/api/library/${song.id}/replacements`, { cookie: cookies.alice }).then((r) => r.status), 200);
      await req('POST', `/api/jobs/${made.body.job.id}/cancel`, { cookie: cookies.bob });
    });

    it('the replacements history carries names, not account or token ids', async () => {
      const song = await makeSong();
      await req('PATCH', `/api/library/${song.id}`, { cookie: cookies.bob, body: { title: 'History' } });
      const r = await req('GET', `/api/library/${song.id}/replacements`, { cookie: cookies.alice });
      assert.equal(r.body.replacements[0].replaced_by, 'Bob');
      assert.equal(r.body.replacements[0].kind, 'details');
      assert.ok(!('replaced_by_user_id' in r.body.replacements[0]));
      assert.ok(!('replaced_by_token' in r.body.replacements[0]));
    });
  });

  describe('migration', () => {
    it('adds the columns and the index to a database from before them, keeping its rows', async () => {
      await srv.stop();
      const song = await pg.query('SELECT id FROM library_songs LIMIT 1');
      await pg.query(`INSERT INTO download_jobs (source, kind, input, status) VALUES ('web', 'video', 'https://www.youtube.com/watch?v=preexisting1', 'queued')`);
      await pg.query('DROP INDEX IF EXISTS idx_download_jobs_replace_active');
      for (const c of ['replace_song_id', 'replace_title', 'replace_artist', 'replace_album']) await pg.query(`ALTER TABLE download_jobs DROP COLUMN ${c} CASCADE`);
      for (const c of ['kind', 'job_id', 'worker_name', 'requested_by']) await pg.query(`ALTER TABLE library_song_replacements DROP COLUMN ${c}`);
      const old = (await pg.query(`SELECT count(*)::int AS n FROM library_song_replacements`)).rows[0].n;
      await boot();
      const cols = (await pg.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('download_jobs', 'library_song_replacements')`)).rows.map((r) => `${r.table_name}.${r.column_name}`);
      for (const c of ['download_jobs.replace_song_id', 'download_jobs.replace_title', 'download_jobs.replace_artist', 'download_jobs.replace_album',
        'library_song_replacements.kind', 'library_song_replacements.job_id', 'library_song_replacements.worker_name', 'library_song_replacements.requested_by']) {
        assert.ok(cols.includes(c), c);
      }
      const idx = await pg.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_download_jobs_replace_active'`);
      assert.equal(idx.rows.length, 1);
      const kinds = (await pg.query(`SELECT count(*)::int AS n FROM library_song_replacements WHERE kind = 'audio'`)).rows[0].n;
      assert.equal(kinds, old, 'old audit rows read as audio');
      const made = await makeSong();
      const r = await replaceJob('alice', made, watch(NEW_VIDEO()));
      assert.equal(r.status, 201, r.text);
      assert.ok(song.rows.length);
      await req('POST', `/api/jobs/${r.body.job.id}/cancel`, { cookie: cookies.alice });
    });
  });
});
