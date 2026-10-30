// The boot-time duplicate-key backfill (library.backfillMetaKeys) must end:
// rows whose title/artist normalize to nothing (meta_key NULL) are still
// marked done (meta_key_version set), so neither this run nor the next boot
// selects them again. Also: ~1,000 songs take well under a few seconds.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

let PostgreSqlContainer;
try { PostgreSqlContainer = require('@testcontainers/postgresql').PostgreSqlContainer; } catch {}
const has = (cmd) => { try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !PostgreSqlContainer ? 'testcontainers package not installed'
  : !has('docker info') ? 'Docker not available' : false;

describe('library meta_key backfill', { skip, timeout: 180_000 }, () => {
  let container;
  let db;
  let library;
  let songMatch;

  before(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('listen_backfill').withUsername('test').withPassword('test').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    db = require('./db');
    assert.ok(await db.init());
    library = require('./library');
    songMatch = require('./songMatch');
  });

  after(async () => {
    if (db) await db.close().catch(() => {});
    if (container) await container.stop();
  });

  it('terminates on unkeyable rows, across batches, and is idempotent', async () => {
    // 1,000 rows like production: every 4th has a title/artist that
    // normalizes to nothing (no key), the rest are ordinary songs.
    await db.query(
      `INSERT INTO library_songs (title, artist, duration_sec, file_path, sha256, uploaded_by)
       SELECT CASE WHEN g % 4 = 0 THEN '(Official Video)' ELSE 'Song ' || g || ' (Lyrics)' END,
              CASE WHEN g % 4 = 0 THEN '!!!' ELSE 'Artist ' || (g % 50) END,
              180 + g % 60, '/data/songs/library/' || g || '.m4a', encode(sha256(g::text::bytea), 'hex'), 'server'
       FROM generate_series(1, 1000) g`
    );
    assert.equal(songMatch.metaKey('(Official Video)', '!!!'), null, 'fixture really is unkeyable');

    const t = Date.now();
    const updated = await library.backfillMetaKeys({ batchSize: 64, pauseMs: 0 });
    const ms = Date.now() - t;
    assert.equal(updated, 1000);
    assert.ok(ms < 15000, `1,000 songs took ${ms}ms`);

    const left = await db.query(
      'SELECT COUNT(*)::int AS n FROM library_songs WHERE meta_key_version IS NULL OR meta_key_version < $1',
      [songMatch.META_KEY_VERSION]
    );
    assert.equal(left.rows[0].n, 0, 'nothing left for the next boot');
    const nulls = await db.query('SELECT COUNT(*)::int AS n FROM library_songs WHERE meta_key IS NULL');
    assert.equal(nulls.rows[0].n, 250, 'unkeyable rows keep a NULL key but are marked done');

    assert.equal(await library.backfillMetaKeys({ pauseMs: 0 }), 0, 'second run (next boot) does nothing');
  });

  it('only recomputes rows from an older normalization version', async () => {
    await db.query("UPDATE library_songs SET meta_key_version = 0 WHERE title = 'Song 1 (Lyrics)'");
    assert.equal(await library.backfillMetaKeys({ pauseMs: 0 }), 1);
    assert.equal(await library.backfillMetaKeys({ pauseMs: 0 }), 0);
  });
});
