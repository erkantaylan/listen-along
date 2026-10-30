/**
 * CLI API tokens. Each token belongs to a user account (api_tokens.user_id):
 * approved users create and revoke their own from the profile page
 * (/api/tokens); the admin page lists and revokes every token. Tokens made
 * before ownership existed have no owner (user_id NULL, "legacy") and keep
 * working under the name they were created with.
 *
 * Only a SHA-256 hash of each token is stored; the plaintext is shown exactly
 * once at creation.
 */

const crypto = require('crypto');
const db = require('./db');

const TOKEN_PREFIX = 'la_';
/** Most active tokens one user may hold at a time. */
const MAX_ACTIVE_PER_USER = 20;

class TokenError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function cleanLabel(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

const ownerName = (row) => row.owner_display_name || row.owner_name || row.owner_username || null;

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    label: row.name,
    prefix: row.token_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    active: !row.revoked_at,
    owner: row.user_id ? { id: row.user_id, name: ownerName(row) } : null,
  };
}

const SELECT_WITH_OWNER = `
  SELECT t.*, u.display_name AS owner_display_name, u.name AS owner_name, u.username AS owner_username
  FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id`;

/**
 * @param {string} name - the label ("Desktop"), or a person's name for an ownerless token
 * @param {{userId?: string}} [opts] - owner (users.id)
 * @returns {Promise<{token: string, record: object}>} plaintext token + public record
 */
async function createToken(name, { userId = null } = {}) {
  const clean = cleanLabel(name);
  if (!clean) throw new TokenError(400, 'A label is required');
  if (userId) {
    const r = await db.query(
      'SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    if (r.rows[0].n >= MAX_ACTIVE_PER_USER) {
      throw new TokenError(409, `You already have ${MAX_ACTIVE_PER_USER} active tokens; revoke one first`);
    }
  }
  const token = generateToken();
  const ins = await db.query(
    'INSERT INTO api_tokens (name, token_hash, token_prefix, user_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [clean, hashToken(token), token.slice(0, 10), userId]
  );
  return { token, record: await getToken(ins.rows[0].id) };
}

async function getToken(id) {
  const r = await db.query(`${SELECT_WITH_OWNER} WHERE t.id = $1`, [id]);
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

/** Every token (admin page), active first, newest first. */
async function listTokens() {
  const r = await db.query(`${SELECT_WITH_OWNER} ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`);
  return r.rows.map(toPublic);
}

/** One user's active tokens, newest first. */
async function listUserTokens(userId) {
  const r = await db.query(
    `${SELECT_WITH_OWNER} WHERE t.user_id = $1 AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
    [userId]
  );
  return r.rows.map(toPublic);
}

/**
 * Revoke a token. With `userId`, only that user's own token: anyone else's
 * (or a legacy one) is "not found".
 * @returns {Promise<object|null>} the public record, or null when not found
 */
async function revokeToken(id, { userId } = {}) {
  const params = [id];
  let where = 'id = $1';
  if (userId !== undefined) { params.push(userId); where += ' AND user_id = $2'; }
  const r = await db.query(
    `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE ${where} RETURNING id`,
    params
  );
  return r.rows[0] ? getToken(r.rows[0].id) : null;
}

/**
 * @returns {Promise<{id, name, label, userId, user}|null>} the active token,
 *   or null. `name` is who uploads are credited to: the owner's display name,
 *   or the legacy token's name. `user` is { id, name } or null (legacy).
 *   A token whose owner is no longer approved (pending, denied, rejected)
 *   is refused.
 */
async function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const r = await db.query(
    `SELECT t.id, t.name, t.user_id, u.id AS owner_id, u.status AS owner_status,
            u.display_name AS owner_display_name, u.name AS owner_name, u.username AS owner_username
     FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hashToken(token)]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.user_id) {
    if (!row.owner_id) return null;
    if ((row.owner_status || 'approved') !== 'approved') return null;
  }
  db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  const user = row.user_id ? { id: row.user_id, name: ownerName(row) || row.name } : null;
  return { id: row.id, name: user ? user.name : row.name, label: row.name, userId: row.user_id || null, user };
}

function bearerFrom(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

/** Express middleware: require a valid Bearer token; sets req.apiUser. */
function requireToken(req, res, next) {
  if (!db.isAvailable()) return res.status(503).json({ error: 'Database not available' });
  const token = bearerFrom(req);
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
  verifyToken(token).then((user) => {
    if (!user) return res.status(401).json({ error: 'Invalid or revoked token' });
    req.apiUser = user;
    next();
  }).catch(next);
}

/**
 * Express middleware for endpoints the web UI may call without a token: no
 * Bearer token -> pass; a Bearer token that is present must be valid. Other
 * Authorization schemes are ignored (browsers keep resending cached Basic
 * credentials from the old dashboard login).
 */
function hasBearer(req) {
  return /^Bearer\s/i.test(req.headers.authorization || '');
}

function optionalToken(req, res, next) {
  if (!hasBearer(req)) return next();
  return requireToken(req, res, next);
}

module.exports = {
  MAX_ACTIVE_PER_USER,
  TokenError,
  hashToken,
  generateToken,
  createToken,
  getToken,
  listTokens,
  listUserTokens,
  revokeToken,
  verifyToken,
  bearerFrom,
  requireToken,
  optionalToken,
  hasBearer,
};
