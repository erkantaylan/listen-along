'use strict';

// Duplicate checks (POST /api/library/check) and --replace, against the stub
// server, plus the guarantee that `la download --json` without the new flags
// keeps its output shape (also against servers without the check endpoint).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer, run, tmpDir, fakeYtdlp, fakeMedia } = require('./helpers');

const VIDEOS = {
  aaaaaaaaaa1: { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', duration: 301 },
  aaaaaaaaaa2: { title: 'Teardrop', artist: 'Massive Attack', duration: 331 },
  aaaaaaaaaa3: { title: 'Roygbiv', artist: 'Boards of Canada', duration: 151 },
};

function deps() {
  const y = fakeYtdlp({
    videos: VIDEOS,
    searches: {
      'massive attack teardrop': [{ id: 'aaaaaaaaaa2', title: 'Massive Attack - Teardrop (Official Video)', channel: 'MassiveAttackVEVO', duration: 330 }],
    },
  });
  const m = fakeMedia({ videos: VIDEOS });
  return { y, m, deps: { ytdlp: y.factory, media: m.factory, sleep: async () => {} } };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('download --json output shape (no new flags)', () => {
  for (const checkEnabled of [false, true]) {
    test(`unchanged result keys and summary (server ${checkEnabled ? 'with' : 'without'} /api/library/check)`, async () => {
      const server = await startServer({ checkEnabled, songs: [{ id: 1, youtube_id: 'aaaaaaaaaa1', title: 'Digital Love', artist: 'Daft Punk' }] });
      const d = deps();
      try {
        const r = await run(['download', '--json', '--sleep', '4', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa3', 'yt:broken00001'], { server, deps: d.deps });
        assert.equal(r.code, 1, r.stderr);
        assert.deepEqual(Object.keys(r.json), ['summary', 'results']);
        assert.deepEqual(r.json.summary, { total: 3, skipped: 1, uploaded: 1, failed: 1 });
        const [skipped, uploaded, failed] = r.json.results;
        assert.equal(skipped.status, 'skipped');
        assert.equal(skipped.reason, 'already in library');
        for (const k of ['input', 'youtube_id', 'url']) assert.ok(k in skipped, k);
        assert.deepEqual(skipped.duplicate_of, { id: 1, title: 'Digital Love', artist: 'Daft Punk', youtube_id: 'aaaaaaaaaa1', match: 'already_in_library' }, 'additive');
        assert.deepEqual(Object.keys(uploaded).sort(), ['artist', 'input', 'song', 'source_url', 'status', 'title', 'url', 'youtube_id']);
        assert.equal(uploaded.status, 'uploaded');
        assert.deepEqual(Object.keys(failed).sort(), ['code', 'error', 'input', 'status', 'url', 'youtube_id']);
        assert.equal(server.state.uploads[0].fields.allow_similar, undefined, 'no allow_similar unless asked');
        // One check (after downloading aaaaaaaaaa3); an old server answers 404
        // to it and is not asked again.
        const checkCalls = server.state.calls.filter((c) => c.path === '/api/library/check').length;
        assert.equal(checkCalls, 1);
      } finally { await server.close(); }
    });
  }
});

describe('duplicate checks', () => {
  test('before download: a search result matching a song by metadata is skipped without downloading', async () => {
    const server = await startServer({ checkEnabled: true, songs: [{ id: 7, youtube_id: 'zzzzzzzzzz9', title: 'Teardrop', artist: 'Massive Attack', duration_sec: 331 }] });
    const d = deps();
    try {
      const r = await run(['download', '--json', 'massive attack teardrop'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(d.y.calls.download, [], 'not downloaded');
      const res = r.json.results[0];
      assert.equal(res.status, 'skipped');
      assert.equal(res.reason, 'duplicate_metadata');
      assert.deepEqual(res.duplicate_of, { id: 7, title: 'Teardrop', artist: 'Massive Attack', youtube_id: 'zzzzzzzzzz9', match: 'duplicate_metadata' });
      assert.equal(res.song.id, 7);
      assert.deepEqual(server.state.checks[0], { youtube_id: 'aaaaaaaaaa2', title: 'Teardrop (Official Video)', artist: 'Massive Attack', duration_sec: 330 });

      const human = await run(['download', 'massive attack teardrop'], { server, deps: d.deps });
      assert.match(human.stderr, /\[skipped\] .*\(duplicate_metadata\) — matches "Teardrop" by Massive Attack \[7\]/);
    } finally { await server.close(); }
  });

  test('--allow-similar downloads and uploads a metadata match (allow_similar sent)', async () => {
    const server = await startServer({ checkEnabled: true, songs: [{ id: 7, youtube_id: 'zzzzzzzzzz9', title: 'Teardrop', artist: 'Massive Attack', duration_sec: 331 }] });
    const d = deps();
    try {
      const r = await run(['download', '--json', '--allow-similar', 'massive attack teardrop'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(d.y.calls.download, ['aaaaaaaaaa2']);
      assert.equal(r.json.results[0].status, 'uploaded');
      assert.equal(server.state.uploads[0].fields.allow_similar, '1');
    } finally { await server.close(); }
  });

  test('after download: the same file bytes (sha256) are skipped before uploading', async () => {
    const server = await startServer({ checkEnabled: true, songs: [{ id: 3, youtube_id: 'other000001', title: 'Something', artist: 'Else', sha256: sha('AUDIO:aaaaaaaaaa3') }] });
    const d = deps();
    try {
      const r = await run(['download', '--json', 'yt:aaaaaaaaaa3'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(d.y.calls.download, ['aaaaaaaaaa3']);
      assert.equal(server.state.uploads.length, 0);
      const res = r.json.results[0];
      assert.equal(res.reason, 'duplicate_hash');
      assert.equal(res.duplicate_of.id, 3);
      const q = server.state.checks.at(-1);
      assert.equal(q.sha256, sha('AUDIO:aaaaaaaaaa3'));
      assert.equal(q.title, 'Roygbiv');
    } finally { await server.close(); }
  });

  test('the server re-check (409 with a code) becomes the matching skip reason', async () => {
    const server = await startServer({ checkEnabled: true });
    server.state.failUpload = () => ({ status: 409, body: { error: 'probable duplicate', code: 'duplicate_metadata', song: { id: 42, title: 'Roygbiv', artist: 'BoC' } } });
    const d = deps();
    try {
      const r = await run(['download', '--json', 'yt:aaaaaaaaaa3'], { server, deps: d.deps });
      assert.equal(r.code, 0);
      assert.equal(r.json.results[0].reason, 'duplicate_metadata');
      assert.deepEqual(r.json.results[0].duplicate_of, { id: 42, title: 'Roygbiv', artist: 'BoC', match: 'duplicate_metadata' });
    } finally { await server.close(); }
  });

  test('la upload: hash and metadata pre-checks, --dry-run reports the skip too', async () => {
    const dir = tmpDir('la-up-');
    const a = path.join(dir, 'a.m4a');
    const b = path.join(dir, 'b.m4a');
    fs.writeFileSync(a, 'AUDIO:aaaaaaaaaa1');
    fs.writeFileSync(b, 'AUDIO:aaaaaaaaaa2');
    const server = await startServer({
      checkEnabled: true,
      songs: [
        { id: 1, youtube_id: null, title: 'x', artist: 'y', sha256: sha('AUDIO:aaaaaaaaaa1') },
        { id: 2, youtube_id: null, title: 'Teardrop', artist: 'Massive Attack', duration_sec: 330 },
      ],
    });
    const d = deps();
    try {
      // Files carry youtube ids in their comment tags; none of them is in the library.
      let r = await run(['upload', '--json', a, b], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.json.results.map((x) => x.reason), ['duplicate_hash', 'duplicate_metadata']);
      assert.equal(server.state.uploads.length, 0);
      r = await run(['upload', '--json', '--dry-run', b], { server, deps: d.deps });
      assert.equal(r.json.results[0].reason, 'duplicate_metadata');
      r = await run(['upload', '--json', '--allow-similar', b], { server, deps: d.deps });
      assert.equal(r.json.results[0].status, 'uploaded');
      assert.equal(server.state.uploads[0].fields.allow_similar, '1');
    } finally { await server.close(); }
  });
});

describe('--replace', () => {
  test('la download <url> --replace <id>: downloads and replaces, no duplicate checks', async () => {
    const server = await startServer({ checkEnabled: true, songs: [{ id: 5, youtube_id: 'wrongvideo1', title: 'Wrong', artist: 'Song' }] });
    const d = deps();
    try {
      const r = await run(['download', '--json', 'yt:aaaaaaaaaa1', '--replace', '5'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.json.summary, { total: 1, replaced: 1, uploaded: 0, skipped: 0, failed: 0 });
      const res = r.json.results[0];
      assert.equal(res.status, 'replaced');
      assert.equal(res.replaced_id, '5');
      assert.equal(res.song.title, 'Digital Love');
      assert.equal(res.previous.title, 'Wrong');
      assert.equal(server.state.uploads.length, 0);
      assert.equal(server.state.checks.length, 0);
      assert.equal(server.state.calls.filter((c) => c.path === '/api/library').length, 0, 'no library listing');
      assert.deepEqual(server.state.replaces[0].fields, {
        title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', youtube_id: 'aaaaaaaaaa1',
        source_url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1', duration_sec: '301',
      });
      assert.equal(server.state.replaces[0].fileContent, 'AUDIO:aaaaaaaaaa1');

      const human = await run(['download', 'yt:aaaaaaaaaa2', '--replace', '5'], { server, deps: d.deps });
      assert.match(human.stderr, /\[replaced\] Massive Attack - Teardrop — was "Digital Love" by Daft Punk \[5\]/);
      assert.match(human.stdout, /1 replaced/);
    } finally { await server.close(); }
  });

  test('la upload <file> --replace <id>, refusals are item failures (exit 1), usage errors exit 2', async () => {
    const dir = tmpDir('la-up-');
    const f = path.join(dir, 'fixed.m4a');
    fs.writeFileSync(f, 'AUDIO:aaaaaaaaaa3');
    fs.writeFileSync(path.join(dir, 'other.m4a'), 'AUDIO:aaaaaaaaaa2');
    const server = await startServer({ songs: [{ id: 5, youtube_id: null, title: 'Wrong', artist: 'Song' }] });
    const d = deps();
    try {
      let r = await run(['upload', '--json', f, '--replace', '5', '--title', 'Roygbiv (fixed)'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.results[0].status, 'replaced');
      assert.equal(server.state.replaces[0].fields.title, 'Roygbiv (fixed)');

      r = await run(['upload', '--json', f, '--replace', '999'], { server, deps: d.deps });
      assert.equal(r.code, 1);
      assert.equal(r.json.results[0].status, 'failed');
      assert.equal(r.json.results[0].code, 'not_found');

      server.state.failReplace = () => ({ status: 409, body: { error: 'This exact file is already in the library as another song', code: 'duplicate_hash', song: { id: 8 } } });
      r = await run(['upload', '--json', f, '--replace', '5'], { server, deps: d.deps });
      assert.equal(r.code, 1);
      assert.equal(r.json.results[0].code, 'duplicate_hash');

      r = await run(['upload', '--json', '--dry-run', f, '--replace', '5'], { server, deps: d.deps });
      assert.equal(r.json.results[0].status, 'would_replace');

      for (const argv of [
        ['download', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', '--replace', '5'],
        ['download', 'yt:aaaaaaaaaa1', '--replace', '5', '--playlist', 'x'],
        ['download', 'yt:aaaaaaaaaa1', '--replace', '5', '--allow-similar'],
        ['download', 'yt:aaaaaaaaaa1', '--replace', ' '],
        ['upload', dir, '--replace', '5'], // a directory with two files
      ]) {
        const u = await run(argv, { server, deps: d.deps });
        assert.equal(u.code, 2, argv.join(' '));
      }
    } finally { await server.close(); }
  });
});
