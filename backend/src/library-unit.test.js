// Unit tests for the music library helpers that need no database.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const library = require('./library');
const tokens = require('./tokens');
const adminAuth = require('./adminAuth');
const { createResolver } = require('./songResolver');

describe('library.parseYoutubeId', () => {
  it('accepts bare ids and the common URL shapes', () => {
    const id = 'dQw4w9WgXcQ';
    for (const input of [
      id,
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&list=PL123&index=2`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?t=10`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
    ]) {
      assert.equal(library.parseYoutubeId(input), id, input);
    }
  });

  it('rejects non-YouTube input', () => {
    for (const input of [null, '', 'never gonna give you up', 'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short', 'https://open.spotify.com/track/abc', 'library:123']) {
      assert.equal(library.parseYoutubeId(input), null, String(input));
    }
  });
});

describe('library.classifyM4a', () => {
  const probe = (format_name, streams) => ({ format: { format_name, duration: '12.5' }, streams });

  it('accepts AAC in an MP4 container', () => {
    const r = library.classifyM4a(probe('mov,mp4,m4a,3gp,3g2,mj2', [{ codec_type: 'audio', codec_name: 'aac' }]));
    assert.deepEqual(r, { ok: true, duration: 12.5 });
  });

  it('accepts embedded cover art (attached picture)', () => {
    const r = library.classifyM4a(probe('mov,mp4,m4a,3gp,3g2,mj2', [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    ]));
    assert.equal(r.ok, true);
  });

  it('rejects mp3, opus-in-mp4, real video, and non-media', () => {
    assert.equal(library.classifyM4a(probe('mp3', [{ codec_type: 'audio', codec_name: 'mp3' }])).ok, false);
    assert.match(library.classifyM4a(probe('mov,mp4,m4a', [{ codec_type: 'audio', codec_name: 'opus' }])).reason, /AAC/);
    assert.match(library.classifyM4a(probe('mov,mp4,m4a', [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
    ])).reason, /video/);
    assert.equal(library.classifyM4a(probe('mov,mp4,m4a', [])).ok, false);
    assert.equal(library.classifyM4a(null).ok, false);
  });
});

describe('library.validateUploadFields', () => {
  it('requires title and artist', () => {
    assert.throws(() => library.validateUploadFields({ artist: 'a' }), /title is required/);
    assert.throws(() => library.validateUploadFields({ title: 'x', artist: '   ' }), /artist is required/);
  });

  it('normalises optional fields', () => {
    const f = library.validateUploadFields({
      title: '  Song\n', artist: 'Band', album: '', youtube_id: 'https://youtu.be/dQw4w9WgXcQ', duration_sec: '201.5',
      request_id: '0b6f3b7e-6b0e-4a59-9a43-6bd1ef3c1f00',
    });
    assert.deepEqual(f, {
      title: 'Song', artist: 'Band', album: null, youtube_id: 'dQw4w9WgXcQ',
      source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration_sec: 201.5,
      request_id: '0b6f3b7e-6b0e-4a59-9a43-6bd1ef3c1f00',
    });
  });

  it('rejects bad youtube_id, duration and request_id', () => {
    assert.throws(() => library.validateUploadFields({ title: 'x', artist: 'y', youtube_id: 'nope' }), /youtube_id/);
    assert.throws(() => library.validateUploadFields({ title: 'x', artist: 'y', duration_sec: '-3' }), /duration_sec/);
    assert.throws(() => library.validateUploadFields({ title: 'x', artist: 'y', duration_sec: 'abc' }), /duration_sec/);
    assert.throws(() => library.validateUploadFields({ title: 'x', artist: 'y', request_id: '42' }), /request_id/);
  });
});

describe('library source_url', () => {
  it('normalizeSourceUrl accepts http(s) only, length-capped', () => {
    assert.equal(library.normalizeSourceUrl(' https://www.youtube.com/watch?v=dQw4w9WgXcQ '), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(library.normalizeSourceUrl('http://example.com/a b'), 'http://example.com/a%20b');
    for (const bad of ['javascript:alert(1)', 'ftp://example.com/x', 'file:///etc/passwd', 'data:text/html,hi',
      'not a url', '', '//example.com/x', 'https://user:pw@example.com/', null, 42]) {
      assert.equal(library.normalizeSourceUrl(bad), null, String(bad));
    }
    const long = 'https://example.com/' + 'a'.repeat(library.MAX_SOURCE_URL_LENGTH);
    assert.equal(library.normalizeSourceUrl(long), null);
  });

  it('validateUploadFields: explicit source_url wins over the derived one', () => {
    const f = library.validateUploadFields({
      title: 't', artist: 'a', youtube_id: 'dQw4w9WgXcQ', source_url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    assert.equal(f.source_url, 'https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('validateUploadFields: derives from youtube_id, null when neither given', () => {
    assert.equal(library.validateUploadFields({ title: 't', artist: 'a', youtube_id: 'dQw4w9WgXcQ', source_url: '  ' }).source_url,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(library.validateUploadFields({ title: 't', artist: 'a' }).source_url, null);
    assert.equal(library.validateUploadFields({ title: 't', artist: 'a', source_url: 'https://soundcloud.com/x/y' }).source_url,
      'https://soundcloud.com/x/y');
  });

  it('validateUploadFields: rejects non-http(s) and over-long source_url', () => {
    assert.throws(() => library.validateUploadFields({ title: 't', artist: 'a', source_url: 'javascript:alert(1)' }), /source_url/);
    assert.throws(() => library.validateUploadFields({ title: 't', artist: 'a', source_url: 'https://x.com/' + 'a'.repeat(3000) }), /source_url/);
  });

  it('toPublic exposes source_url, falling back to the YouTube watch URL', () => {
    assert.equal(library.toPublic({ id: '1', youtube_id: null, source_url: 'https://x.com/s' }).source_url, 'https://x.com/s');
    assert.equal(library.toPublic({ id: '1', youtube_id: 'dQw4w9WgXcQ', source_url: null }).source_url,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(library.toPublic({ id: '1', youtube_id: null, source_url: null }).source_url, null);
  });
});

describe('library.validateUploadFileMeta', () => {
  it('requires a .m4a file with an audio/mp4-ish content type', () => {
    assert.throws(() => library.validateUploadFileMeta(undefined), /file is required/);
    assert.throws(() => library.validateUploadFileMeta({ originalname: 'a.mp3', mimetype: 'audio/mpeg' }), /\.m4a/);
    assert.throws(() => library.validateUploadFileMeta({ originalname: 'a.m4a', mimetype: 'text/plain' }), /content type/);
    for (const mimetype of ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'application/octet-stream', '']) {
      assert.doesNotThrow(() => library.validateUploadFileMeta({ originalname: 'Song.M4A', mimetype }));
    }
  });
});

describe('library queue url helpers', () => {
  it('uses the YouTube URL when there is a youtube_id, else library:<id>', () => {
    assert.equal(library.queueUrlFor({ id: 'x', youtube_id: 'dQw4w9WgXcQ' }), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(library.queueUrlFor({ id: 'abc', youtube_id: null }), 'library:abc');
    const e = library.toQueueEntry({ id: 'abc', youtube_id: null, title: 'T', artist: 'A', duration_sec: 10 });
    assert.deepEqual(e, { url: 'library:abc', title: 'T - A', duration: 10, thumbnail: null });
  });
});

// queue:add with a libraryId refuses a song the lobby already has queued
// (index.js addLibrarySongToLobby with skipIfQueued), based on this check.
describe('library.isQueued', () => {
  const { Queue } = require('./queue');
  const ytSong = { id: '11111111-1111-4111-8111-111111111111', youtube_id: 'dQw4w9WgXcQ', title: 'Y', artist: 'A' };
  const plainSong = { id: '22222222-2222-4222-8222-222222222222', youtube_id: null, title: 'P', artist: 'A' };

  it('is false for an empty queue or a different song', () => {
    const q = new Queue('lobby');
    assert.equal(library.isQueued(q.getSongs(), ytSong), false);
    q.addSong({ ...library.toQueueEntry(plainSong), addedBy: 'x' });
    assert.equal(library.isQueued(q.getSongs(), ytSong), false);
    assert.equal(library.isQueued(q.getSongs(), plainSong), true);
  });

  it('matches a queued library song by its queue url, and stops once it is removed', () => {
    const q = new Queue('lobby');
    const entry = q.addSong({ ...library.toQueueEntry(ytSong), addedBy: 'x' });
    assert.equal(library.isQueued(q.getSongs(), ytSong), true);
    q.removeSong(entry.id);
    assert.equal(library.isQueued(q.getSongs(), ytSong), false);
  });

  it('matches other URL shapes for the same YouTube id, library: urls and the legacy source_url', () => {
    assert.equal(library.isQueued([{ url: 'https://youtu.be/dQw4w9WgXcQ?t=3' }], ytSong), true);
    assert.equal(library.isQueued([{ url: `library:${ytSong.id}` }], ytSong), true);
    const legacy = { ...plainSong, source_url: 'https://example.com/cache/p.m4a' };
    assert.equal(library.isQueued([{ url: 'https://example.com/cache/p.m4a' }], legacy), true);
    assert.equal(library.isQueued([{ url: 'https://example.com/other.m4a' }, {}, null], legacy), false);
  });
});

describe('tokens helpers', () => {
  it('generates distinct prefixed tokens and hashes deterministically', () => {
    const a = tokens.generateToken();
    const b = tokens.generateToken();
    assert.notEqual(a, b);
    assert.match(a, /^la_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokens.hashToken(a), tokens.hashToken(a));
    assert.match(tokens.hashToken(a), /^[0-9a-f]{64}$/);
  });

  it('parses Bearer headers', () => {
    assert.equal(tokens.bearerFrom({ headers: { authorization: 'Bearer abc' } }), 'abc');
    assert.equal(tokens.bearerFrom({ headers: { authorization: 'bearer   abc ' } }), 'abc');
    assert.equal(tokens.bearerFrom({ headers: { authorization: 'Basic abc' } }), null);
    assert.equal(tokens.bearerFrom({ headers: {} }), null);
  });

  it('optionalToken ignores non-Bearer Authorization (cached browser Basic auth)', () => {
    let passed = false;
    const res = { status() { throw new Error('should not respond'); } };
    tokens.optionalToken({ headers: { authorization: 'Basic YWRtaW46cHc=' } }, res, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(tokens.hasBearer({ headers: { authorization: 'Bearer x' } }), true);
    assert.equal(tokens.hasBearer({ headers: { authorization: 'Basic x' } }), false);
  });
});

describe('adminAuth', () => {
  let saved;
  let savedUser;
  beforeEach(() => { saved = process.env.ADMIN_PASSWORD; savedUser = process.env.ADMIN_USER; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = saved;
    if (savedUser === undefined) delete process.env.ADMIN_USER; else process.env.ADMIN_USER = savedUser;
  });

  it('is disabled without ADMIN_PASSWORD', () => {
    delete process.env.ADMIN_PASSWORD;
    assert.equal(adminAuth.isEnabled(), false);
    assert.equal(adminAuth.checkPassword(''), false);
    assert.equal(adminAuth.verifySessionValue('123.abc'), false);
  });

  it('checks the password and signs expiring sessions', () => {
    process.env.ADMIN_PASSWORD = 'hunter2';
    assert.equal(adminAuth.checkPassword('hunter2'), true);
    assert.equal(adminAuth.checkPassword('hunter3'), false);
    const now = Date.now();
    const v = adminAuth.createSessionValue(now);
    assert.equal(adminAuth.verifySessionValue(v, now), true);
    assert.equal(adminAuth.verifySessionValue(v, now + 8 * 24 * 3600 * 1000), false, 'expired');
    const [exp, sig] = v.split('.');
    assert.equal(adminAuth.verifySessionValue(`${Number(exp) + 1}.${sig}`, now), false, 'tampered');
    process.env.ADMIN_PASSWORD = 'changed';
    assert.equal(adminAuth.verifySessionValue(v, now), false, 'password change logs out');
  });

  it('checks the username, defaulting to admin', () => {
    delete process.env.ADMIN_USER;
    process.env.ADMIN_PASSWORD = 'hunter2';
    assert.equal(adminAuth.checkCredentials('admin', 'hunter2'), true);
    assert.equal(adminAuth.checkCredentials('root', 'hunter2'), false);
    assert.equal(adminAuth.checkCredentials(undefined, 'hunter2'), false);
    const now = Date.now();
    const v = adminAuth.createSessionValue(now);
    process.env.ADMIN_USER = 'erkan';
    assert.equal(adminAuth.checkCredentials('erkan', 'hunter2'), true);
    assert.equal(adminAuth.checkCredentials('admin', 'hunter2'), false);
    assert.equal(adminAuth.checkCredentials('erkan', 'hunter3'), false);
    assert.equal(adminAuth.verifySessionValue(v, now), false, 'username change logs out');
  });
});

describe('songResolver', () => {
  const song = { id: '11111111-1111-4111-8111-111111111111', youtube_id: 'dQw4w9WgXcQ', title: 'Never', artist: 'Rick' };
  function fakes(over = {}) {
    const library2 = {
      parseYoutubeId: library.parseYoutubeId,
      youtubeUrl: library.youtubeUrl,
      getById: async (id) => (id === song.id ? song : null),
      getByYoutubeId: async (id) => (id === song.youtube_id ? song : null),
      findBestTextMatch: async () => null,
      findByTitleArtist: async () => null,
      resolveQueueUrl: async () => null,
      ...over.library,
    };
    const ytdlp = {
      parsePlaylistId: require('./ytdlp').parsePlaylistId,
      searchYoutube: async () => null,
      getOembed: async () => ({ title: 'From oEmbed', channel: 'Chan' }),
      getPlaylistEntries: async () => [],
      ...over.ytdlp,
    };
    const spotify = { parseSpotifyUrl: require('./spotify').parseSpotifyUrl, getTrack: async () => ({}), ...over.spotify };
    return createResolver({ library: library2, ytdlp, spotify });
  }

  it('resolves libraryId and in-library YouTube links to the library song', async () => {
    const r = fakes();
    assert.deepEqual(await r.resolve({ libraryId: song.id }), { type: 'library', song });
    assert.deepEqual(await r.resolve({ input: 'https://youtu.be/dQw4w9WgXcQ' }), { type: 'library', song });
    assert.equal((await r.resolve({ libraryId: '22222222-2222-4222-8222-222222222222' })).type, 'error');
  });

  it('turns a YouTube link not in the library into a request (title via oEmbed)', async () => {
    const r = await fakes().resolve({ input: 'https://www.youtube.com/watch?v=9bZkp7q19f0' });
    assert.deepEqual(r, {
      type: 'request',
      request: { youtubeId: '9bZkp7q19f0', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', title: 'From oEmbed', artist: null },
    });
  });

  it('free text: YouTube search hit in library > library text match > request', async () => {
    const hit = { id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Rick' };
    assert.equal((await fakes({ ytdlp: { searchYoutube: async () => hit } }).resolve({ input: 'rick' })).type, 'library');

    const other = { id: '9bZkp7q19f0', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', title: 'Gangnam' };
    const viaText = await fakes({ ytdlp: { searchYoutube: async () => other }, library: { findBestTextMatch: async () => song } }).resolve({ input: 'never' });
    assert.deepEqual(viaText, { type: 'library', song });

    const req = await fakes({ ytdlp: { searchYoutube: async () => other } }).resolve({ input: 'gangnam' });
    assert.deepEqual(req.request, { youtubeId: '9bZkp7q19f0', url: other.url, title: 'Gangnam', artist: null });

    // search fails (IP blocked) and nothing matches -> text-only request
    const blocked = await fakes({ ytdlp: { searchYoutube: async () => { throw new Error('bot'); } } }).resolve({ input: 'some song' });
    assert.deepEqual(blocked, { type: 'request', request: { youtubeId: null, url: null, title: 'some song', artist: null } });
  });

  it('playlists split into library songs and requests', async () => {
    const r = await fakes({
      ytdlp: { getPlaylistEntries: async () => [{ id: 'dQw4w9WgXcQ', title: 'a' }, { id: '9bZkp7q19f0', title: 'b' }] },
    }).resolve({ input: 'https://www.youtube.com/playlist?list=PLabc' });
    assert.equal(r.type, 'playlist');
    assert.deepEqual(r.items.map((i) => i.type), ['library', 'request']);
    assert.equal(r.items[1].request.youtubeId, '9bZkp7q19f0');
  });

  it('spotify links match title+artist in the library, else request with title/artist', async () => {
    const track = { name: 'Never', artist: 'Rick', searchQuery: 'Never Rick' };
    const lib = await fakes({ spotify: { getTrack: async () => track }, library: { findByTitleArtist: async () => song } })
      .resolve({ input: 'https://open.spotify.com/track/abc123' });
    assert.equal(lib.type, 'library');
    const req = await fakes({ spotify: { getTrack: async () => track } }).resolve({ input: 'https://open.spotify.com/track/abc123' });
    assert.deepEqual(req.request, { youtubeId: null, url: 'https://open.spotify.com/track/abc123', title: 'Never', artist: 'Rick' });
  });

  it('rejects unsupported links and empty input', async () => {
    assert.equal((await fakes().resolve({ input: 'https://example.com/song.mp3' })).type, 'error');
    assert.equal((await fakes().resolve({ input: '   ' })).type, 'error');
  });
});

describe('library.uploadTmpPath', () => {
  const path = require('node:path');
  it('resolves multer temp files inside UPLOAD_TMP_DIR only', () => {
    const root = path.resolve(library.UPLOAD_TMP_DIR);
    assert.equal(library.uploadTmpPath({ path: path.join(root, 'abc.part') }), path.join(root, 'abc.part'));
    // anything else is pinned to its basename inside the temp dir
    assert.equal(library.uploadTmpPath({ path: '/etc/passwd' }), path.join(root, 'passwd'));
    for (const bad of [{ path: '' }, { path: '..' }, {}, null]) {
      assert.throws(() => library.uploadTmpPath(bad), /temp path/);
    }
  });
});

describe('rateLimits', () => {
  it('returns 429 JSON once the per-IP limit is exceeded', async () => {
    const express = require('express');
    const http = require('node:http');
    const { make } = require('./rateLimits');
    const app = express();
    app.get('/x', make(2), (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/x`;
    try {
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await fetch(url)).status, 200);
      const res = await fetch(url);
      assert.equal(res.status, 429);
      assert.match((await res.json()).error, /Too many requests/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
