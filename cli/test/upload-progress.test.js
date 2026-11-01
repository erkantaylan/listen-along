'use strict';

// Streamed uploads with a byte count, the percent throttle, and where the
// percent may show up (terminal only; never --json or a pipe).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ApiClient, ApiError } = require('../src/api');
const { Output } = require('../src/output');
const { percentThrottle } = require('../src/progress');
const { main } = require('../src/cli');
const { JobOutput } = require('../src/commands/worker');
const { startServer, run, tmpDir, fakeMedia, TOKEN } = require('./helpers');

function fileOf(size, name = 'song.m4a') {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, Buffer.alloc(size, 'x'));
  return file;
}

/** One-route server: `handler(req, res)`; closes with the test. */
async function rawServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return new ApiClient({ server: `http://127.0.0.1:${server.address().port}`, token: TOKEN });
}

describe('percentThrottle', () => {
  function setup(intervalMs = 1000) {
    const clock = { t: 0 };
    const sent = [];
    const p = percentThrottle({ intervalMs, now: () => clock.t, emit: (percent) => sent.push(percent) });
    return { clock, sent, p };
  }

  test('at most one report per interval, however many updates come in', () => {
    const { clock, sent, p } = setup();
    for (let i = 1; i <= 50; i++) { clock.t = i * 10; p.update(i, 100); } // 50 percents in 500ms
    assert.deepEqual(sent, [1]);
    clock.t = 1010;
    p.update(60, 100);
    assert.deepEqual(sent, [1, 60]);
  });

  test('only on change: the same percent is never repeated, even after the interval', () => {
    const { clock, sent, p } = setup();
    p.update(10, 100);
    clock.t = 5000;
    p.update(10, 100);
    p.update(109, 1000); // still 10%
    assert.deepEqual(sent, [10]);
  });

  test('100% goes out at once and only when every byte is sent', () => {
    const { clock, sent, p } = setup();
    p.update(10, 100);
    clock.t = 5000;
    p.update(999, 1000); // rounds down to 99
    clock.t = 5001;
    p.update(1000, 1000);
    p.finish();
    assert.deepEqual(sent, [10, 99, 100]);
  });

  test('finish reports the percent the throttle held back, once', () => {
    const { clock, sent, p } = setup();
    p.update(10, 100);
    clock.t = 100;
    p.update(40, 100);
    p.finish();
    p.finish();
    p.update(50, 100);
    assert.deepEqual(sent, [10, 40]);
  });

  test('nothing to report: no bytes seen, or an empty total', () => {
    const { sent, p } = setup();
    p.update(0, 0);
    p.finish();
    assert.deepEqual(sent, []);
  });
});

describe('streamed upload', () => {
  test('real multipart with Content-Length; the count ends exactly at the bytes the server got', async (t) => {
    let seen;
    const api = await rawServer(t, async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      seen = { headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ song: { id: 7 } }));
    });
    const size = 3 * 1024 * 1024 + 17;
    const file = fileOf(size, 'Şarkı "bir".m4a');
    const counts = [];
    const r = await api.upload(file, { title: 'Başlık', artist: 'A\nB', empty: '', none: null, duration_sec: 5 }, {
      onProgress: (sent, total) => counts.push([sent, total]),
    });
    assert.deepEqual(r, { status: 'uploaded', song: { id: 7 } });

    assert.equal(seen.headers['transfer-encoding'], undefined);
    assert.equal(Number(seen.headers['content-length']), seen.body.length);
    assert.equal(counts.at(-1)[0], seen.body.length);
    assert.ok(counts.every(([, total]) => total === seen.body.length));
    assert.ok(counts.every(([sent], i) => i === 0 || sent > counts[i - 1][0]), 'grows');
    assert.ok(counts.length > 40, `many steps, got ${counts.length}`);

    const form = await new Response(seen.body, { headers: { 'content-type': seen.headers['content-type'] } }).formData();
    const part = form.get('file');
    assert.equal(part.size, size);
    assert.equal(part.type, 'audio/mp4');
    assert.equal(part.name, 'Şarkı "bir".m4a');
    assert.equal(form.get('title'), 'Başlık');
    assert.equal(form.get('artist'), 'A\r\nB');
    assert.equal(form.get('duration_sec'), '5');
    assert.equal(form.has('empty'), false);
    assert.equal(form.has('none'), false);
  });

  test('the file is read in small chunks as they are asked for, with no timeout (injected fetch)', async () => {
    const reads = [];
    let init;
    const api = new ApiClient({
      server: 'http://x',
      token: TOKEN,
      fetch: async (url, o) => {
        init = o;
        const reader = o.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          reads.push(value.length);
        }
        return new Response(JSON.stringify({ song: { id: 1 } }), { status: 201 });
      },
    });
    await api.upload(fileOf(1024 * 1024), { title: 'T' });
    assert.ok(Math.max(...reads) <= 64 * 1024, `largest chunk ${Math.max(...reads)}`);
    assert.equal(init.signal, undefined);
    assert.equal(init.duplex, 'half');
    // Without these two, fetch tees the body and holds the whole file in memory.
    assert.equal(init.redirect, 'error');
    assert.equal(init.window, null);
    assert.equal(Number(init.headers['Content-Length']), reads.reduce((a, b) => a + b, 0));
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  });

  test('a large upload stays out of memory (real fetch, 120 MB)', async (t) => {
    let received = 0;
    const api = await rawServer(t, async (req, res) => {
      for await (const c of req) received += c.length;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"song":{"id":1}}');
    });
    const file = path.join(tmpDir(), 'big.m4a');
    fs.closeSync(fs.openSync(file, 'w'));
    fs.truncateSync(file, 120 * 1024 * 1024);
    let peak = 0;
    const base = process.memoryUsage().arrayBuffers;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); }, 5);
    await api.upload(file, { title: 'T' }, { onProgress: () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); } });
    clearInterval(timer);
    fs.rmSync(file);
    assert.ok(received > 120 * 1024 * 1024);
    assert.ok(peak < 60 * 1024 * 1024, `peak ${Math.round(peak / 1048576)} MB of buffers`);
  });

  test('an empty file still goes out as a valid form', async (t) => {
    let form;
    const api = await rawServer(t, async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty' }));
    });
    await assert.rejects(api.upload(fileOf(0), { title: 'T' }), (e) => e.status === 400);
    assert.equal(form.get('file').size, 0);
    assert.equal(form.get('title'), 'T');
  });

  test('a server that answers without reading the body (bad token) is an auth error', async (t) => {
    const api = await rawServer(t, (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid token' }));
    });
    await assert.rejects(api.upload(fileOf(20 * 1024 * 1024), { title: 'T' }), (e) => e instanceof ApiError && e.exitCode === 4);
  });

  test('a redirect is reported, not followed (a stream cannot be sent twice)', async (t) => {
    let calls = 0;
    const api = await rawServer(t, (req, res) => {
      calls++;
      req.resume();
      res.writeHead(308, { location: 'https://elsewhere.example/api/library/upload' });
      res.end();
    });
    await assert.rejects(api.upload(fileOf(10), { title: 'T' }), (e) => e.code === 'REDIRECTED' && /use the address it redirects to/.test(e.message));
    assert.equal(calls, 1);
  });

  test('409 stays a duplicate result; a missing file is still ENOENT', async (t) => {
    const server = await startServer({ songs: [{ id: 9, youtube_id: 'aaaaaaaaaa1', title: 'S', artist: 'A' }] });
    t.after(() => server.close());
    const api = new ApiClient({ server: server.url, token: TOKEN });
    const counts = [];
    const r = await api.upload(fileOf(100), { title: 'S', artist: 'A', youtube_id: 'aaaaaaaaaa1' }, { onProgress: (s) => counts.push(s) });
    assert.equal(r.status, 'duplicate');
    assert.equal(r.song.id, 9);
    assert.ok(counts.length > 0);
    await assert.rejects(api.upload('/nonexistent/x.m4a', {}), (e) => e.code === 'ENOENT');
  });

  test('replace streams and counts too; 409 stays an item failure', async (t) => {
    const server = await startServer({ songs: [{ id: 9, title: 'S', artist: 'A' }] });
    t.after(() => server.close());
    const api = new ApiClient({ server: server.url, token: TOKEN });
    const file = fileOf(1000);
    const counts = [];
    const r = await api.replace(9, file, { title: 'New', artist: 'A' }, { onProgress: (s, total) => counts.push([s, total]) });
    assert.equal(r.song.title, 'New');
    assert.equal(server.state.replaces[0].fileContent.length, 1000);
    assert.equal(counts.at(-1)[0], counts.at(-1)[1]);
    server.state.failReplace = () => ({ status: 409, body: { error: 'taken', code: 'duplicate_hash' } });
    await assert.rejects(api.replace(9, file, { title: 'New', artist: 'A' }), (e) => e.exitCode === 1 && e.code === 'duplicate_hash');
  });
});

describe('where the percent shows', () => {
  const VIDEOS = { aaaaaaaaaa1: { title: 'Digital Love', artist: 'Daft Punk', duration: 301 } };

  function audioFile() {
    const file = path.join(tmpDir(), 'a.m4a');
    fs.writeFileSync(file, 'AUDIO:aaaaaaaaaa1');
    return file;
  }

  function sink(isTTY) {
    const s = { data: '', isTTY, write(c) { s.data += c; return true; } };
    return s;
  }

  async function upload(server, extraArgs, stderr) {
    const stdout = sink(false);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LA_CONFIG: path.join(tmpDir(), 'c.json'), LA_SERVER: server.url, LA_TOKEN: TOKEN };
    const code = await main(['upload', audioFile(), ...extraArgs], { env, stdout, stderr, deps: { media: fakeMedia({ videos: VIDEOS }).factory } });
    assert.equal(code, 0);
    return stdout.data;
  }

  test('`la upload` on a terminal: percent on stderr, rewritten in place, and a clean stdout', async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const stderr = sink(true);
    const stdout = await upload(server, [], stderr);
    assert.match(stderr.data, /Uploading Daft Punk - Digital Love…\n/);
    assert.match(stderr.data, /\r {2}100%\r\x1b\[K/);
    assert.doesNotMatch(stdout, /%|\r/);
  });

  test('--json, --quiet and a piped stderr get no percent', async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const fresh = () => { server.state.songs.length = 0; return sink(true); };

    const json = fresh();
    const out = await upload(server, ['--json'], json);
    assert.equal(JSON.parse(out).summary.uploaded, 1);
    assert.doesNotMatch(json.data, /%|\r/);

    const quiet = fresh();
    await upload(server, ['--quiet'], quiet);
    assert.doesNotMatch(quiet.data, /%|\r/);

    server.state.songs.length = 0;
    const piped = sink(false);
    await upload(server, [], piped);
    assert.doesNotMatch(piped.data, /%|\r/);
  });

  test('a plain run without a terminal is unchanged', async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const r = await run(['upload', audioFile()], { server, deps: { media: fakeMedia({ videos: VIDEOS }).factory } });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /%/);
  });

  test('a worker job sends percent to the server (about 1/s), never to its terminal', () => {
    const sent = [];
    const stderr = sink(true);
    const out = new JobOutput(new Output({ stdout: sink(false), stderr }), 'job-1', (stage, message) => sent.push([stage, message]));
    const p = out.uploadProgress('Daft Punk - Digital Love');
    for (let i = 1; i <= 1000; i++) p.update(i, 1000);
    p.finish();
    assert.deepEqual(sent, [
      ['uploading', 'Uploading Daft Punk - Digital Love… 0%'],
      ['uploading', 'Uploading Daft Punk - Digital Love… 100%'],
    ]);
    assert.equal(stderr.data, '');
  });

  test('a failing server connection does not break the upload reporting', () => {
    const out = new JobOutput(new Output({ stdout: sink(false), stderr: sink(false) }), 'job-1', () => { throw new Error('gone'); });
    const p = out.uploadProgress('x');
    p.update(5, 10);
    p.finish();
  });

  test('a long song name cannot push the percent out of the message', () => {
    const sent = [];
    const out = new JobOutput(new Output({ stdout: sink(false), stderr: sink(false) }), 'job-1', (stage, message) => sent.push(message));
    out.uploadProgress('x'.repeat(1000)).update(1, 2);
    assert.ok(sent[0].length < 300 && sent[0].endsWith('50%'), sent[0]);
  });
});
