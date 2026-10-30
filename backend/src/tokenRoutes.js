/**
 * A user's own CLI tokens (the "CLI tokens" card on the profile page):
 *
 *   GET    /api/tokens       { tokens: [...] }  the caller's active tokens
 *   POST   /api/tokens       { label } -> 201 { token, record }  (plaintext once)
 *   DELETE /api/tokens/:id   { record }  revoke one of the caller's tokens
 *
 * Approved accounts only (pending users get chat / people and their profile,
 * nothing that reaches the library). Every query is scoped to the caller's
 * users.id, so nobody can see or revoke another user's (or a legacy) token:
 * those are simply "not found". The admin page manages all tokens through
 * /api/admin/tokens (libraryRoutes.js).
 */

const express = require('express');
const db = require('./db');
const tokens = require('./tokens');
const library = require('./library');
const { make } = require('./rateLimits');

/**
 * @param {object} hooks
 * @param {Function} hooks.requireUser - middleware: an approved, logged-in
 *   account; sets req.account = { id, name }. Responds 401/403 otherwise.
 * @param {number} [hooks.createLimit] - token creations per user per hour
 */
function createTokenRouter({ requireUser, createLimit = 10 } = {}) {
  if (typeof requireUser !== 'function') throw new Error('createTokenRouter: requireUser is required');
  const router = express.Router();

  const requireDb = (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'CLI tokens need the database' });
    next();
  };

  // Keyed by account, not IP: a user can't dodge it by switching networks,
  // and people sharing an IP don't share a bucket.
  const createLimiter = make(createLimit, 60 * 60 * 1000, {
    keyGenerator: (req) => `user:${req.account.id}`,
    message: 'Too many tokens created, try again later',
  });

  router.get('/api/tokens', requireUser, requireDb, async (req, res) => {
    try {
      res.json({ tokens: await tokens.listUserTokens(req.account.id) });
    } catch (err) {
      console.error('[tokens] list error:', err.message);
      res.status(500).json({ error: 'Failed to list tokens' });
    }
  });

  router.post('/api/tokens', requireUser, requireDb, createLimiter, express.json(), async (req, res) => {
    const label = req.body && typeof req.body.label === 'string' ? req.body.label : '';
    if (!label.trim()) return res.status(400).json({ error: 'A label is required (e.g. "Desktop")' });
    try {
      const { token, record } = await tokens.createToken(label, { userId: req.account.id });
      console.log(`[tokens] ${req.account.name || req.account.id} created token ${record.prefix}… ("${record.label}")`);
      res.status(201).json({ token, record });
    } catch (err) {
      if (err instanceof tokens.TokenError) return res.status(err.status).json({ error: err.message });
      console.error('[tokens] create error:', err.message);
      res.status(500).json({ error: 'Failed to create token' });
    }
  });

  router.delete('/api/tokens/:id', requireUser, requireDb, async (req, res) => {
    if (!library.isUuid(req.params.id)) return res.status(404).json({ error: 'Token not found' });
    try {
      const record = await tokens.revokeToken(req.params.id, { userId: req.account.id });
      if (!record) return res.status(404).json({ error: 'Token not found' });
      console.log(`[tokens] ${req.account.name || req.account.id} revoked token ${record.prefix}… ("${record.label}")`);
      res.json({ record });
    } catch (err) {
      console.error('[tokens] revoke error:', err.message);
      res.status(500).json({ error: 'Failed to revoke token' });
    }
  });

  return router;
}

module.exports = { createTokenRouter };
