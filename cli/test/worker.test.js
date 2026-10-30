'use strict';

// `la worker` against a stub server: the HTTP library API from helpers.js plus
// a stub of the worker hub's WebSocket protocol (wsStub.js). yt-dlp / ffmpeg
// are the in-process fakes the other tests use.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { startServer, run, tmpDir, fakeYtdlp, fakeMedia, TOKEN } = require('./helpers');
const { attachWsStub } = require('./wsStub');
const tools = require('../src/tools');
const { workerUrl } = require('../src/worker');

const VIDEOS = {
  aaaaaaaaaa1: { title: 'Digital Love', artist: 'Daft Punk', duration: 301 },
  aaaaaaaaaa2: { title: 'Teardrop', artist: 'Massive Attack', duration: 331 },
  agerestrict: { fail: 'Age-restricted', failCode: 'AGE_RESTRICTED' },
};
const SEARCHES = { 'Daft Punk - Digital Love': [{ id: 'aaaaaaaaaa1', title: 'Daft Punk - Digital Love', channel: 'Daft Punk - Topic', duration: 301 }] };
const WORKER_ID = '11111111-2222-3333-4444-555555555555';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Stub hub: records every connection's messages; `onHello(conn, msg)` decides
 * what to answer (default: welcome + hand out the queued jobs one by one).
 */
function stubHub(server, { jobs = [] } = {}) {
  const hub = { conns: [], messages: [], jobs: [...jobs], onHello: null, done: [] };
  attachWsStub(server.server, '/api/workers/connect', (ws) => {
    const conn = { ws, messages: [], hello: null };
    hub.conns.push(conn);
    ws.on('message', (msg) => {
      conn.messages.push(msg);
      hub.messages.push(msg);
      if (msg.type === 'hello') {
        conn.hello = msg;
        if (hub.onHello) return hub.onHello(conn, msg);
        if (msg.token !== TOKEN) return ws.close(4001, 'bad token');
        ws.send({ type: 'welcome', worker: { id: WORKER_ID, name: msg.name }, owner: 'owner', heartbeat_ms: 25000 });
        if (!msg.current_job_id) hub.next(conn);
      } else if (msg.type === 'job:done' || msg.type === 'job:release') {
        hub.done.push(msg);
        hub.next(conn);
      }
    });
  });
  hub.next = (conn) => {
    const job = hub.jobs.shift();
    if (job) conn.ws.send({ type: 'job', job });
  };
  return hub;
}

function deps(extra = {}) {
  const y = fakeYtdlp({ videos: VIDEOS, searches: SEARCHES, version: '2026.10.20', ...extra.ytdlp });
  const m = fakeMedia({ videos: VIDEOS });
  const signals = new EventEmitter();
  return { y, m, signals, deps: { ytdlp: y.factory, media: m.factory, signals, prompt: async () => false, backoffMs: 20, maxBackoffMs: 50, ...extra.deps } };
}

describe('la worker', () => {
  let server;
  let hub;
  beforeEach(async () => {
    server = await startServer({ checkEnabled: true });
  });
  afterEach(async () => { await server.close(); });

  test('runs a job: progress, upload with job_id / worker_id, job:done; Ctrl+C when idle exits 0', async () => {
    hub = stubHub(server, { jobs: [{ id: 'job-1', kind: 'video', input: 'https://www.youtube.com/watch?v=aaaaaaaaaa1', title: 'Daft Punk - Digital Love', no_playlist: true }] });
    const d = deps();
    const p = run(['worker', '--name', 'test-box', '--json'], { server, deps: d.deps });
    const done = await until(() => hub.done[0], 'job:done');
    assert.equal(done.type, 'job:done');
    assert.equal(done.job_id, 'job-1');
    assert.equal(done.result.summary.uploaded, 1);
    assert.equal(done.result.results[0].status, 'uploaded');
    assert.ok(done.result.results[0].song_id);

    const hello = hub.conns[0].hello;
    assert.equal(hello.token, TOKEN);
    assert.equal(hello.name, 'test-box');
    assert.equal(hello.platform, process.platform);
    assert.equal(hello.cli_version, require('../package.json').version);
    assert.equal(hello.ytdlp_version, '2026.10.20');
    assert.ok(hello.hostname);

    const progress = hub.messages.filter((m) => m.type === 'job:progress');
    assert.ok(progress.some((m) => m.stage === 'downloading' && m.job_id === 'job-1'), JSON.stringify(progress));
    assert.ok(progress.some((m) => m.stage === 'uploading'));

    const up = server.state.uploads[0].fields;
    assert.equal(up.job_id, 'job-1');
    assert.equal(up.worker_id, WORKER_ID);
    assert.equal(up.youtube_id, 'aaaaaaaaaa1');

    d.signals.emit('SIGINT');
    const r = await p;
    assert.equal(r.code, 0);
    const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.event), ['ready', 'connected', 'job_started', 'job_finished', 'stopped']);
    assert.ok(hub.messages.some((m) => m.type === 'drain'));
  });

  test('request jobs upload with request_id; searches; failures report the CLI error code', async () => {
    server.state.requests.push({ id: 'req-7', title: 'Digital Love', artist: 'Daft Punk', status: 'pending' });
    hub = stubHub(server, {
      jobs: [
        { id: 'job-r', kind: 'search', input: 'Daft Punk - Digital Love', request_id: 'req-7', requested_by: 'Ayşe' },
        { id: 'job-age', kind: 'video', input: 'https://www.youtube.com/watch?v=agerestrict' },
        { id: 'job-bad', kind: 'search', input: 'https://soundcloud.com/someone/track' },
      ],
    });
    const d = deps();
    const p = run(['worker', '--name', 'b'], { server, deps: d.deps });
    await until(() => hub.done.length === 3, 'three results');
    const [r1, r2, r3] = hub.done;
    assert.equal(r1.result.summary.uploaded, 1);
    assert.equal(server.state.uploads[0].fields.request_id, 'req-7');
    assert.equal(server.state.requests[0].status, 'fulfilled');
    assert.equal(r2.result.summary.failed, 1);
    assert.equal(r2.result.results[0].code, 'AGE_RESTRICTED');
    assert.equal(r3.result.error_code, 'UNSUPPORTED_INPUT');
    assert.equal(d.y.calls.download.filter((id) => id === 'agerestrict').length, 1);
    d.signals.emit('SIGTERM');
    assert.equal((await p).code, 0);
  });

  test('reconnects after a dropped connection, also in the middle of a job', async () => {
    let release;
    const gateOpen = new Promise((r) => { release = r; });
    hub = stubHub(server, { jobs: [{ id: 'job-2', kind: 'video', input: 'https://www.youtube.com/watch?v=aaaaaaaaaa2' }] });
    let firstDropped = false;
    hub.onHello = (conn, msg) => {
      conn.ws.send({ type: 'welcome', worker: { id: WORKER_ID, name: msg.name }, heartbeat_ms: 25000 });
      if (!firstDropped) {
        // First connection: drop it right away (no close frame).
        firstDropped = true;
        setTimeout(() => conn.ws.terminate(), 20);
      } else if (hub.conns.length === 2) {
        hub.next(conn); // second: hand out the job, then drop mid-job
      }
    };
    const d = deps({ ytdlp: { gate: () => gateOpen } });
    const p = run(['worker', '--name', 'c'], { server, deps: d.deps });
    await until(() => d.y.calls.download.length === 1, 'download started');
    hub.conns[1].ws.terminate();
    await until(() => hub.conns.length === 3 && hub.conns[2].hello, 'third connection');
    assert.equal(hub.conns[2].hello.current_job_id, 'job-2', 'the hello names the job still running');
    release();
    await until(() => hub.conns[2].messages.some((m) => m.type === 'job:done'), 'job:done on the new connection');
    assert.equal(hub.conns[1].messages.filter((m) => m.type === 'job:done').length, 0);
    d.signals.emit('SIGINT');
    assert.equal((await p).code, 0);
  });

  test('graceful shutdown: first Ctrl+C finishes the job and reports it; second gives it back (exit 130)', async () => {
    let release;
    let gateOpen = new Promise((r) => { release = r; });
    hub = stubHub(server, { jobs: [{ id: 'job-3', kind: 'video', input: 'https://www.youtube.com/watch?v=aaaaaaaaaa1' }] });
    let d = deps({ ytdlp: { gate: () => gateOpen } });
    let p = run(['worker', '--name', 'd'], { server, deps: d.deps });
    await until(() => d.y.calls.download.length === 1, 'download started');
    d.signals.emit('SIGINT');
    await until(() => hub.messages.some((m) => m.type === 'drain'), 'drain');
    release();
    let r = await p;
    assert.equal(r.code, 0);
    assert.equal(hub.done[0].type, 'job:done');
    assert.equal(hub.done[0].result.summary.uploaded, 1);
    assert.match(r.stderr, /Finishing the current job/);

    // Again, but press Ctrl+C twice.
    gateOpen = new Promise((res) => { release = res; });
    hub.jobs.push({ id: 'job-4', kind: 'video', input: 'https://www.youtube.com/watch?v=aaaaaaaaaa2' });
    d = deps({ ytdlp: { gate: () => gateOpen } });
    p = run(['worker', '--name', 'd'], { server, deps: d.deps });
    await until(() => d.y.calls.download.length === 1, 'second download started');
    d.signals.emit('SIGINT');
    d.signals.emit('SIGINT');
    r = await p;
    assert.equal(r.code, 130);
    const rel = hub.done.find((m) => m.job_id === 'job-4');
    assert.equal(rel.type, 'job:release');
    assert.equal(rel.reason, 'shutdown');
    release();
  });

  test('a refused token exits 4; being replaced by another worker with the same name exits 1', async () => {
    hub = stubHub(server);
    hub.onHello = (conn) => conn.ws.close(4001, 'Invalid token');
    let r = await run(['worker', '--name', 'e'], { server, deps: deps().deps });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /refused the token/);

    hub.onHello = (conn, msg) => {
      conn.ws.send({ type: 'welcome', worker: { id: WORKER_ID, name: msg.name }, heartbeat_ms: 25000 });
      setTimeout(() => conn.ws.close(4003, 'replaced'), 20);
    };
    r = await run(['worker', '--name', 'e'], { server, deps: deps().deps });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /same name/);
  });

  test('missing ffmpeg -> exit 6 with an install hint; not configured -> exit 3', async () => {
    const d = deps();
    d.deps.media = fakeMedia({ missing: true }).factory;
    const r = await run(['worker'], { server, deps: d.deps });
    assert.equal(r.code, 6);
    assert.match(r.stderr, /ffmpeg/i);
    assert.equal((await run(['worker'])).code, 3);
  });

  test('ws url follows the server scheme', () => {
    assert.equal(workerUrl('https://listen.example.com/'), 'wss://listen.example.com/api/workers/connect');
    assert.equal(workerUrl('http://127.0.0.1:3000'), 'ws://127.0.0.1:3000/api/workers/connect');
  });
});

describe('tools: yt-dlp standalone binary', () => {
  test('tools dir and asset per OS', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    assert.equal(tools.toolsDir(env, 'win32'), path.join('C:\\Users\\a\\AppData\\Local', 'listen-along', 'bin'));
    assert.match(tools.toolsDir({}, 'darwin'), /Library[\\/]Application Support[\\/]listen-along[\\/]bin$/);
    assert.match(tools.toolsDir({}, 'linux'), /\.local[\\/]share[\\/]listen-along[\\/]bin$/);
    assert.equal(tools.toolsDir({ XDG_DATA_HOME: '/x' }, 'linux'), path.join('/x', 'listen-along', 'bin'));
    assert.equal(tools.toolsDir({ LA_TOOLS_DIR: '/t' }, 'linux'), '/t');
    assert.equal(tools.ytdlpAssetName('linux', 'x64'), 'yt-dlp_linux');
    assert.equal(tools.ytdlpAssetName('linux', 'arm64'), 'yt-dlp_linux_aarch64');
    assert.equal(tools.ytdlpAssetName('darwin', 'arm64'), 'yt-dlp_macos');
    assert.equal(tools.ytdlpAssetName('win32', 'x64'), 'yt-dlp.exe');
    assert.equal(tools.ytdlpAssetName('win32', 'ia32'), 'yt-dlp_x86.exe');
    assert.equal(tools.ytdlpAssetName('freebsd', 'x64'), null);
    assert.match(tools.installedYtdlpPath({ LA_TOOLS_DIR: 'T' }, 'win32'), /yt-dlp\.exe$/);
  });

  test('version age', () => {
    const now = Date.UTC(2026, 9, 30);
    assert.equal(tools.versionAgeDays('2026.10.26', now), 4);
    assert.equal(tools.versionAgeDays('2026.10.26.233005', now), 4);
    assert.equal(tools.versionAgeDays('nightly', now), null);
    assert.equal(tools.isOutdated('2026.01.01', now), true);
    assert.equal(tools.isOutdated('2026.10.01', now), false);
  });

  test('install: downloads the asset, checks SHA2-256SUMS, and is then used; a bad checksum is refused', async () => {
    const dir = tmpDir('la-tools-');
    const body = Buffer.from('#!/bin/sh\necho 2026.10.29\n');
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const asset = tools.ytdlpAssetName();
    let sums = `${sha}  ${asset}\n${'0'.repeat(64)}  yt-dlp_other\n`;
    const urls = [];
    const fetchStub = async (url) => {
      urls.push(url);
      if (url.endsWith('/SHA2-256SUMS')) return new Response(sums);
      if (url.endsWith(`/${asset}`)) return new Response(body);
      return new Response('nope', { status: 404 });
    };
    const env = { LA_TOOLS_DIR: dir };
    const dest = await tools.installYtdlp({ env, fetch: fetchStub });
    assert.equal(dest, tools.installedYtdlpPath(env));
    assert.deepEqual(fs.readFileSync(dest), body);
    if (process.platform !== 'win32') assert.equal(fs.statSync(dest).mode & 0o111, 0o111);
    assert.equal(tools.resolveYtdlpBin(env), dest);
    assert.equal(tools.resolveYtdlpBin({ ...env, LA_YTDLP_BIN: '/pinned' }), '/pinned');
    assert.ok(urls.every((u) => u.startsWith('https://github.com/yt-dlp/yt-dlp/releases/latest/download/')));

    sums = `${'f'.repeat(64)}  ${asset}\n`;
    await assert.rejects(tools.installYtdlp({ env: { LA_TOOLS_DIR: tmpDir() }, fetch: fetchStub }), (e) => e.code === 'TOOL_CHECKSUM' && e.exitCode === 6);
  });

  test('worker: a missing yt-dlp is installed on a yes (or --install-ytdlp); a no -> exit 6 with a hint', async () => {
    const { ensureYtdlp } = require('../src/commands/worker');
    const dir = tmpDir('la-tools-');
    const env = { LA_TOOLS_DIR: dir };
    const body = Buffer.from('bin');
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const fetchStub = async (url) => (url.endsWith('SHA2-256SUMS') ? new Response(`${sha}  ${tools.ytdlpAssetName()}\n`) : new Response(body));
    const ctx = (answer) => ({
      env,
      deps: { fetch: fetchStub, prompt: async () => answer },
      out: { info() {}, warn() {}, json: false },
      // "Installed" once the tools dir holds the binary.
      makeYtdlp: () => ({
        async version() {
          if (!fs.existsSync(tools.installedYtdlpPath(env))) { const { missingDependency } = require('../src/proc'); throw missingDependency('yt-dlp', 'yt-dlp'); }
          return '2026.10.29';
        },
      }),
    });
    await assert.rejects(ensureYtdlp(ctx(false), {}), (e) => e.exitCode === 6 && /--install-ytdlp/.test(e.hint));
    assert.equal(await ensureYtdlp(ctx(true), {}), '2026.10.29');
    assert.ok(fs.existsSync(tools.installedYtdlpPath(env)));
    fs.rmSync(tools.installedYtdlpPath(env));
    assert.equal(await ensureYtdlp(ctx(false), { 'install-ytdlp': true }), '2026.10.29');
  });
});
