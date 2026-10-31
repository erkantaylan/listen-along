// Per-user playlist pins (PUT / DELETE /api/playlists/:id/pin, `pinnedByMe`).
// Real server on Postgres (testcontainers) plus the no-database mode:
//   - one user's pin never shows for another; the shared `pinned` flag stays
//     independent
//   - a playlist you cannot see is a 404, also when you pinned it before it went
//     private; the pin never reveals it
//   - deleting the playlist or the user cascades
//   - playlist_pins appears on an existing database, idempotently
//   - tokens: a user's token is that user, a legacy token has no pins
//   - playlists:changed carries nothing and a private playlist's changes only
//     reach its owner
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const { io: ioClient } = require('socket.io-client');
const { cookieFor, startServer, requester } = require('./testServer');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('playlist pins on Postgres', { skip, timeout: 180_000 }, () => {
  let container, pg, srv, req;
  const ids = {};
  const cookies = {};
  const pl = {};
  const sockets = [];
  let legacyToken, aliceToken;

  const list = async (who) => {
    const r = await req('GET', '/api/playlists', { cookie: cookies[who] });
    assert.equal(r.status, 200);
    return r.body.playlists;
  };
  const rowOf = async (who, id) => (await list(who)).find(p => p.id === id);
  const create = async (who, name, visibility = 'public') => {
    const r = await req('POST', '/api/playlists', { cookie: cookies[who], body: { name, visibility } });
    assert.equal(r.status, 201);
    return r.body.id;
  };
  const connect = (who) => new Promise((resolve, reject) => {
    const s = ioClient(srv.base, { extraHeaders: { cookie: cookies[who] }, transports: ['websocket'] });
    s.signals = [];
    s.on('playlists:changed', (...args) => s.signals.push(args));
    s.on('connect', () => { sockets.push(s); resolve(s); });
    s.on('connect_error', reject);
  });

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_pins').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();

    // A database from before pins: boot once, drop the new table, boot again.
    srv = await startServer({ DATABASE_URL: url });
    await srv.stop();
    await pg.query('DROP TABLE playlist_pins');
    srv = await startServer({ DATABASE_URL: url });
    req = requester(srv.base);

    for (const key of ['alice', 'bob', 'carol']) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $2, 'approved', 1) RETURNING id`,
        [key, key]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    aliceToken = (await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'CLI' } })).body.token;
    legacyToken = 'la_' + crypto.randomBytes(32).toString('base64url');
    await pg.query('INSERT INTO api_tokens (name, token_hash, token_prefix) VALUES ($1, $2, $3)',
      ['oldbot', crypto.createHash('sha256').update(legacyToken).digest('hex'), legacyToken.slice(0, 10)]);
    pl.pub = await create('alice', 'Shared one');
    pl.priv = await create('alice', 'Alice secret', 'private');
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
  });

  it('the migration created the table on the existing database, with cascades', async () => {
    const r = await pg.query(`
      SELECT confrelid::regclass::text AS target, confdeltype FROM pg_constraint
      WHERE conrelid = 'playlist_pins'::regclass AND contype = 'f' ORDER BY 1`);
    assert.deepEqual(r.rows.map(x => [x.target, x.confdeltype]), [['lobbies', 'c'], ['users', 'c']]);
  });

  it('requires a login', async () => {
    assert.equal((await req('PUT', `/api/playlists/${pl.pub}/pin`)).status, 401);
    assert.equal((await req('DELETE', `/api/playlists/${pl.pub}/pin`)).status, 401);
    const bad = { headers: { Authorization: 'Bearer la_nope' } };
    assert.equal((await req('PUT', `/api/playlists/${pl.pub}/pin`, bad)).status, 401);
  });

  it('a pin belongs to one user and leaves the shared flag alone', async () => {
    assert.equal((await rowOf('alice', pl.pub)).pinnedByMe, false);
    const r = await req('PUT', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.bob });
    assert.equal(r.status, 200);
    assert.equal(r.body.pinnedByMe, true);
    assert.ok(r.body.pinnedAt > 0);

    const bobs = await rowOf('bob', pl.pub);
    assert.equal(bobs.pinnedByMe, true);
    assert.equal(bobs.pinned, false, 'shared flag untouched');
    assert.equal((await rowOf('alice', pl.pub)).pinnedByMe, false);
    assert.equal((await rowOf('alice', pl.pub)).pinnedAt, null);
    assert.equal((await req('GET', `/api/playlists/${pl.pub}`, { cookie: cookies.bob })).body.pinnedByMe, true);
    assert.equal((await req('GET', `/api/playlists/${pl.pub}`, { cookie: cookies.alice })).body.pinnedByMe, false);
  });

  it('is idempotent, keeps the first pin time, and unpin only touches your own', async () => {
    const first = (await req('PUT', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.bob })).body.pinnedAt;
    await sleep(5);
    assert.equal((await req('PUT', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.bob })).body.pinnedAt, first);

    await req('PUT', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.carol });
    const r = await req('DELETE', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.carol });
    assert.equal(r.status, 200);
    assert.equal(r.body.pinnedByMe, false);
    assert.equal((await req('DELETE', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.carol })).status, 200);
    assert.equal((await rowOf('carol', pl.pub)).pinnedByMe, false);
    assert.equal((await rowOf('bob', pl.pub)).pinnedByMe, true);
  });

  it('a private or missing playlist is a 404, never a 403', async () => {
    for (const method of ['PUT', 'DELETE']) {
      for (const id of [pl.priv, 'nope1234']) {
        const r = await req(method, `/api/playlists/${id}/pin`, { cookie: cookies.bob });
        assert.equal(r.status, 404, `${method} ${id}`);
        assert.equal(r.body.code, 'NOT_FOUND');
      }
    }
    const { rows } = await pg.query('SELECT 1 FROM playlist_pins WHERE lobby_id = $1', [pl.priv]);
    assert.equal(rows.length, 0);
    assert.equal((await req('PUT', `/api/playlists/${pl.priv}/pin`, { cookie: cookies.alice })).status, 200);
    assert.equal((await rowOf('alice', pl.priv)).pinnedByMe, true);
  });

  it('a pin never reveals a playlist that went private, and returns with it', async () => {
    const id = await create('alice', 'Going dark');
    await req('PUT', `/api/playlists/${id}/pin`, { cookie: cookies.bob });
    assert.equal((await req('PATCH', `/api/playlists/${id}`, { cookie: cookies.alice, body: { visibility: 'private' } })).status, 200);

    assert.equal(await rowOf('bob', id), undefined);
    assert.ok(!JSON.stringify(await list('bob')).includes('Going dark'));
    assert.equal((await req('GET', `/api/playlists/${id}`, { cookie: cookies.bob })).status, 404);
    assert.equal((await req('DELETE', `/api/playlists/${id}/pin`, { cookie: cookies.bob })).status, 404);

    await req('PATCH', `/api/playlists/${id}`, { cookie: cookies.alice, body: { visibility: 'public' } });
    assert.equal((await rowOf('bob', id)).pinnedByMe, true);
  });

  it('deleting the playlist or the user removes the pins', async () => {
    const id = await create('alice', 'Short lived');
    await req('PUT', `/api/playlists/${id}/pin`, { cookie: cookies.alice });
    await req('PUT', `/api/playlists/${id}/pin`, { cookie: cookies.bob });
    assert.equal((await pg.query('SELECT 1 FROM playlist_pins WHERE lobby_id = $1', [id])).rows.length, 2);
    assert.equal((await req('DELETE', `/api/playlists/${id}`, { cookie: cookies.alice })).status, 200);
    assert.equal((await pg.query('SELECT 1 FROM playlist_pins WHERE lobby_id = $1', [id])).rows.length, 0);

    const temp = await pg.query(`INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', 'temp', 'temp', 'approved', 1) RETURNING id`);
    await req('PUT', `/api/playlists/${pl.pub}/pin`, { cookie: cookieFor(temp.rows[0].id) });
    assert.equal((await pg.query('SELECT 1 FROM playlist_pins WHERE user_id = $1', [temp.rows[0].id])).rows.length, 1);
    await pg.query('DELETE FROM users WHERE id = $1', [temp.rows[0].id]);
    assert.equal((await pg.query('SELECT 1 FROM playlist_pins WHERE user_id = $1', [temp.rows[0].id])).rows.length, 0);
  });

  it('a user token acts as its owner; a legacy token has no pins', async () => {
    const asAlice = { headers: { Authorization: `Bearer ${aliceToken}` } };
    assert.equal((await req('PUT', `/api/playlists/${pl.pub}/pin`, asAlice)).status, 200);
    assert.equal((await rowOf('alice', pl.pub)).pinnedByMe, true);
    assert.equal((await req('DELETE', `/api/lobbies/${pl.pub}/pin`, asAlice)).status, 200, 'old alias');
    assert.equal((await rowOf('alice', pl.pub)).pinnedByMe, false);

    const legacy = { headers: { Authorization: `Bearer ${legacyToken}` } };
    const r = await req('PUT', `/api/playlists/${pl.pub}/pin`, legacy);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN');
    assert.equal((await req('PUT', `/api/playlists/${pl.priv}/pin`, legacy)).status, 404);
    const seen = (await req('GET', '/api/playlists', legacy)).body.playlists;
    assert.ok(seen.every(p => p.pinnedByMe === false));
  });

  it('playlists:changed is empty and private changes reach only the owner', async () => {
    const [alice, bob] = await Promise.all([connect('alice'), connect('bob')]);
    await sleep(100);
    const reset = () => { alice.signals.length = 0; bob.signals.length = 0; };
    const settle = () => sleep(250);

    reset();
    const id = await create('alice', 'Sig private', 'private');
    await settle();
    assert.equal(alice.signals.length, 1);
    assert.deepEqual(alice.signals[0], []);
    assert.equal(bob.signals.length, 0);

    reset();
    await req('PATCH', `/api/playlists/${id}`, { cookie: cookies.alice, body: { name: 'Sig renamed' } });
    await settle();
    assert.equal(alice.signals.length, 1);
    assert.equal(bob.signals.length, 0);

    reset();
    await req('PATCH', `/api/playlists/${id}`, { cookie: cookies.alice, body: { visibility: 'public' } });
    await settle();
    assert.equal(bob.signals.length, 1, 'going public reaches everyone');

    reset();
    await req('PATCH', `/api/playlists/${id}`, { cookie: cookies.alice, body: { visibility: 'private' } });
    await settle();
    assert.equal(bob.signals.length, 1, 'going private reaches everyone');

    reset();
    await req('PUT', `/api/playlists/${pl.pub}/pin`, { cookie: cookies.alice });
    await settle();
    assert.equal(alice.signals.length, 1, 'a pin syncs your own devices');
    assert.equal(bob.signals.length, 0);

    reset();
    await req('DELETE', `/api/playlists/${id}`, { cookie: cookies.alice });
    await settle();
    assert.equal(alice.signals.length, 1);
    assert.equal(bob.signals.length, 0, 'deleting a private playlist tells only its owner');

    reset();
    const pub = await create('alice', 'Sig public');
    await settle();
    assert.equal(bob.signals.length, 1);
    reset();
    await req('DELETE', `/api/playlists/${pub}`, { cookie: cookies.alice });
    await settle();
    assert.equal(bob.signals.length, 1);
  });
});

describe('playlist pins without a database', { timeout: 60_000 }, () => {
  let srv, req;
  const a = cookieFor('mem-alice');
  const b = cookieFor('mem-bob');

  before(async () => {
    srv = await startServer();
    req = requester(srv.base);
  });
  after(async () => { if (srv) await srv.stop(); });

  it('pins per user in memory, hides private ones, forgets deleted ones', async () => {
    const id = (await req('POST', '/api/playlists', { cookie: a, body: { name: 'Mem' } })).body.id;
    assert.equal((await req('PUT', `/api/playlists/${id}/pin`, { cookie: a })).status, 200);
    const row = async (c) => (await req('GET', '/api/playlists', { cookie: c })).body.playlists.find(p => p.id === id);
    assert.equal((await row(a)).pinnedByMe, true);
    assert.equal((await row(b)).pinnedByMe, false);

    await req('PATCH', `/api/playlists/${id}`, { cookie: a, body: { visibility: 'private' } });
    assert.equal((await req('PUT', `/api/playlists/${id}/pin`, { cookie: b })).status, 404);
    assert.equal(await row(b), undefined);

    assert.equal((await req('DELETE', `/api/playlists/${id}/pin`, { cookie: a })).status, 200);
    assert.equal((await row(a)).pinnedByMe, false);
    await req('PUT', `/api/playlists/${id}/pin`, { cookie: a });
    assert.equal((await req('DELETE', `/api/playlists/${id}`, { cookie: a })).status, 200);
    assert.equal(await row(a), undefined);
  });
});
