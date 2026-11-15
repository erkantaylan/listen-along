// Playlist folders (/api/playlist-folders, folders.ts) against the real server:
//   - who gets in: the web session and the Android app session; not a CLI
//     token, not a pending account, nobody without a login
//   - one user's folders never show for, or answer to, another user
//   - a playlist the caller cannot see is a 404 exactly like a missing one,
//     and is left out of every list; one that goes private keeps its place,
//     hidden, and is back in its folder when it is public again
//   - deleting a playlist, a folder or a user cascades the right rows (and
//     never deletes a playlist); the 100 folder limit holds under concurrency
//   - the tables appear on an existing database (migration) with cascades
//   - playlists:changed reaches only the caller's own sockets
//   - the same rules in the no-database mode
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { io as ioClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SECRET, cookieFor, requester, startServer } from '../../testServer.js';
import { policyFor } from '../../userAuth.js';
import { signDevMobileToken } from '../../mobileTokens.js';
import { cleanFolderName, MAX_FOLDERS } from './folders.ts';

// Server JSON.
type Payload = any;

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}
const has = (cmd: string) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('folders: policy and names', () => {
  it('the API needs an approved account by the guard default and is not the playlist API (no CLI tokens)', () => {
    assert.equal(policyFor('/api/playlist-folders'), 'approved');
    assert.equal(policyFor('/api/playlist-folders/x/playlists/y'), 'approved');
    assert.equal(policyFor('/API/Playlist-Folders'), 'approved');
  });
  it('names: trimmed, 1-50 characters, no control characters or line breaks', () => {
    assert.deepEqual(cleanFolderName('  Road  '), { name: 'Road' });
    assert.deepEqual(cleanFolderName('Şarkılar 🎵'), { name: 'Şarkılar 🎵' });
    assert.deepEqual(cleanFolderName('x'.repeat(50)), { name: 'x'.repeat(50) });
    for (const bad of ['', '   ', 'x'.repeat(51), 'a\nb', 'a\u0000b', 'a b', 42, null, undefined, ['a'], { name: 'a' }]) {
      assert.ok('error' in cleanFolderName(bad), JSON.stringify(bad));
    }
  });
});

interface Ctx {
  base: string;
  req: ReturnType<typeof requester>;
}

/** The checks both modes share: isolation, visibility, folder delete, moves. */
function sharedChecks(get: () => Ctx & { cookies: Record<string, string>; pl: Record<string, string> }) {
  const call = (who: string, method: string, url: string, body?: unknown) => {
    const c = get();
    return c.req(method, url, { cookie: c.cookies[who], body });
  };
  const folders = async (who: string): Promise<Payload[]> => {
    const r = await call(who, 'GET', '/api/playlist-folders');
    assert.equal(r.status, 200);
    return r.body.folders;
  };
  const make = async (who: string, name: string, playlistId?: string) => {
    const r = await call(who, 'POST', '/api/playlist-folders', playlistId ? { name, playlistId } : { name });
    assert.equal(r.status, 201, r.text);
    return r.body.folder;
  };

  it('creates, lists, renames and deletes a folder, only for its owner', async () => {
    const { pl } = get();
    const f = await make('alice', '  Mixes ');
    assert.equal(f.name, 'Mixes');
    assert.deepEqual(f.playlistIds, []);
    assert.match(f.id, /^[0-9a-f-]{36}$/);
    assert.ok(f.createdAt > 0);
    assert.deepEqual((await folders('alice')).map((x) => x.name), ['Mixes']);
    assert.deepEqual(await folders('bob'), [], 'another user sees none of them');

    // Bob cannot touch it: the same 404 as a folder that does not exist.
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const id of [f.id, missing, 'not-a-uuid']) {
      const a = await call('bob', 'PATCH', `/api/playlist-folders/${id}`, { name: 'Mine now' });
      assert.equal(a.status, 404);
      assert.deepEqual(a.body, { error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
      assert.equal((await call('bob', 'DELETE', `/api/playlist-folders/${id}`)).status, 404);
      const put = await call('bob', 'PUT', `/api/playlist-folders/${id}/playlists/${pl.bobPub}`);
      assert.deepEqual([put.status, put.body.code], [404, 'FOLDER_NOT_FOUND']);
    }
    assert.equal((await folders('alice'))[0].name, 'Mixes', 'untouched by bob');

    const renamed = await call('alice', 'PATCH', `/api/playlist-folders/${f.id}`, { name: 'Evening' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.folder.name, 'Evening');
    for (const name of ['', 'x'.repeat(51), 7]) {
      const bad = await call('alice', 'PATCH', `/api/playlist-folders/${f.id}`, { name });
      assert.deepEqual([bad.status, bad.body.code], [400, 'BAD_REQUEST']);
    }
    const bad = await call('alice', 'POST', '/api/playlist-folders', { name: '' });
    assert.deepEqual([bad.status, bad.body.code], [400, 'BAD_REQUEST']);

    assert.equal((await call('alice', 'DELETE', `/api/playlist-folders/${f.id}`)).status, 200);
    assert.deepEqual(await folders('alice'), []);
    assert.equal((await call('alice', 'DELETE', `/api/playlist-folders/${f.id}`)).status, 404);
  });

  it('files any playlist the user can see; another user\'s private one is a 404 like a missing one', async () => {
    const { pl } = get();
    const f = await make('alice', 'Filed');
    for (const id of [pl.alicePub, pl.alicePriv, pl.bobPub]) {
      const r = await call('alice', 'PUT', `/api/playlist-folders/${f.id}/playlists/${id}`);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body, { playlistId: id, folderId: f.id });
    }
    assert.deepEqual((await folders('alice'))[0].playlistIds, [pl.alicePub, pl.alicePriv, pl.bobPub], 'in filing order');

    const hidden = await call('alice', 'PUT', `/api/playlist-folders/${f.id}/playlists/${pl.bobPriv}`);
    const missing = await call('alice', 'PUT', `/api/playlist-folders/${f.id}/playlists/zz99zz99`);
    const odd = await call('alice', 'PUT', `/api/playlist-folders/${f.id}/playlists/${encodeURIComponent('a b;')}`);
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body, { error: 'Playlist not found', code: 'NOT_FOUND' });
    assert.deepEqual([missing.status, missing.body], [hidden.status, hidden.body], 'hidden = missing');
    assert.deepEqual([odd.status, odd.body], [hidden.status, hidden.body]);
    // Also when the folder is not even the caller's: the playlist is checked first.
    const other = await call('bob', 'PUT', `/api/playlist-folders/${f.id}/playlists/${pl.alicePriv}`);
    assert.deepEqual([other.status, other.body], [hidden.status, hidden.body]);
    // Taking it out, and "New folder" with it, say the same.
    const out = await call('alice', 'DELETE', `/api/playlist-folders/${f.id}/playlists/${pl.bobPriv}`);
    assert.deepEqual([out.status, out.body], [hidden.status, hidden.body]);
    const before = (await folders('alice')).length;
    const withHidden = await call('alice', 'POST', '/api/playlist-folders', { name: 'Sneaky', playlistId: pl.bobPriv });
    assert.deepEqual([withHidden.status, withHidden.body], [hidden.status, hidden.body]);
    assert.equal((await folders('alice')).length, before, 'nothing was made');

    // A playlist sits in one folder per user: filing it elsewhere moves it.
    const g = await make('alice', 'Other', pl.bobPub);
    assert.deepEqual(g.playlistIds, [pl.bobPub]);
    const now = await folders('alice');
    assert.deepEqual(now.find((x) => x.id === f.id).playlistIds, [pl.alicePub, pl.alicePriv]);
    // Bob files his own playlist in his own folder: alice's filing is unaffected.
    const bf = await make('bob', 'Bob stuff', pl.bobPub);
    assert.deepEqual(bf.playlistIds, [pl.bobPub]);
    assert.deepEqual((await folders('alice')).find((x) => x.id === g.id).playlistIds, [pl.bobPub]);
    // Bob sees his own playlists only in his folder, never alice's private one.
    assert.deepEqual((await folders('bob')).map((x) => x.name), ['Bob stuff']);

    // Out of a folder: to the top level; again is a no-op.
    const r1 = await call('alice', 'DELETE', `/api/playlist-folders/${g.id}/playlists/${pl.bobPub}`);
    assert.deepEqual([r1.status, r1.body.removed, r1.body.folderId], [200, true, null]);
    const r2 = await call('alice', 'DELETE', `/api/playlist-folders/${g.id}/playlists/${pl.bobPub}`);
    assert.deepEqual([r2.status, r2.body.removed], [200, false]);
    // Out of a folder it is not in: nothing moves.
    const r3 = await call('alice', 'DELETE', `/api/playlist-folders/${g.id}/playlists/${pl.alicePub}`);
    assert.equal(r3.body.removed, false);
    assert.ok((await folders('alice')).find((x) => x.id === f.id).playlistIds.includes(pl.alicePub));

    // Deleting a folder returns its playlists to the top level and deletes none.
    assert.equal((await call('alice', 'DELETE', `/api/playlist-folders/${f.id}`)).status, 200);
    const lists = await call('alice', 'GET', '/api/playlists');
    for (const id of [pl.alicePub, pl.alicePriv, pl.bobPub]) assert.ok(lists.body.playlists.some((p: Payload) => p.id === id), id);
    for (const x of await folders('alice')) assert.ok(!x.playlistIds.includes(pl.alicePub));
    for (const x of await folders('alice')) await call('alice', 'DELETE', `/api/playlist-folders/${x.id}`);
    for (const x of await folders('bob')) await call('bob', 'DELETE', `/api/playlist-folders/${x.id}`);
  });

  it('a filed playlist that goes private is hidden in its folder, and back when public again', async () => {
    const { pl } = get();
    const f = await make('alice', 'Watch', pl.bobPub);
    assert.equal((await call('bob', 'PATCH', `/api/playlists/${pl.bobPub}`, { visibility: 'private' })).status, 200);
    assert.deepEqual((await folders('alice')).find((x) => x.id === f.id).playlistIds, []);
    // Hidden means a 404, also for the folder actions on it.
    assert.equal((await call('alice', 'PUT', `/api/playlist-folders/${f.id}/playlists/${pl.bobPub}`)).status, 404);
    assert.equal((await call('alice', 'DELETE', `/api/playlist-folders/${f.id}/playlists/${pl.bobPub}`)).status, 404);
    assert.equal((await call('bob', 'PATCH', `/api/playlists/${pl.bobPub}`, { visibility: 'public' })).status, 200);
    assert.deepEqual((await folders('alice')).find((x) => x.id === f.id).playlistIds, [pl.bobPub], 'back in its folder');
    await call('alice', 'DELETE', `/api/playlist-folders/${f.id}`);
  });

  it('a deleted playlist leaves its folder (cascade, or pruned in memory)', async () => {
    const c = get();
    const created = await c.req('POST', '/api/playlists', { cookie: c.cookies.bob, body: { name: `Gone ${Date.now()}` } });
    assert.equal(created.status, 201);
    const f = await make('alice', 'Soon empty', created.body.id);
    assert.deepEqual(f.playlistIds, [created.body.id]);
    assert.equal((await c.req('DELETE', `/api/playlists/${created.body.id}`, { cookie: c.cookies.bob })).status, 200);
    assert.deepEqual((await folders('alice')).find((x) => x.id === f.id).playlistIds, []);
    await call('alice', 'DELETE', `/api/playlist-folders/${f.id}`);
  });
}

describe('folders on Postgres', { skip, timeout: 240_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let db: pg.Client | undefined;
  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  let req: ReturnType<typeof requester>;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const pl: Record<string, string> = {};
  const sockets: Socket[] = [];

  const connect = (who: string) => new Promise<Socket & { signals: number }>((resolve, reject) => {
    const s = ioClient(srv!.base, { extraHeaders: { cookie: cookies[who] }, transports: ['websocket'] }) as Socket & { signals: number };
    s.signals = 0;
    s.on('playlists:changed', () => { s.signals++; });
    s.on('connect', () => { sockets.push(s); resolve(s); });
    s.on('connect_error', reject);
  });
  const create = async (who: string, name: string, visibility = 'public') => {
    const r = await req('POST', '/api/playlists', { cookie: cookies[who], body: { name, visibility } });
    assert.equal(r.status, 201);
    return r.body.id as string;
  };

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_folders').withUsername('test').withPassword('test').start();
    const url = container.getConnectionUri();
    db = new pg.Client({ connectionString: url });
    await db.connect();
    // A database from before folders: boot once, drop the new tables, boot again.
    srv = await startServer({ DATABASE_URL: url });
    await srv.stop();
    await db.query('DROP TABLE playlist_folder_items');
    await db.query('DROP TABLE playlist_folders');
    srv = await startServer({ DATABASE_URL: url });
    req = requester(srv.base);
    for (const [key, status] of [['alice', 'approved'], ['bob', 'approved'], ['carol', 'approved'], ['pat', 'pending'], ['dan', 'denied']]) {
      const r = await db.query(
        `INSERT INTO users (provider, provider_id, name, display_name, status, created_at) VALUES ('github', $1, $2, $2, $3, 1) RETURNING id`,
        [key, key, status]
      );
      ids[key] = r.rows[0].id;
      cookies[key] = cookieFor(ids[key]);
    }
    pl.alicePub = await create('alice', 'Alice public');
    pl.alicePriv = await create('alice', 'Alice private', 'private');
    pl.bobPub = await create('bob', 'Bob public');
    pl.bobPriv = await create('bob', 'Bob private', 'private');
  });

  after(async () => {
    for (const s of sockets) s.disconnect();
    if (srv) await srv.stop();
    if (db) await db.end().catch(() => {});
    if (container) await container.stop();
  });

  it('the migration made both tables on an existing database, with their cascades and the per-user folder key', async () => {
    const fks = await db!.query(`
      SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS target, confdeltype,
             (SELECT string_agg(attname::text, ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = conrelid AND attnum = ANY(conkey)) AS cols
      FROM pg_constraint WHERE conrelid IN ('playlist_folders'::regclass, 'playlist_folder_items'::regclass) AND contype = 'f'
      ORDER BY 1, 2`);
    assert.deepEqual(fks.rows.map((r) => [r.tbl, r.target, r.confdeltype, r.cols]), [
      ['playlist_folder_items', 'lobbies', 'c', 'lobby_id'],
      ['playlist_folder_items', 'playlist_folders', 'c', 'folder_id,user_id'],
      ['playlist_folder_items', 'users', 'c', 'user_id'],
      ['playlist_folders', 'users', 'c', 'user_id'],
    ]);
    const idx = await db!.query(`SELECT indexname FROM pg_indexes WHERE tablename LIKE 'playlist_folder%' ORDER BY 1`);
    for (const name of ['idx_playlist_folder_items_folder', 'idx_playlist_folder_items_lobby', 'idx_playlist_folders_user']) {
      assert.ok(idx.rows.some((r) => r.indexname === name), name);
    }
  });

  it('the database refuses a filing row that points at another user\'s folder', async () => {
    const f = await req('POST', '/api/playlist-folders', { cookie: cookies.alice, body: { name: 'Key test' } });
    await assert.rejects(
      db!.query('INSERT INTO playlist_folder_items (user_id, lobby_id, folder_id, position) VALUES ($1, $2, $3, 0)', [ids.bob, pl.bobPub, f.body.folder.id]),
      /foreign key/
    );
    await req('DELETE', `/api/playlist-folders/${f.body.folder.id}`, { cookie: cookies.alice });
  });

  it('who gets in: cookie and app session yes; nobody, pending, denied and CLI tokens no', async () => {
    assert.equal((await req('GET', '/api/playlist-folders')).status, 401);
    assert.equal((await req('POST', '/api/playlist-folders', { body: { name: 'x' } })).status, 401);
    assert.equal((await req('GET', '/api/playlist-folders', { cookie: cookies.pat })).status, 403);
    assert.equal((await req('GET', '/api/playlist-folders', { cookie: cookies.dan })).status, 403);
    const token = (await req('POST', '/api/tokens', { cookie: cookies.alice, body: { label: 'CLI' } })).body.token;
    const cli = { Authorization: `Bearer ${token}` };
    assert.equal((await req('GET', '/api/playlists', { headers: cli })).status, 200, 'the token works where it should');
    assert.equal((await req('GET', '/api/playlist-folders', { headers: cli })).status, 401);
    assert.equal((await req('POST', '/api/playlist-folders', { headers: cli, body: { name: 'x' } })).status, 401);

    // The Android app's session is the account, at its level.
    const app = { Authorization: `Bearer ${signDevMobileToken(SECRET, ids.alice)}` };
    const made = await req('POST', '/api/playlist-folders', { headers: app, body: { name: 'From the app', playlistId: pl.alicePub } });
    assert.equal(made.status, 201, made.text);
    const web = await req('GET', '/api/playlist-folders', { cookie: cookies.alice });
    assert.deepEqual(web.body.folders.map((f: Payload) => [f.name, f.playlistIds]), [['From the app', [pl.alicePub]]]);
    assert.deepEqual(web.body.limits, { folders: MAX_FOLDERS, nameLength: 50 });
    const pendingApp = { Authorization: `Bearer ${signDevMobileToken(SECRET, ids.pat)}` };
    assert.equal((await req('GET', '/api/playlist-folders', { headers: pendingApp })).status, 403);
    const endedApp = await req('GET', '/api/playlist-folders', { headers: { Authorization: 'Bearer lam_nope.nope' } });
    assert.deepEqual([endedApp.status, endedApp.body.code], [401, 'SESSION_ENDED']);
    await req('DELETE', `/api/playlist-folders/${made.body.folder.id}`, { headers: app });
  });

  sharedChecks(() => ({ base: srv!.base, req, cookies, pl }));

  it('playlists:changed goes to the caller\'s own sockets only', async () => {
    const a1 = await connect('alice');
    const a2 = await connect('alice');
    const b = await connect('bob');
    await sleep(200);
    a1.signals = 0; a2.signals = 0; b.signals = 0;
    const f = await req('POST', '/api/playlist-folders', { cookie: cookies.alice, body: { name: 'Signals' } });
    await req('PUT', `/api/playlist-folders/${f.body.folder.id}/playlists/${pl.alicePub}`, { cookie: cookies.alice });
    await req('PATCH', `/api/playlist-folders/${f.body.folder.id}`, { cookie: cookies.alice, body: { name: 'Signals 2' } });
    await req('DELETE', `/api/playlist-folders/${f.body.folder.id}`, { cookie: cookies.alice });
    await sleep(300);
    assert.equal(a1.signals, 4);
    assert.equal(a2.signals, 4, 'the same user\'s other tab');
    assert.equal(b.signals, 0, 'nobody else');
  });

  it('at most 100 folders per user, also when they are created at once', async () => {
    const made: string[] = [];
    for (let i = 0; i < MAX_FOLDERS - 5; i++) {
      const r = await req('POST', '/api/playlist-folders', { cookie: cookies.carol, body: { name: `F${i}` } });
      assert.equal(r.status, 201);
      made.push(r.body.folder.id);
    }
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => req('POST', '/api/playlist-folders', { cookie: cookies.carol, body: { name: `B${i}` } })));
    assert.equal(burst.filter((r) => r.status === 201).length, 5);
    for (const r of burst.filter((x) => x.status !== 201)) assert.deepEqual([r.status, r.body.code], [409, 'FOLDER_LIMIT']);
    const rows = await db!.query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT position)::int AS p FROM playlist_folders WHERE user_id = $1', [ids.carol]);
    assert.deepEqual(rows.rows[0], { n: 100, p: 100 }, 'no more, and each in its own place');
    // Another user is not limited by carol's folders.
    const other = await req('POST', '/api/playlist-folders', { cookie: cookies.bob, body: { name: 'Free' } });
    assert.equal(other.status, 201);
    await req('DELETE', `/api/playlist-folders/${other.body.folder.id}`, { cookie: cookies.bob });
    // Deleting one makes room again.
    assert.equal((await req('DELETE', `/api/playlist-folders/${made[0]}`, { cookie: cookies.carol })).status, 200);
    assert.equal((await req('POST', '/api/playlist-folders', { cookie: cookies.carol, body: { name: 'Room' } })).status, 201);
  });

  it('a deleted user takes their folders and filings with them; the playlists stay', async () => {
    const f = await req('POST', '/api/playlist-folders', { cookie: cookies.carol, body: { name: 'Last', playlistId: pl.bobPub } });
    // Carol is at the limit; free one place first if needed.
    if (f.status === 409) {
      const any = (await req('GET', '/api/playlist-folders', { cookie: cookies.carol })).body.folders[0];
      await req('DELETE', `/api/playlist-folders/${any.id}`, { cookie: cookies.carol });
      assert.equal((await req('POST', '/api/playlist-folders', { cookie: cookies.carol, body: { name: 'Last', playlistId: pl.bobPub } })).status, 201);
    }
    await db!.query('DELETE FROM users WHERE id = $1', [ids.carol]);
    const left = await db!.query('SELECT (SELECT COUNT(*) FROM playlist_folders WHERE user_id = $1)::int AS f, (SELECT COUNT(*) FROM playlist_folder_items WHERE user_id = $1)::int AS i', [ids.carol]);
    assert.deepEqual(left.rows[0], { f: 0, i: 0 });
    assert.equal((await db!.query('SELECT COUNT(*)::int AS n FROM lobbies WHERE id = $1', [pl.bobPub])).rows[0].n, 1);
  });

  it('a private playlist hidden in a folder keeps its row in the database (so it can come back)', async () => {
    const f = await req('POST', '/api/playlist-folders', { cookie: cookies.alice, body: { name: 'Rows', playlistId: pl.bobPub } });
    await req('PATCH', `/api/playlists/${pl.bobPub}`, { cookie: cookies.bob, body: { visibility: 'private' } });
    const rows = await db!.query('SELECT folder_id::text AS f FROM playlist_folder_items WHERE user_id = $1 AND lobby_id = $2', [ids.alice, pl.bobPub]);
    assert.deepEqual(rows.rows, [{ f: f.body.folder.id }]);
    await req('PATCH', `/api/playlists/${pl.bobPub}`, { cookie: cookies.bob, body: { visibility: 'public' } });
    await req('DELETE', `/api/playlist-folders/${f.body.folder.id}`, { cookie: cookies.alice });
  });
});

describe('folders without a database (in memory)', { timeout: 60_000 }, () => {
  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  let req: ReturnType<typeof requester>;
  const cookies: Record<string, string> = {
    alice: cookieFor('00000000-0000-4000-8000-0000000a11ce'),
    bob: cookieFor('00000000-0000-4000-8000-000000000b0b'),
  };
  const pl: Record<string, string> = {};

  before(async () => {
    srv = await startServer();
    req = requester(srv.base);
    const create = async (who: string, name: string, visibility = 'public') => {
      const r = await req('POST', '/api/playlists', { cookie: cookies[who], body: { name, visibility } });
      assert.equal(r.status, 201);
      return r.body.id as string;
    };
    pl.alicePub = await create('alice', 'Mem alice public');
    pl.alicePriv = await create('alice', 'Mem alice private', 'private');
    pl.bobPub = await create('bob', 'Mem bob public');
    pl.bobPriv = await create('bob', 'Mem bob private', 'private');
  });
  after(async () => { if (srv) await srv.stop(); });

  sharedChecks(() => ({ base: srv!.base, req, cookies, pl }));

  it('the limit holds in memory too', async () => {
    for (let i = 0; i < MAX_FOLDERS; i++) assert.equal((await req('POST', '/api/playlist-folders', { cookie: cookies.bob, body: { name: `M${i}` } })).status, 201);
    const r = await req('POST', '/api/playlist-folders', { cookie: cookies.bob, body: { name: 'One more' } });
    assert.deepEqual([r.status, r.body.code], [409, 'FOLDER_LIMIT']);
  });
});
