// Global chat + people panel on Postgres: db.init() migrates an existing
// users table (adds last_seen) and creates global_chat_messages; the chat
// store persists and pages with a keyset cursor; the people list holds every
// account except denied / rejected ones (pending included) with last seen.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}

function dockerOk() {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}

const skipReason = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !dockerOk() ? 'Docker not available' : false;

describe('global chat and people on Postgres', { skip: skipReason, timeout: 120_000 }, () => {
  let container;
  let db;
  let pg;
  const ids = {};

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_social').withUsername('test').withPassword('test').start();
    process.env.DATABASE_URL = container.getConnectionUri();

    // A users table as an older release left it: no last_seen column.
    const { Client } = require('pg');
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id VARCHAR(255), username VARCHAR(255),
        emoji VARCHAR(10), provider VARCHAR(20) NOT NULL DEFAULT 'local', provider_id VARCHAR(255),
        email VARCHAR(255), name VARCHAR(255), avatar_url TEXT, status VARCHAR(20) DEFAULT 'approved',
        created_at BIGINT NOT NULL, updated_at BIGINT, UNIQUE NULLS NOT DISTINCT(provider, provider_id)
      );
    `);
    for (const [key, status, i] of [['alice', 'approved', 1], ['bob', 'approved', 2], ['denied', 'denied', 3], ['rejected', 'rejected', 4]]) {
      const r = await pg.query(
        `INSERT INTO users (provider, provider_id, name, avatar_url, status, created_at) VALUES ('github', $1, $2, $3, $4, $5) RETURNING id`,
        [key, key, i === 1 ? 'https://avatars.example/a.png' : 'javascript:alert(1)', status, i]
      );
      ids[key] = r.rows[0].id;
    }

    db = require('./db');
    assert.equal(await db.init(), true);
  });

  after(async () => {
    if (pg) await pg.end();
    if (db) await db.close();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
  });

  it('adds users.last_seen to an existing table and creates the chat table', async () => {
    const cols = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'last_seen'`);
    assert.equal(cols.rows.length, 1);
    const t = await pg.query(`SELECT to_regclass('global_chat_messages') AS t`);
    assert.equal(t.rows[0].t, 'global_chat_messages');
    // Running the migrations again keeps the history (the old per-playlist
    // chat_messages table is dropped on boot; this one must not be).
    const chat = require('./chat');
    await chat.createPgStore(db).add({ userId: ids.alice, author: { name: 'alice' }, text: 'survives a reboot' });
    await db.close();
    assert.equal(await db.init(), true);
    const { messages } = await chat.createPgStore(db).page({});
    assert.equal(messages.at(-1).text, 'survives a reboot');
  });

  it('persists messages and pages them newest first with a keyset cursor', async () => {
    const chat = require('./chat');
    const store = chat.createPgStore(db);
    await pg.query('DELETE FROM global_chat_messages');
    for (let i = 1; i <= 120; i++) await store.add({ userId: i % 2 ? ids.alice : ids.bob, author: { name: 'x' }, text: `m${i}`, createdAt: 1000 + i });

    const p1 = await store.page({});
    assert.equal(p1.messages.length, chat.PAGE_SIZE);
    assert.deepEqual([p1.messages[0].text, p1.messages.at(-1).text], ['m71', 'm120']);
    assert.equal(p1.hasMore, true);
    const p2 = await store.page({ before: p1.messages[0].id });
    assert.deepEqual([p2.messages[0].text, p2.messages.at(-1).text], ['m21', 'm70']);
    const p3 = await store.page({ before: p2.messages[0].id });
    assert.equal(p3.messages.length, 20);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.messages[0].text, 'm1');
    assert.equal(p3.messages[0].createdAt, 1001);

    // The query uses the primary key, not OFFSET.
    const plan = await pg.query(`EXPLAIN SELECT id FROM global_chat_messages WHERE id < 50 ORDER BY id DESC LIMIT 51`);
    assert.ok(!plan.rows.map(r => r['QUERY PLAN']).join('\n').includes('Offset'));
  });

  it('shows the author from the users table, falling back to the snapshot', async () => {
    const chat = require('./chat');
    const store = chat.createPgStore(db);
    await pg.query(`UPDATE users SET display_name = 'Alice Renamed' WHERE id = $1`, [ids.alice]);
    const m = await store.add({ userId: ids.alice, author: { name: 'alice' }, text: 'hi' });
    assert.equal(m.authorName, 'Alice Renamed');
    assert.equal(m.authorAvatar, 'https://avatars.example/a.png');

    const tmp = await pg.query(`INSERT INTO users (provider, provider_id, name, created_at) VALUES ('github', 'tmp', 'Temp', 1) RETURNING id`);
    const gone = await store.add({ userId: tmp.rows[0].id, author: { name: 'Temp' }, text: 'bye' });
    await pg.query('DELETE FROM users WHERE id = $1', [tmp.rows[0].id]);
    const { messages } = await store.page({});
    const kept = messages.find(x => x.id === gone.id);
    assert.equal(kept.userId, null);
    assert.equal(kept.authorName, 'Temp');

    assert.equal(await store.remove(gone.id), true);
    assert.equal(await store.remove(gone.id), false);
    assert.equal(await store.remove('nonsense'), false);
  });

  it('lists every account except denied / rejected ones, with last seen, and records it', async () => {
    const { createSocial } = require('./social');
    const { createPresence } = require('./presence');
    const chat = require('./chat');
    const noop = { emit() {}, except() { return this; } };
    const io = { to: () => noop, in: () => ({ socketsLeave() {} }) };
    const presence = createPresence({ graceMs: 0 });
    const social = createSocial({ io, db, presence, store: chat.createPgStore(db), getLobby: () => null, isAdmin: () => false });

    // Pending accounts are promoted on every boot (no approval gating), but a
    // status can still be set to pending afterwards; they must be listed.
    const pend = await pg.query(`INSERT INTO users (provider, provider_id, name, status, created_at) VALUES ('github', 'pend', 'pend', 'pending', 5) RETURNING id`);
    ids.pending = pend.rows[0].id;
    await pg.query('UPDATE users SET last_seen = 777 WHERE id = $1', [ids.bob]);
    const people = await social.listPeople(ids.alice);
    const byId = new Map(people.map(p => [p.id, p]));
    assert.ok(byId.has(ids.alice));
    assert.ok(byId.has(ids.bob));
    assert.equal(byId.get(ids.pending).pending, true);
    assert.ok(!byId.has(ids.denied));
    assert.ok(!byId.has(ids.rejected));
    assert.equal(byId.get(ids.bob).lastSeen, 777);
    assert.equal(byId.get(ids.bob).online, false);
    assert.equal(byId.get(ids.bob).avatarUrl, null, 'non-https avatars are dropped');
    assert.equal(byId.get(ids.alice).name, 'Alice Renamed');

    // Going offline writes users.last_seen.
    presence.connect(ids.bob, 'sock');
    presence.disconnect(ids.bob, 'sock');
    await new Promise(r => setTimeout(r, 100));
    const r = await pg.query('SELECT last_seen FROM users WHERE id = $1', [ids.bob]);
    assert.ok(Number(r.rows[0].last_seen) > 777);
    presence.close();
  });
});
