// The one global chat (social.ts / chat.ts). Run by shared/db.ts, in the order
// of its SCHEMA list.
import type { Migration } from '../../shared/db.ts';

export const tables: readonly string[] = [
  // Kept forever; read newest first with keyset pagination on id. Deliberately
  // NOT named chat_messages: that was the old per-playlist chat table, which
  // the migration below drops on every boot. author_name is a snapshot used
  // when the user row is gone.
  `
    CREATE TABLE IF NOT EXISTS global_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      author_name VARCHAR(255),
      body TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `,
];

export const migrations: readonly Migration[] = [
  // Per-playlist chat was removed (a global chat replaces it); drop its table
  // and history on existing deployments.
  `DROP TABLE IF EXISTS chat_messages`,
];
