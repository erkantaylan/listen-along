// The schema list (db.ts SCHEMA, each area's schema.ts): the rules init()
// relies on, checked without a database. The schema itself is exercised on
// Postgres by playlist-migration.test.js, account-status-restart.test.js and
// every store test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import db, { SCHEMA } from './db.ts';
import type { Migration } from './db.ts';
import type { SettingsDb } from './settings.ts';

const tableName = (sql: string): string => {
  const m = sql.match(/^\s*CREATE TABLE IF NOT EXISTS (\w+) \(/);
  assert.ok(m, `not a CREATE TABLE IF NOT EXISTS: ${sql.trim().slice(0, 60)}`);
  return m[1];
};
const migrationSql = (m: Migration): string => (typeof m === 'string' ? m : typeof m === 'function' ? m.toString() : m.sql);

describe('the schema list', () => {
  it('tables are CREATE TABLE IF NOT EXISTS, each once, after every table they reference', () => {
    const created: string[] = [];
    for (const { area, schema } of SCHEMA) {
      for (const sql of schema.tables) {
        const name = tableName(sql);
        assert.ok(!created.includes(name), `${name} is created twice`);
        for (const [, ref] of sql.matchAll(/REFERENCES (\w+)\(/g)) {
          assert.ok(ref === name || created.includes(ref), `${area}: ${name} references ${ref}, which is created later`);
        }
        created.push(name);
      }
    }
    assert.equal(created.length, 18);
  });

  it('a migration only references tables that exist by then (all tables run first)', () => {
    const tables = new Set(SCHEMA.flatMap(({ schema }) => schema.tables.map(tableName)));
    for (const { area, schema } of SCHEMA) {
      for (const m of schema.migrations) {
        for (const [, ref] of migrationSql(m).matchAll(/REFERENCES (\w+)\(/g)) assert.ok(tables.has(ref), `${area}: ${ref}`);
      }
    }
  });

  it('never creates chat_messages and never rewrites a user status', () => {
    for (const { schema } of SCHEMA) {
      for (const sql of [...schema.tables, ...schema.migrations.map(migrationSql)]) {
        assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS chat_messages\b/);
        assert.doesNotMatch(sql, /UPDATE users\b[\s\S]*\bstatus\s*=/i);
      }
    }
  });

  it('the module object is what the stores are typed against', () => {
    const forSettings: SettingsDb = db;
    assert.equal(typeof forSettings.query, 'function');
    assert.equal(db.isAvailable(), false, 'no pool before init()');
  });
});
