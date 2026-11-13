// la self-update, server side (no database needed):
//   - the bundle of cli/ is deterministic, leaves test/ out, and unpacks with
//     the CLI's own reader (cli/src/update.js) to the files on disk
//   - GET /api/cli/latest|bundle: token required, 404 without cli/, ETag
//   - the worker hub's welcome carries cli_latest; an old worker (no 'update'
//     capability, older version, idle) gets close 4010 once, then is served
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createCliRelease, createCliRouter, buildBundle, compareVersions, isOutdated, findCliDir } = require('./cliRelease');
const { createWorkerHub, CLOSE_OUTDATED } = require('./workerHub');

const CLI_DIR = path.join(__dirname, '..', '..', 'cli');
const cliUpdate = require(path.join(CLI_DIR, 'src', 'update.js'));
const cliVersion = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version;
const quiet = () => {};

describe('versions', () => {
  it('compares x.y.z numerically', () => {
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
    assert.equal(compareVersions('0.3.0', '0.4.0'), -1);
    assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
    assert.equal(compareVersions('junk', '0.4.0'), null);
    assert.equal(isOutdated('0.3.0', '0.4.0'), true);
    assert.equal(isOutdated('0.4.0', '0.4.0'), false);
    assert.equal(isOutdated(null, '0.4.0'), false, 'an unknown version is not flagged');
  });
});

describe('cli bundle', () => {
  it('finds the repo cli/ in a checkout', () => {
    assert.equal(findCliDir({}), path.resolve(CLI_DIR));
    assert.equal(findCliDir({ CLI_DIR: '/nowhere' }), '/nowhere');
  });

  it('is deterministic, skips test/, and the CLI unpacks it to the files on disk', () => {
    const a = buildBundle(CLI_DIR);
    const b = buildBundle(CLI_DIR);
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.version, cliVersion);
    assert.equal(crypto.createHash('sha256').update(a.buffer).digest('hex'), a.sha256);
    cliUpdate.verifySha256(a.buffer, a.sha256);
    const { version, files } = cliUpdate.parseBundle(a.buffer, { expectVersion: cliVersion });
    assert.equal(version, cliVersion);
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('bin/la.js') && paths.includes('src/cli.js') && paths.includes('src/update.js') && paths.includes('src/supervisor.js'));
    assert.ok(paths.includes('package.json') && paths.includes('README.md'));
    assert.ok(!paths.some((p) => p.startsWith('test/')), 'no tests');
    for (const f of files) assert.deepEqual(f.data, fs.readFileSync(path.join(CLI_DIR, ...f.path.split('/'))), f.path);
    assert.equal(files.find((f) => f.path === 'bin/la.js').mode, 0o755);
  });

  it('no or a broken cli/: no bundle, no crash', () => {
    assert.equal(createCliRelease({ dir: null, log: quiet }).load(), null);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-nocli-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.0.0"}');
    const r = createCliRelease({ dir: tmp, log: quiet });
    assert.equal(r.load(), null, 'no bin/la.js');
    assert.equal(r.latest(), null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('GET /api/cli/latest and /api/cli/bundle', () => {
  let server;
  let base;
  let release;
  const requireToken = (req, res, next) => (req.headers.authorization === 'Bearer la_good' ? next() : res.status(401).json({ error: 'Invalid or revoked token' }));
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
  const auth = { authorization: 'Bearer la_good' };

  before(async () => {
    release = createCliRelease({ dir: CLI_DIR, log: quiet });
    release.load();
    const none = createCliRelease({ dir: null, log: quiet });
    none.load();
    const app = express();
    app.use('/none', createCliRouter({ release: none, requireToken }));
    app.use(createCliRouter({ release, requireToken }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server && server.close());

  it('needs a token', async () => {
    assert.equal((await get('/api/cli/latest')).status, 401);
    assert.equal((await get('/api/cli/bundle')).status, 401);
    assert.equal((await get('/api/cli/latest', { authorization: 'Bearer la_bad' })).status, 401);
  });

  it('latest -> version, sha256, size, url; the bundle matches it', async () => {
    const res = await get('/api/cli/latest', auth);
    assert.equal(res.status, 200);
    const latest = await res.json();
    assert.deepEqual(Object.keys(latest).sort(), ['sha256', 'size', 'url', 'version']);
    assert.equal(latest.version, cliVersion);
    assert.equal(latest.url, '/api/cli/bundle');
    const b = await get(latest.url, auth);
    assert.equal(b.status, 200);
    assert.equal(b.headers.get('content-type'), 'application/gzip');
    const buf = Buffer.from(await b.arrayBuffer());
    assert.equal(buf.length, latest.size);
    cliUpdate.verifySha256(buf, latest.sha256);
    assert.equal(b.headers.get('etag'), `"${latest.sha256}"`);
    assert.equal((await get(latest.url, { ...auth, 'if-none-match': `"${latest.sha256}"` })).status, 304);
  });

  it('404 NO_CLI_BUNDLE without cli/', async () => {
    for (const p of ['/none/api/cli/latest', '/none/api/cli/bundle']) {
      const res = await get(p, auth);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, 'NO_CLI_BUNDLE');
    }
  });
});

describe('worker hub: cli_latest and the outdated nudge', () => {
  let server;
  let hub;
  const latest = { version: '0.4.0', sha256: 'a'.repeat(64), size: 1, url: '/api/cli/bundle' };
  const logs = [];
  const store = {
    registerWorker: async (apiUser, hello) => ({ id: `w-${hello.name}`, name: hello.name, last_ip: '127.0.0.1', cli_version: hello.cli_version }),
    workerOwnerName: () => 'Alice',
    reclaim: async () => null,
    touchWorker: async () => {},
    listQueued: async () => [],
    listAll: async () => [],
    requeueAllAssigned: async () => 0,
    requeue: async () => null,
  };

  function connect(hello) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/workers/connect`);
    const w = { ws, messages: [], closed: null, reason: null };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'la_good', ...hello })));
    ws.addEventListener('message', (ev) => w.messages.push(JSON.parse(ev.data)));
    ws.addEventListener('close', (ev) => { w.closed = ev.code; w.reason = ev.reason; });
    w.welcome = () => w.messages.find((m) => m.type === 'welcome');
    return w;
  }
  const until = async (fn, what, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
  };
  const settle = () => new Promise((r) => setTimeout(r, 100));

  function start(opts = {}) {
    server = http.createServer();
    hub = createWorkerHub({
      verifyToken: async (t) => (t === 'la_good' ? { id: 't1', userId: 'u1', name: 'Alice', user: { id: 'u1', name: 'Alice' } } : null),
      store, heartbeatMs: 60000, cliLatest: () => latest, ...opts,
    });
    hub.attach(server);
    return new Promise((r) => server.listen(0, '127.0.0.1', r));
  }
  function stop() {
    hub.close();
    server.closeAllConnections?.();
    server.close();
  }

  const origLog = console.log;
  before(() => { console.log = (...a) => (a[0] === '[workers]' ? logs.push(a.join(' ')) : origLog(...a)); });
  after(() => { console.log = origLog; });

  it('the welcome carries cli_latest; a worker that can update is never nudged', async () => {
    await start();
    try {
      const w = connect({ name: 'new', cli_version: '0.3.0', capabilities: ['replace', 'update'] });
      await until(w.welcome, 'welcome');
      assert.deepEqual(w.welcome().cli_latest, { version: '0.4.0', sha256: latest.sha256, url: '/api/cli/bundle' });
      await settle();
      assert.equal(w.closed, null);
      assert.equal(hub.stats().online, 1);
      w.ws.close();
    } finally { stop(); }
  });

  it('an old idle worker: welcome, then close 4010 with the reason; it reconnects and is served', async () => {
    await start();
    try {
      const hello = { name: 'old', cli_version: '0.3.0', capabilities: ['replace'] };
      const w = connect(hello);
      await until(() => w.closed !== null, 'close');
      assert.equal(w.closed, CLOSE_OUTDATED);
      assert.ok(w.welcome(), 'welcome first: an old worker prints a close reason only after one');
      assert.match(w.reason, /^la 0\.3\.0 is out of date; this server has la 0\.4\.0\. Replace your cli\/ folder once/);
      assert.ok(Buffer.byteLength(w.reason) <= 123);
      assert.equal(w.messages.find((m) => m.type === 'error').code, 'OUTDATED');
      assert.equal(hub.stats().online, 0, 'never counted as online');
      assert.ok(logs.some((l) => /runs la 0\.3\.0 < 0\.4\.0: told to update/.test(l)));

      const again = connect(hello);
      await until(again.welcome, 'second welcome');
      await settle();
      assert.equal(again.closed, null, 'once per WORKER_OUTDATED_NUDGE_MS');
      assert.equal(hub.stats().online, 1);
      again.ws.close();
    } finally { stop(); }
  });

  it('no nudge mid-job, when up to date, when off, or without a bundle', async () => {
    const cases = [
      [{}, { name: 'busy', cli_version: '0.1.0', current_job_id: '00000000-0000-0000-0000-000000000001' }],
      [{}, { name: 'same', cli_version: '0.4.0' }],
      [{}, { name: 'unknown' }],
      [{ outdatedNudgeMs: 0 }, { name: 'off', cli_version: '0.2.0' }],
      [{ cliLatest: () => null }, { name: 'nobundle', cli_version: '0.2.0' }],
    ];
    for (const [opts, hello] of cases) {
      await start(opts);
      try {
        const w = connect(hello);
        await until(w.welcome, `welcome ${hello.name}`);
        await settle();
        assert.equal(w.closed, null, hello.name);
        if (opts.cliLatest) assert.equal(w.welcome().cli_latest, undefined);
        w.ws.close();
      } finally { stop(); }
    }
  });
});
