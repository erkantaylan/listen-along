// Unit tests for the music library helpers that need no database.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { library } from './index.ts';
import type { PublicSongRow } from './index.ts';
import type { Probe, ProbeStream, ProbeVerdict, UploadVerdict } from './library.ts';
import type { LibrarySongRow } from '../../shared/types.ts';
import { Queue } from '../queue/index.ts';

/** A refusal's reason ('' when it was accepted, which no pattern below matches). */
const reason = (v: ProbeVerdict | UploadVerdict): string => (v.ok ? '' : v.reason);
/** A partial row for toPublic. */
const row = (r: Partial<PublicSongRow>) => r as PublicSongRow;

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
  const probe = (format_name: string, streams: ProbeStream[]): Probe => ({ format: { format_name, duration: '12.5' }, streams });

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
    assert.match(reason(library.classifyM4a(probe('mov,mp4,m4a', [{ codec_type: 'audio', codec_name: 'opus' }]))), /AAC/);
    assert.match(reason(library.classifyM4a(probe('mov,mp4,m4a', [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
    ]))), /video/);
    assert.equal(library.classifyM4a(probe('mov,mp4,m4a', [])).ok, false);
    assert.equal(library.classifyM4a(null).ok, false);
  });
});

describe('library.classifyUpload (m4a or Ogg Opus, by content)', () => {
  const probe = (format_name: string, streams: ProbeStream[]): Probe => ({ format: { format_name, duration: '12.5' }, streams });

  it('AAC in MP4 is stored as .m4a, served as audio/mp4', () => {
    const r = library.classifyUpload(probe('mov,mp4,m4a,3gp,3g2,mj2', [{ codec_type: 'audio', codec_name: 'aac' }]));
    assert.deepEqual(r, { ok: true, duration: 12.5, format: 'm4a', ext: '.m4a', mime: 'audio/mp4' });
  });

  it('Opus in Ogg is stored as .opus, served as audio/ogg; a cover picture is fine', () => {
    const r = library.classifyUpload(probe('ogg', [
      { codec_type: 'audio', codec_name: 'opus' },
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    ]));
    assert.deepEqual(r, { ok: true, duration: 12.5, format: 'opus', ext: '.opus', mime: 'audio/ogg' });
  });

  it('refuses Vorbis or FLAC in Ogg, Theora video, Opus in WebM, mp3 and non-media', () => {
    assert.match(reason(library.classifyUpload(probe('ogg', [{ codec_type: 'audio', codec_name: 'vorbis' }]))), /Opus/);
    assert.match(reason(library.classifyUpload(probe('ogg', [{ codec_type: 'audio', codec_name: 'flac' }]))), /Opus/);
    assert.match(reason(library.classifyUpload(probe('ogg', [
      { codec_type: 'audio', codec_name: 'opus' },
      { codec_type: 'video', codec_name: 'theora', disposition: { attached_pic: 0 } },
    ]))), /video/);
    assert.match(reason(library.classifyUpload(probe('matroska,webm', [{ codec_type: 'audio', codec_name: 'opus' }]))), /container/);
    assert.equal(library.classifyUpload(probe('mp3', [{ codec_type: 'audio', codec_name: 'mp3' }])).ok, false);
    assert.equal(library.classifyUpload(probe('ogg', [])).ok, false);
    assert.equal(library.classifyUpload(null).ok, false);
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
      request_id: '0b6f3b7e-6b0e-4a59-9a43-6bd1ef3c1f00', allow_similar: false,
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
    assert.equal(library.toPublic(row({ id: '1', youtube_id: null, source_url: 'https://x.com/s' })).source_url, 'https://x.com/s');
    assert.equal(library.toPublic(row({ id: '1', youtube_id: 'dQw4w9WgXcQ', source_url: null })).source_url,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(library.toPublic(row({ id: '1', youtube_id: null, source_url: null })).source_url, null);
  });
});

describe('library.validateUploadFileMeta', () => {
  it('requires a .m4a or .opus file with an audio-ish content type', () => {
    assert.throws(() => library.validateUploadFileMeta(undefined), /file is required/);
    assert.throws(() => library.validateUploadFileMeta({ originalname: 'a.mp3', mimetype: 'audio/mpeg' }), /\.m4a/);
    assert.throws(() => library.validateUploadFileMeta({ originalname: 'a.webm', mimetype: 'audio/webm' }), /\.opus/);
    assert.throws(() => library.validateUploadFileMeta({ originalname: 'a.m4a', mimetype: 'text/plain' }), /content type/);
    for (const mimetype of ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'application/octet-stream', '']) {
      assert.doesNotThrow(() => library.validateUploadFileMeta({ originalname: 'Song.M4A', mimetype }));
    }
    for (const mimetype of ['audio/ogg', 'audio/opus', 'application/ogg', 'application/octet-stream', '']) {
      assert.doesNotThrow(() => library.validateUploadFileMeta({ originalname: 'Song.opus', mimetype }));
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

// queue:add with a libraryId refuses a song the playlist already has queued
// (app/reactions.ts addLibrarySongToPlaylist with skipIfQueued), based on this check.
describe('library.isQueued', () => {
  const ytSong = { id: '11111111-1111-4111-8111-111111111111', youtube_id: 'dQw4w9WgXcQ', title: 'Y', artist: 'A' } as LibrarySongRow;
  const plainSong = { id: '22222222-2222-4222-8222-222222222222', youtube_id: null, title: 'P', artist: 'A' } as LibrarySongRow;

  it('is false for an empty queue or a different song', () => {
    const q = new Queue('playlist');
    assert.equal(library.isQueued(q.getSongs(), ytSong), false);
    q.addSong({ ...library.toQueueEntry(plainSong), addedBy: 'x' });
    assert.equal(library.isQueued(q.getSongs(), ytSong), false);
    assert.equal(library.isQueued(q.getSongs(), plainSong), true);
  });

  it('matches a queued library song by its queue url, and stops once it is removed', () => {
    const q = new Queue('playlist');
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

describe('library.uploadTmpPath', () => {
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

describe('library.pathInside / songsFile: every renamed, stat-ed or deleted path stays in the songs folder', () => {
  it('keeps paths inside the folder and refuses traversal, other absolute paths, the folder itself and its look-alikes', () => {
    const root = path.resolve('/srv/songs');
    assert.equal(library.pathInside(root, '/srv/songs/library/a.m4a'), '/srv/songs/library/a.m4a');
    assert.equal(library.pathInside(root, 'library/a.m4a'), '/srv/songs/library/a.m4a', 'relative = inside the folder');
    assert.equal(library.pathInside(root, '/srv/songs/library/../old.m4a'), '/srv/songs/old.m4a', 'a ".." that stays inside is fine');
    // Encoded separators are not decoded: a strange file name inside, never a way out.
    assert.equal(library.pathInside(root, '..%2F..%2Fetc%2Fpasswd'), '/srv/songs/..%2F..%2Fetc%2Fpasswd');
    for (const bad of ['../etc/passwd', '/srv/songs/../../etc/passwd', '/etc/passwd', '/srv/songs', '/srv/songs/', '/srv/songs-other/a.m4a', '..', '']) {
      assert.throws(() => library.pathInside(root, bad), /outside/, bad);
    }
    assert.equal(library.songsFile(path.join(library.LIBRARY_DIR, 'x.m4a')), path.join(path.resolve(library.LIBRARY_DIR), 'x.m4a'));
    assert.throws(() => library.songsFile('/etc/passwd'), /outside/);
  });

  it('a symlink in the folder is a path in the folder: deleting it removes the link, never its target', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-inside-'));
    try {
      const root = path.join(tmp, 'songs');
      fs.mkdirSync(root);
      const outside = path.join(tmp, 'outside.txt');
      fs.writeFileSync(outside, 'keep me');
      const link = path.join(root, 'link.m4a');
      fs.symlinkSync(outside, link);
      fs.unlinkSync(library.pathInside(root, link));
      assert.equal(fs.existsSync(link), false);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
