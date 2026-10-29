'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classify, findVideoId, pickBest } = require('../src/youtube');
const { splitArgs } = require('../src/proc');
const config = require('../src/config');
const { YtDlp, parseError, FORMAT } = require('../src/ytdlp');
const { Media, expandInputs } = require('../src/media');
const { safeName } = require('../src/pipeline');
const { tmpDir } = require('./helpers');

describe('youtube.classify', () => {
  test('video URLs in all common shapes', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=10',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      assert.deepEqual(classify(u), { kind: 'video', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, u);
    }
  });

  test('playlists, radio mixes and --no-playlist', () => {
    assert.equal(classify('https://www.youtube.com/playlist?list=PL123').kind, 'playlist');
    assert.equal(classify('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123').kind, 'playlist');
    assert.equal(classify('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123', { noPlaylist: true }).kind, 'video');
    assert.equal(classify('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ').kind, 'video');
  });

  test('search text, yt: ids and foreign URLs', () => {
    assert.deepEqual(classify('Daft Punk - Digital Love'), { kind: 'search', query: 'Daft Punk - Digital Love' });
    assert.equal(classify('yt:dQw4w9WgXcQ').id, 'dQw4w9WgXcQ');
    assert.equal(classify('dQw4w9WgXcQ').kind, 'search');
    assert.deepEqual(classify('https://soundcloud.com/a/b'), { kind: 'url', url: 'https://soundcloud.com/a/b' });
  });
});

test('findVideoId reads URLs and yt-dlp style file names', () => {
  assert.equal(findVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(findVideoId('see https://youtu.be/dQw4w9WgXcQ now'), 'dQw4w9WgXcQ');
  assert.equal(findVideoId('Rick - Never [dQw4w9WgXcQ].m4a'), 'dQw4w9WgXcQ');
  assert.equal(findVideoId('plain.m4a'), null);
  assert.equal(findVideoId(undefined), null);
});

test('pickBest prefers Topic channels / official audio and avoids live/cover', () => {
  const entries = [
    { id: 'aaaaaaaaaaa', title: 'Song (Live at Wembley)', channel: 'Band' },
    { id: 'bbbbbbbbbbb', title: 'Song (cover)', channel: 'Someone' },
    { id: 'ccccccccccc', title: 'Song', channel: 'Band - Topic' },
  ];
  assert.equal(pickBest(entries, 'Band - Song').id, 'ccccccccccc');
  assert.equal(pickBest([{ id: 'x1x1x1x1x1x', title: 'Song (Official Video)' }, { id: 'y2y2y2y2y2y', title: 'Song (Official Audio)' }], 'Song').id, 'y2y2y2y2y2y');
  // asked for live explicitly: no penalty, relevance order wins
  assert.equal(pickBest([{ id: 'aaaaaaaaaaa', title: 'Song live' }, { id: 'ddddddddddd', title: 'Song live 2' }], 'song live').id, 'aaaaaaaaaaa');
  assert.equal(pickBest([], 'x'), null);
});

test('splitArgs handles quotes and escapes', () => {
  assert.deepEqual(splitArgs('--cookies-from-browser firefox'), ['--cookies-from-browser', 'firefox']);
  assert.deepEqual(splitArgs(`--a "b c" 'd e' f\\ g`), ['--a', 'b c', 'd e', 'f g']);
  assert.deepEqual(splitArgs(['--x 1', '--y']), ['--x', '1', '--y']);
  assert.deepEqual(splitArgs(''), []);
  assert.throws(() => splitArgs('"open'), /Unterminated/);
});

test('safeName strips path separators', () => {
  assert.equal(safeName('AC/DC - Back\\In  Black'), 'AC-DC - Back-In Black');
});

describe('config', () => {
  test('set writes mode 600 and load applies env > file > default', () => {
    const dir = tmpDir();
    const env = { LA_CONFIG: path.join(dir, 'sub', 'config.json') };
    config.setValue('server', 'https://a.example.com/', env);
    config.setValue('token', 'tok-file', env);
    const mode = fs.statSync(env.LA_CONFIG).mode & 0o777;
    assert.equal(mode, 0o600);
    let cfg = config.load(env);
    assert.equal(cfg.values.server, 'https://a.example.com');
    assert.equal(cfg.sources.server, 'file');
    assert.equal(cfg.values.sleep, 3);
    assert.equal(cfg.sources.sleep, 'default');
    cfg = config.load({ ...env, LA_TOKEN: 'tok-env' }, { server: 'http://flag.local' });
    assert.equal(cfg.values.token, 'tok-env');
    assert.equal(cfg.sources.token, 'env');
    assert.equal(cfg.values.server, 'http://flag.local');
    assert.equal(cfg.sources.server, 'flag');
    config.unsetValue('token', env);
    assert.equal(config.load(env).values.token, undefined);
  });

  test('XDG_CONFIG_HOME is respected and bad values rejected', () => {
    assert.equal(config.configPath({ XDG_CONFIG_HOME: '/x' }), '/x/listen-along/config.json');
    const env = { LA_CONFIG: path.join(tmpDir(), 'c.json') };
    assert.throws(() => config.setValue('server', 'not a url', env), /Invalid server URL/);
    assert.throws(() => config.setValue('sleep', '-1', env), /non-negative/);
    assert.throws(() => config.setValue('nope', 'x', env), /Unknown config key/);
  });

  test('requireServer reports what is missing', () => {
    assert.throws(() => config.requireServer({ values: { server: 'http://x' } }), (e) => e.exitCode === 3 && /token/.test(e.message));
  });
});

describe('YtDlp invocation layer', () => {
  function recorder(result) {
    const calls = [];
    const run = async (bin, args) => { calls.push({ bin, args }); return typeof result === 'function' ? result(args) : result; };
    return { calls, run };
  }

  test('download: m4a format 140, no re-encode flags, tags, target after --', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'abcdefghijk.m4a');
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(path.join(dir, 'abcdefghijk.jpg'), 'j');
    const { calls, run } = recorder({ code: 0, stdout: `${JSON.stringify({ id: 'abcdefghijk', title: 'T', filepath: file })}\n`, stderr: '' });
    const y = new YtDlp({ run, extraArgs: ['--cookies', 'c.txt'], env: { PATH: '' } });
    const res = await y.download('https://www.youtube.com/watch?v=abcdefghijk', { outDir: dir });
    assert.equal(res.file, file);
    assert.equal(res.thumbnail, path.join(dir, 'abcdefghijk.jpg'));
    const args = calls[0].args;
    assert.equal(calls[0].bin, 'yt-dlp');
    assert.equal(args[args.indexOf('-f') + 1], FORMAT);
    assert.match(FORMAT, /^140\//);
    for (const flag of ['--embed-metadata', '--write-thumbnail', '--no-playlist']) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes('-x') && !args.includes('--extract-audio') && !args.includes('--audio-format'), 'must not transcode');
    const dd = args.indexOf('--');
    assert.ok(dd > args.indexOf('--cookies'), 'extra args go before --');
    assert.deepEqual(args.slice(dd + 1), ['https://www.youtube.com/watch?v=abcdefghijk']);
    // No deno on PATH -> node is used as the JS runtime.
    assert.ok(args.includes('--js-runtimes'));
  });

  test('search uses ytsearchN: with flat JSON', async () => {
    const { calls, run } = recorder({ code: 0, stdout: JSON.stringify({ entries: [{ id: 'abcdefghijk', title: 'S', channel: 'C' }] }), stderr: '' });
    const y = new YtDlp({ run, env: { PATH: '' } });
    const r = await y.search('a - b', 5);
    assert.equal(r[0].url, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.ok(calls[0].args.includes('ytsearch5:a - b'));
    assert.ok(calls[0].args.includes('--flat-playlist'));
  });

  test('playlist drops deleted/private entries', async () => {
    const { run } = recorder({ code: 0, stdout: JSON.stringify({ entries: [{ id: 'abcdefghijk', title: 'ok' }, { id: 'zzzzzzzzzzz', title: '[Deleted video]' }, null] }), stderr: '' });
    const r = await new YtDlp({ run, env: { PATH: '' } }).playlist('https://www.youtube.com/playlist?list=PL1');
    assert.deepEqual(r.map((e) => e.id), ['abcdefghijk']);
  });

  test('errors are classified', async () => {
    const { run } = recorder({ code: 1, stdout: '', stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot" });
    await assert.rejects(new YtDlp({ run, env: { PATH: '' } }).download('https://www.youtube.com/watch?v=abcdefghijk', { outDir: tmpDir() }), (e) => e.code === 'BOT_CHECK');
    assert.equal(parseError('ERROR: Sign in to confirm your age').code, 'AGE_RESTRICTED');
    assert.equal(parseError('ERROR: Video unavailable').code, 'VIDEO_UNAVAILABLE');
    assert.equal(parseError('ERROR: unable to download video data: HTTP Error 403: Forbidden').code, 'FORBIDDEN');
    assert.equal(parseError('ERROR: Requested format is not available').code, 'NO_M4A_FORMAT');
    assert.equal(parseError('ERROR: weird').code, 'YTDLP_FAILED');
  });

  test('missing binary -> dependency error with install hint', async () => {
    const y = new YtDlp({ bin: '/nonexistent/yt-dlp' });
    await assert.rejects(y.version(), (e) => e.exitCode === 6 && /pipx install yt-dlp/.test(e.hint));
  });
});

describe('media', () => {
  test('isAacM4a', () => {
    assert.ok(Media.isAacM4a({ format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac' }, 'a.m4a'));
    assert.ok(!Media.isAacM4a({ format: 'mp3', codec: 'mp3' }, 'a.mp3'));
    assert.ok(!Media.isAacM4a({ format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'alac' }, 'a.m4a'));
  });

  test('expandInputs walks directories for audio files only', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', '1.mp3'), '');
    fs.writeFileSync(path.join(dir, 'a', 'b', '2.FLAC'), '');
    fs.writeFileSync(path.join(dir, 'a', 'cover.jpg'), '');
    fs.writeFileSync(path.join(dir, 'a', '.hidden.mp3'), '');
    fs.writeFileSync(path.join(dir, 'odd.bin'), '');
    const r = expandInputs([path.join(dir, 'a'), path.join(dir, 'odd.bin'), path.join(dir, 'missing')]);
    assert.deepEqual(r.files.map((f) => path.relative(dir, f)), ['a/1.mp3', 'a/b/2.FLAC', 'odd.bin']);
    assert.deepEqual(r.missing, [path.join(dir, 'missing')]);
  });
});
