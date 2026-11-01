// Radio stations against the real server on Postgres (testcontainers): the
// "all" rule, who gets in, and what the lean list carries.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cookieFor, startServer, requester } = require('./testServer');
const { policyFor } = require('./userAuth');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('stations: policy', () => {
  it('the API is approved-only and the page needs a login, by default', () => {
    assert.equal(policyFor('/api/stations/all'), 'approved');
    assert.equal(policyFor('/api/stations/all/songs'), 'approved');
    assert.equal(policyFor('/API/Stations/all/songs'), 'approved');
    assert.equal(policyFor('/radio'), 'page');
  });
});

describe('stations API', { skip, timeout: 180_000 }, () => {
  let container;
  let pg;
  let srv;
  let req;
  let tmp;
  const cookies = {};
  const ids = {};
  const songIds = [];

  async function addSong(title, duration, sha) {
    const id = crypto.randomUUID();
    await pg.query(
      `INSERT INTO library_songs (id, title, artist, duration_sec, file_path, mime_type, size_bytes, sha256, youtube_id, uploaded_by)
       VALUES ($1, $2, 'Artist', $3, $4, 'audio/mp4', 1, $5, NULL, 'test')`,
      [id, title, duration, `/tmp/${id}.m4a`, sha]
    );
    songIds.push(id);
    return id;
  }

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_stations').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-stations-'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const [key, status] of [['alice', 'approved'], ['bob', 'approved'], ['pat', 'pending'], ['dan', 'denied']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $2, $3, 1) RETURNING id`,
        [key, key, status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    await addSong('One', 100, 'a'.repeat(64));
    await addSong('Two', 200, 'b'.repeat(64));
    await addSong('No length', null, 'c'.repeat(64));
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end();
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('nobody, pending and denied accounts are refused; the page needs a login', async () => {
    for (const url of ['/api/stations/all', '/api/stations/all/songs']) {
      assert.equal((await req('GET', url)).status, 401);
      assert.equal((await req('GET', url, { cookie: cookies.pat })).status, 403);
      assert.equal((await req('GET', url, { cookie: cookies.dan })).status, 403);
    }
    const page = await req('GET', '/radio');
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login/);
    assert.equal((await req('GET', '/radio', { cookie: cookies.alice })).status, 200);
  });

  it('a CLI token does not get in, and its own routes are untouched', async () => {
    const t = await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'CLI' } });
    assert.equal(t.status, 201);
    const headers = { Authorization: `Bearer ${t.body.token}` };
    assert.equal((await req('GET', '/api/stations/all/songs', { headers })).status, 401);
    assert.equal((await req('GET', '/api/library?limit=1', { headers })).status, 200);
  });

  it('an unknown station is a 404', async () => {
    assert.equal((await req('GET', '/api/stations/lofi', { cookie: cookies.alice })).status, 404);
    assert.equal((await req('GET', '/api/stations/lofi/songs', { cookie: cookies.alice })).status, 404);
  });

  it('summary and songs agree; rows carry only what the list needs', async () => {
    const sum = await req('GET', '/api/stations/all', { cookie: cookies.alice });
    assert.deepEqual(sum.body, { id: 'all', count: 3, duration_sec: 300 });
    const list = await req('GET', '/api/stations/all/songs', { cookie: cookies.alice });
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 3);
    assert.equal(list.body.duration_sec, 300);
    assert.equal(list.body.songs.length, 3);
    const one = list.body.songs.find((s) => s.title === 'One');
    assert.deepEqual(Object.keys(one).sort(), ['artist', 'duration_sec', 'file_version', 'id', 'title', 'youtube_id']);
    assert.equal(one.file_version, 'a'.repeat(16));
    assert.equal(list.body.songs.find((s) => s.title === 'No length').duration_sec, null);
  });

  it('a song with an open report leaves the station and comes back when it closes', async () => {
    const id = songIds[0];
    assert.equal((await req('POST', `/api/library/${id}/report`, { cookie: cookies.bob, body: { reason: 'Bad audio' } })).status, 201);
    assert.equal((await req('POST', `/api/library/${id}/report`, { cookie: cookies.alice, body: { reason: 'Cut off' } })).status, 201);

    let list = await req('GET', '/api/stations/all/songs', { cookie: cookies.alice });
    assert.ok(!list.body.songs.some((s) => s.id === id));
    assert.deepEqual((await req('GET', '/api/stations/all', { cookie: cookies.alice })).body, { id: 'all', count: 2, duration_sec: 200 });
    // Library stays as it is.
    const lib = await req('GET', '/api/library?limit=10', { cookie: cookies.alice });
    assert.ok(lib.body.songs.some((s) => s.id === id));

    assert.equal((await req('DELETE', `/api/library/${id}/report`, { cookie: cookies.bob })).status, 200);
    list = await req('GET', '/api/stations/all/songs', { cookie: cookies.alice });
    assert.ok(!list.body.songs.some((s) => s.id === id), 'still one open report');
    assert.equal((await req('DELETE', `/api/library/${id}/report`, { cookie: cookies.alice })).status, 200);
    list = await req('GET', '/api/stations/all/songs', { cookie: cookies.alice });
    assert.ok(list.body.songs.some((s) => s.id === id));
  });

  it('handles 2,500 songs in one quick answer', async () => {
    await pg.query(
      `INSERT INTO library_songs (id, title, artist, duration_sec, file_path, mime_type, size_bytes, sha256, uploaded_by)
       SELECT gen_random_uuid(), 'Song ' || g, 'Artist ' || g, 180, '/tmp/f' || g || '.m4a', 'audio/mp4', 1, md5(g::text) || md5(g::text), 'test'
       FROM generate_series(1, 2500) g`
    );
    const started = Date.now();
    const list = await req('GET', '/api/stations/all/songs', { cookie: cookies.alice });
    assert.equal(list.status, 200);
    assert.equal(list.body.songs.length, 2503);
    assert.ok(Date.now() - started < 3000);
    assert.ok(list.text.length < 2503 * 220, `payload ${list.text.length}`);
  });
});
