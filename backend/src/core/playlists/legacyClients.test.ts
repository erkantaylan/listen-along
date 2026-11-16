// One release of compatibility for the lobby -> playlist rename on the wire
// (shared/legacyWire.ts): a web tab opened before the deploy speaks lobby:* and
// lobbyId, a new one playlist:* and playlistId; on the same server both work,
// side by side in one playlist, and each hears what it listens for.
// REMOVE with shared/legacyWire.ts.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { startServer, cookieFor, requester } from '../../testing/testServer.ts';

// Server and socket JSON.
type Payload = any;

const ALICE = '00000000-0000-4000-8000-0000000a1100';
const BOB = '00000000-0000-4000-8000-0000000b0b00';

describe('old and new web clients against the renamed server', { timeout: 60_000 }, () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let oldTab: Socket;
  let newTab: Socket;
  const heard: Record<string, Array<[string, Payload]>> = { old: [], new: [] };
  let id = '';

  const connect = (userId: string, label: 'old' | 'new') => new Promise<Socket>((resolve, reject) => {
    const s = ioClient(srv.base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: cookieFor(userId) } });
    s.onAny((event: string, payload: Payload) => heard[label].push([event, payload]));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const next = (s: Socket, event: string) => new Promise<Payload>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event}`)), 5000);
    s.once(event, (p: Payload) => { clearTimeout(t); resolve(p); });
  });
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const names = (label: 'old' | 'new') => heard[label].map(([e]) => e);

  before(async () => {
    srv = await startServer();
    oldTab = await connect(ALICE, 'old');
    newTab = await connect(BOB, 'new');
  });
  after(async () => {
    oldTab?.close();
    newTab?.close();
    await srv?.stop();
  });

  it('an old tab creates a playlist with lobby:create and hears lobby:created with lobbyId', async () => {
    const created = next(oldTab, 'lobby:created');
    oldTab.emit('lobby:create', { name: 'Made by an old tab' });
    const p = await created;
    assert.equal(typeof p.lobbyId, 'string');
    assert.equal(p.playlistId, p.lobbyId, 'both fields');
    assert.equal(p.name, 'Made by an old tab');
    id = p.lobbyId;
  });

  it('a new tab joins it with playlist:join / playlistId; the old tab hears lobby:user-joined', async () => {
    const joined = next(newTab, 'playlist:joined');
    const queue = next(newTab, 'queue:update');
    const heardByOld = next(oldTab, 'lobby:user-joined');
    newTab.emit('playlist:join', { playlistId: id });
    const j = await joined;
    assert.equal(j.playlistId, id);
    assert.equal((await queue).playlistId, id);
    assert.equal((await heardByOld).lobbyId, id);
  });

  it('a rename from the old tab reaches both, each under its own name', async () => {
    const forOld = next(oldTab, 'lobby:renamed');
    const forNew = next(newTab, 'playlist:renamed');
    oldTab.emit('lobby:rename', { lobbyId: id, name: 'Renamed by the old tab' });
    assert.equal((await forOld).lobbyId, id);
    const n = await forNew;
    assert.equal(n.playlistId, id);
    assert.equal(n.name, 'Renamed by the old tab');
  });

  it('queue events take either id field; queue:update carries both', async () => {
    const a = next(oldTab, 'queue:update');
    const b = next(newTab, 'queue:update');
    oldTab.emit('queue:clear', { lobbyId: id });
    for (const u of [await a, await b]) {
      assert.equal(u.playlistId, id);
      assert.equal(u.lobbyId, id);
    }
    // queue:add reads the id under either name (no database here: the refusal after the playlist check).
    for (const [s, body] of [[oldTab, { lobbyId: id, query: 'x' }], [newTab, { playlistId: id, query: 'x' }]] as const) {
      const err = next(s, 'queue:error');
      s.emit('queue:add', body);
      assert.equal((await err).message, 'The music library is unavailable (no database)');
    }
  });

  it('a missing playlist: lobby:not-found to the old tab, playlist:not-found to the new one', async () => {
    const forOld = next(oldTab, 'lobby:not-found');
    oldTab.emit('lobby:view', { lobbyId: 'nope0000' });
    assert.equal((await forOld).lobbyId, 'nope0000');
    const forNew = next(newTab, 'playlist:not-found');
    newTab.emit('playlist:view', { playlistId: 'nope0000' });
    assert.equal((await forNew).playlistId, 'nope0000');
  });

  it('the old shared pin still works from an old tab', async () => {
    const forNew = next(newTab, 'playlist:pinned');
    oldTab.emit('lobby:pin', { lobbyId: id, pinned: true });
    assert.equal((await forNew).pinned, true);
    await tick();
    assert.ok(names('old').includes('lobby:pinned'));
  });

  it('every playlist event is sent under both names for one release', async () => {
    await tick();
    for (const e of ['created', 'user-joined', 'renamed', 'not-found', 'pinned']) {
      const both = [...names('old'), ...names('new')];
      assert.ok(both.includes(`playlist:${e}`) && both.includes(`lobby:${e}`), e);
    }
  });

  it('the HTTP alias /api/lobbies is gone; /api/playlists answers playlists only', async () => {
    const req = requester(srv.base);
    assert.equal((await req('GET', '/api/lobbies', { cookie: cookieFor(ALICE) })).status, 404);
    const r = await req('GET', '/api/playlists', { cookie: cookieFor(ALICE) });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.playlists));
    assert.equal(r.body.lobbies, undefined);
    // Old page URLs are bookmarks: still a 301 to the new ones.
    const page = await req('GET', `/lobby/${id}`, { cookie: cookieFor(ALICE) });
    assert.equal(page.status, 301);
    assert.equal(page.headers.get('location'), `/playlist/${id}`);
  });
});
