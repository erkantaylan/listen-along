// Playlist visibility / permission rules, end to end: the pure rules in
// playlistAccess.js, then the real server (in-memory storage, no Postgres)
// over HTTP and Socket.IO with two signed-in users and one anonymous client.
// Also covers the /lobby/... -> /playlist/... redirect.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');
const access = require('./playlistAccess');

const SECRET = 'playlist-permissions-test-secret';
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-000000000b0b';

// Same format as createAuthToken in index.js (HMAC-signed listen_auth cookie).
function authCookie(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `listen_auth=${payload}.${sig}`;
}

describe('playlistAccess rules', () => {
  const pub = { id: 'p', ownerId: ALICE, visibility: 'public' };
  const priv = { id: 'q', ownerId: ALICE, visibility: 'private' };
  const ownerless = { id: 'r', ownerId: null, visibility: 'public' };

  it('public: everyone logged in can view and edit; only the owner manages', () => {
    assert.equal(access.canView(pub, BOB), true);
    assert.equal(access.canEdit(pub, BOB), true);
    assert.equal(access.canManage(pub, BOB), false);
    assert.equal(access.canManage(pub, ALICE), true);
  });

  it('private: only the owner can view, edit or manage', () => {
    assert.equal(access.canView(priv, ALICE), true);
    assert.equal(access.canEdit(priv, ALICE), true);
    assert.equal(access.canManage(priv, ALICE), true);
    assert.equal(access.canView(priv, BOB), false);
    assert.equal(access.canEdit(priv, BOB), false);
    assert.equal(access.canManage(priv, BOB), false);
  });

  it('ownerless: editable by everyone, managed by no user, admin-deletable', () => {
    assert.equal(access.canEdit(ownerless, BOB), true);
    assert.equal(access.canManage(ownerless, BOB), false);
    assert.equal(access.canManage(ownerless, null), false);
    assert.equal(access.canAdminDelete(ownerless), true);
    assert.equal(access.canAdminDelete(priv), false);
  });

  it('viewers: a user token is its user; a legacy token sees/edits public only and manages nothing', () => {
    const alice = { userId: ALICE, legacy: false };
    const bob = { userId: BOB, legacy: false };
    const legacy = { userId: null, legacy: true };
    assert.equal(access.viewerCanView(priv, alice), true);
    assert.equal(access.viewerCanManage(priv, alice), true);
    assert.equal(access.viewerCanView(priv, bob), false);
    assert.equal(access.viewerCanView(pub, legacy), true);
    assert.equal(access.viewerCanEdit(ownerless, legacy), true);
    assert.equal(access.viewerCanView(priv, legacy), false);
    assert.equal(access.viewerCanManage(pub, legacy), false);
    assert.equal(access.viewerCanManage(ownerless, legacy), false);
    assert.equal(access.viewerCanView(pub, null), false);
  });

  it('rename: owner only; an ownerless playlist only by an admin', () => {
    const alice = { userId: ALICE, legacy: false };
    const bob = { userId: BOB, legacy: false };
    const legacy = { userId: null, legacy: true };
    assert.equal(access.canRename(pub, ALICE), true);
    assert.equal(access.canRename(pub, BOB), false);
    assert.equal(access.canRename(pub, BOB, { admin: true }), false);
    assert.equal(access.canRename(ownerless, BOB), false);
    assert.equal(access.canRename(ownerless, BOB, { admin: true }), true);
    assert.equal(access.viewerCanRename(pub, alice), true);
    assert.equal(access.viewerCanRename(pub, bob), false);
    assert.equal(access.viewerCanRename(pub, legacy), false);
    assert.equal(access.viewerCanRename(ownerless, legacy), false);
    assert.equal(access.viewerCanRename(ownerless, bob, { admin: true }), true);
    assert.equal(access.viewerCanRename(priv, bob, { admin: true }), false);
  });

  it('not logged in sees nothing', () => {
    assert.equal(access.canView(pub, null), false);
    assert.equal(access.canEdit(ownerless, null), false);
    assert.equal(access.canView(null, ALICE), false);
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

describe('playlist permissions against a running server', { timeout: 60_000 }, () => {
  let server;
  let base;
  const sockets = [];

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, PORT: String(port), SESSION_SECRET: SECRET, NODE_ENV: 'test', FRONTEND_PATH: path.join(__dirname, '..', '..', 'frontend') };
    delete env.DATABASE_URL;
    delete env.ADMIN_PASSWORD;
    server = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 20_000);
      server.stdout.on('data', (d) => { if (/Server running on port/.test(String(d))) { clearTimeout(timer); resolve(); } });
      server.on('exit', (code) => reject(new Error(`server exited (${code})`)));
    });
  });

  after(() => {
    for (const s of sockets) s.disconnect();
    if (server) server.kill('SIGKILL');
  });

  async function api(method, url, { user, body } = {}) {
    const headers = {};
    if (user) headers.cookie = authCookie(user);
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json, headers: res.headers };
  }

  function connect(user) {
    const s = ioClient(base, { transports: ['websocket'], forceNew: true, extraHeaders: user ? { cookie: authCookie(user) } : {} });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  // Resolves with [event, payload] for the first of `events`, or ['timeout'].
  function waitFor(socket, events, ms = 1500) {
    return new Promise((resolve) => {
      const handlers = {};
      const done = (result) => {
        clearTimeout(timer);
        for (const e of events) socket.off(e, handlers[e]);
        resolve(result);
      };
      for (const e of events) { handlers[e] = (data) => done([e, data]); socket.on(e, handlers[e]); }
      const timer = setTimeout(() => done(['timeout']), ms);
    });
  }

  function getRaw(url, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(base + url, { headers }, (res) => { res.resume(); resolve(res); }).on('error', reject);
    });
  }

  let pubId;
  let privId;

  it('redirects old /lobby URLs to /playlist with 301, keeping the query', async () => {
    let res = await getRaw('/lobby/abc123');
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, '/playlist/abc123');
    res = await getRaw('/lobby/abc123/library?q=daft%20punk&page=2');
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, '/playlist/abc123/library?q=daft%20punk&page=2');
    // The SPA page itself needs a login: logged out -> /login?next=<page>.
    res = await getRaw('/playlist/abc123');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/login?next=%2Fplaylist%2Fabc123');
    res = await getRaw('/playlist/abc123', { cookie: authCookie(ALICE) });
    assert.equal(res.statusCode, 200);
  });

  it('requires a logged-in user for every playlist route', async () => {
    assert.equal((await api('GET', '/api/playlists')).status, 401);
    assert.equal((await api('POST', '/api/playlists', { body: { name: 'x' } })).status, 401);
  });

  it('creates public and private playlists owned by the caller', async () => {
    const a = await api('POST', '/api/playlists', { user: ALICE, body: { name: 'Alice Public' } });
    assert.equal(a.status, 201);
    assert.equal(a.body.visibility, 'public');
    assert.equal(a.body.ownerId, ALICE);
    assert.equal(a.body.isOwner, true);
    pubId = a.body.id;

    const b = await api('POST', '/api/playlists', { user: ALICE, body: { name: 'Alice Secret', visibility: 'private' } });
    assert.equal(b.status, 201);
    assert.equal(b.body.visibility, 'private');
    privId = b.body.id;

    assert.equal((await api('POST', '/api/playlists', { user: ALICE, body: { visibility: 'hidden' } })).status, 400);
  });

  it("lists public playlists to everyone and private ones only to their owner", async () => {
    const bob = await api('GET', '/api/playlists', { user: BOB });
    const bobIds = bob.body.playlists.map(p => p.id);
    assert.ok(bobIds.includes(pubId));
    assert.ok(!bobIds.includes(privId), "Bob must not see Alice's private playlist");
    assert.equal(bob.body.playlists.find(p => p.id === pubId).isOwner, false);

    const alice = await api('GET', '/api/playlists', { user: ALICE });
    assert.ok(alice.body.playlists.map(p => p.id).includes(privId));

    // The old /api/lobbies path is an alias with the same filtering.
    const legacy = await api('GET', '/api/lobbies', { user: BOB });
    assert.ok(!legacy.body.lobbies.map(p => p.id).includes(privId));
  });

  it("treats someone else's private playlist as not found on every route", async () => {
    assert.equal((await api('GET', `/api/playlists/${privId}`, { user: BOB })).status, 404);
    assert.equal((await api('PATCH', `/api/playlists/${privId}`, { user: BOB, body: { name: 'Hijack' } })).status, 404);
    assert.equal((await api('PATCH', `/api/playlists/${privId}`, { user: BOB, body: { visibility: 'public' } })).status, 404);
    assert.equal((await api('PATCH', `/api/lobbies/${privId}/visibility`, { user: BOB, body: { is_public: true } })).status, 404);
    assert.equal((await api('DELETE', `/api/playlists/${privId}`, { user: BOB })).status, 404);
    // Same answer as for an id that does not exist at all.
    assert.equal((await api('GET', '/api/playlists/nope0000', { user: BOB })).status, 404);
    // A name clash with a hidden playlist is not reported.
    const dup = await api('POST', '/api/playlists', { user: BOB, body: { name: 'Alice Secret' } });
    assert.equal(dup.status, 201);
    assert.equal((await api('GET', `/api/playlists/${privId}`, { user: ALICE })).body.name, 'Alice Secret');
  });

  it('only the owner renames, changes visibility or deletes a public playlist', async () => {
    const rename = await api('PATCH', `/api/playlists/${pubId}`, { user: BOB, body: { name: 'Renamed by Bob' } });
    assert.equal(rename.status, 403);
    assert.equal(rename.body.code, 'FORBIDDEN');
    assert.equal(rename.body.error, 'Only the owner can rename');
    const own = await api('PATCH', `/api/playlists/${pubId}`, { user: ALICE, body: { name: 'Renamed by Alice' } });
    assert.equal(own.status, 200);
    assert.equal(own.body.name, 'Renamed by Alice');
    assert.equal((await api('PATCH', `/api/playlists/${pubId}`, { user: BOB, body: { visibility: 'private' } })).status, 403);
    assert.equal((await api('DELETE', `/api/playlists/${pubId}`, { user: BOB })).status, 403);
  });

  it('socket: a private playlist cannot be joined, viewed, read or edited by others', async () => {
    const bob = await connect(BOB);
    bob.emit('lobby:join', { lobbyId: privId, username: 'Bob' });
    assert.equal((await waitFor(bob, ['lobby:not-found', 'lobby:joined']))[0], 'lobby:not-found');
    bob.emit('lobby:view', { lobbyId: privId });
    assert.equal((await waitFor(bob, ['lobby:not-found', 'lobby:joined']))[0], 'lobby:not-found');
    bob.emit('queue:get', privId);
    assert.equal((await waitFor(bob, ['queue:update'], 500))[0], 'timeout');
    bob.emit('lobby:rename', { lobbyId: privId, name: 'Hijack' });
    assert.equal((await waitFor(bob, ['lobby:error', 'lobby:renamed']))[0], 'lobby:error');
    bob.emit('queue:clear', { lobbyId: privId });
    bob.emit('lobby:pin', { lobbyId: privId, pinned: true });
    assert.equal((await waitFor(bob, ['lobby:error', 'lobby:pinned']))[0], 'lobby:error');
    const alice = await api('GET', `/api/playlists/${privId}`, { user: ALICE });
    assert.equal(alice.body.name, 'Alice Secret');
    assert.equal(alice.body.pinned, false);
  });

  it('socket: the owner joins their private playlist and learns it is theirs', async () => {
    const alice = await connect(ALICE);
    alice.emit('lobby:join', { lobbyId: privId, username: 'Alice' });
    const [event, data] = await waitFor(alice, ['lobby:joined', 'lobby:not-found']);
    assert.equal(event, 'lobby:joined');
    assert.equal(data.visibility, 'private');
    assert.equal(data.isOwner, true);
    alice.disconnect();
  });

  it('socket: not logged in cannot even connect', async () => {
    await assert.rejects(connect(null), /Authentication required/);
  });

  it('socket: creating a private playlist makes the creator its owner', async () => {
    const alice = await connect(ALICE);
    alice.emit('lobby:create', { name: 'Made over socket', visibility: 'private', username: 'Alice' });
    const [event, data] = await waitFor(alice, ['lobby:created', 'lobby:error']);
    assert.equal(event, 'lobby:created');
    assert.equal(data.visibility, 'private');
    assert.equal(data.ownerId, ALICE);
    const bobList = await api('GET', '/api/playlists', { user: BOB });
    assert.ok(!bobList.body.playlists.some(p => p.id === data.lobbyId));
    alice.disconnect();
  });

  it('socket: going private evicts other users who had the playlist open', async () => {
    const bob = await connect(BOB);
    bob.emit('lobby:join', { lobbyId: pubId, username: 'Bob' });
    assert.equal((await waitFor(bob, ['lobby:joined']))[0], 'lobby:joined');
    bob.emit('lobby:rename', { lobbyId: pubId, name: 'Bob was here' });
    const [ev, data] = await waitFor(bob, ['lobby:renamed', 'lobby:error']);
    assert.equal(ev, 'lobby:error');
    assert.equal(data.message, 'Only the owner can rename');
    const alice = await connect(ALICE);
    alice.emit('lobby:join', { lobbyId: pubId, username: 'Alice' });
    assert.equal((await waitFor(alice, ['lobby:joined']))[0], 'lobby:joined');
    alice.emit('lobby:rename', { lobbyId: pubId, name: 'Alice socket name' });
    assert.equal((await waitFor(alice, ['lobby:renamed', 'lobby:error']))[0], 'lobby:renamed');
    alice.disconnect();

    const closed = waitFor(bob, ['lobby:closed']);
    const res = await api('PATCH', `/api/playlists/${pubId}`, { user: ALICE, body: { visibility: 'private' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.visibility, 'private');
    assert.equal((await closed)[0], 'lobby:closed');

    // Bob is out of the room: no more edits, no more updates.
    bob.emit('lobby:rename', { lobbyId: pubId, name: 'Still here?' });
    assert.equal((await waitFor(bob, ['lobby:error', 'lobby:renamed']))[0], 'lobby:error');
    assert.equal((await api('GET', `/api/playlists/${pubId}`, { user: BOB })).status, 404);

    // And back to public: visible again.
    await api('PATCH', `/api/playlists/${pubId}`, { user: ALICE, body: { visibility: 'public' } });
    assert.equal((await api('GET', `/api/playlists/${pubId}`, { user: BOB })).status, 200);
  });

  it('the owner can delete; then it is gone for everyone', async () => {
    assert.equal((await api('DELETE', `/api/playlists/${privId}`, { user: ALICE })).status, 200);
    assert.equal((await api('GET', `/api/playlists/${privId}`, { user: ALICE })).status, 404);
  });
});
