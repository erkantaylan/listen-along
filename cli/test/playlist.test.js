'use strict';

// `la playlist ...` and `--playlist` on download/upload, against the stub
// server in helpers.js (same permission rules as the real server).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, run, tmpDir, fakeYtdlp, fakeMedia } = require('./helpers');

const VIDEOS = {
  aaaaaaaaaa1: { title: 'Digital Love', artist: 'Daft Punk', album: 'Discovery', duration: 301 },
  aaaaaaaaaa2: { title: 'Teardrop', artist: 'Massive Attack', duration: 331 },
  broken00001: { fail: 'Video is unavailable', failCode: 'VIDEO_UNAVAILABLE' },
};

function deps(opts = {}) {
  const y = fakeYtdlp({ videos: VIDEOS, ...opts.ytdlp });
  const m = fakeMedia({ videos: VIDEOS, ...opts.media });
  return { y, m, deps: { ytdlp: y.factory, media: m.factory, sleep: async () => {} } };
}

const ME = { name: 'Alice', userId: 'u-alice' };
const LIB = [
  { id: '00000001-0000-4000-8000-000000000001', youtube_id: 'aaaaaaaaaa1', title: 'Digital Love', artist: 'Daft Punk' },
  { id: '00000002-0000-4000-8000-000000000002', youtube_id: 'bbbbbbbbbb2', title: 'Love Song', artist: 'Cure' },
  { id: '00000003-0000-4000-8000-000000000003', youtube_id: 'cccccccccc3', title: 'Roygbiv', artist: 'Boards of Canada' },
];
const pl = (id, name, visibility, ownerId, songs = []) => ({ id, name, visibility, ownerId, songs });

async function withServer(overrides, fn) {
  const server = await startServer({ me: { ...ME }, songs: LIB.map((s) => ({ ...s })), ...overrides });
  try { await fn(server); } finally { await server.close(); }
}

describe('la playlist', () => {
  test('list shows what the user can see (public + own private), as JSON and a table', () => withServer({
    playlists: [pl('p1', 'Mine', 'private', 'u-alice'), pl('p2', 'Shared', 'public', 'u-bob'), pl('p3', 'Bobs secret', 'private', 'u-bob')],
  }, async (server) => {
    let r = await run(['playlist', 'list', '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.playlists.map((p) => [p.id, p.name, p.visibility, p.is_owner]), [['p1', 'Mine', 'private', true], ['p2', 'Shared', 'public', false]]);
    r = await run(['playlist'], { server });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ID\s+NAME\s+VISIBILITY\s+OWNER\s+SONGS/);
    assert.match(r.stdout, /p1\s+Mine\s+private\s+you/);
    assert.doesNotMatch(r.stdout, /Bobs secret/);
    assert.equal(server.state.calls.at(-1).auth, 'Bearer test-token-123456');
  }));

  test('create (public default / --private), rename, visibility, delete --yes', () => withServer({}, async (server) => {
    let r = await run(['playlist', 'create', 'Road', 'trip', '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.playlist.name, 'Road trip');
    assert.equal(r.json.playlist.visibility, 'public');
    const id = r.json.playlist.id;
    r = await run(['playlist', 'create', 'Late night', '--private', '--json'], { server });
    assert.equal(r.json.playlist.visibility, 'private');
    r = await run(['playlist', 'create', 'road TRIP', '--json'], { server });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'CONFLICT');

    r = await run(['playlist', 'rename', 'ROAD TRIP', 'Road', 'trip', '2026', '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.playlist.name, 'Road trip 2026');
    r = await run(['playlist', 'visibility', id, 'private'], { server });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /is now private/);
    assert.equal((await run(['playlist', 'visibility', id, 'hidden'], { server })).code, 2);

    r = await run(['playlist', 'delete', 'road trip 2026'], { server });
    assert.equal(r.code, 2, 'no --yes');
    assert.equal(server.state.playlists.length, 2);
    r = await run(['playlist', 'delete', 'road trip 2026', '--yes', '--json'], { server });
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.deleted, { id, name: 'Road trip 2026' });
    assert.equal(server.state.playlists.length, 1);
  }));

  test('name lookup: not found / ambiguous -> exit 1; another user\'s private one does not exist', () => withServer({
    playlists: [pl('p1', 'Mix', 'public', 'u-alice'), pl('p2', 'mix', 'public', 'u-bob'), pl('p3', 'Hidden', 'private', 'u-bob')],
  }, async (server) => {
    let r = await run(['playlist', 'show', 'Mix', '--json'], { server });
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stderr).error;
    assert.equal(err.code, 'AMBIGUOUS');
    assert.match(err.message, /p1.*p2/);
    r = await run(['playlist', 'show', 'p2', '--json'], { server });
    assert.equal(r.code, 0, 'the id still works');
    for (const ref of ['Hidden', 'p3', 'nope']) {
      r = await run(['playlist', 'show', ref, '--json'], { server });
      assert.equal(r.code, 1, ref);
      assert.equal(JSON.parse(r.stderr).error.code, 'PLAYLIST_NOT_FOUND');
    }
  }));

  test('not the owner: visibility/delete are FORBIDDEN with exit 1 (not an auth failure)', () => withServer({
    playlists: [pl('p2', 'Shared', 'public', 'u-bob')],
  }, async (server) => {
    let r = await run(['playlist', 'visibility', 'Shared', 'private', '--json'], { server });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'FORBIDDEN');
    r = await run(['playlist', 'delete', 'Shared', '--yes'], { server });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Only the owner/);
    // Editing a public playlist is fine.
    r = await run(['playlist', 'add', 'Shared', 'yt:aaaaaaaaaa1', '--json'], { server });
    assert.equal(r.code, 0);
  }));

  test('legacy token cannot create a private playlist', () => withServer({ me: { name: 'oldbot', userId: null } }, async (server) => {
    const r = await run(['playlist', 'create', 'x', '--private', '--json'], { server });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'FORBIDDEN');
    assert.equal((await run(['playlist', 'create', 'x'], { server })).code, 0);
  }));

  test('add by id / yt: / URL, by search (one match, ambiguous, --first), show, remove, move', () => withServer({
    playlists: [pl('p1', 'Mine', 'private', 'u-alice')],
  }, async (server) => {
    let r = await run(['playlist', 'add', 'mine', '00000003-0000-4000-8000-000000000003', 'yt:aaaaaaaaaa1', 'https://youtu.be/aaaaaaaaaa1', 'yt:zzzzzzzzzzz', '--json'], { server });
    assert.equal(r.code, 1, 'one song is not in the library');
    assert.deepEqual(r.json.results.map((x) => x.status), ['added', 'added', 'already_in_playlist', 'not_in_library']);
    assert.equal(r.json.song_count, 2);

    r = await run(['playlist', 'add', 'mine', 'love', '--json'], { server });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'AMBIGUOUS');
    assert.match(JSON.parse(r.stderr).error.message, /00000001-0000-4000-8000-000000000001[\s\S]*00000002-0000-4000-8000-000000000002/);
    r = await run(['playlist', 'add', 'mine', 'love', 'song'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[added\] Cure - Love Song/);
    r = await run(['playlist', 'add', 'mine', 'nothing', 'like', 'this'], { server });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No library song matches/);
    r = await run(['playlist', 'add', 'mine', 'love', '--first', '--json'], { server });
    assert.equal(r.json.results[0].status, 'already_in_playlist');

    r = await run(['playlist', 'show', 'mine', '--json'], { server });
    assert.deepEqual(r.json.songs.map((s) => s.library_id), ['00000003-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000002']);
    r = await run(['playlist', 'show', 'mine'], { server });
    assert.match(r.stdout, /"Mine" \(p1\) — private, 3 song\(s\)/);
    assert.match(r.stdout, /#\s+TITLE/);

    r = await run(['playlist', 'move', 'mine', '3', '1', '--json'], { server });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.songs.map((s) => s.library_id), ['00000002-0000-4000-8000-000000000002', '00000003-0000-4000-8000-000000000003', '00000001-0000-4000-8000-000000000001']);

    r = await run(['playlist', 'remove', 'mine', '#1', 'yt:aaaaaaaaaa1', '9', 'yt:cccccccccc3', 'yt:cccccccccc3', '--json'], { server });
    assert.equal(r.code, 1);
    assert.deepEqual(r.json.results.map((x) => x.status), ['removed', 'removed', 'failed', 'removed', 'failed']);
    assert.equal(r.json.results[2].code, 'SONG_NOT_FOUND');
    assert.equal(r.json.results[4].code, 'SONG_NOT_FOUND');
    assert.deepEqual(r.json.summary, { total: 5, removed: 3, failed: 2 });
    assert.equal(server.state.playlists[0].songs.length, 0);
  }));
});

describe('--playlist on download / upload', () => {
  test('download adds uploaded and skipped songs; failures still exit 1', () => withServer({
    songs: [{ id: '00000001-0000-4000-8000-000000000001', youtube_id: 'aaaaaaaaaa1', title: 'Digital Love', artist: 'Daft Punk' }],
    playlists: [pl('p1', 'Road trip', 'private', 'u-alice')],
  }, async (server) => {
    const d = deps();
    const r = await run(['download', '--json', '--sleep', '4', '--playlist', 'road trip', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', 'yt:broken00001'], { server, deps: d.deps });
    assert.equal(r.code, 1);
    assert.deepEqual(r.json.summary, { total: 3, uploaded: 1, skipped: 1, failed: 1 });
    assert.deepEqual(r.json.results.map((x) => x.playlist_status), ['added', 'added', undefined]);
    assert.deepEqual(r.json.playlist, { id: 'p1', name: 'Road trip', visibility: 'private', created: false, added: 2, already_in_playlist: 0, failed: 0 });
    assert.deepEqual(server.state.playlists[0].songs.map((s) => s.youtube_id), ['aaaaaaaaaa1', 'aaaaaaaaaa2']);
    // The skipped one is added by yt:<id>, the uploaded one by its library id.
    const adds = server.state.calls.filter((c) => c.method === 'POST' && c.path === '/api/playlists/p1/songs');
    assert.equal(adds.length, 2);

    // Again: everything already there, exit 0.
    const again = await run(['download', '--playlist', 'p1', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2'], { server, deps: d.deps });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Playlist "Road trip": 0 added, 2 already there/);
  }));

  test('missing playlist: exit 1 before downloading; --create-playlist makes it public, --private private', () => withServer({}, async (server) => {
    const d = deps();
    let r = await run(['download', '--json', '--playlist', 'New one', 'yt:aaaaaaaaaa1'], { server, deps: d.deps });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'PLAYLIST_NOT_FOUND');
    assert.deepEqual(d.y.calls.download, []);

    r = await run(['download', '--json', '--playlist', 'New one', '--create-playlist', 'yt:aaaaaaaaaa2'], { server, deps: d.deps });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.playlist.created, true);
    assert.equal(r.json.playlist.visibility, 'public');
    assert.equal(r.json.playlist.added, 1);

    r = await run(['download', '--json', '--playlist', 'Secret', '--create-playlist', '--private', '--dry-run', 'yt:aaaaaaaaaa1'], { server, deps: d.deps });
    assert.equal(r.code, 0);
    assert.equal(r.json.playlist.would_create, true);
    assert.equal(server.state.playlists.length, 1, 'dry run creates nothing');

    r = await run(['download', '--json', '--playlist', 'Secret', '--create-playlist', '--private', 'yt:aaaaaaaaaa1'], { server, deps: d.deps });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.state.playlists[1].visibility, 'private');
    assert.equal(server.state.playlists[1].songs.length, 1);
  }));

  test('a failed playlist add is reported per item and makes the exit code 1', () => withServer({
    playlists: [pl('p1', 'Road trip', 'private', 'u-alice')],
    failPlaylistAdd: { status: 400, body: { error: 'nope', code: 'BAD_REQUEST' } },
  }, async (server) => {
    const r = await run(['download', '--json', '--playlist', 'p1', 'yt:aaaaaaaaaa2'], { server, deps: deps().deps });
    assert.equal(r.code, 1);
    assert.equal(r.json.results[0].status, 'uploaded');
    assert.equal(r.json.results[0].playlist_status, 'failed');
    assert.equal(r.json.results[0].playlist_error, 'nope');
    assert.equal(r.json.playlist.failed, 1);
  }));

  test('upload --playlist adds uploaded and skipped files', () => withServer({
    songs: [{ id: '00000009-0000-4000-8000-000000000009', youtube_id: 'dQw4w9WgXcQ', title: 'Never', artist: 'Rick' }],
    playlists: [pl('p1', 'Album', 'public', 'u-alice')],
  }, async (server) => {
    const dir = tmpDir('la-pl-files-');
    fs.writeFileSync(path.join(dir, 'good.m4a'), 'GOOD');
    fs.writeFileSync(path.join(dir, 'Rick [dQw4w9WgXcQ].m4a'), 'RICK');
    const files = {
      GOOD: { format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', duration: 61, tags: { title: 'Good', artist: 'Band' } },
      RICK: { format: 'mov,mp4,m4a,3gp,3g2,mj2', codec: 'aac', duration: 212, tags: { title: 'Never', artist: 'Rick' } },
    };
    const r = await run(['upload', dir, '--playlist', 'Album', '--json'], { server, deps: deps({ media: { files } }).deps });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.summary, { total: 2, uploaded: 1, skipped: 1, failed: 0 });
    assert.equal(r.json.playlist.added, 2);
    assert.equal(server.state.playlists[0].songs.length, 2);
  }));

  test('usage errors', () => withServer({}, async (server) => {
    const d = deps();
    for (const argv of [
      ['download', '--private', '--playlist', 'x', 'yt:aaaaaaaaaa1'],
      ['download', '--create-playlist', 'yt:aaaaaaaaaa1'],
      ['download', '--no-upload', '--playlist', 'x', 'yt:aaaaaaaaaa1'],
      ['download', '--playlist', '', 'yt:aaaaaaaaaa1'],
    ]) {
      assert.equal((await run(argv, { server, deps: d.deps })).code, 2, argv.join(' '));
    }
  }));

  test('without --playlist the download JSON keeps its exact shape and never touches playlists', () => withServer({
    songs: [{ id: '00000001-0000-4000-8000-000000000001', youtube_id: 'aaaaaaaaaa1', title: 'Digital Love', artist: 'Daft Punk' }],
  }, async (server) => {
    const r = await run(['download', '--json', '--sleep', '4', 'yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2'], { server, deps: deps().deps });
    assert.equal(r.code, 0);
    assert.deepEqual(Object.keys(r.json), ['summary', 'results']);
    assert.deepEqual(Object.keys(r.json.summary), ['total', 'skipped', 'uploaded', 'failed']);
    for (const x of r.json.results) {
      assert.ok(!('playlist_status' in x));
      assert.ok(['input', 'youtube_id', 'url', 'status'].every((k) => k in x));
    }
    assert.ok(!server.state.calls.some((c) => c.path.startsWith('/api/playlists')));
  }));
});
