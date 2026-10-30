// Integration tests for the library / requests / tokens / admin HTTP API and
// the legacy cache migration. Needs Docker (testcontainers Postgres) and
// ffmpeg/ffprobe on PATH.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}

function has(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

const skipReason = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available'
  : !has('ffmpeg -version') || !has('ffprobe -version') ? 'ffmpeg/ffprobe not available'
  : false;

// SONGS_PATH is read when library.js loads, so set it before requiring.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'la-library-test-'));
const SONGS = path.join(TMP, 'songs');
const FX = path.join(TMP, 'fixtures');
process.env.SONGS_PATH = SONGS;
fs.mkdirSync(SONGS, { recursive: true });
fs.mkdirSync(FX, { recursive: true });

function makeAudio(name, freq, codecArgs) {
  const out = path.join(FX, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, ...codecArgs, out]);
  return out;
}

describe('Library API', { skip: skipReason, timeout: 180_000 }, () => {
  let container;
  let db;
  let library;
  let requests;
  let server;
  let base;
  const hookCalls = [];
  let requestsChanged = 0;
  let token;
  let tokenRecord;
  const fx = {};

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  async function upload(filePath, fields = {}, { name = filePath ? path.basename(filePath) : 'x', type = 'audio/mp4', headers = auth() } = {}) {
    const fd = new FormData();
    if (filePath) fd.append('file', new Blob([fs.readFileSync(filePath)], { type }), name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    const res = await fetch(`${base}/api/library/upload`, { method: 'POST', headers, body: fd });
    return { status: res.status, body: await res.json() };
  }

  // Reads need a token (or the admin cookie / an approved web user) too.
  async function getJson(url, headers = auth()) {
    const res = await fetch(base + url, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_test').withUsername('test').withPassword('test').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    db = require('./db');
    assert.ok(await db.init());
    library = require('./library');
    requests = require('./requests');
    const tokens = require('./tokens');
    ({ token, record: tokenRecord } = await tokens.createToken('Alice'));

    fx.a = makeAudio('a.m4a', 440, ['-c:a', 'aac']);
    fx.b = makeAudio('b.m4a', 550, ['-c:a', 'aac']);
    fx.c = makeAudio('c.m4a', 660, ['-c:a', 'aac']);
    fx.d = makeAudio('d.m4a', 770, ['-c:a', 'aac']);
    fx.e = makeAudio('e.m4a', 990, ['-c:a', 'aac']);
    fx.mp3 = makeAudio('song.mp3', 880, ['-c:a', 'libmp3lame']);
    fx.mp3AsM4a = path.join(FX, 'fake.m4a');
    fs.copyFileSync(fx.mp3, fx.mp3AsM4a);
    fx.text = path.join(FX, 'notes.m4a');
    fs.writeFileSync(fx.text, 'this is not audio'.repeat(100));

    const express = require('express');
    const { createLibraryRouter } = require('./libraryRoutes');
    const app = express();
    app.use(createLibraryRouter({
      onSongAdded: (song, fulfilled) => hookCalls.push({ song, fulfilled }),
      onRequestsChanged: () => { requestsChanged++; },
    }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) await db.close();
    if (container) await container.stop();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  describe('token auth', () => {
    it('GET /api/me requires a valid token', async () => {
      assert.equal((await getJson('/api/me', {})).status, 401);
      assert.equal((await getJson('/api/me', auth('la_wrong'))).status, 401);
      const ok = await getJson('/api/me', auth());
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { name: 'Alice', user: null, token: { label: 'Alice', legacy: true } }, 'a legacy token (no owner)');
    });

    it('upload and every read require a token here (no web-user hook); a bad token is refused', async () => {
      assert.equal((await upload(fx.a, { title: 't', artist: 'a' }, { headers: {} })).status, 401);
      assert.equal((await getJson('/api/library')).status, 200);
      for (const url of ['/api/library', '/api/library/00000000-0000-4000-8000-000000000000',
        '/api/library/00000000-0000-4000-8000-000000000000/file', '/api/requests']) {
        assert.equal((await getJson(url, {})).status, 401, `${url} without a token`);
      }
      assert.equal((await getJson('/api/library', auth('nope'))).status, 401);
    });

    it('a revoked token stops working', async () => {
      const tokens = require('./tokens');
      const { token: t2, record } = await tokens.createToken('Bob');
      assert.equal((await getJson('/api/me', auth(t2))).status, 200);
      await tokens.revokeToken(record.id);
      assert.equal((await getJson('/api/me', auth(t2))).status, 401);
      const r = await db.query('SELECT token_hash FROM api_tokens WHERE id = $1', [record.id]);
      assert.notEqual(r.rows[0].token_hash, t2, 'plaintext is never stored');
    });
  });

  describe('upload validation', () => {
    it('rejects missing file, wrong extension, fake m4a, non-audio and missing fields', async () => {
      assert.equal((await upload(null, { title: 't', artist: 'a' })).status, 400);
      const mp3 = await upload(fx.mp3, { title: 't', artist: 'a' }, { type: 'audio/mpeg' });
      assert.equal(mp3.status, 400);
      assert.match(mp3.body.error, /\.m4a/);
      const fake = await upload(fx.mp3AsM4a, { title: 't', artist: 'a' });
      assert.equal(fake.status, 400);
      assert.match(fake.body.error, /MP4|AAC/);
      assert.equal((await upload(fx.text, { title: 't', artist: 'a' })).status, 400);
      assert.equal((await upload(fx.a, { artist: 'a' })).status, 400);
      assert.equal((await upload(fx.a, { title: 't' })).status, 400);
      assert.equal((await upload(fx.a, { title: 't', artist: 'a', youtube_id: 'bad' })).status, 400);
      const badSrc = await upload(fx.a, { title: 't', artist: 'a', source_url: 'javascript:alert(1)' });
      assert.equal(badSrc.status, 400);
      assert.match(badSrc.body.error, /source_url/);
      assert.equal((await upload(fx.a, { title: 't', artist: 'a', source_url: 'https://x.com/' + 'a'.repeat(3000) })).status, 400);
      assert.equal((await upload(fx.a, { title: 't', artist: 'a' }, { type: 'text/plain' })).status, 400);
      assert.equal(fs.readdirSync(library.UPLOAD_TMP_DIR).length, 0, 'temp files are cleaned up');
    });

    it('rejects files over the size cap with 413', async () => {
      const big = path.join(FX, 'big.m4a');
      fs.writeFileSync(big, Buffer.alloc(library.MAX_UPLOAD_BYTES + 1024));
      const r = await upload(big, { title: 't', artist: 'a' });
      assert.equal(r.status, 413);
      fs.rmSync(big);
    });

    it('accepts a valid m4a, records the uploader and serves it with Range support', async () => {
      const r = await upload(fx.a, { title: 'Song A', artist: 'Artist', album: 'LP', youtube_id: 'AAAAAAAAAAA', duration_sec: 2 });
      assert.equal(r.status, 201);
      const s = r.body.song;
      assert.deepEqual(Object.keys(s).sort(), ['album', 'artist', 'created_at', 'duration_sec', 'file_version', 'id', 'replaced_at', 'source_url', 'title', 'uploaded_by', 'youtube_id']);
      assert.equal(s.uploaded_by, 'Alice');
      const row = (await db.query('SELECT uploaded_by_user_id, uploaded_by_token FROM library_songs WHERE id = $1', [s.id])).rows[0];
      assert.equal(row.uploaded_by_user_id, null, 'legacy token: no owning account');
      assert.equal(row.uploaded_by_token, tokenRecord.id);
      assert.equal(s.youtube_id, 'AAAAAAAAAAA');
      assert.equal(s.source_url, 'https://www.youtube.com/watch?v=AAAAAAAAAAA', 'derived from youtube_id');
      assert.equal(s.duration_sec, 2);
      assert.equal((await getJson(`/api/library/${s.id}`)).body.song.source_url, s.source_url);

      const full = await fetch(`${base}/api/library/${s.id}/file`, { headers: auth() });
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), 'audio/mp4');
      const bytes = Buffer.from(await full.arrayBuffer());
      assert.equal(bytes.length, fs.statSync(fx.a).size);

      const part = await fetch(`${base}/api/library/${s.id}/file`, { headers: { ...auth(), Range: 'bytes=0-99' } });
      assert.equal(part.status, 206);
      assert.equal((await part.arrayBuffer()).byteLength, 100);
      assert.match(part.headers.get('content-range'), /^bytes 0-99\//);

      // A range past the end is a 416 with a JSON body, not a 500 labelled audio/mp4.
      const past = await fetch(`${base}/api/library/${s.id}/file`, { headers: { ...auth(), Range: `bytes=${bytes.length + 10}-` } });
      assert.equal(past.status, 416);
      assert.match(past.headers.get('content-type'), /^application\/json/);
      assert.equal(past.headers.get('content-range'), `bytes */${bytes.length}`);
      assert.equal(past.headers.get('cache-control'), null, 'errors are not cached as immutable');
      assert.equal((await past.json()).error, 'Requested range not satisfiable');

      const list = await getJson('/api/library?q=artist%20song');
      assert.equal(list.body.total, 1);
      assert.equal(list.body.songs[0].id, s.id);
      assert.equal((await getJson('/api/library?limit=500')).status, 200);
      assert.equal((await getJson('/api/library?youtube_id=AAAAAAAAAAA')).body.total, 1);
    });

    it('takes duration from ffprobe when not given', async () => {
      const r = await upload(fx.b, { title: 'Song B', artist: 'Artist' });
      assert.equal(r.status, 201);
      assert.ok(r.body.song.duration_sec > 1.5 && r.body.song.duration_sec < 2.5);
      assert.equal(r.body.song.youtube_id, null);
      assert.equal(r.body.song.source_url, null);
    });

    it('stores an explicit source_url (with and without youtube_id) and lists it', async () => {
      const r = await upload(fx.d, {
        title: 'Song D', artist: 'Artist', youtube_id: 'DDDDDDDDDDD', source_url: 'https://music.youtube.com/watch?v=DDDDDDDDDDD',
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.song.source_url, 'https://music.youtube.com/watch?v=DDDDDDDDDDD');
      const listed = (await getJson('/api/library?youtube_id=DDDDDDDDDDD')).body.songs[0];
      assert.equal(listed.source_url, 'https://music.youtube.com/watch?v=DDDDDDDDDDD');
      const row = (await db.query('SELECT source_url FROM library_songs WHERE id = $1', [r.body.song.id])).rows[0];
      assert.equal(row.source_url, 'https://music.youtube.com/watch?v=DDDDDDDDDDD');
      // clean up so later dedupe/request tests see the same library as before
      await library.remove(r.body.song.id);
    });
  });

  describe('token owners', () => {
    let owner;
    let ownerToken;
    before(async () => {
      const r = await db.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at)
         VALUES ('github', 'owner-1', 'Real Name', 'Deejay', 'approved', 1) RETURNING id`
      );
      owner = r.rows[0].id;
      ({ token: ownerToken } = await require('./tokens').createToken('Desktop', { userId: owner }));
    });

    it('/api/me names the owning account', async () => {
      const me = await getJson('/api/me', auth(ownerToken));
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { name: 'Deejay', user: { id: owner, name: 'Deejay' }, token: { label: 'Desktop', legacy: false } });
    });

    it("an upload records the owner's account and display name", async () => {
      const r = await upload(fx.e, { title: 'Owned', artist: 'Owner' }, { headers: auth(ownerToken) });
      assert.equal(r.status, 201);
      assert.equal(r.body.song.uploaded_by, 'Deejay', 'the UI keeps showing a name');
      const row = (await db.query('SELECT uploaded_by, uploaded_by_user_id FROM library_songs WHERE id = $1', [r.body.song.id])).rows[0];
      assert.equal(row.uploaded_by_user_id, owner);
      assert.equal(row.uploaded_by, 'Deejay');
    });

    it("a token stops working when its owner is no longer approved, and again when re-approved", async () => {
      for (const status of ['pending', 'denied', 'rejected']) {
        await db.query('UPDATE users SET status = $1 WHERE id = $2', [status, owner]);
        assert.equal((await getJson('/api/me', auth(ownerToken))).status, 401, status);
      }
      await db.query("UPDATE users SET status = 'approved' WHERE id = $1", [owner]);
      assert.equal((await getJson('/api/me', auth(ownerToken))).status, 200);
    });
  });

  describe('dedupe', () => {
    it('409 with the existing song for identical bytes', async () => {
      const r = await upload(fx.a, { title: 'Other title', artist: 'X' });
      assert.equal(r.status, 409);
      assert.equal(r.body.song.title, 'Song A');
      assert.ok(r.body.error);
    });

    it('409 for an already-known youtube_id even with different bytes', async () => {
      const r = await upload(fx.c, { title: 'Song C', artist: 'X', youtube_id: 'AAAAAAAAAAA' });
      assert.equal(r.status, 409);
      assert.equal(r.body.song.youtube_id, 'AAAAAAAAAAA');
    });
  });

  describe('requests lifecycle', () => {
    it('creates, dedupes per lobby, lists and validates status', async () => {
      const a = await requests.createRequest({ youtubeId: 'CCCCCCCCCCC', url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', title: 'Wanted', requestedBy: 'Bob', requestedById: 'user_bob', lobbyId: 'lobby001' });
      assert.equal(a.created, true);
      const again = await requests.createRequest({ youtubeId: 'CCCCCCCCCCC', requestedBy: 'Bob', lobbyId: 'lobby001' });
      assert.equal(again.created, false);
      assert.equal(again.request.id, a.request.id);
      const other = await requests.createRequest({ youtubeId: 'CCCCCCCCCCC', requestedBy: 'Carol', lobbyId: 'lobby002' });
      assert.equal(other.created, true);

      const list = await getJson('/api/requests');
      assert.equal(list.status, 200);
      assert.equal(list.body.requests.length, 2);
      const r0 = list.body.requests[0];
      for (const k of ['id', 'youtube_id', 'url', 'title', 'artist', 'requested_by', 'status', 'created_at']) assert.ok(k in r0, k);
      assert.equal(r0.status, 'pending');
      assert.equal((await getJson('/api/requests?status=bogus')).status, 400);
    });

    it('an upload with a matching youtube_id fulfils every pending request for it', async () => {
      hookCalls.length = 0;
      const r = await upload(fx.c, { title: 'Wanted', artist: 'Band', youtube_id: 'CCCCCCCCCCC' });
      assert.equal(r.status, 201);
      assert.equal(r.body.fulfilled_requests.length, 2);
      assert.equal(hookCalls.length, 1);
      assert.deepEqual(hookCalls[0].fulfilled.map((x) => x.lobby_id).sort(), ['lobby001', 'lobby002']);
      const fulfilled = await getJson('/api/requests?status=fulfilled');
      assert.equal(fulfilled.body.requests.length, 2);
      assert.ok(fulfilled.body.requests.every((x) => x.song_id === r.body.song.id));
      assert.equal((await getJson('/api/requests')).body.requests.length, 0);
    });

    it('request_id fulfils a text-only request', async () => {
      const { request } = await requests.createRequest({ title: 'Some obscure tune', requestedBy: 'Dan', lobbyId: 'lobby003' });
      const r = await upload(fx.d, { title: 'Obscure Tune', artist: 'Nobody', request_id: request.id });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body.fulfilled_requests, [request.id]);
      const after = (await getJson('/api/requests?status=all')).body.requests.find((x) => x.id === request.id);
      assert.equal(after.status, 'fulfilled');
    });

    it('a 409 duplicate upload still fulfils request_id and youtube_id matches (CLI fulfil flow)', async () => {
      hookCalls.length = 0;
      const byId = await requests.createRequest({ title: 'Song A again', requestedBy: 'Eve', lobbyId: 'lobby004' });
      const byYt = await requests.createRequest({ youtubeId: 'AAAAAAAAAAA', requestedBy: 'Fay', lobbyId: 'lobby005' });
      // same bytes as Song A, uploader claims a different (unknown) youtube_id + the request id
      const byYt2 = await requests.createRequest({ youtubeId: 'ZZZZZZZZZZZ', requestedBy: 'Gus', lobbyId: 'lobby006' });
      const r = await upload(fx.a, { title: 'Song A', artist: 'Artist', youtube_id: 'ZZZZZZZZZZZ', request_id: byId.request.id });
      assert.equal(r.status, 409);
      const all = (await getJson('/api/requests?status=all')).body.requests;
      for (const req of [byId.request, byYt.request, byYt2.request]) {
        assert.equal(all.find((x) => x.id === req.id).status, 'fulfilled', req.requested_by);
      }
      assert.equal(hookCalls.length, 1, 'queues waiting on the song are refreshed');
      assert.equal(hookCalls[0].song.title, 'Song A');
    });

    it('dismiss needs a token, 404s unknown ids, and marks dismissed', async () => {
      const { request } = await requests.createRequest({ youtubeId: 'DDDDDDDDDDD', requestedBy: 'Bob', lobbyId: 'lobby001' });
      const noAuth = await fetch(`${base}/api/requests/${request.id}/dismiss`, { method: 'POST' });
      assert.equal(noAuth.status, 401);
      const unknown = await fetch(`${base}/api/requests/00000000-0000-4000-8000-000000000000/dismiss`, { method: 'POST', headers: auth() });
      assert.equal(unknown.status, 404);
      const before = requestsChanged;
      const ok = await fetch(`${base}/api/requests/${request.id}/dismiss`, { method: 'POST', headers: auth() });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).request.status, 'dismissed');
      assert.equal(requestsChanged, before + 1);
      const dismissed = await getJson('/api/requests?status=dismissed');
      assert.ok(dismissed.body.requests.some((x) => x.id === request.id));
    });
  });

  describe('admin', () => {
    it('is 404 when ADMIN_PASSWORD is unset', async () => {
      delete process.env.ADMIN_PASSWORD;
      assert.equal((await getJson('/api/admin/tokens')).status, 404);
      assert.deepEqual((await getJson('/api/admin/status')).body, { enabled: false, authenticated: false });
    });

    it('logs in with the password, lists every token with its owner and revokes any of them', async () => {
      process.env.ADMIN_PASSWORD = 'pw-test';
      const post = (url, body, cookie) => fetch(base + url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body || {}),
      });
      assert.equal((await getJson('/api/admin/tokens')).status, 401);
      assert.equal((await post('/api/admin/login', { username: 'admin', password: 'nope' })).status, 401);
      assert.equal((await post('/api/admin/login', { username: 'nope', password: 'pw-test' })).status, 401);
      assert.equal((await post('/api/admin/login', { password: 'pw-test' })).status, 401, 'username required');
      const login = await post('/api/admin/login', { username: 'admin', password: 'pw-test' });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];

      // Creating tokens moved to the profile page.
      assert.equal((await post('/api/admin/tokens', { name: 'Hana' }, cookie)).status, 404);

      const tokens = require('./tokens');
      const u = (await db.query(
        `INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('google', 'hana', 'Hana', 'approved', 1) RETURNING id`
      )).rows[0].id;
      const { token: t, record } = await tokens.createToken('Laptop', { userId: u });
      assert.equal((await getJson('/api/me', auth(t))).body.name, 'Hana');

      const listed = await getJson('/api/admin/tokens', { Cookie: cookie });
      const mine = listed.body.tokens.find((x) => x.id === record.id);
      assert.ok(mine && mine.active);
      assert.equal(mine.label, 'Laptop');
      assert.deepEqual(mine.owner, { id: u, name: 'Hana' });
      const legacy = listed.body.tokens.find((x) => x.id === tokenRecord.id);
      assert.equal(legacy.owner, null, 'legacy token listed without an owner');
      assert.equal(legacy.label, 'Alice');
      assert.ok(listed.body.tokens.every((x) => !('token_hash' in x)));

      assert.equal((await post('/api/admin/tokens/not-a-uuid/revoke', {}, cookie)).status, 404);
      assert.equal((await post(`/api/admin/tokens/${record.id}/revoke`, {}, cookie)).status, 200);
      assert.equal((await getJson('/api/me', auth(t))).status, 401);
      assert.equal((await getJson('/api/me')).status, 200, 'other tokens unaffected');
      delete process.env.ADMIN_PASSWORD;
    });
  });

  describe('source_url schema migration', () => {
    it('re-running init on a DB without source_url adds the column and backfills from youtube_id', async () => {
      await db.query('DROP INDEX IF EXISTS idx_library_songs_source_url');
      await db.query('ALTER TABLE library_songs DROP COLUMN source_url');
      await db.close();
      assert.ok(await db.init());
      const cols = await db.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'library_songs' AND column_name = 'source_url'"
      );
      assert.equal(cols.rows.length, 1);
      const rows = (await db.query('SELECT youtube_id, source_url FROM library_songs')).rows;
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.source_url, row.youtube_id ? `https://www.youtube.com/watch?v=${row.youtube_id}` : null);
      }
    });
  });

  describe('legacy cache migration', () => {
    it('registers the old cache once (idempotent), keeping the format', async () => {
      const legacyFile = path.join(SONGS, 'aaaaaaaa-1111-4111-8111-111111111111.mp3');
      const orphanFile = path.join(SONGS, 'bbbbbbbb-2222-4222-8222-222222222222.mp3');
      fs.copyFileSync(fx.mp3, legacyFile);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=990:duration=2', '-c:a', 'libmp3lame',
        '-metadata', 'title=Tagged Title', '-metadata', 'artist=Tagged Artist', orphanFile]);
      await db.query(
        `INSERT INTO songs (url, title, duration, file_path, status, created_at, updated_at)
         VALUES ('https://www.youtube.com/watch?v=LLLLLLLLLLL', 'Legacy Song', 2, $1, 'ready', 1, 1)`,
        [legacyFile]
      );

      const first = await library.migrateLegacyCache();
      assert.equal(first.registered, 2);
      const second = await library.migrateLegacyCache();
      assert.equal(second.registered, 0);

      const rows = (await db.query("SELECT * FROM library_songs WHERE uploaded_by = 'server' ORDER BY title")).rows;
      assert.equal(rows.length, 2);
      const legacy = rows.find((x) => x.file_path === legacyFile);
      assert.equal(legacy.title, 'Legacy Song');
      assert.equal(legacy.youtube_id, 'LLLLLLLLLLL');
      assert.equal(legacy.source_url, 'https://www.youtube.com/watch?v=LLLLLLLLLLL');
      assert.equal(legacy.mime_type, 'audio/mpeg');
      const orphan = rows.find((x) => x.file_path === orphanFile);
      assert.equal(orphan.title, 'Tagged Title');
      assert.equal(orphan.artist, 'Tagged Artist');
      assert.equal(orphan.source_url, null);
      assert.ok(fs.existsSync(legacyFile), 'files are left in place');

      // old queue entries keep resolving
      const resolved = await library.resolveQueueUrl('https://www.youtube.com/watch?v=LLLLLLLLLLL');
      assert.equal(resolved.id, legacy.id);
      const missing = await library.findUnavailableUrls([
        'https://www.youtube.com/watch?v=LLLLLLLLLLL', `library:${orphan.id}`, 'https://www.youtube.com/watch?v=NNNNNNNNNNN',
      ]);
      assert.deepEqual(missing, ['https://www.youtube.com/watch?v=NNNNNNNNNNN']);
    });

    it('reads the tags of legacy Ogg/Opus and WebM files (stream tags, upper-case keys)', async () => {
      const ogg = path.join(SONGS, 'cccccccc-3333-4333-8333-333333333333.opus');
      const webm = path.join(SONGS, 'dddddddd-4444-4444-8444-444444444444.webm');
      // Ogg keeps Vorbis comments on the stream; Matroska writes ARTIST/TITLE.
      for (const [file, freq, title] of [[ogg, 660, 'Ogg Title'], [webm, 770, 'Webm Title']]) {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, '-c:a', 'libopus',
          '-metadata', `title=${title}`, '-metadata', 'artist=Opus Artist', '-metadata', 'album=Opus Album', file]);
      }
      const r = await library.migrateLegacyCache();
      assert.equal(r.registered, 2);
      const rows = (await db.query('SELECT * FROM library_songs WHERE file_path = ANY($1)', [[ogg, webm]])).rows;
      const byPath = Object.fromEntries(rows.map((x) => [x.file_path, x]));
      assert.equal(byPath[ogg].title, 'Ogg Title');
      assert.equal(byPath[ogg].artist, 'Opus Artist');
      assert.equal(byPath[ogg].album, 'Opus Album');
      assert.equal(byPath[ogg].mime_type, 'audio/ogg');
      assert.equal(byPath[webm].title, 'Webm Title');
      assert.equal(byPath[webm].artist, 'Opus Artist');
      assert.equal(byPath[webm].mime_type, 'audio/webm');
    });
  });
});
