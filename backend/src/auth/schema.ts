// Accounts and sign-in: users, their legacy provider links, CLI tokens and the
// central login's sessions. Run by shared/db.ts, in the order of its SCHEMA list.
import type { Migration } from '../shared/db.ts';

export const tables: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(255),
      username VARCHAR(255),
      emoji VARCHAR(10),
      provider VARCHAR(20) NOT NULL DEFAULT 'local',
      provider_id VARCHAR(255),
      email VARCHAR(255),
      name VARCHAR(255),
      avatar_url TEXT,
      status VARCHAR(20) DEFAULT 'approved',
      created_at BIGINT NOT NULL,
      updated_at BIGINT,
      last_seen BIGINT,
      UNIQUE NULLS NOT DISTINCT(provider, provider_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS user_providers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(20) NOT NULL,
      provider_id VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      name VARCHAR(255),
      avatar_url TEXT,
      linked_at BIGINT NOT NULL,
      UNIQUE(provider, provider_id)
    )
  `,
  // CLI upload tokens. Only the SHA-256 of the token is stored.
  `
    CREATE TABLE IF NOT EXISTS api_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      token_prefix VARCHAR(16),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `,
  // Central login: server-side sessions. Only the SHA-256 of the cookie's id
  // is stored; the tokens are AES-256-GCM encrypted (shared/secretBox.ts). Go
  // with the user.
  `
    CREATE TABLE IF NOT EXISTS user_sessions (
      id_hash CHAR(64) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      oidc_sub TEXT NOT NULL,
      refresh_token_enc TEXT,
      id_token_enc TEXT,
      roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL,
      last_checked_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `,
];

export const migrations: readonly Migration[] = [
  // Migration: tokens belong to a user account (created from the profile
  // page). Tokens made before this keep user_id NULL ("legacy, no owner") and
  // keep working. Deleting the account deletes its tokens.
  `
    ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE
  `,
  `CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`,

  { sql: `CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_user_providers_user ON user_providers(user_id);`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_user_providers_provider ON user_providers(provider, provider_id);`, mustSucceed: true },

  // Users table migrations (OAuth support)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji VARCHAR(10)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT`,
  `ALTER TABLE users ALTER COLUMN provider SET DEFAULT 'local'`,
  `ALTER TABLE users ALTER COLUMN status SET DEFAULT 'approved'`,
  // Never touch existing accounts' status here: this runs on every boot, and
  // an admin's pending / denied / rejected decision must survive a restart.
  // (An old "promote every pending user" line did exactly that.)
  // Drop old last_login NOT NULL constraint (replaced by updated_at). Guarded so
  // it only runs when the column exists — otherwise Postgres logs a (caught but
  // noisy) ERROR on every boot for newer schemas that have no last_login column.
  `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'last_login'
      ) THEN
        ALTER TABLE users ALTER COLUMN last_login DROP NOT NULL;
      END IF;
    END $$;
  `,

  // Profile feature: add display_name column for user-chosen name
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`,

  // People panel: when the user was last online (ms). Set when they connect
  // and when their last socket goes away (features/social). Kept here with the
  // other users columns: their order decides where each column lands.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen BIGINT`,

  // Central login (OIDC; oidcLink.ts, oidcSessions.ts, shared/settings.ts).
  // Added after release, so explicit migrations. Unused until OIDC_ISSUER is set.
  // users.oidc_sub: the central identity's `sub` once linked; unique, so one
  // sub is never linked to two users (NULLs do not clash).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub TEXT`,
  (db) => db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub)`)
    .catch((err: Error) => console.error('Could not create idx_users_oidc_sub:', err.message)),
  { sql: `CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`, mustSucceed: true },
  { sql: `CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at)`, mustSucceed: true },

  // Migrate existing users' provider data into user_providers junction table.
  // Only real legacy providers: accounts made by central login carry
  // provider 'oidc' (provider_id = the central sub), which must never look like
  // a Google / GitHub account (central login's rule b reads both tables).
  (db) => db.query(`
    INSERT INTO user_providers (user_id, provider, provider_id, email, name, avatar_url, linked_at)
    SELECT id, provider, provider_id, email, name, avatar_url, COALESCE(created_at, $1)
    FROM users
    WHERE provider IS NOT NULL AND provider NOT IN ('local', 'oidc')
      AND provider_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_providers up WHERE up.user_id = users.id AND up.provider = users.provider
      )
  `, [Date.now()]).catch(() => {}),
];
