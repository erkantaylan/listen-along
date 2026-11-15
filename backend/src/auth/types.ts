// The sign-in area's shapes. Type-only: import with `import type`.
//
// Rows are written from the SQL in auth/schema.ts with node-postgres' default
// parsing (BIGINT a string, TIMESTAMPTZ a Date, JSONB parsed); change them with
// the schema. The users row itself is shared (shared/types.ts).
import type { AccountStatus } from '../shared/types.ts';

/** An `api_tokens` row (CLI tokens; only the SHA-256 of a token is stored). */
export interface ApiTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  /** the owner (users.id); null for a legacy token from before ownership */
  user_id: string | null;
}

/** A CLI token as the profile page and the dashboard see it (tokens.toPublic). */
export interface PublicToken {
  id: string;
  name: string;
  label: string;
  prefix: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  active: boolean;
  owner: { id: string; name: string | null } | null;
}

/**
 * The caller behind a valid CLI token (`req.apiUser`, tokens.verifyToken).
 * `name` is who uploads are credited to: the owner's display name, or a legacy
 * token's own name.
 */
export interface ApiUser {
  /** api_tokens.id */
  id: string;
  name: string;
  label: string;
  /** the owner's users.id; null for a legacy token */
  userId: string | null;
  user: { id: string; name: string } | null;
}

/** An account as access checks see it (userAuth.getAccount). */
export interface Account {
  /** users.id */
  id: string;
  /** users.status; a row without one counts as approved */
  status: AccountStatus;
  name: string | null;
  emoji: string | null;
}
