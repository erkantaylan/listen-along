// Migration of an existing (pre-playlist) database: lobbies with the old
// is_public flag and a per-lobby chat_messages table. db.init() must add
// visibility, backfill it, drop is_public and the chat history, keep every
// playlist and its queue, and be safe to run again.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pgModule from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import db from '../../shared/db.ts';
import { playlist } from './index.ts';
import { forgetAll as forgetQueues } from '../queue/index.ts';

let PostgreSqlContainer: typeof import('@testcontainers/postgresql').PostgreSqlContainer | undefined;
try { ({ PostgreSqlContainer } = await import('@testcontainers/postgresql')); } catch {}

function dockerOk() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

const skipReason = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !dockerOk() ? 'Docker not available' : false;

describe('Playlist migration from the old lobby schema', { skip: skipReason, timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer | undefined;
  let dbOpened = false;
  let pg: pgModule.Client | undefined;

  before(async () => {
    container = await new PostgreSqlContainer!('postgres:16-alpine')
      .withDatabase('listen_migrate').withUsername('test').withPassword('test').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    // The schema as an older release left it.
    const { Client } = pgModule;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`
      CREATE TABLE lobbies (
        id VARCHAR(8) PRIMARY KEY, host_id VARCHAR(255), name VARCHAR(50),
        is_public BOOLEAN NOT NULL DEFAULT TRUE, created_at BIGINT NOT NULL,
        last_activity BIGINT NOT NULL, pinned BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE queue_songs (
        id UUID PRIMARY KEY, lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
        url TEXT NOT NULL, title TEXT DEFAULT 'Unknown', duration REAL DEFAULT 0,
        added_by VARCHAR(255) DEFAULT 'anonymous', thumbnail TEXT, added_at BIGINT NOT NULL,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE chat_messages (
        id UUID PRIMARY KEY, lobby_id VARCHAR(8) NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL, username VARCHAR(255) NOT NULL, emoji VARCHAR(10),
        content TEXT NOT NULL, created_at BIGINT NOT NULL, song_mention TEXT
      );
    `);
    const now = Date.now();
    await pg.query(`INSERT INTO lobbies (id, host_id, name, is_public, created_at, last_activity) VALUES
      ('own-pub', 'user-a', 'Owned public', TRUE, ${now}, ${now}),
      ('own-prv', 'user-a', 'Owned private', FALSE, ${now}, ${now}),
      ('anon-pr', NULL, 'Ownerless private', FALSE, ${now}, ${now}),
      ('anon-pb', NULL, 'Ownerless public', TRUE, ${now}, ${now})`);
    await pg.query(`INSERT INTO queue_songs (id, lobby_id, url, title, added_at, sort_order)
      VALUES (gen_random_uuid(), 'own-prv', 'library:x', 'Kept song', ${now}, 0)`);
    await pg.query(`INSERT INTO chat_messages (id, lobby_id, user_id, username, content, created_at)
      VALUES (gen_random_uuid(), 'own-pub', 'u', 'U', 'hello', ${now})`);

    dbOpened = true;
    assert.ok(await db.init(), 'db.init should succeed on the old schema');
  });

  after(async () => {
    if (pg) await pg.end();
    if (dbOpened) await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
    playlist.forgetAll();
    forgetQueues();
  });

  it('backfills visibility: owned private stays private, everything else is public', async () => {
    const r = await db.query<{ id: string; host_id: string | null; visibility: string }>('SELECT id, host_id, visibility FROM playlists ORDER BY id');
    const byId = Object.fromEntries(r.rows.map(row => [row.id, row]));
    assert.equal(Object.keys(byId).length, 4, 'no playlist is lost');
    assert.equal(byId['own-pub'].visibility, 'public');
    assert.equal(byId['own-prv'].visibility, 'private');
    assert.equal(byId['anon-pr'].visibility, 'public', 'ownerless playlists cannot be private');
    assert.equal(byId['anon-pb'].visibility, 'public');
    assert.equal(byId['own-prv'].host_id, 'user-a', 'owner is kept');
  });

  it('drops is_public and the chat history, keeps queues', async () => {
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'playlists'`);
    assert.ok(!cols.rows.some(c => c.column_name === 'is_public'));
    const chat = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_messages'`);
    assert.equal(chat.rows.length, 0);
    const songs = await db.query(`SELECT title FROM queue_songs WHERE playlist_id = 'own-prv'`);
    assert.deepEqual(songs.rows.map(s => s.title), ['Kept song']);
  });

  it('is idempotent: a second boot changes nothing', async () => {
    await db.query(`UPDATE playlists SET visibility = 'private' WHERE id = 'own-pub'`);
    await db.close();
    assert.ok(await db.init());
    const r = await db.query(`SELECT visibility FROM playlists WHERE id = 'own-pub'`);
    assert.equal(r.rows[0].visibility, 'private', 'a later choice is not overwritten on restart');
  });

  it('loads migrated playlists into memory with owner + visibility', async () => {
    await playlist.loadPlaylistsFromDB();
    const l = await playlist.getPlaylistAsync('own-prv');
    assert.equal(l!.ownerId, 'user-a');
    assert.equal(l!.visibility, 'private');
  });
});
