// The shared base's own table: app-wide switches (settings.ts). Run by
// shared/db.ts, in the order of its SCHEMA list.
import type { Migration } from './db.ts';

export const tables: readonly string[] = [
  // App-wide switches an admin flips at run time (settings.ts), e.g.
  // registrations_open. A missing row means the default.
  `
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(64) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `,
];

export const migrations: readonly Migration[] = [];
