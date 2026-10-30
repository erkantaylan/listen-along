// Download workers and jobs, against the real server on Postgres
// (testcontainers), with workers speaking the WebSocket protocol through
// Node's built-in WebSocket:
//   - routing: own idle worker first, busy -> any idle, none -> queued and
//     dispatched when a worker connects; one job at a time per worker
//   - jobs persist (restart), requeue when the worker disconnects mid-job,
//     a reconnecting worker reclaims its job
//   - song requests create jobs; uploads record worker, owner and requester;
//     a web job's songs land in the chosen playlist
//   - failures carry the CLI error code; cancel / retry; permissions
//   - worker IP / OS / hostname only for admins; profile activity owner-only
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { cookieFor, adminCookie, startServer, requester } = require('./testServer');
const { planAssignments } = require('./workerHub');
const downloadJobs = require('./downloadJobs');

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

describe('planAssignments (routing rules)', () => {
  const w = (name, userId, idleSince = 0) => ({ name, userId, idleSince });
  const j = (id, requester) => ({ id, requested_by_user_id: requester });

  it('prefers the requester\'s own idle worker', () => {
    const plan = planAssignments([j('1', 'bob')], [w('A', 'alice', 1), w('B', 'bob', 2)]);
    assert.deepEqual(plan.map((p) => [p.job.id, p.worker.name]), [['1', 'B']]);
  });
  it('requester has no idle worker -> the longest-idle worker of anyone', () => {
    const plan = planAssignments([j('1', 'carol')], [w('A', 'alice', 5), w('B', 'bob', 2)]);
    assert.deepEqual(plan.map((p) => p.worker.name), ['B']);
  });
  it('own-worker matches first, then the rest oldest first; extra jobs wait', () => {
    const plan = planAssignments([j('1', 'carol'), j('2', 'alice'), j('3', 'dave')], [w('A', 'alice', 1), w('B', 'bob', 2)]);
    assert.deepEqual(plan.map((p) => [p.job.id, p.worker.name]), [['2', 'A'], ['1', 'B']]);
  });
  it('no idle workers -> nothing assigned', () => {
    assert.deepEqual(planAssignments([j('1', 'alice')], []), []);
  });
});

describe('downloadJobs input rules', () => {
  it('classifies Download box input', () => {
    assert.equal(downloadJobs.classifyInput('https://youtu.be/dQw4w9WgXcQ').kind, 'video');
    assert.equal(downloadJobs.classifyInput('https://www.youtube.com/playlist?list=PLabc').kind, 'playlist');
    assert.equal(downloadJobs.classifyInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ').kind, 'video');
    assert.equal(downloadJobs.classifyInput('https://open.spotify.com/track/abc').kind, 'spotify');
    assert.equal(downloadJobs.classifyInput('Daft Punk - Digital Love').kind, 'search');
    assert.ok(downloadJobs.classifyInput('https://soundcloud.com/x/y').error);
    assert.ok(downloadJobs.classifyInput('   ').error);
  });
  it('turns a song request into a YouTube video or a search, never another site', () => {
    assert.equal(downloadJobs.requestInput({ youtube_id: 'dQw4w9WgXcQ' }).input, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.deepEqual(downloadJobs.requestInput({ url: 'https://open.spotify.com/track/x', title: 'Song', artist: 'Band' }), { input: 'Band - Song', kind: 'search', title: 'Band - Song' });
    assert.equal(downloadJobs.requestInput({}), null);
  });
});

describe('download workers and jobs on Postgres', { skip, timeout: 240_000 }, () => {
  let container;
  let dbUrl;
  let pg;
  let srv;
  let req;
  let tmp;
  const ids = {};
  const cookies = {};
  const tok = {};
  const workers = [];
  const sockets = [];
  let toneN = 0;

  async function boot() {
    srv = await startServer({
      DATABASE_URL: dbUrl, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers'),
      WORKER_REQUEUE_GRACE_MS: '300', WORKER_HEARTBEAT_MS: '60000',
    });
    req = requester(srv.base);
  }

  /** A worker process stand-in speaking the protocol. */
  function connectWorker(token, name, extra = {}) {
    const ws = new WebSocket(srv.base.replace(/^http/, 'ws') + '/api/workers/connect');
    const w = { ws, name, messages: [], jobs: [], closed: null };
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      w.messages.push(msg);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (msg.type === 'job') w.jobs.push(msg.job);
      if (msg.type === 'welcome') w.id = msg.worker.id;
    });
    ws.addEventListener('close', (ev) => { w.closed = ev.code; });
    w.ready = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({
        type: 'hello', protocol: 1, token, name, hostname: `${name}.lan`, platform: 'linux', arch: 'x64',
        os_release: 'Linux 6.1', cli_version: '0.1.0', node_version: '24.0.0', ytdlp_version: '2026.10.26', ...extra,
      })));
      const check = setInterval(() => {
        if (w.id) { clearInterval(check); resolve(w); }
        if (w.closed !== null) { clearInterval(check); reject(new Error(`closed ${w.closed}`)); }
      }, 10);
    });
    w.send = (m) => ws.send(JSON.stringify(m));
    w.nextJob = (n = 1) => until(() => w.jobs.length >= n && w.jobs[n - 1], `${name} job #${n}`);
    workers.push(w);
    return w;
  }

  function tone(freq) {
    const file = path.join(tmp, `tone-${toneN++}.m4a`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=1`, '-c:a', 'aac', file]);
    return file;
  }

  async function uploadAs(token, fields) {
    const f = new FormData();
    f.append('file', new Blob([fs.readFileSync(tone(300 + toneN * 37))], { type: 'audio/mp4' }), 'x.m4a');
    for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
    const res = await fetch(`${srv.base}/api/library/upload`, { method: 'POST', body: f, headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  }

  const done = (w, jobId, songIds = [], extra = {}) => w.send({
    type: 'job:done', job_id: jobId,
    result: { summary: { total: 1, uploaded: songIds.length, skipped: 0, failed: songIds.length ? 0 : 1 }, results: songIds.map((id) => ({ status: 'uploaded', song_id: id })), ...extra },
  });
  const myJobs = async (who) => (await req('GET', '/api/jobs', { cookie: cookies[who] })).body.jobs;
  const job = async (who, id) => (await myJobs(who)).find((j) => j.id === id);
  const create = async (who, body) => req('POST', '/api/jobs', { cookie: cookies[who], body });

  function socketFor(who) {
    const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { cookie: cookies[who] } });
    sockets.push(s);
    return new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject); });
  }

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_workers').withUsername('test').withPassword('test').start();
    dbUrl = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-workers-'));
    await boot();
    const { Client } = require('pg');
    pg = new Client({ connectionString: dbUrl });
    await pg.connect();
    for (const key of ['alice', 'bob', 'carol']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $3, 'approved', 1) RETURNING id`,
        [key, key, key[0].toUpperCase() + key.slice(1)]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    for (const who of ['alice', 'bob', 'carol']) {
      const r = await req('POST', '/api/tokens', { cookie: cookies[who], body: { label: 'CLI' } });
      assert.equal(r.status, 201);
      tok[who] = r.body.token;
    }
  });

  after(async () => {
    for (const w of workers) { try { w.ws.close(); } catch {} }
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const closeAll = async () => {
    for (const w of workers.splice(0)) { try { w.ws.close(); } catch {} }
    await until(async () => (await req('GET', '/api/workers', { cookie: cookies.alice })).body.online === 0, 'no workers online');
  };

  it('validates input and needs an approved login', async () => {
    assert.equal((await req('POST', '/api/jobs', { body: { input: 'x' } })).status, 401);
    let r = await create('alice', { input: '' });
    assert.equal(r.status, 400);
    r = await create('alice', { input: 'https://soundcloud.com/x/y' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'BAD_INPUT');
    r = await create('alice', { input: 'Some song', playlist_id: 'nope1234' });
    assert.equal(r.status, 404);
  });

  it('no worker online -> job waits queued; dispatched when a worker connects (one at a time)', async () => {
    const r1 = await create('alice', { input: 'Daft Punk - Digital Love' });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.job.status, 'queued');
    assert.equal(r1.body.workers.online, 0);
    const r2 = await create('alice', { input: 'Massive Attack - Teardrop' });
    assert.equal(r2.status, 201);
    assert.equal((await job('alice', r1.body.job.id)).status, 'queued');
    assert.equal((await myJobs('bob')).length, 0, 'jobs are listed to their requester only');

    const w = connectWorker(tok.bob, 'bob-pc');
    await w.ready;
    const first = await w.nextJob();
    assert.equal(first.id, r1.body.job.id, 'oldest first');
    assert.equal(first.input, 'Daft Punk - Digital Love');
    assert.equal(first.no_playlist, true);
    assert.equal(first.requested_by, 'Alice');
    assert.equal(first.playlist_id, undefined, 'workers do not learn playlist ids');
    await tick(150);
    assert.equal(w.jobs.length, 1, 'one job at a time');
    let j = await job('alice', first.id);
    assert.equal(j.status, 'assigned');
    assert.deepEqual(j.worker, { name: 'bob-pc', owner: 'Bob' });

    w.send({ type: 'job:progress', job_id: first.id, stage: 'downloading', message: 'Downloading Daft Punk - Digital Love…' });
    j = await until(async () => { const x = await job('alice', first.id); return x.stage === 'downloading' && x; }, 'progress');
    assert.match(j.progress, /Downloading/);

    // A failure carries the CLI's code.
    done(w, first.id, [], { results: [{ status: 'failed', code: 'AGE_RESTRICTED', error: 'Age-restricted video' }] });
    j = await until(async () => { const x = await job('alice', first.id); return x.status === 'failed' && x; }, 'failed');
    assert.equal(j.error_code, 'AGE_RESTRICTED');
    const second = await w.nextJob(2);
    assert.equal(second.id, r2.body.job.id, 'the next one follows when the worker is idle again');
    done(w, second.id, [], { results: [{ status: 'failed', code: 'NOT_FOUND', error: 'No search results' }] });
    await until(async () => (await job('alice', second.id)).status === 'failed', 'second failed');

    // Retry (requester only) puts it back; bob cannot retry alice's job.
    assert.equal((await req('POST', `/api/jobs/${first.id}/retry`, { cookie: cookies.bob })).status, 409);
    const rr = await req('POST', `/api/jobs/${first.id}/retry`, { cookie: cookies.alice });
    assert.equal(rr.status, 200);
    const again = await w.nextJob(3);
    assert.equal(again.id, first.id);
    done(w, again.id, [], { results: [{ status: 'failed', code: 'AGE_RESTRICTED', error: 'x' }] });
    await until(async () => (await job('alice', first.id)).status === 'failed', 'failed again');
    await closeAll();
  });

  it('routing: own idle worker first; busy -> another idle worker', async () => {
    const wa = connectWorker(tok.alice, 'alice-pc');
    const wb = connectWorker(tok.bob, 'bob-pc');
    await Promise.all([wa.ready, wb.ready]);
    const rb = await create('bob', { input: 'Bob song' });
    const jb = await wb.nextJob();
    assert.equal(jb.id, rb.body.job.id, 'bob\'s job went to bob\'s worker');
    assert.equal(wa.jobs.length, 0);
    // Bob's worker is busy now: bob's next job goes to alice's idle worker.
    const rb2 = await create('bob', { input: 'Bob song 2' });
    const ja = await wa.nextJob();
    assert.equal(ja.id, rb2.body.job.id);
    // Both busy: carol's job waits.
    const rc = await create('carol', { input: 'Carol song' });
    await tick(150);
    assert.equal((await job('carol', rc.body.job.id)).status, 'queued');
    done(wa, ja.id);
    const jc = await wa.nextJob(2);
    assert.equal(jc.id, rc.body.job.id, 'dispatched as soon as a worker is idle');
    done(wa, jc.id);
    done(wb, jb.id);
    await closeAll();
  });

  it('requeues a job whose worker disconnects; a worker that comes back reclaims its job', async () => {
    const wa = connectWorker(tok.alice, 'alice-pc');
    await wa.ready;
    const r = await create('carol', { input: 'Lost song' });
    const j1 = await wa.nextJob();
    assert.equal(j1.id, r.body.job.id);

    // Comes back at once naming the job: keeps it.
    wa.ws.close();
    const wa2 = connectWorker(tok.alice, 'alice-pc', { current_job_id: j1.id });
    await wa2.ready;
    await tick(500); // past the grace period
    let j = await job('carol', j1.id);
    assert.equal(j.status, 'assigned');
    assert.equal(j.worker.name, 'alice-pc');

    // Gone for good: after the grace period it goes to another worker.
    const wb = connectWorker(tok.bob, 'bob-pc');
    await wb.ready;
    wa2.ws.close();
    const moved = await wb.nextJob();
    assert.equal(moved.id, j1.id);
    j = await job('carol', j1.id);
    assert.equal(j.status, 'assigned');
    assert.equal(j.worker.name, 'bob-pc');
    assert.equal(j.attempts, 2);
    done(wb, moved.id);
    await closeAll();
  });

  it('a second process with the same worker name replaces the first (close 4003); bad token -> 4001', async () => {
    const w1 = connectWorker(tok.alice, 'same');
    await w1.ready;
    const w2 = connectWorker(tok.alice, 'same');
    await w2.ready;
    await until(() => w1.closed === 4003, 'first replaced');
    assert.equal(w1.id, w2.id, 'same worker row');
    const bad = connectWorker('la_nope', 'x');
    await assert.rejects(bad.ready, /closed 4001/);
    await closeAll();
  });

  it('web job with a target playlist: upload records worker / owner / requester; the song lands in the playlist', async () => {
    const created = await req('POST', '/api/playlists', { cookie: cookies.carol, body: { name: 'Carol private', visibility: 'private' } });
    assert.equal(created.status, 201);
    const plId = created.body.id;
    // Bob cannot target carol's private playlist.
    assert.equal((await create('bob', { input: 'x', playlist_id: plId })).status, 404);

    const wb = connectWorker(tok.bob, 'bob-pc');
    await wb.ready;
    const r = await create('carol', { input: 'https://www.youtube.com/watch?v=cccccccccc1', playlist_id: plId });
    assert.equal(r.status, 201);
    assert.equal(r.body.job.kind, 'video');
    assert.equal(r.body.job.playlist_name, 'Carol private');
    const j = await wb.nextJob();
    assert.equal(j.input, 'https://www.youtube.com/watch?v=cccccccccc1');
    // Bob's token uploads as bob's worker for this job.
    const up = await uploadAs(tok.bob, { title: 'Carol Song', artist: 'Band', youtube_id: 'cccccccccc1', job_id: j.id, worker_id: wb.id });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.song.uploaded_by, 'Bob');
    assert.equal(up.body.song.uploaded_by_worker, 'bob-pc');
    assert.equal(up.body.song.requested_by, 'Carol');
    const row = (await pg.query('SELECT uploaded_by_user_id, uploaded_by_worker_id, requested_by_user_id, upload_job_id FROM library_songs WHERE id = $1', [up.body.song.id])).rows[0];
    assert.deepEqual(row, { uploaded_by_user_id: ids.bob, uploaded_by_worker_id: wb.id, requested_by_user_id: ids.carol, upload_job_id: j.id });
    // In the playlist already (added at upload time), and only once after job:done.
    const inPlaylist = async () => (await req('GET', `/api/playlists/${plId}/songs`, { cookie: cookies.carol })).body.songs;
    await until(async () => (await inPlaylist()).length === 1, 'song in playlist');
    done(wb, j.id, [up.body.song.id]);
    const finished = await until(async () => { const x = await job('carol', j.id); return x.status === 'done' && x; }, 'done');
    assert.equal(finished.song.title, 'Carol Song');
    await tick(200);
    assert.equal((await inPlaylist()).length, 1);

    // A worker id that is not the token's own is ignored (no fake credit).
    const up2 = await uploadAs(tok.alice, { title: 'Alice Song', artist: 'Band', worker_id: wb.id });
    assert.equal(up2.status, 201);
    assert.equal(up2.body.song.uploaded_by_worker, null);

    // The same video again: already in the library, nothing to download.
    const again = await create('alice', { input: 'https://youtu.be/cccccccccc1' });
    assert.equal(again.status, 200);
    assert.equal(again.body.job, null);
    assert.equal(again.body.existing.title, 'Carol Song');
    await closeAll();
  });

  it('a song request creates a job; the upload fulfils it and adds it to the requesting playlist', async () => {
    const s = await socketFor('alice');
    s.emit('lobby:create', { name: 'Alice list' });
    const created = await new Promise((resolve) => s.once('lobby:created', resolve));
    const updates = [];
    s.on('jobs:update', (p) => updates.push(p.job));
    // A YouTube link with a title: no network lookup on the server.
    s.emit('queue:add', { lobbyId: created.lobbyId, url: 'https://youtu.be/rrrrrrrrrr1', title: 'Requested Song' });
    const requested = await new Promise((resolve) => s.once('queue:requested', resolve));
    const jq = await until(async () => (await myJobs('alice')).find((x) => x.request_id === requested.request.id), 'request job');
    assert.equal(jq.source, 'request');
    assert.equal(jq.status, 'queued');
    assert.equal(jq.input, 'https://www.youtube.com/watch?v=rrrrrrrrrr1');

    const wb = connectWorker(tok.bob, 'bob-pc');
    await wb.ready;
    const j = await wb.nextJob();
    assert.equal(j.id, jq.id);
    assert.equal(j.request_id, requested.request.id);
    // The upload names only the job: the server supplies the request id.
    const up = await uploadAs(tok.bob, { title: 'Requested Song', artist: 'Someone', youtube_id: 'rrrrrrrrrr1', job_id: j.id, worker_id: wb.id });
    assert.equal(up.status, 201);
    assert.deepEqual(up.body.fulfilled_requests, [requested.request.id]);
    const queue = await new Promise((resolve) => {
      const h = (p) => { if (p.songs.some((x) => x.url.includes('rrrrrrrrrr1'))) { s.off('queue:update', h); resolve(p.songs); } };
      s.on('queue:update', h);
    });
    assert.equal(queue.filter((x) => x.url.includes('rrrrrrrrrr1')).length, 1);
    done(wb, j.id, [up.body.song.id]);
    await until(() => updates.some((u) => u.id === j.id && u.status === 'done'), 'live done update');
    assert.ok(updates.some((u) => u.id === j.id && u.status === 'assigned' && u.worker && u.worker.name === 'bob-pc'), 'live "downloading on" update');
    await closeAll();
  });

  it('worker machine details are admin-only; admin sees workers and the queue', async () => {
    const wa = connectWorker(tok.alice, 'alice-pc');
    await wa.ready;
    const pub = await req('GET', '/api/workers', { cookie: cookies.bob });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.online, 1);
    assert.deepEqual(Object.keys(pub.body.workers[0]).sort(), ['busy', 'id', 'name', 'owner']);
    const text = JSON.stringify(pub.body) + JSON.stringify(await myJobs('carol')) + JSON.stringify((await req('GET', '/api/library', { cookie: cookies.bob })).body)
      + JSON.stringify((await req('GET', '/api/profile/activity', { cookie: cookies.bob })).body);
    for (const secret of ['alice-pc.lan', 'Linux 6.1', '127.0.0.1', '::1', '"platform"', 'last_ip']) assert.ok(!text.includes(secret), `leaked ${secret}`);

    assert.equal((await req('GET', '/api/admin/workers', { cookie: cookies.alice })).status, 401);
    assert.equal((await req('GET', '/api/admin/jobs', { cookie: cookies.alice })).status, 401);
    const adm = await req('GET', '/api/admin/workers', { cookie: adminCookie() });
    assert.equal(adm.status, 200);
    const a = adm.body.workers.find((x) => x.name === 'alice-pc');
    assert.equal(a.online, true);
    assert.equal(a.hostname, 'alice-pc.lan');
    assert.equal(a.platform, 'linux');
    assert.equal(a.os_release, 'Linux 6.1');
    assert.equal(a.cli_version, '0.1.0');
    assert.match(a.last_ip, /127\.0\.0\.1|::1/);
    assert.equal(a.owner, 'Alice');
    const bob = adm.body.workers.find((x) => x.name === 'bob-pc');
    assert.equal(bob.online, false);
    assert.ok(bob.jobs_done >= 1);
    const q = await req('GET', '/api/admin/jobs?status=all', { cookie: adminCookie() });
    assert.equal(q.status, 200);
    assert.ok(q.body.counts.failed >= 2);
    assert.ok(q.body.jobs.length >= 5);
    await closeAll();
  });

  it('profile activity: only ever the caller\'s own', async () => {
    assert.equal((await req('GET', '/api/profile/activity')).status, 401);
    const bob = (await req('GET', `/api/profile/activity?user=${ids.carol}`, { cookie: cookies.bob })).body;
    assert.ok(bob.uploaded.length >= 2, 'bob uploaded via his worker');
    assert.ok(bob.uploaded.every((s) => s.title !== 'Alice Song'));
    assert.ok(bob.counts.uploaded_by_workers >= 2);
    const names = bob.fulfilled_by_my_workers.map((s) => [s.title, s.requested_by]);
    assert.deepEqual(names.sort(), [['Carol Song', 'Carol'], ['Requested Song', 'Alice']]);
    assert.ok(bob.workers.some((w) => w.name === 'bob-pc' && w.jobs_done >= 1));
    assert.equal(bob.asked.length, 0);

    const alice = (await req('GET', '/api/profile/activity', { cookie: cookies.alice })).body;
    const asked = alice.asked.find((r) => r.title === 'Requested Song');
    assert.equal(asked.status, 'fulfilled');
    assert.deepEqual(asked.fulfilled_by, { name: 'Bob', worker: 'bob-pc' });
    assert.ok(alice.downloads.length >= 2);
    assert.equal(alice.counts.asked_fulfilled, 1);
  });

  it('jobs persist across a restart; a running job is queued again', async () => {
    const wb = connectWorker(tok.bob, 'bob-pc');
    await wb.ready;
    const r = await create('carol', { input: 'Survivor song' });
    const j = await wb.nextJob();
    assert.equal(j.id, r.body.job.id);
    const r2 = await create('carol', { input: 'Waiting song' });
    await srv.stop();
    await boot();
    const after = await myJobs('carol');
    assert.equal(after.find((x) => x.id === j.id).status, 'queued', 'running job requeued at boot');
    assert.equal(after.find((x) => x.id === r2.body.job.id).status, 'queued');
    // Cancel (requester only, queued only).
    assert.equal((await req('POST', `/api/jobs/${r2.body.job.id}/cancel`, { cookie: cookies.alice })).status, 409);
    assert.equal((await req('POST', `/api/jobs/${r2.body.job.id}/cancel`, { cookie: cookies.carol })).body.job.status, 'cancelled');
    const wa = connectWorker(tok.alice, 'alice-pc');
    await wa.ready;
    assert.equal((await wa.nextJob()).id, j.id);
    done(wa, j.id);
    await tick(150);
    assert.equal(wa.jobs.length, 1, 'the cancelled job is not handed out');
  });
});
