/**
 * CLI API tokens. Created from the admin page, labelled with a person's display
 * name. Only a SHA-256 hash of each token is stored; the plaintext is shown
 * exactly once at creation.
 */

const crypto = require('crypto');
const db = require('./db');

const TOKEN_PREFIX = 'la_';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    active: !row.revoked_at,
  };
}

/** @returns {Promise<{token: string, record: object}>} plaintext token + public record */
async function createToken(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!clean) throw new Error('name is required');
  const token = generateToken();
  const r = await db.query(
    'INSERT INTO api_tokens (name, token_hash, token_prefix) VALUES ($1, $2, $3) RETURNING *',
    [clean, hashToken(token), token.slice(0, 10)]
  );
  return { token, record: toPublic(r.rows[0]) };
}

async function listTokens() {
  const r = await db.query('SELECT * FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC');
  return r.rows.map(toPublic);
}

async function revokeToken(id) {
  const r = await db.query(
    'UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING *',
    [id]
  );
  return r.rows[0] ? toPublic(r.rows[0]) : null;
}

/** @returns {Promise<{id, name}|null>} the active token's owner, or null */
async function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const r = await db.query(
    'SELECT id, name FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)]
  );
  const row = r.rows[0];
  if (!row) return null;
  db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  return { id: row.id, name: row.name };
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
  hashToken,
  generateToken,
  createToken,
  listTokens,
  revokeToken,
  verifyToken,
  bearerFrom,
  requireToken,
  optionalToken,
  hasBearer,
};
