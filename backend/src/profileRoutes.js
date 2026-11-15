/**
 * The caller's own profile (the profile page):
 *
 *   GET /api/profile   { id, displayName, emoji, email, avatarUrl }
 *   PUT /api/profile   { displayName, emoji? } -> { success }
 *
 * Pending accounts may use both (policyFor: `member`). Without a database
 * there is no users table: 401.
 */

const express = require('express');

/**
 * @param {object} deps
 * @param {{ isAvailable: () => boolean, query: Function }} deps.db
 * @param {{ userIdFor: (req: object) => Promise<string|null>, invalidate: (userId: string) => void }} deps.userAuth
 * @param {() => ({ profileChanged: (userId: string) => void }|null)} deps.getSocial - features/social, once start() made it
 * @returns {import('express').Router}
 */
function createProfileRouter({ db, userAuth, getSocial }) {
  const router = express.Router();

  // Get current user's profile
  router.get('/api/profile', async (req, res) => {
    const userId = await userAuth.userIdFor(req);
    if (!userId || !db.isAvailable()) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const userResult = await db.query(
        'SELECT id, display_name, username, emoji, name, email, avatar_url, provider FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const user = userResult.rows[0];
      res.json({
        id: user.id,
        displayName: user.display_name || user.username || user.name || 'User',
        emoji: user.emoji,
        email: user.email,
        avatarUrl: user.avatar_url
      });
    } catch (err) {
      console.error('Profile fetch error:', err.message);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  });

  // Update profile (display name, emoji)
  router.put('/api/profile', express.json(), async (req, res) => {
    const userId = await userAuth.userIdFor(req);
    if (!userId || !db.isAvailable()) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { displayName, emoji } = req.body;
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
      return res.status(400).json({ error: 'displayName is required' });
    }
    if (displayName.trim().length > 30) {
      return res.status(400).json({ error: 'displayName must be 30 characters or less' });
    }
    try {
      await db.query(
        'UPDATE users SET display_name = $1, emoji = $2, updated_at = $3 WHERE id = $4',
        [displayName.trim(), typeof emoji === 'string' && emoji ? emoji.slice(0, 10) : null, Date.now(), userId]
      );
      userAuth.invalidate(userId);
      const social = getSocial();
      if (social) social.profileChanged(String(userId));
      res.json({ success: true });
    } catch (err) {
      console.error('Profile update error:', err.message);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  return router;
}

module.exports = { createProfileRouter };
