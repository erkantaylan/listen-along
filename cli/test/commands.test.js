'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, run, tmpDir, fakeYtdlp, fakeMedia, TOKEN } = require('./helpers');
const { COMMANDS } = require('../src/cli');

const VIDEOS = {
  aaaaaaaaaa1: { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', duration: 301 },
  aaaaaaaaaa2: { title: 'Teardrop', artist: 'Massive Attack', duration: 331 },
  aaaaaaaaaa3: { title: 'Roygbiv', artist: 'Boards of Canada', duration: 151 },
  broken00001: { fail: 'Video is unavailable', failCode: 'VIDEO_UNAVAILABLE' },
};

function deps(opts = {}) {
  const y = fakeYtdlp({ videos: VIDEOS, ...opts.ytdlp });
  const m = fakeMedia({ videos: VIDEOS, ...opts.media });
  const sleeps = [];
  return {
    y, m, sleeps,
    deps: { ytdlp: y.factory, media: m.factory, sleep: async (ms) => { sleeps.push(ms); } },
  };
}

describe('help and usage', () => {
  test('root help documents commands, exit codes and examples', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0);
    for (const c of COMMANDS) assert.ok(r.stdout.includes(c.name), c.name);
    assert.match(r.stdout, /Exit codes:/);
    assert.match(r.stdout, /Examples:/);
    assert.equal((await run([])).code, 0);
  });

  test('every command and subcommand has --help with examples', async () => {
    for (const c of COMMANDS) {
      const r = await run([c.name, '--help']);
      assert.equal(r.code, 0, c.name);
      assert.match(r.stdout, /Usage:/, c.name);
      assert.match(r.stdout, /Examples:/, c.name);
      for (const s of c.subcommands || []) {
        const rs = await run([c.name, s.name, '--help']);
        assert.equal(rs.code, 0, `${c.name} ${s.name}`);
        assert.match(rs.stdout, new RegExp(`la ${c.name} ${s.name}`));
      }
    }
  });

  test('unknown command / option -> exit 2 on stderr', async () => {
    let r = await run(['nope']);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Unknown command/);
    r = await run(['library', '--bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bogus/);
    r = await run(['download', '--json']);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stderr).error.code, 'USAGE');
  });

  test('--version', async () => {
    const r = await run(['--version', '--json']);
    assert.equal(r.json.version, require('../package.json').version);
  });

  test('bin/la.js runs as a process and sets the exit code', () => {
    const bin = path.join(__dirname, '..', 'bin', 'la.js');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LA_CONFIG: path.join(tmpDir(), 'c.json') };
    let p = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', env });
    assert.equal(p.status, 0);
    assert.match(p.stdout, /Usage:/);
    p = spawnSync(process.execPath, [bin, 'whoami', '--json'], { encoding: 'utf8', env });
    assert.equal(p.status, 3);
    assert.equal(JSON.parse(p.stderr).error.code, 'NOT_CONFIGURED');
  });
});

describe('config + whoami', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  test('config set/get/list round trip with masked token', async () => {
    const env = { LA_CONFIG: path.join(tmpDir(), 'config.json') };
    assert.equal((await run(['config', 'set', 'server', server.url], { env })).code, 0);
    const setTok = await run(['config', 'set', 'token', TOKEN, '--json'], { env });
    assert.notEqual(setTok.json.value, TOKEN);
    assert.equal((fs.statSync(env.LA_CONFIG).mode & 0o777), 0o600);
    const get = await run(['config', 'get', 'token'], { env });
    assert.equal(get.stdout.trim(), TOKEN);
    const list = await run(['config', '--json'], { env });
    assert.equal(list.json.values.server.value, server.url);
    assert.equal(list.json.values.server.source, 'file');
    assert.ok(!JSON.stringify(list.json).includes(TOKEN));
    const who = await run(['whoami', '--json'], { env });
    assert.equal(who.code, 0);
    assert.deepEqual(who.json, { name: 'owner', server: server.url });
    assert.equal(server.state.calls.at(-1).auth, `Bearer ${TOKEN}`);
  });

  test('env overrides config; bad token -> exit 4; unreachable -> exit 5; unset -> exit 3', async () => {
    let r = await run(['whoami'], { env: { LA_SERVER: server.url, LA_TOKEN: 'wrong' } });
    assert.equal(r.code, 4);
    assert.match(r.stderr, /Authentication failed/);
    r = await run(['whoami'], { env: { LA_SERVER: 'http://127.0.0.1:9', LA_TOKEN: 'x' } });
    assert.equal(r.code, 5);
    r = await run(['whoami']);
    assert.equal(r.code, 3);
    r = await run(['whoami', '--server', server.url, '--token', TOKEN]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /owner @/);
  });
});

describe('library', () => {
  test('lists, searches and pages', async () => {
    const songs = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, youtube_id: `yyyyyyyyyy${i}`, title: `Song ${i}`, artist: i < 2 ? 'Daft Punk' : 'Other', album: null, duration_sec: 200 + i }));
    const server = await startServer({ songs });
    try {
      let r = await run(['library', '--json'], { server });
      assert.equal(r.json.total, 7);
      assert.equal(r.json.songs.length, 7);
      r = await run(['library', 'daft', 'punk', '--json'], { server });
      assert.equal(r.json.total, 2);
      assert.equal(server.state.calls.at(-1).query.q, 'daft punk');
      r = await run(['library', '--limit', '3', '--offset', '3'], { server });
      assert.match(r.stdout, /Song 3/);
      assert.match(r.stdout, /4-6 of 7/);
      r = await run(['library', '--all', '--json'], { server });
      assert.equal(r.json.songs.length, 7);
      r = await run(['library', '--limit', 'x'], { server });
      assert.equal(r.code, 2);
    } finally { await server.close(); }
  });
});

describe('download', () => {
  test('video URL: downloads, embeds cover, uploads multipart with tags and youtube_id', async () => {
    const server = await startServer();
    const d = deps();
    try {
      const r = await run(['download', 'https://youtu.be/aaaaaaaaaa1', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.json.summary, { total: 1, uploaded: 1, skipped: 0, failed: 0 });
      const up = server.state.uploads[0];
      assert.deepEqual(up.fields, {
        title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', youtube_id: 'aaaaaaaaaa1',
        source_url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1', duration_sec: '301',
      });
      assert.equal(r.json.results[0].source_url, 'https://www.youtube.com/watch?v=aaaaaaaaaa1');
      assert.equal(r.json.results[0].song.source_url, 'https://www.youtube.com/watch?v=aaaaaaaaaa1');
      assert.equal(up.fileContent, 'AUDIO:aaaaaaaaaa1');
      assert.equal(up.fileName, 'aaaaaaaaaa1.m4a');
      assert.equal(up.fileType, 'audio/mp4');
      assert.equal(d.m.calls.embedCover.length, 1);
      assert.equal(r.json.results[0].song.title, 'Digital Love');
      assert.match(r.stderr, /Uploading Daft Punk - Digital Love/);
    } finally { await server.close(); }
  });

  test('resumable: skips songs already in the library, treats 409 as skipped', async () => {
    const server = await startServer({ songs: [{ id: 1, youtube_id: 'aaaaaaaaaa1', title: 'Digital Love', artist: 'Daft Punk' }] });
    const d = deps();
    try {
      // aaaaaaaaaa2 gets a 409 from the server even though the listing missed it
      server.state.failUpload = (f) => (f.youtube_id === 'aaaaaaaaaa2' ? { status: 409, body: { error: 'duplicate', song: { id: 9 } } } : null);
      const r = await run(['download', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', 'yt:aaaaaaaaaa3', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0);
      assert.deepEqual(d.y.calls.download, ['aaaaaaaaaa2', 'aaaaaaaaaa3']);
      assert.deepEqual(r.json.results.map((x) => x.status), ['skipped', 'skipped', 'uploaded']);
      assert.equal(r.json.results[0].reason, 'already in library');
      assert.match(r.json.results[1].reason, /duplicate/);
      assert.deepEqual(r.json.summary, { total: 3, uploaded: 1, skipped: 2, failed: 0 });
      // throttle between the two real downloads only
      assert.deepEqual(d.sleeps, [3000]);
    } finally { await server.close(); }
  });

  test('playlist + search + failures: summary and exit 1', async () => {
    const server = await startServer();
    const d = deps({
      ytdlp: {
        playlists: { PLtest: ['aaaaaaaaaa1', 'broken00001', 'aaaaaaaaaa1'] },
        searches: {
          'Massive Attack - Teardrop': [
            { id: 'zzzzzzzzzz1', title: 'Teardrop (Live)', channel: 'Fan' },
            { id: 'aaaaaaaaaa2', title: 'Teardrop', channel: 'Massive Attack - Topic' },
          ],
        },
      },
    });
    try {
      const r = await run(['download', 'https://www.youtube.com/playlist?list=PLtest', 'Massive Attack - Teardrop', 'no results here', '--sleep', '0', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 1);
      const by = (s) => r.json.results.filter((x) => x.status === s);
      assert.equal(by('uploaded').length, 2);
      assert.equal(by('failed').length, 2);
      assert.equal(by('skipped').length, 1); // duplicate in batch
      assert.deepEqual(r.json.results.find((x) => x.youtube_id === 'aaaaaaaaaa2').matched, { title: 'Teardrop', channel: 'Massive Attack - Topic' });
      assert.ok(by('failed').some((x) => x.code === 'VIDEO_UNAVAILABLE'));
      assert.ok(by('failed').some((x) => x.code === 'NOT_FOUND'));
      assert.deepEqual(d.sleeps, []);
      const human = await run(['download', 'yt:broken00001'], { server, deps: d.deps });
      assert.equal(human.code, 1);
      assert.match(human.stdout, /Summary: 1 item\(s\): 1 failed/);
      assert.match(human.stdout, /Video is unavailable \[VIDEO_UNAVAILABLE\]/);
    } finally { await server.close(); }
  });

  test('--dry-run downloads and uploads nothing', async () => {
    const server = await startServer({ songs: [{ id: 1, youtube_id: 'aaaaaaaaaa1', title: 'x', artist: 'y' }] });
    const d = deps();
    try {
      const r = await run(['download', '--dry-run', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0);
      assert.deepEqual(r.json.results.map((x) => x.status), ['skipped', 'would_download']);
      assert.equal(r.json.dry_run, true);
      assert.equal(d.y.calls.download.length, 0);
      assert.equal(server.state.uploads.length, 0);
    } finally { await server.close(); }
  });

  test('--keep stores a named local copy and later runs reuse it', async () => {
    const server = await startServer();
    const keepDir = tmpDir('la-keep-');
    const d = deps();
    try {
      let r = await run(['download', '--keep', '--keep-dir', keepDir, 'yt:aaaaaaaaaa1', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0);
      const kept = path.join(keepDir, 'Daft Punk - Digital Love [aaaaaaaaaa1].m4a');
      assert.ok(fs.existsSync(kept));
      assert.equal(r.json.results[0].local_file, kept);
      // Server lost the song: re-run uploads from the local copy without downloading.
      server.state.songs.length = 0;
      r = await run(['download', '--keep', '--keep-dir', keepDir, 'yt:aaaaaaaaaa1', '--json'], { server, deps: d.deps });
      assert.equal(r.json.results[0].status, 'uploaded');
      assert.deepEqual(d.y.calls.download, ['aaaaaaaaaa1']);
    } finally { await server.close(); }
  });

  test('--no-upload works without a server', async () => {
    const keepDir = tmpDir('la-keep-');
    const d = deps();
    const r = await run(['download', '--no-upload', '--keep-dir', keepDir, 'yt:aaaaaaaaaa3', '--json'], { deps: d.deps });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.results[0].status, 'downloaded');
    assert.ok(fs.existsSync(path.join(keepDir, 'Boards of Canada - Roygbiv [aaaaaaaaaa3].m4a')));
  });

  test('--no-upload files bulk-upload later with youtube_id and source_url auto-detected', async () => {
    const keepDir = tmpDir('la-keep-');
    const d = deps();
    const dl = await run(['download', '--no-upload', '--keep-dir', keepDir, 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa3', '--json'], { deps: d.deps });
    assert.equal(dl.code, 0, dl.stderr);
    const server = await startServer();
    try {
      const r = await run(['upload', keepDir, '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.summary.uploaded, 2);
      const byId = Object.fromEntries(server.state.uploads.map((u) => [u.fields.youtube_id, u.fields]));
      assert.equal(byId.aaaaaaaaaa1.source_url, 'https://www.youtube.com/watch?v=aaaaaaaaaa1');
      assert.equal(byId.aaaaaaaaaa1.title, 'Digital Love');
      assert.equal(byId.aaaaaaaaaa3.source_url, 'https://www.youtube.com/watch?v=aaaaaaaaaa3');
      // a second run skips both by youtube_id (the dedupe the bulk upload relies on)
      const again = await run(['upload', keepDir, '--json'], { server, deps: d.deps });
      assert.deepEqual(again.json.summary, { total: 2, uploaded: 0, skipped: 2, failed: 0 });
    } finally { await server.close(); }
  });

  test('--ytdlp-args and config ytdlp-args reach the yt-dlp layer', async () => {
    const server = await startServer();
    const d = deps();
    try {
      await run(['download', '--dry-run', '--ytdlp-args=--cookies-from-browser firefox', 'yt:aaaaaaaaaa1'], { server, deps: d.deps, env: { LA_YTDLP_ARGS: '--limit-rate 1M' } });
      assert.deepEqual(d.y.calls.extraArgs, ['--limit-rate', '1M', '--cookies-from-browser', 'firefox']);
    } finally { await server.close(); }
  });

  test('missing tools -> exit 6 with install hint; bad token aborts batch with exit 4', async () => {
    const server = await startServer();
    try {
      let d = deps({ ytdlp: { missing: true } });
      let r = await run(['download', 'yt:aaaaaaaaaa1'], { server, deps: d.deps });
      assert.equal(r.code, 6);
      assert.match(r.stderr, /hint: Install yt-dlp/);
      d = deps({ media: { missing: true } });
      r = await run(['download', 'yt:aaaaaaaaaa1', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 6);
      assert.equal(JSON.parse(r.stderr).error.code, 'MISSING_DEPENDENCY');
      // real YtDlp class with a missing binary
      r = await run(['download', 'yt:aaaaaaaaaa1'], { server, env: { LA_YTDLP_BIN: '/nonexistent/yt-dlp' } });
      assert.equal(r.code, 6);

      d = deps();
      r = await run(['download', 'yt:aaaaaaaaaa1'], { server, deps: d.deps, env: { LA_TOKEN: 'bad' } });
      assert.equal(r.code, 4);
    } finally { await server.close(); }
  });
});

describe('upload', () => {
  test('m4a as-is, other formats converted, tags required, overrides, youtube_id from name', async () => {
    const server = await startServer({ songs: [{ id: 1, youtube_id: 'dQw4w9WgXcQ', title: 'x', artist: 'y' }] });
    const dir = tmpDir('la-files-');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'good.m4a'), 'GOOD');
    fs.writeFileSync(path.join(dir, 'sub', 'track.flac'), 'FLAC');
    fs.writeFileSync(path.join(dir, 'sub', 'untagged.mp3'), 'UNTAGGED');
    fs.writeFileSync(path.join(dir, 'Rick [dQw4w9WgXcQ].m4a'), 'RICK');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const files = {
      GOOD: { format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', duration: 61.4, tags: { title: 'Good', artist: 'Band', album: 'LP' } },
      FLAC: { format: 'flac', codec: 'flac', duration: 120, tags: { title: 'Flac Song', album_artist: 'Band' } },
      UNTAGGED: { format: 'mp3', codec: 'mp3', duration: 10, tags: {} },
      RICK: { format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', duration: 212, tags: { title: 'Never', artist: 'Rick' } },
    };
    const d = deps({ media: { files } });
    try {
      const r = await run(['upload', dir, '--json'], { server, deps: d.deps });
      assert.equal(r.code, 1);
      const byName = Object.fromEntries(r.json.results.map((x) => [path.basename(x.file), x]));
      assert.equal(byName['good.m4a'].status, 'uploaded');
      assert.equal(byName['good.m4a'].converted, false);
      assert.equal(byName['track.flac'].status, 'uploaded');
      assert.equal(byName['track.flac'].converted, true);
      assert.equal(byName['untagged.mp3'].status, 'failed');
      assert.equal(byName['untagged.mp3'].code, 'MISSING_TAGS');
      assert.match(byName['untagged.mp3'].error, /--title\/--artist/);
      assert.equal(byName['Rick [dQw4w9WgXcQ].m4a'].status, 'skipped');
      assert.equal(byName['Rick [dQw4w9WgXcQ].m4a'].youtube_id, 'dQw4w9WgXcQ');
      assert.equal(d.m.calls.toM4a.length, 1);
      assert.equal(d.m.calls.toM4a[0].opts.bitrate, '192k');
      const flacUp = server.state.uploads.find((u) => u.fields.title === 'Flac Song');
      assert.equal(flacUp.fileContent, 'CONVERTED:FLAC');
      assert.equal(flacUp.fileName, 'track.m4a');
      assert.equal(flacUp.fields.artist, 'Band');
      assert.equal(server.state.uploads.find((u) => u.fields.title === 'Good').fields.duration_sec, '61');
      assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));

      const r2 = await run(['upload', path.join(dir, 'sub', 'untagged.mp3'), '--title', 'T', '--artist', 'A', '--request-id', '5', '--json'], { server, deps: d.deps });
      assert.equal(r2.code, 0, r2.stderr);
      assert.deepEqual(server.state.uploads.at(-1).fields, { title: 'T', artist: 'A', duration_sec: '10', request_id: '5' });
    } finally { await server.close(); }
  });

  test('auto-detects youtube_id + source_url from CLI-named files and comment tags; --source-url override', async () => {
    const server = await startServer();
    const dir = tmpDir('la-files-');
    const M4A = 'mov,mp4,m4a,3gp,3g2,mj2';
    const write = (name, content) => { fs.writeFileSync(path.join(dir, name), content); return path.join(dir, name); };
    // exactly what `la download --no-upload` leaves behind
    write('2CELLOS - Misirlou [HOLIDAY VIDEO] [saHMo3zV_iA].m4a', 'CLI');
    // name only, no comment tag (e.g. tags stripped) -> URL derived from the id
    write('Band - Name Only [bbbbbbbbbb2].m4a', 'NAMEONLY');
    // comment tag for a different video than the file name: the tag wins for the id
    // (it is checked first) and its URL is used as source
    write('Band - Other [cccccccccc3].m4a', 'OTHER');
    // free-text comment, no id anywhere -> neither field
    write('plain.m4a', 'PLAIN');
    const files = {
      CLI: { format: M4A, codec: 'aac', duration: 200, tags: { title: 'Misirlou', artist: '2CELLOS', comment: 'https://www.youtube.com/watch?v=saHMo3zV_iA' } },
      NAMEONLY: { format: M4A, codec: 'aac', duration: 100, tags: { title: 'Name Only', artist: 'Band' } },
      OTHER: { format: M4A, codec: 'aac', duration: 100, tags: { title: 'Other', artist: 'Band', comment: 'https://youtu.be/dddddddddd4' } },
      PLAIN: { format: M4A, codec: 'aac', duration: 100, tags: { title: 'Plain', artist: 'Band', comment: 'ripped from my CD' } },
      SINGLE: { format: M4A, codec: 'aac', duration: 100, tags: { title: 'Single', artist: 'Band' } },
    };
    const d = deps({ media: { files } });
    try {
      const r = await run(['upload', dir, '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0, r.stderr);
      const by = Object.fromEntries(server.state.uploads.map((u) => [u.fields.title, u.fields]));
      assert.equal(by.Misirlou.youtube_id, 'saHMo3zV_iA');
      assert.equal(by.Misirlou.source_url, 'https://www.youtube.com/watch?v=saHMo3zV_iA');
      assert.equal(by['Name Only'].youtube_id, 'bbbbbbbbbb2');
      assert.equal(by['Name Only'].source_url, 'https://www.youtube.com/watch?v=bbbbbbbbbb2');
      assert.equal(by.Other.youtube_id, 'dddddddddd4');
      assert.equal(by.Other.source_url, 'https://youtu.be/dddddddddd4');
      assert.equal(by.Plain.youtube_id, undefined);
      assert.equal(by.Plain.source_url, undefined);
      const res = r.json.results.find((x) => x.title === 'Misirlou');
      assert.equal(res.source_url, 'https://www.youtube.com/watch?v=saHMo3zV_iA');

      // --source-url overrides and, for a YouTube link, supplies the youtube_id
      const single = write('single.m4a', 'SINGLE');
      const r2 = await run(['upload', single, '--source-url', 'https://music.youtube.com/watch?v=eeeeeeeeee5', '--json'], { server, deps: d.deps });
      assert.equal(r2.code, 0, r2.stderr);
      assert.equal(server.state.uploads.at(-1).fields.source_url, 'https://music.youtube.com/watch?v=eeeeeeeeee5');
      assert.equal(server.state.uploads.at(-1).fields.youtube_id, 'eeeeeeeeee5');

      // a non-YouTube --source-url is sent as-is, without inventing a youtube_id
      fs.writeFileSync(single, 'SINGLE');
      server.state.songs.length = 0;
      const r3 = await run(['upload', single, '--source-url', 'https://soundcloud.com/band/single', '--json'], { server, deps: d.deps });
      assert.equal(r3.code, 0, r3.stderr);
      assert.deepEqual(server.state.uploads.at(-1).fields, { title: 'Single', artist: 'Band', source_url: 'https://soundcloud.com/band/single', duration_sec: '100' });

      // usage errors
      const bad = await run(['upload', single, '--source-url', 'javascript:alert(1)'], { server, deps: d.deps });
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /--source-url must be an http\(s\) URL/);
      const many = await run(['upload', dir, '--source-url', 'https://x.com/a'], { server, deps: d.deps });
      assert.equal(many.code, 2);
      assert.match(many.stderr, /single file/);
    } finally { await server.close(); }
  });

  test('usage errors: no files, missing path, --title with many files', async () => {
    const server = await startServer();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'b.mp3'), 'x');
    try {
      assert.equal((await run(['upload'], { server })).code, 2);
      assert.equal((await run(['upload', path.join(dir, 'nope.mp3')], { server })).code, 2);
      const r = await run(['upload', dir, '--title', 'x'], { server, deps: deps().deps });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /single file/);
    } finally { await server.close(); }
  });

  test('--dry-run reports fields and conversion without uploading', async () => {
    const server = await startServer();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'A');
    const d = deps({ media: { files: { A: { format: 'mp3', codec: 'mp3', duration: 99.6, tags: { title: 'At', artist: 'Aa' } } } } });
    try {
      const r = await run(['upload', '--dry-run', dir, '--json'], { server, deps: d.deps });
      assert.equal(r.code, 0);
      assert.equal(r.json.results[0].status, 'would_upload');
      assert.deepEqual(r.json.results[0].fields, { title: 'At', artist: 'Aa', duration_sec: 100 });
      assert.match(r.json.results[0].reason, /convert/);
      assert.equal(server.state.uploads.length, 0);
      assert.equal(d.m.calls.toM4a.length, 0);
    } finally { await server.close(); }
  });
});

describe('requests', () => {
  const REQUESTS = () => [
    { id: 1, youtube_id: 'aaaaaaaaaa1', url: null, title: 'Digital Love', artist: 'Daft Punk', requested_by: 'ann', status: 'pending', created_at: 't' },
    { id: 2, youtube_id: null, url: 'https://www.youtube.com/watch?v=aaaaaaaaaa2&list=PLx', title: null, artist: null, requested_by: 'bob', status: 'pending', created_at: 't' },
    { id: 3, youtube_id: null, url: null, title: 'Roygbiv', artist: 'Boards of Canada', requested_by: 'cy', status: 'pending', created_at: 't' },
    { id: 4, youtube_id: null, url: null, title: null, artist: null, requested_by: 'dee', status: 'pending', created_at: 't' },
    { id: 5, youtube_id: 'aaaaaaaaaa3', title: 'Old', artist: 'X', requested_by: 'ed', status: 'fulfilled', created_at: 't' },
  ];

  test('list (default pending, --status all)', async () => {
    const server = await startServer({ requests: REQUESTS() });
    try {
      let r = await run(['requests', '--json'], { server });
      assert.equal(r.json.requests.length, 4);
      assert.equal(server.state.calls.at(-1).query.status, 'pending');
      r = await run(['requests', 'list', '--status', 'all'], { server });
      assert.match(r.stdout, /ID\s+STATUS/);
      assert.match(r.stdout, /fulfilled/);
      r = await run(['requests', '--status', 'weird'], { server });
      assert.equal(r.code, 2);
    } finally { await server.close(); }
  });

  test('fulfill --all: youtube_id, url (single video) and search; request_id sent', async () => {
    const server = await startServer({ requests: REQUESTS() });
    const d = deps({ ytdlp: { searches: { 'Boards of Canada - Roygbiv': [{ id: 'aaaaaaaaaa3', title: 'Roygbiv', channel: 'Boards of Canada - Topic' }] } } });
    try {
      const r = await run(['requests', 'fulfill', '--all', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 1); // request 4 has nothing to go on
      assert.deepEqual(d.y.calls.download, ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3']);
      assert.deepEqual(d.y.calls.playlist, []);
      assert.deepEqual(server.state.uploads.map((u) => u.fields.request_id), ['1', '2', '3']);
      const failed = r.json.results.find((x) => x.status === 'failed');
      assert.equal(failed.request_id, 4);
      assert.equal(failed.code, 'EMPTY_REQUEST');
      assert.equal(server.state.requests.filter((x) => x.status === 'fulfilled').length, 4);
      // no library listing needed for fulfill
      assert.ok(!server.state.calls.some((c) => c.path === '/api/library'));
    } finally { await server.close(); }
  });

  test('fulfill by id: unknown and already-fulfilled ids are reported', async () => {
    const server = await startServer({ requests: REQUESTS() });
    const d = deps();
    try {
      const r = await run(['requests', 'fulfill', '1', '5', '99', '--json'], { server, deps: d.deps });
      assert.equal(r.code, 1);
      const st = Object.fromEntries(r.json.results.map((x) => [String(x.request_id), x.status]));
      assert.deepEqual(st, { 1: 'uploaded', 5: 'skipped', 99: 'failed' });
      assert.equal((await run(['requests', 'fulfill'], { server })).code, 2);
      assert.equal((await run(['requests', 'fulfill', '--all', '1'], { server })).code, 2);
    } finally { await server.close(); }
  });

  test('dismiss', async () => {
    const server = await startServer({ requests: REQUESTS() });
    try {
      const r = await run(['requests', 'dismiss', '2', '3', '42', '--json'], { server });
      assert.equal(r.code, 1);
      assert.deepEqual(server.state.dismissed, [2, 3]);
      assert.deepEqual(r.json.summary, { total: 3, dismissed: 2, failed: 1, uploaded: 0, skipped: 0 });
      assert.match(r.json.results[2].error, /404/);
    } finally { await server.close(); }
  });
});
