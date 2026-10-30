// Token-authenticated playlist API (the CLI's `la playlist ...`), against the
// real server on Postgres (testcontainers):
//   - a user's CLI token acts as that user, with the web session's rules
//     (public: everyone sees/edits; private: owner only, "not found" to
//     others; visibility + delete: owner only)
//   - a legacy (ownerless) token sees/edits public playlists only, creates
//     only public (ownerless) playlists and manages nothing
//   - songs: list / add (library ids, yt:<id>) / remove / move, with clear 4xx
//   - adding over the API broadcasts queue:update to open web clients
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { cookieFor, startServer, requester } = require('./testServer');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('playlist API with CLI tokens on Postgres', { skip, timeout: 180_000 }, () => {
  let container;
  let pg;
  let srv;
  let req;
  let tmp;
  const ids = {};
  const cookies = {};
  const tok = {};
  const songs = {};
  const sockets = [];

  const bearer = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
  const as = (who, extra = {}) => ({ ...bearer(tok[who]), ...extra });

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_playlist_api').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-playlist-api-'));
    srv = await startServer({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
    req = requester(srv.base);

    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const [key, status] of [['alice', 'approved'], ['bob', 'approved'], ['pending', 'approved']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $3, $4, 1) RETURNING id`,
        [key, key, key[0].toUpperCase() + key.slice(1), status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    // Tokens through the profile flow.
    for (const who of ['alice', 'bob', 'pending']) {
      const r = await req('POST', '/api/tokens', { cookie: cookies[who], body: { label: 'CLI' } });
      assert.equal(r.status, 201);
      tok[who] = r.body.token;
    }
    // The "pending" user is demoted after making a token: it must stop working.
    await pg.query(`UPDATE users SET status = 'pending' WHERE id = $1`, [ids.pending]);
    // A token from before ownership existed.
    tok.legacy = 'la_' + crypto.randomBytes(32).toString('base64url');
    await pg.query('INSERT INTO api_tokens (name, token_hash, token_prefix) VALUES ($1, $2, $3)',
      ['oldbot', crypto.createHash('sha256').update(tok.legacy).digest('hex'), tok.legacy.slice(0, 10)]);
    // Library songs (rows only; no audio needed to queue them).
    for (const [key, yt, title] of [['one', 'aaaaaaaaaa1', 'Digital Love'], ['two', 'aaaaaaaaaa2', 'Teardrop'], ['three', null, 'Roygbiv']]) {
      const r = await pg.query(
        `INSERT INTO library_songs (youtube_id, title, artist, file_path, sha256, uploaded_by) VALUES ($1, $2, 'Artist', '/nope.m4a', $3, 'seed') RETURNING id`,
        [yt, title, crypto.createHash('sha256').update(title).digest('hex')]
      );
      songs[key] = { id: r.rows[0].id, yt };
    }
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const pl = {};

  it('rejects missing, invalid and not-approved tokens', async () => {
    assert.equal((await req('GET', '/api/playlists')).status, 401);
    assert.equal((await req('GET', '/api/playlists', bearer('la_nope'))).status, 401);
    assert.equal((await req('GET', '/api/playlists', as('pending'))).status, 401);
    assert.equal((await req('POST', '/api/playlists', as('pending', { body: { name: 'x' } }))).status, 401);
  });

  it('a user token creates playlists owned by that user (public by default)', async () => {
    let r = await req('POST', '/api/playlists', as('alice', { body: { name: 'Alice Private', visibility: 'private' } }));
    assert.equal(r.status, 201);
    assert.equal(r.body.visibility, 'private');
    assert.equal(r.body.ownerId, ids.alice);
    assert.equal(r.body.isOwner, true);
    pl.alicePriv = r.body.id;

    r = await req('POST', '/api/playlists', as('alice', { body: { name: 'Alice Public' } }));
    assert.equal(r.status, 201);
    assert.equal(r.body.visibility, 'public');
    pl.alicePub = r.body.id;

    // Validation.
    assert.equal((await req('POST', '/api/playlists', as('alice', { body: { name: 'x', visibility: 'secret' } }))).body.code, 'BAD_REQUEST');
    assert.equal((await req('POST', '/api/playlists', as('alice', { body: { name: 'y'.repeat(51) } }))).status, 400);
    r = await req('POST', '/api/playlists', as('alice', { body: { name: 'alice public' } }));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CONFLICT');

    // The web session sees the same playlists (same owner).
    const web = await req('GET', '/api/playlists', { cookie: cookies.alice });
    assert.ok(web.body.playlists.some((p) => p.id === pl.alicePriv));
  });

  it("another user's token: private is invisible (404), public is editable but not manageable", async () => {
    const list = (await req('GET', '/api/playlists', as('bob'))).body.playlists.map((p) => p.id);
    assert.ok(list.includes(pl.alicePub));
    assert.ok(!list.includes(pl.alicePriv));
    for (const [method, suffix, body] of [
      ['GET', '', undefined], ['GET', '/songs', undefined], ['PATCH', '', { name: 'hijack' }],
      ['DELETE', '', undefined], ['POST', '/songs', { songs: [songs.one.id] }], ['DELETE', `/songs/${songs.one.id}`, undefined],
    ]) {
      const r = await req(method, `/api/playlists/${pl.alicePriv}${suffix}`, as('bob', { body }));
      assert.equal(r.status, 404, `${method} ${suffix}`);
      assert.equal(r.body.code, 'NOT_FOUND');
    }
    // Bob may not even learn the name is taken.
    assert.equal((await req('POST', '/api/playlists', as('bob', { body: { name: 'Alice Private' } }))).status, 201);

    // Public: Bob can neither rename, change visibility nor delete; Alice renames.
    let r = await req('PATCH', `/api/playlists/${pl.alicePub}`, as('bob', { body: { name: 'Shared' } }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN');
    r = await req('PATCH', `/api/playlists/${pl.alicePub}`, as('alice', { body: { name: 'Shared' } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Shared');
    r = await req('PATCH', `/api/playlists/${pl.alicePub}`, as('bob', { body: { visibility: 'private' } }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN');
    r = await req('DELETE', `/api/playlists/${pl.alicePub}`, as('bob'));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN');
  });

  it('the owner changes visibility and deletes over the token', async () => {
    let r = await req('PATCH', `/api/playlists/${pl.alicePub}/visibility`, as('alice', { body: { visibility: 'private' } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.visibility, 'private');
    assert.equal((await req('GET', `/api/playlists/${pl.alicePub}`, as('bob'))).status, 404);
    r = await req('PATCH', `/api/playlists/${pl.alicePub}`, as('alice', { body: { visibility: 'public' } }));
    assert.equal(r.body.visibility, 'public');

    const tmpPl = (await req('POST', '/api/playlists', as('alice', { body: { name: 'Doomed' } }))).body.id;
    r = await req('DELETE', `/api/playlists/${tmpPl}`, as('alice'));
    assert.equal(r.status, 200);
    assert.equal((await req('GET', `/api/playlists/${tmpPl}`, as('alice'))).status, 404);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM lobbies WHERE id = $1', [tmpPl])).rows[0].n, 0);
  });

  it('legacy token: public only, creates ownerless public playlists, manages nothing', async () => {
    const list = (await req('GET', '/api/playlists', as('legacy'))).body.playlists.map((p) => p.id);
    assert.ok(list.includes(pl.alicePub));
    assert.ok(!list.includes(pl.alicePriv));
    assert.equal((await req('GET', `/api/playlists/${pl.alicePriv}/songs`, as('legacy'))).status, 404);

    let r = await req('POST', '/api/playlists', as('legacy', { body: { name: 'Bot private', visibility: 'private' } }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN');
    r = await req('POST', '/api/playlists', as('legacy', { body: { name: 'Bot list' } }));
    assert.equal(r.status, 201);
    assert.equal(r.body.visibility, 'public');
    assert.equal(r.body.ownerId, null);
    pl.legacy = r.body.id;

    // It can edit public playlists (songs) but not change visibility / delete.
    r = await req('POST', `/api/playlists/${pl.alicePub}/songs`, as('legacy', { body: { songs: [songs.three.id] } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.added, 1);
    assert.equal((await req('PATCH', `/api/playlists/${pl.alicePub}`, as('legacy', { body: { visibility: 'private' } }))).status, 403);
    assert.equal((await req('DELETE', `/api/playlists/${pl.legacy}`, as('legacy'))).status, 403);
    // Ownerless means every user can edit it, and nobody but an admin deletes it.
    // Ownerless: nobody but an admin renames it; the legacy token can't rename anything.
    assert.equal((await req('PATCH', `/api/playlists/${pl.legacy}`, as('bob', { body: { name: 'Bot list 2' } }))).status, 403);
    assert.equal((await req('PATCH', `/api/playlists/${pl.legacy}`, as('legacy', { body: { name: 'Bot list 2' } }))).status, 403);
    assert.equal((await req('PATCH', `/api/playlists/${pl.alicePub}`, as('legacy', { body: { name: 'Bot rename' } }))).status, 403);
    assert.equal((await req('DELETE', `/api/playlists/${pl.legacy}`, as('bob'))).status, 403);
  });

  it('songs: add by library id / yt:<id>, skip duplicates, report unknown ones', async () => {
    const r = await req('POST', `/api/playlists/${pl.alicePriv}/songs`, as('alice', {
      body: { songs: [songs.one.id, `yt:${songs.two.yt}`, songs.one.id, 'yt:zzzzzzzzzzz', 'garbage', { youtube_id: songs.two.yt }] },
    }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map((x) => x.status),
      ['added', 'added', 'already_in_playlist', 'not_in_library', 'invalid', 'already_in_playlist']);
    assert.deepEqual(r.body.summary, { total: 6, added: 2, already_in_playlist: 2, not_in_library: 1, invalid: 1 });
    assert.equal(r.body.results[0].song.id, songs.one.id);
    assert.equal(r.body.song_count, 2);

    const dup = await req('POST', `/api/playlists/${pl.alicePriv}/songs`, as('alice', { body: { songs: [songs.one.id], allow_duplicates: true } }));
    assert.equal(dup.body.summary.added, 1);

    const list = await req('GET', `/api/playlists/${pl.alicePriv}/songs`, as('alice'));
    assert.equal(list.status, 200);
    assert.equal(list.body.playlist.id, pl.alicePriv);
    assert.deepEqual(list.body.songs.map((s) => [s.position, s.library_id, s.youtube_id]),
      [[1, songs.one.id, songs.one.yt], [2, songs.two.id, songs.two.yt], [3, songs.one.id, songs.one.yt]]);
    assert.ok(list.body.songs.every((s) => s.entry_id && s.added_by === 'Alice' && s.available === true));

    // Bad bodies.
    for (const body of [{}, { songs: [] }, { songs: 'x' }, { songs: Array(201).fill(songs.one.id) }]) {
      const b = await req('POST', `/api/playlists/${pl.alicePriv}/songs`, as('alice', { body }));
      assert.equal(b.status, 400);
      assert.equal(b.body.code, 'BAD_REQUEST');
    }
  });

  it('songs: move and remove (by entry id, library id or yt:<id>)', async () => {
    let songsNow = (await req('GET', `/api/playlists/${pl.alicePriv}/songs`, as('alice'))).body.songs;
    let r = await req('POST', `/api/playlists/${pl.alicePriv}/songs/${songsNow[2].entry_id}/move`, as('alice', { body: { position: 1 } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.songs[0].entry_id, songsNow[2].entry_id);
    assert.equal((await req('POST', `/api/playlists/${pl.alicePriv}/songs/${songsNow[2].entry_id}/move`, as('alice', { body: { position: 9 } }))).status, 400);
    assert.equal((await req('POST', `/api/playlists/${pl.alicePriv}/songs/nope/move`, as('alice', { body: { position: 1 } }))).status, 404);

    // A library id removes every entry of that song.
    r = await req('DELETE', `/api/playlists/${pl.alicePriv}/songs/${songs.one.id}`, as('alice'));
    assert.equal(r.status, 200);
    assert.equal(r.body.removed.length, 2);
    assert.equal(r.body.song_count, 1);
    r = await req('DELETE', `/api/playlists/${pl.alicePriv}/songs/yt:${songs.two.yt}`, as('alice'));
    assert.equal(r.body.removed.length, 1);
    r = await req('DELETE', `/api/playlists/${pl.alicePriv}/songs/yt:${songs.two.yt}`, as('alice'));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'SONG_NOT_FOUND');

    await req('POST', `/api/playlists/${pl.alicePriv}/songs`, as('alice', { body: { songs: [songs.three.id] } }));
    songsNow = (await req('GET', `/api/playlists/${pl.alicePriv}/songs`, as('alice'))).body.songs;
    r = await req('DELETE', `/api/playlists/${pl.alicePriv}/songs/${songsNow[0].entry_id}`, as('alice'));
    assert.equal(r.status, 200);
    assert.equal(r.body.song_count, 0);
    // Persisted in Postgres.
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM queue_songs WHERE lobby_id = $1', [pl.alicePriv])).rows[0].n, 0);
  });

  it('adding over the API updates open web clients like a web add (queue:update)', async () => {
    const sock = ioClient(srv.base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: cookies.alice } });
    sockets.push(sock);
    await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('connect_error', reject); });
    const joined = new Promise((resolve) => sock.once('queue:update', resolve));
    sock.emit('lobby:view', { lobbyId: pl.alicePub });
    await joined;

    const update = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no queue:update')), 3000);
      sock.on('queue:update', (d) => {
        if (d.lobbyId === pl.alicePub && d.songs.some((s) => s.url === `https://www.youtube.com/watch?v=${songs.two.yt}`)) {
          clearTimeout(timer);
          resolve(d);
        }
      });
    });
    // Bob (another user) adds to the public playlist with his CLI token.
    const r = await req('POST', `/api/playlists/${pl.alicePub}/songs`, as('bob', { body: { songs: [`yt:${songs.two.yt}`] } }));
    assert.equal(r.body.summary.added, 1);
    const d = await update;
    assert.equal(d.songs.at(-1).addedBy, 'Bob');

    const removed = new Promise((resolve) => sock.on('queue:update', (x) => { if (!x.songs.some((s) => s.url.includes(songs.two.yt))) resolve(x); }));
    await req('DELETE', `/api/playlists/${pl.alicePub}/songs/yt:${songs.two.yt}`, as('bob'));
    await removed;
  });
});
