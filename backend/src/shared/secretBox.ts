/**
 * Authenticated encryption for small secrets the server keeps for itself:
 * the central login's refresh token and id_token at rest (auth/oidcSessions.ts) and
 * the short-lived sign-in flow cookie (auth/oidc.ts).
 *
 * AES-256-GCM with a random 96-bit IV. Each use gets its own key, derived from
 * SESSION_SECRET with HKDF-SHA256 and a purpose label, so a box made for one
 * purpose never opens as another. `aad` binds a box to its context (for a
 * session row: the hash of its id), so a ciphertext copied to another row does
 * not open either.
 *
 * Format: "v1.<iv>.<ciphertext>.<tag>", each part base64url.
 */

import crypto from 'node:crypto';

const SALT = 'listen-along/secret-box/v1';

/** A 32-byte key for `purpose`, derived from `secret` (SESSION_SECRET). */
export function deriveKey(secret: unknown, purpose: unknown): Buffer {
  if (!secret) throw new Error('secretBox: a secret is required');
  if (!purpose) throw new Error('secretBox: a purpose is required');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), Buffer.from(SALT), Buffer.from(String(purpose)), 32));
}

export function seal(key: Buffer, plaintext: unknown, aad: unknown = ''): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

/** The plaintext, or null for anything that is not a box this key made with this aad. */
export function open(key: Buffer, box: unknown, aad: unknown = ''): string | null {
  if (typeof box !== 'string' || box.length > 64 * 1024) return null;
  const parts = box.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(String(aad)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
