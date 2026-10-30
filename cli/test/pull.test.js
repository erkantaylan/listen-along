'use strict';

// `la pull` against the stub server in helpers.js (which serves song files
// with Range support).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, run, tmpDir } = require('./helpers');
const { portableName, songBaseName, m3u8 } = require('../src/pull');

const ID1 = '00000001-0000-4000-8000-000000000001';
const ID2 = '00000002-0000-4000-8000-000000000002';
const ID3 = '00000003-0000-4000-8000-000000000003';
const ID4 = '00000004-0000-4000-8000-000000000004';
const BIG = 'x'.repeat(5000);
const LIB = [
  { id: ID1, youtube_id: 'aaaaaaaaaa1', title: 'Digital Love', artist: 'Daft Punk', duration_sec: 301, content: `AUDIO1-${BIG}` },
  { id: ID2, youtube_id: 'bbbbbbbbbb2', title: 'One More Time', artist: 'Daft Punk', duration_sec: 320, content: 'AUDIO2' },
  { id: ID3, youtube_id: null, title: 'What? Now: "Live" <Take> *1*', artist: 'AC/DC', duration_sec: 200, content: 'AUDIO3', mime_type: 'audio/mpeg' },
  { id: ID4, youtube_id: 'dddddddddd4', title: 'Teardrop', artist: 'Massive Attack', duration_sec: 331, content: 'AUDIO4' },
];

async function withServer(overrides, fn) {
  const server = await startServer({ me: { name: 'Alice', userId: 'u-alice' }, songs: LIB.map((s) => ({ ...s })), ...overrides });
  try { await fn(server); } finally { await server.close(); }
}

const files = (dir) => fs.readdirSync(dir).sort();

describe('la pull', () => {
  test('by library id and yt:<id>: names like --keep, sanitized, extension from Content-Type', () => withServer({}, async (server) => {
    const dir = tmpDir();
    const r = await run(['pull', ID1, 'yt:bbbbbbbbbb2', ID3, '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.summary, { total: 3, pulled: 3, skipped: 0, failed: 0 });
    assert.deepEqual(files(dir), [
      'AC-DC - What Now - \'Live\' Take 1 [00000003-0000-4000-8000-000000000003].mp3',
      'Daft Punk - Digital Love [aaaaaaaaaa1].m4a',
      'Daft Punk - One More Time [bbbbbbbbbb2].m4a',
    ]);
    assert.equal(fs.readFileSync(path.join(dir, 'Daft Punk - Digital Love [aaaaaaaaaa1].m4a'), 'utf8'), LIB[0].content);
    const r1 = r.json.results[0];
    assert.equal(r1.status, 'pulled');
    assert.equal(r1.id, ID1);
    assert.equal(r1.input, ID1);
    assert.equal(r1.bytes, LIB[0].content.length);
    assert.equal(r1.file, path.join(dir, 'Daft Punk - Digital Love [aaaaaaaaaa1].m4a'));
    assert.equal(r.json.dir, dir);
    assert.ok(server.state.calls.filter((c) => c.path.endsWith('/file')).every((c) => c.auth === 'Bearer test-token-123456'));
  }));

  test('unknown id fails (exit 1) but the rest are pulled; bad argument is a usage error', () => withServer({}, async (server) => {
    const dir = tmpDir();
    const missing = '0000000f-0000-4000-8000-00000000000f';
    let r = await run(['pull', missing, ID2, 'yt:zzzzzzzzzzz', '--dir', dir, '--json'], { server });
    assert.equal(r.code, 1);
    assert.deepEqual(r.json.summary, { total: 3, pulled: 1, skipped: 0, failed: 2 });
    assert.equal(r.json.results.find((x) => x.input === missing).code, 'NOT_FOUND');
    assert.equal(r.json.results.find((x) => x.input === 'yt:zzzzzzzzzzz').code, 'NOT_FOUND');
    r = await run(['pull', 'not-an-id', '--dir', dir], { server });
    assert.equal(r.code, 2);
    r = await run(['pull', '--dir', dir], { server });
    assert.equal(r.code, 2);
    r = await run(['pull', ID1, '--concurrency', '0', '--dir', dir], { server });
    assert.equal(r.code, 2);
  }));

  test('re-run skips files with the server hash; a replaced song is downloaded again', () => withServer({}, async (server) => {
    const dir = tmpDir();
    let r = await run(['pull', ID1, ID2, '--dir', dir, '--json'], { server });
    assert.equal(r.json.summary.pulled, 2);
    const before = server.state.fileRequests.length;
    r = await run(['pull', ID1, ID2, '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.summary, { total: 2, pulled: 0, skipped: 2, failed: 0 });
    assert.equal(r.json.results[0].reason, 'already downloaded');
    assert.equal(server.state.fileRequests.length, before, 'no file requests for skipped songs');

    server.state.songs.find((s) => s.id === ID2).content = 'AUDIO2-REPLACED';
    r = await run(['pull', ID2, '--dir', dir, '--json'], { server });
    assert.equal(r.json.results[0].status, 'pulled');
    assert.equal(r.json.results[0].updated, true);
    assert.equal(fs.readFileSync(path.join(dir, 'Daft Punk - One More Time [bbbbbbbbbb2].m4a'), 'utf8'), 'AUDIO2-REPLACED');
    assert.equal(files(dir).filter((f) => f.endsWith('.part')).length, 0);
  }));

  test('a --keep copy with another title but the same [id] counts as downloaded', () => withServer({}, async (server) => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'Daft Punk - Digital Love (Official) [aaaaaaaaaa1].m4a'), LIB[0].content);
    const r = await run(['pull', ID1, '--dir', dir, '--json'], { server });
    assert.equal(r.json.results[0].status, 'skipped');
    assert.equal(files(dir).length, 1);
  }));

  test('without file_version (older server): skip by size via HEAD', () => withServer({
    songs: LIB.map((s) => ({ ...s, file_version: null })),
  }, async (server) => {
    const dir = tmpDir();
    let r = await run(['pull', ID2, '--dir', dir, '--json'], { server });
    assert.equal(r.json.results[0].status, 'pulled');
    r = await run(['pull', ID2, '--dir', dir, '--json'], { server });
    assert.equal(r.json.results[0].status, 'skipped');
    assert.ok(server.state.fileRequests.some((f) => f.method === 'HEAD'));
  }));

  test('interrupted download keeps a .part and the next run resumes it with Range', () => withServer({}, async (server) => {
    const dir = tmpDir();
    server.state.cutFile = (id) => (id === ID1 ? 1000 : null);
    let r = await run(['pull', ID1, '--dir', dir, '--json'], { server });
    assert.equal(r.code, 1);
    assert.equal(r.json.results[0].code, 'INTERRUPTED');
    const part = files(dir).find((f) => f.endsWith('.part'));
    assert.ok(part, files(dir).join(','));
    assert.match(part, /^Daft Punk - Digital Love \[aaaaaaaaaa1\]\.[0-9a-f]{16}\.part$/);
    const partSize = fs.statSync(path.join(dir, part)).size;
    assert.ok(partSize > 0 && partSize < LIB[0].content.length);

    server.state.cutFile = null;
    r = await run(['pull', ID1, '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.results[0].resumed, true);
    assert.equal(server.state.fileRequests.at(-1).range, `bytes=${partSize}-`);
    assert.deepEqual(files(dir), ['Daft Punk - Digital Love [aaaaaaaaaa1].m4a']);
    assert.equal(fs.readFileSync(path.join(dir, files(dir)[0]), 'utf8'), LIB[0].content);
  }));

  test('a server that ignores Range (200) gets a full download; a corrupt .part is redone', () => withServer({ rangeEnabled: false }, async (server) => {
    const dir = tmpDir();
    const sha = require('crypto').createHash('sha256').update(LIB[1].content).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(dir, `Daft Punk - One More Time [bbbbbbbbbb2].${sha}.part`), 'GARBAGE');
    let r = await run(['pull', ID2, '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.results[0].resumed, false);
    assert.equal(fs.readFileSync(path.join(dir, 'Daft Punk - One More Time [bbbbbbbbbb2].m4a'), 'utf8'), 'AUDIO2');

    server.state.rangeEnabled = true; // 206 from offset 3 of "AUDIO2" + "BAD" -> hash mismatch -> full retry
    const sha4 = require('crypto').createHash('sha256').update('AUDIO4').digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(dir, `Massive Attack - Teardrop [dddddddddd4].${sha4}.part`), 'BAD');
    r = await run(['pull', ID4, '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'Massive Attack - Teardrop [dddddddddd4].m4a'), 'utf8'), 'AUDIO4');
  }));

  test('--search pulls every match; more than 20 need --yes (exit 2 without a terminal)', () => withServer({
    songs: [...LIB, ...Array.from({ length: 25 }, (_, i) => ({ id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, youtube_id: `zzzzzzzzz${String(i).padStart(2, '0')}`, title: `Track ${i}`, artist: 'Many', content: `M${i}` }))],
  }, async (server) => {
    const dir = tmpDir();
    let r = await run(['pull', '--search', 'daft punk', '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.summary.pulled, 2);
    r = await run(['pull', '--search', 'many', '--dir', dir, '--json'], { server });
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stderr.trim().split('\n').at(-1)).error.code, 'CONFIRM_REQUIRED');
    r = await run(['pull', '--search', 'many', '--dir', dir], { server, deps: { confirm: async () => false } });
    assert.equal(r.code, 1, 'declined');
    r = await run(['pull', '--search', 'many', '--yes', '--dir', dir, '--json', '--concurrency', '4'], { server });
    assert.equal(r.code, 0);
    assert.equal(r.json.summary.pulled, 25);
    assert.equal(files(dir).length, 27);
  }));

  test('--all needs --yes, then pulls the whole library', () => withServer({}, async (server) => {
    const dir = tmpDir();
    let r = await run(['pull', '--all', '--dir', dir], { server });
    assert.equal(r.code, 2);
    r = await run(['pull', '--all', '--yes', '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0);
    assert.equal(r.json.summary.pulled, 4);
  }));

  test('--playlist: subfolder + .m3u8 in playlist order, missing entries as comments, --flat', () => withServer({
    playlists: [{
      id: 'p1', name: 'Road: Trip', visibility: 'public', ownerId: 'u-alice', songs: [
        { entry_id: 'e1', library_id: ID4, youtube_id: 'dddddddddd4', title: 'Teardrop - Massive Attack' },
        { entry_id: 'e2', library_id: null, youtube_id: 'yyyyyyyyyy1', title: 'Only on YouTube', url: 'https://www.youtube.com/watch?v=yyyyyyyyyy1' },
        { entry_id: 'e3', library_id: ID1, youtube_id: 'aaaaaaaaaa1', title: 'Digital Love - Daft Punk' },
        { entry_id: 'e4', library_id: ID4, youtube_id: 'dddddddddd4', title: 'Teardrop - Massive Attack' },
      ],
    }],
  }, async (server) => {
    const dir = tmpDir();
    let r = await run(['pull', '--playlist', 'road: trip', '--dir', dir, '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.summary, { total: 3, pulled: 2, skipped: 1, failed: 0 });
    assert.equal(r.json.results.find((x) => x.status === 'skipped').reason, 'not in library');
    const plDir = path.join(dir, 'Road - Trip');
    assert.deepEqual(files(plDir), ['Daft Punk - Digital Love [aaaaaaaaaa1].m4a', 'Massive Attack - Teardrop [dddddddddd4].m4a', 'Road - Trip.m3u8']);
    const pl = r.json.playlists[0];
    assert.equal(pl.m3u8, path.join(plDir, 'Road - Trip.m3u8'));
    assert.equal(pl.listed, 3);
    assert.equal(pl.missing, 1);
    assert.equal(fs.readFileSync(pl.m3u8, 'utf8'), [
      '#EXTM3U',
      '#EXTINF:331,Massive Attack - Teardrop',
      'Massive Attack - Teardrop [dddddddddd4].m4a',
      '# missing: Only on YouTube (not in library)',
      '#EXTINF:301,Daft Punk - Digital Love',
      'Daft Punk - Digital Love [aaaaaaaaaa1].m4a',
      '#EXTINF:331,Massive Attack - Teardrop',
      'Massive Attack - Teardrop [dddddddddd4].m4a',
      '',
    ].join('\n'));

    r = await run(['pull', '--playlist', 'p1', '--dir', dir, '--json'], { server });
    assert.equal(r.json.summary.skipped, 3, 'second run: all skipped, m3u8 rewritten');

    const flat = tmpDir();
    r = await run(['pull', '--playlist', 'p1', '--flat', '--dir', flat, '--json'], { server });
    assert.equal(r.code, 0);
    assert.ok(files(flat).includes('Road - Trip.m3u8'));
    assert.ok(files(flat).includes('Daft Punk - Digital Love [aaaaaaaaaa1].m4a'));

    r = await run(['pull', '--playlist', 'nope', '--dir', dir, '--json'], { server });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'PLAYLIST_NOT_FOUND');
  }));

  test('--dry-run writes nothing', () => withServer({}, async (server) => {
    const dir = path.join(tmpDir(), 'new');
    const r = await run(['pull', ID1, '--dir', dir, '--dry-run', '--json'], { server });
    assert.equal(r.code, 0);
    assert.equal(r.json.results[0].status, 'would_pull');
    assert.equal(fs.existsSync(dir), false);
  }));

  test('auth failure aborts with exit 4', () => withServer({}, async (server) => {
    const r = await run(['pull', ID1, '--dir', tmpDir(), '--token', 'wrong'], { server });
    assert.equal(r.code, 4);
  }));
});

describe('pull file names', () => {
  test('portableName: Windows/macOS/Linux-safe', () => {
    assert.equal(portableName('AC/DC: Back\\in|Black?*'), 'AC-DC - Back-in-Black');
    assert.equal(portableName('"Quoted" <x>'), "'Quoted' x");
    assert.equal(portableName('  ...hidden. . '), 'hidden');
    assert.equal(portableName('CON'), '_CON');
    assert.equal(portableName('nul.txt'), '_nul.txt');
    assert.equal(portableName('Console'), 'Console');
    assert.equal(portableName('a\u0000b\nc\td'), 'abcd');
    assert.equal(portableName(''), 'untitled');
    assert.equal(portableName('Café'), 'Café'); // NFC
    const long = portableName('ş'.repeat(200));
    assert.ok(Buffer.byteLength(long) <= 180);
    assert.equal(long, 'ş'.repeat(90));
  });

  test('songBaseName uses youtube_id, else the library id; no artist -> title only', () => {
    assert.equal(songBaseName({ id: ID1, youtube_id: 'abcdefghijk', title: 'T', artist: 'A' }), 'A - T [abcdefghijk]');
    assert.equal(songBaseName({ id: ID1, youtube_id: null, title: 'T', artist: '' }), `T [${ID1}]`);
  });

  test('m3u8 paths are relative with forward slashes', () => {
    const base = path.join(tmpDir(), 'pl');
    const text = m3u8([{ file: path.join(base, 'sub', 'a.m4a'), title: 'T', artist: 'A', duration_sec: 61.4 }, { missing: 'x\ny' }], base);
    assert.equal(text, '#EXTM3U\n#EXTINF:61,A - T\nsub/a.m4a\n# missing: x y\n');
  });
});
