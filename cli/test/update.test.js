'use strict';

// Self-update: version compare, bundle checks, the file swap with rollback
// (on temp dirs, never this install), `la update`, the supervisor that
// restarts `la worker`, and the child's signal router.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { startServer, run, tmpDir } = require('./helpers');
const { makeBundle, fakeInstall, snapshot } = require('./updateFixtures');
const update = require('../src/update');
const { runSupervisor, createSignalRouter, RESTART_EXIT_CODE } = require('../src/supervisor');
const pkg = require('../package.json');

const leftovers = (root) => fs.readdirSync(root).filter((n) => n.startsWith(update.STAGE_PREFIX));

describe('versions', () => {
  test('compareVersions / isNewer', () => {
    assert.equal(update.compareVersions('0.4.0', '0.3.0'), 1);
    assert.equal(update.compareVersions('0.3.0', '0.3.0'), 0);
    assert.equal(update.compareVersions('0.3.9', '0.4.0'), -1);
    assert.equal(update.compareVersions('0.10.0', '0.9.9'), 1, 'numeric, not string, compare');
    assert.equal(update.compareVersions('1.0.0', '0.99.99'), 1);
    assert.equal(update.compareVersions('v0.4.0', '0.4.0'), 0);
    assert.equal(update.compareVersions('0.4', '0.3.0'), null);
    assert.equal(update.compareVersions('0.4.0-beta', '0.3.0'), null);
    assert.equal(update.compareVersions(undefined, '0.3.0'), null);
    assert.equal(update.isNewer('0.4.0', '0.3.0'), true);
    assert.equal(update.isNewer('0.4.0', '0.4.0'), false, 'never the same version');
    assert.equal(update.isNewer('0.3.0', '0.4.0'), false, 'never an older one');
    assert.equal(update.isNewer('garbage', '0.1.0'), false);
  });
});

describe('bundle checks', () => {
  test('a good bundle unpacks with modes; sha256 must match', () => {
    const b = makeBundle('9.1.0');
    update.verifySha256(b.buffer, b.sha256);
    const { version, files } = update.parseBundle(b.buffer, { expectVersion: '9.1.0' });
    assert.equal(version, '9.1.0');
    assert.deepEqual(files.map((f) => f.path), ['README.md', 'bin/la.js', 'package.json', 'src/cli.js', 'src/update.js']);
    assert.equal(files.find((f) => f.path === 'bin/la.js').mode, 0o755);
    assert.equal(files.find((f) => f.path === 'src/cli.js').mode, 0o644);
    assert.throws(() => update.verifySha256(b.buffer, 'a'.repeat(64)), { code: 'UPDATE_BAD_CHECKSUM' });
    assert.throws(() => update.verifySha256(b.buffer, ''), { code: 'UPDATE_BAD_BUNDLE' });
  });

  test('unsafe or unexpected paths are refused', () => {
    for (const bad of ['../evil.js', 'src/../../evil.js', '/etc/passwd', 'src\\evil.js', 'C:/evil.js', 'test/x.js', 'node_modules/x/index.js', 'src/.', 'evil.js', 'src//x.js', '.git/config']) {
      const b = makeBundle('9.1.0', { [bad]: 'x' });
      assert.throws(() => update.parseBundle(b.buffer), { code: 'UPDATE_BAD_BUNDLE' }, bad);
    }
    assert.equal(update.safePath('src/commands/worker.js'), true);
    assert.equal(update.safePath('bin/la.js'), true);
  });

  test('version, required files, format and integrity are checked', () => {
    assert.throws(() => update.parseBundle(makeBundle('9.1.0').buffer, { expectVersion: '9.2.0' }), /not the announced/);
    assert.throws(() => update.parseBundle(makeBundle('9.1.0', { 'package.json': '{"version":"9.0.0"}' }).buffer), /package.json says 9.0.0/);
    assert.throws(() => update.parseBundle(makeBundle('9.1.0', {}, { omit: ['bin/la.js'] }).buffer), /no bin\/la.js/);
    assert.throws(() => update.parseBundle(makeBundle('9.1.0', {}, { doc: (d) => ({ ...d, format_version: 2 }) }).buffer), /understands/);
    assert.throws(() => update.parseBundle(makeBundle('9.1.0', {}, { doc: (d) => ({ ...d, files: [...d.files, d.files[0]] }) }).buffer), /twice/);
    assert.throws(() => update.parseBundle(makeBundle('9.1.0', {}, { doc: (d) => ({ ...d, files: d.files.map((f) => (f.path === 'src/cli.js' ? { ...f, sha256: 'b'.repeat(64) } : f)) }) }).buffer), /damaged/);
    assert.throws(() => update.parseBundle(Buffer.from('not gzip')), { code: 'UPDATE_BAD_BUNDLE' });
  });

  test('the bundle URL stays on the configured server', () => {
    assert.equal(update.bundleUrl('https://la.example.com', '/api/cli/bundle'), 'https://la.example.com/api/cli/bundle');
    assert.equal(update.bundleUrl('https://la.example.com/', 'https://la.example.com/api/cli/bundle'), 'https://la.example.com/api/cli/bundle');
    assert.throws(() => update.bundleUrl('https://la.example.com', 'https://evil.example/x'), { code: 'UPDATE_REFUSED' });
    assert.throws(() => update.bundleUrl('https://la.example.com', '//evil.example/x'), { code: 'UPDATE_REFUSED' });
    assert.throws(() => update.bundleUrl('https://la.example.com', 'http://la.example.com/api/cli/bundle'), { code: 'UPDATE_REFUSED' }, 'no downgrade to http');
  });
});

describe('installFiles (swap + rollback)', () => {
  test('replaces bin/, src/, package.json, README.md; leaves test/; cleans up', () => {
    const root = fakeInstall();
    const { files } = update.parseBundle(makeBundle('9.1.0').buffer);
    const r = update.installFiles(root, files);
    assert.equal(r.cleaned, true);
    const after = snapshot(root);
    assert.equal(after['src/cli.js'], '// cli 9.1.0\n');
    assert.equal(after['bin/la.js'], '#!/usr/bin/env node\n// la 9.1.0\n');
    assert.equal(after['src/old-only.js'], undefined, 'files the new version does not have are gone');
    assert.equal(after['test/keep.test.js'], '// mine\n');
    assert.equal(update.diskVersion(root), '9.1.0');
    assert.deepEqual(leftovers(root), []);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(root, 'bin', 'la.js')).mode & 0o777, 0o755);
      assert.equal(fs.statSync(path.join(root, 'src', 'cli.js')).mode & 0o777, 0o644);
    }
  });

  test('a failure at any rename puts every old file back', () => {
    const { files } = update.parseBundle(makeBundle('9.1.0').buffer);
    // 4 entries x (aside + in) = 8 renames on the way.
    for (let failAt = 1; failAt <= 8; failAt++) {
      const root = fakeInstall();
      const before = snapshot(root);
      let n = 0;
      const flaky = { ...fs, renameSync: (a, b) => { if (++n === failAt) { const e = new Error('disk said no'); e.code = 'EIO'; throw e; } return fs.renameSync(a, b); } };
      assert.throws(() => update.installFiles(root, files, { fs: flaky }), (err) => err.code === 'UPDATE_FAILED' && /old version was put back/.test(err.message), `fail at rename ${failAt}`);
      assert.deepEqual(snapshot(root), before, `tree restored after failing rename ${failAt}`);
      assert.deepEqual(leftovers(root), [], `no leftovers after failing rename ${failAt}`);
    }
  });

  test('a failure while writing the new tree changes nothing', () => {
    const root = fakeInstall();
    const before = snapshot(root);
    const { files } = update.parseBundle(makeBundle('9.1.0').buffer);
    let n = 0;
    const flaky = { ...fs, writeFileSync: (...a) => { if (++n === 3) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.writeFileSync(...a); } };
    assert.throws(() => update.installFiles(root, files, { fs: flaky }), { code: 'UPDATE_WRITE' });
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(leftovers(root), []);
  });

  test('busy files (Windows) are retried', () => {
    const root = fakeInstall();
    const { files } = update.parseBundle(makeBundle('9.1.0').buffer);
    let busy = 2;
    const flaky = { ...fs, renameSync: (a, b) => { if (busy-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.renameSync(a, b); } };
    update.installFiles(root, files, { fs: flaky });
    assert.equal(update.diskVersion(root), '9.1.0');
  });

  test('cleanLeftovers removes only old staging dirs', () => {
    const root = fakeInstall();
    fs.mkdirSync(path.join(root, `${update.STAGE_PREFIX}old-x`));
    update.cleanLeftovers(root);
    assert.deepEqual(leftovers(root), [`${update.STAGE_PREFIX}old-x`], 'a fresh one may be a running update');
    update.cleanLeftovers(root, { now: Date.now() + 2 * 3600 * 1000 });
    assert.deepEqual(leftovers(root), []);
    assert.ok(fs.existsSync(path.join(root, 'test', 'keep.test.js')));
  });
});

describe('la update', () => {
  const NEWER = '99.0.0';

  async function setup(cli) {
    const server = await startServer();
    if (cli) server.state.cli = cli;
    const root = fakeInstall(pkg.version);
    return { server, root };
  }

  test('--check reports, changes nothing', async () => {
    const b = makeBundle(NEWER);
    const { server, root } = await setup({ latest: b.latest, buffer: b.buffer });
    try {
      const before = snapshot(root);
      const r = await run(['update', '--check', '--json'], { server, deps: { installRoot: root } });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.json, { current: pkg.version, latest: NEWER, update_available: true, updated: false, root });
      assert.deepEqual(snapshot(root), before);
      assert.ok(!server.state.calls.some((c) => c.path === '/api/cli/bundle'));
      const h = await run(['update', '--check'], { server, deps: { installRoot: root } });
      assert.match(h.stdout, new RegExp(`la ${NEWER} is available \\(this is ${pkg.version.replace(/\./g, '\\.')}\\)`));
    } finally { await server.close(); }
  });

  test('installs a newer version with the token, from the same server', async () => {
    const b = makeBundle(NEWER);
    const { server, root } = await setup({ latest: b.latest, buffer: b.buffer });
    try {
      const r = await run(['update'], { server, deps: { installRoot: root } });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`Updated la .* → ${NEWER}`));
      assert.equal(update.diskVersion(root), NEWER);
      assert.equal(fs.readFileSync(path.join(root, 'test', 'keep.test.js'), 'utf8'), '// mine\n');
      const call = server.state.calls.find((c) => c.path === '/api/cli/bundle');
      assert.ok(call.auth.startsWith('Bearer '));
      assert.ok(!r.stderr.includes(call.auth.slice(7)), 'the token is never printed');
    } finally { await server.close(); }
  });

  test('never the same or an older version', async () => {
    for (const version of [pkg.version, '0.0.1']) {
      const b = makeBundle(version);
      const { server, root } = await setup({ latest: b.latest, buffer: b.buffer });
      try {
        const before = snapshot(root);
        const r = await run(['update', '--json'], { server, deps: { installRoot: root } });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.json.update_available, false);
        assert.equal(r.json.updated, false);
        assert.deepEqual(snapshot(root), before);
        assert.ok(!server.state.calls.some((c) => c.path === '/api/cli/bundle'));
      } finally { await server.close(); }
    }
  });

  test('bad checksum, redirect, no updates: exit 1, old version kept', async () => {
    const b = makeBundle(NEWER);
    const cases = [
      [{ latest: { ...b.latest, sha256: 'c'.repeat(64) }, buffer: b.buffer }, 'UPDATE_BAD_CHECKSUM'],
      [{ latest: b.latest, buffer: b.buffer, redirect: 'http://127.0.0.1:1/elsewhere' }, 'UPDATE_REFUSED'],
      [{ latest: { ...b.latest, url: 'https://evil.example/bundle' }, buffer: b.buffer }, 'UPDATE_REFUSED'],
      [null, 'NO_UPDATES'],
    ];
    for (const [cli, code] of cases) {
      const { server, root } = await setup(cli);
      try {
        const before = snapshot(root);
        const r = await run(['update', '--json'], { server, deps: { installRoot: root } });
        assert.equal(r.code, 1, `${code}: ${r.stderr}`);
        assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)).error.code, code);
        assert.deepEqual(snapshot(root), before, code);
        assert.deepEqual(leftovers(root), []);
      } finally { await server.close(); }
    }
  });

  test('config key auto-update takes true / false only', async () => {
    let r = await run(['config', 'set', 'auto-update', 'false', '--json']);
    assert.equal(r.code, 0, r.stderr);
    r = await run(['config', 'set', 'auto-update', 'maybe']);
    assert.equal(r.code, 2);
  });
});

describe('daily update hint', () => {
  test('at most once a day, only when newer', async () => {
    const server = await startServer();
    server.state.cli = { latest: makeBundle('99.0.0').latest };
    const dir = tmpDir('la-hint-');
    const configFile = path.join(dir, 'config.json');
    const { ApiClient } = require('../src/api');
    const api = new ApiClient({ server: server.url, token: require('./helpers').TOKEN });
    const err = { data: '', write(s) { this.data += s; } };
    try {
      const hint = await update.maybeHint({ api, configFile, current: '0.4.0', stderr: err });
      assert.match(hint, /la 99\.0\.0 is available \(this is 0\.4\.0\); run `la update`/);
      assert.equal(await update.maybeHint({ api, configFile, current: '0.4.0', stderr: err }), null, 'not again today');
      assert.equal(server.state.calls.filter((c) => c.path === '/api/cli/latest').length, 1);
      assert.equal(await update.maybeHint({ api, configFile, current: '99.0.0', stderr: err, now: Date.now() + 25 * 3600 * 1000 }), null, 'same version: no hint');
    } finally { await server.close(); }
  });
});

describe('supervisor', () => {
  /** A stand-in for bin/la.js: behaviour from a script body; state in files. */
  function childScript(body) {
    const dir = tmpDir('la-sup-');
    const script = path.join(dir, 'child.js');
    fs.writeFileSync(script, `'use strict';\nconst fs = require('fs');\nconst path = require('path');\nconst dir = ${JSON.stringify(dir)};\n${body}\n`);
    return { dir, script };
  }
  const sup = (script, extra = {}) => {
    const stderr = { data: '', write(s) { this.data += s; } };
    const signals = new EventEmitter();
    const p = runSupervisor({ argv: ['worker', '--name', 'x'], script, execArgv: [], signals, stderr, env: { ...process.env, LA_WORKER_CHILD: '' }, ...extra });
    return { p, signals, stderr };
  };
  const waitFor = async (file, ms = 10000) => {
    const end = Date.now() + ms;
    while (!fs.existsSync(file)) { if (Date.now() > end) throw new Error(`no ${file}`); await new Promise((r) => setTimeout(r, 20)); }
  };

  test(`restarts the child on exit ${RESTART_EXIT_CODE}, passes argv and LA_WORKER_CHILD, propagates the final code`, async () => {
    const { dir, script } = childScript(`
      const f = path.join(dir, 'runs');
      const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 1;
      fs.writeFileSync(f, String(n));
      fs.writeFileSync(path.join(dir, 'seen-' + n), JSON.stringify({ argv: process.argv.slice(2), child: process.env.LA_WORKER_CHILD, ipc: typeof process.send }));
      process.exit(n === 1 ? ${RESTART_EXIT_CODE} : 3);
    `);
    const { p } = sup(script);
    assert.equal(await p, 3);
    assert.equal(fs.readFileSync(path.join(dir, 'runs'), 'utf8'), '2');
    const seen = JSON.parse(fs.readFileSync(path.join(dir, 'seen-2'), 'utf8'));
    assert.deepEqual(seen, { argv: ['worker', '--name', 'x'], child: '1', ipc: 'function' });
  });

  test('gives up after too many restarts', async () => {
    const { dir, script } = childScript(`fs.appendFileSync(path.join(dir, 'runs'), 'x'); process.exit(${RESTART_EXIT_CODE});`);
    const { p, stderr } = sup(script, { maxRestarts: 2 });
    assert.equal(await p, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'runs'), 'utf8'), 'xxx');
    assert.match(stderr.data, /restarted 2 times/);
  });

  test('forwards a stop signal over IPC and exits with the child', async () => {
    const sig = process.platform === 'win32' ? 'SIGBREAK' : 'SIGTERM';
    const { dir, script } = childScript(`
      process.on('message', (m) => { fs.writeFileSync(path.join(dir, 'got'), JSON.stringify(m)); process.exit(9); });
      fs.writeFileSync(path.join(dir, 'ready'), '1');
      setInterval(() => {}, 1000);
    `);
    const { p, signals } = sup(script);
    await waitFor(path.join(dir, 'ready'));
    signals.emit(sig);
    assert.equal(await p, 9);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'got'), 'utf8')), { type: 'la:signal', signal: sig });
    assert.equal(signals.listenerCount(sig), 0, 'listeners removed');
  });

  test('a restart request after a stop signal ends instead of restarting', async () => {
    const { dir, script } = childScript(`
      process.on('message', () => { fs.appendFileSync(path.join(dir, 'runs'), 'x'); process.exit(${RESTART_EXIT_CODE}); });
      fs.writeFileSync(path.join(dir, 'ready'), '1');
      setInterval(() => {}, 1000);
    `);
    const { p, signals } = sup(script);
    await waitFor(path.join(dir, 'ready'));
    signals.emit('SIGINT');
    assert.equal(await p, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'runs'), 'utf8'), 'x');
  });

  test('a child killed by a signal gives 128 + its number', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
    const { script } = childScript(`process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);`);
    const { p } = sup(script);
    assert.equal(await p, 143);
  });
});

describe('signal router (child side)', () => {
  const fakeProc = () => Object.assign(new EventEmitter(), { channel: { unref() {} } });
  const collect = (router) => {
    const got = [];
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) router.on(s, () => got.push(s));
    return got;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fwd = (proc, signal) => proc.emit('message', { type: 'la:signal', signal });

  test('a signal that arrives directly and forwarded counts once, in either order', async () => {
    const proc = fakeProc();
    const router = createSignalRouter({ proc, platform: 'linux', delayMs: 40, windowMs: 200 });
    const got = collect(router);
    proc.emit('SIGINT');
    fwd(proc, 'SIGINT');
    await sleep(80);
    assert.deepEqual(got, ['SIGINT']);
    fwd(proc, 'SIGTERM');
    proc.emit('SIGTERM');
    await sleep(80);
    assert.deepEqual(got, ['SIGINT', 'SIGTERM']);
    router.close();
  });

  test('two quick Ctrl+C presses stay two', async () => {
    const proc = fakeProc();
    const router = createSignalRouter({ proc, platform: 'linux', delayMs: 40, windowMs: 200 });
    const got = collect(router);
    proc.emit('SIGINT'); fwd(proc, 'SIGINT');
    proc.emit('SIGINT'); fwd(proc, 'SIGINT');
    await sleep(80);
    assert.deepEqual(got, ['SIGINT', 'SIGINT']);
    router.close();
  });

  test('a signal sent to the child only still works; the parent going away is a hangup', async () => {
    const proc = fakeProc();
    const router = createSignalRouter({ proc, platform: 'linux', delayMs: 30, windowMs: 100 });
    const got = collect(router);
    proc.emit('SIGTERM');
    assert.deepEqual(got, []);
    await sleep(60);
    assert.deepEqual(got, ['SIGTERM']);
    proc.emit('disconnect');
    assert.deepEqual(got, ['SIGTERM', 'SIGHUP']);
    router.close();
    assert.equal(proc.listenerCount('SIGINT'), 0);
    assert.equal(proc.listenerCount('message'), 0);
  });
});
