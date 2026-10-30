// Per-user CLI tokens and account status across restarts, against the real
// server on Postgres (testcontainers):
//   - /api/tokens: approved users create / list / revoke only their own tokens
//     (pending / denied refused, other users' and legacy tokens invisible)
//   - token creation is rate limited per user
//   - legacy (ownerless) tokens made before ownership still authenticate
//   - /api/admin/tokens lists every token with its owner and revokes any
//   - a server restart never changes an account's status
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cookieFor, adminCookie, startServer, requester } = require('./testServer');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('per-user CLI tokens on Postgres', { skip, timeout: 180_000 }, () => {
  let container;
  let url;
  let pg;
  let srv;
  let req;
  let tmp;
  let legacyToken;
  let legacyId;
  const ids = {};
  const cookies = {};

  const env = () => ({ DATABASE_URL: url, SONGS_PATH: path.join(tmp, 'songs'), COVERS_DIR: path.join(tmp, 'covers') });
  const bearer = (t) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_tokens').withUsername('test').withPassword('test').start();
    url = container.getConnectionUri();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'la-tokens-test-'));
    srv = await startServer(env());
    req = requester(srv.base);

    const { Client } = require('pg');
    pg = new Client({ connectionString: url });
    await pg.connect();
    for (const [key, status] of [['alice', 'approved'], ['bob', 'approved'], ['carol', 'approved'],
      ['pending', 'pending'], ['denied', 'denied'], ['rejected', 'rejected']]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $3, $4, 1) RETURNING id`,
        [key, `${key} real`, key[0].toUpperCase() + key.slice(1), status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    // A token from before ownership existed, stored as the old admin page did.
    legacyToken = 'la_' + crypto.randomBytes(32).toString('base64url');
    const r = await pg.query('INSERT INTO api_tokens (name, token_hash, token_prefix) VALUES ($1, $2, $3) RETURNING id',
      ['erkan', crypto.createHash('sha256').update(legacyToken).digest('hex'), legacyToken.slice(0, 10)]);
    legacyId = r.rows[0].id;
  });

  after(async () => {
    if (srv) await srv.stop();
    if (pg) await pg.end().catch(() => {});
    if (container) await container.stop();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the migration added api_tokens.user_id and library_songs.uploaded_by_user_id', async () => {
    const r = await pg.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name, column_name) IN (('api_tokens', 'user_id'), ('library_songs', 'uploaded_by_user_id'))`);
    assert.equal(r.rows.length, 2);
  });

  it('only approved accounts may use /api/tokens', async () => {
    assert.equal((await req('GET', '/api/tokens')).status, 401);
    assert.equal((await req('POST', '/api/tokens', { body: { label: 'x' } })).status, 401);
    for (const who of ['pending', 'denied', 'rejected']) {
      const r = await req('POST', '/api/tokens', { cookie: cookies[who], body: { label: 'x' } });
      assert.equal(r.status, 403, who);
      assert.equal((await req('GET', '/api/tokens', { cookie: cookies[who] })).status, 403, who);
    }
    // A CLI token is not a web login.
    assert.equal((await req('GET', '/api/tokens', { headers: bearer(legacyToken) })).status, 401);
    const n = (await pg.query('SELECT count(*)::int AS n FROM api_tokens')).rows[0].n;
    assert.equal(n, 1, 'nothing was created');
  });

  it('a user creates a token, sees it once, and it authenticates as them', async () => {
    assert.equal((await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: '   ' } })).status, 400);
    const r = await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'Desktop' } });
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^la_[A-Za-z0-9_-]{40,}$/);
    assert.equal(r.body.record.label, 'Desktop');
    assert.equal(r.body.record.prefix, r.body.token.slice(0, 10));
    assert.deepEqual(r.body.record.owner, { id: ids.alice, name: 'Alice' });

    const me = await req('GET', '/api/me', { headers: bearer(r.body.token) });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { name: 'Alice', user: { id: ids.alice, name: 'Alice' }, token: { label: 'Desktop', legacy: false } });

    const list = await req('GET', '/api/tokens', { cookie: cookies.alice });
    assert.equal(list.status, 200);
    assert.equal(list.body.tokens.length, 1);
    const [t] = list.body.tokens;
    assert.equal(t.id, r.body.record.id);
    assert.ok(!('token' in t) && !('token_hash' in t), 'the token itself is never listed');
    assert.ok(t.last_used_at, 'last used is tracked');
  });

  it("users never see or revoke each other's tokens (or legacy ones)", async () => {
    const alice = (await req('GET', '/api/tokens', { cookie: cookies.alice })).body.tokens[0];
    const bobMade = await req('POST', '/api/tokens', { cookie: cookies.bob, body: { label: 'Laptop' } });
    assert.equal(bobMade.status, 201);

    const bobList = (await req('GET', '/api/tokens', { cookie: cookies.bob })).body.tokens;
    assert.deepEqual(bobList.map((t) => t.label), ['Laptop']);
    const aliceList = (await req('GET', '/api/tokens', { cookie: cookies.alice })).body.tokens;
    assert.deepEqual(aliceList.map((t) => t.label), ['Desktop']);

    for (const id of [alice.id, legacyId]) {
      const r = await req('DELETE', `/api/tokens/${id}`, { cookie: cookies.bob });
      assert.equal(r.status, 404);
    }
    assert.equal((await req('DELETE', '/api/tokens/not-a-uuid', { cookie: cookies.bob })).status, 404);
    const still = await pg.query('SELECT count(*)::int AS n FROM api_tokens WHERE revoked_at IS NULL AND id = ANY($1)', [[alice.id, legacyId]]);
    assert.equal(still.rows[0].n, 2, "bob revoked nothing of anyone else's");

    // Bob revokes his own: it stops working at once.
    const del = await req('DELETE', `/api/tokens/${bobMade.body.record.id}`, { cookie: cookies.bob });
    assert.equal(del.status, 200);
    assert.ok(del.body.record.revoked_at);
    assert.equal((await req('GET', '/api/me', { headers: bearer(bobMade.body.token) })).status, 401);
    assert.deepEqual((await req('GET', '/api/tokens', { cookie: cookies.bob })).body.tokens, []);
  });

  it('a legacy token without an owner still authenticates the CLI', async () => {
    const me = await req('GET', '/api/me', { headers: bearer(legacyToken) });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { name: 'erkan', user: null, token: { label: 'erkan', legacy: true } });
    assert.equal((await req('GET', '/api/library?limit=1', { headers: bearer(legacyToken) })).status, 200);
    assert.equal((await req('GET', '/api/requests', { headers: bearer(legacyToken) })).status, 200);
  });

  it('token creation is rate limited per user', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await req('POST', '/api/tokens', { cookie: cookies.carol, body: { label: `T${i}` } })).status, 201, `token ${i}`);
    }
    const r = await req('POST', '/api/tokens', { cookie: cookies.carol, body: { label: 'one too many' } });
    assert.equal(r.status, 429);
    // Another user (same IP) is not affected.
    assert.equal((await req('POST', '/api/tokens', { cookie: cookies.bob, body: { label: 'Phone' } })).status, 201);
  });

  it('/admin lists every token with its owner and revokes any; creation is gone', async () => {
    const admin = adminCookie();
    assert.equal((await req('GET', '/api/admin/tokens', { cookie: cookies.alice })).status, 401);
    assert.equal((await req('POST', '/api/admin/tokens', { cookie: admin, body: { name: 'x' } })).status, 404);

    const { body } = await req('GET', '/api/admin/tokens', { cookie: admin });
    const legacy = body.tokens.find((t) => t.id === legacyId);
    assert.equal(legacy.owner, null);
    assert.equal(legacy.label, 'erkan');
    const desktop = body.tokens.find((t) => t.label === 'Desktop');
    assert.deepEqual(desktop.owner, { id: ids.alice, name: 'Alice' });
    assert.ok(body.tokens.some((t) => t.label === 'Laptop' && !t.active), 'revoked tokens are listed too');
    assert.ok(body.tokens.every((t) => !('token_hash' in t)));

    const phone = body.tokens.find((t) => t.label === 'Phone');
    assert.equal((await req('POST', `/api/admin/tokens/${phone.id}/revoke`, { cookie: admin })).status, 200);
    assert.ok(!(await req('GET', '/api/tokens', { cookie: cookies.bob })).body.tokens.some((t) => t.id === phone.id));
    assert.equal((await req('GET', '/api/me', { headers: bearer(legacyToken) })).status, 200, 'legacy token untouched');
  });

  it('tokens and account status survive a server restart', async () => {
    const statusOf = async () => Object.fromEntries((await pg.query('SELECT id, status FROM users')).rows.map((r) => [r.id, r.status]));
    const beforeRestart = await statusOf();
    assert.equal(beforeRestart[ids.pending], 'pending');

    await srv.stop();
    srv = await startServer(env());
    req = requester(srv.base);

    assert.deepEqual(await statusOf(), beforeRestart);
    const r = await req('GET', '/api/playlists', { cookie: cookies.pending });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ACCOUNT_PENDING');
    assert.equal((await req('GET', '/api/me', { headers: bearer(legacyToken) })).status, 200);
  });
});
