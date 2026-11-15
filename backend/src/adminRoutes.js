/**
 * The dashboard's APIs that are not about the library, jobs or tokens (those
 * are in libraryRoutes.js / jobRoutes.js). Every route is behind
 * adminAuth.requireAdmin (the la_admin cookie, not a user account):
 *
 *   GET    /api/auth/users                     users (older list)
 *   POST   /api/auth/users/:userId/status      { status: approved | denied | rejected }
 *   GET    /api/dashboard/stats                disk, memory, playlists (private ones counted, never listed)
 *   GET    /api/dashboard/users                users
 *   GET|PUT /api/admin/settings                { registrations_open } (shared/settings.ts)
 *   PUT    /api/dashboard/users/:id/approve
 *   PUT    /api/dashboard/users/:id/reject
 *   DELETE /api/dashboard/lobbies/:id          an ownerless / public playlist
 *   DELETE /api/chat/messages/:id              a global chat message
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const access = require('./playlistAccess');

// What the status route accepts: exactly what the dashboard's actions write.
const ADMIN_SET_STATUSES = ['approved', 'denied', 'rejected'];

/**
 * @param {object} deps
 * @param {{ isAvailable: () => boolean, query: Function }} deps.db
 * @param {{ lobbies: Map<string, object>, getLobby: Function, getLobbyUsers: Function }} deps.lobby - lobby.js
 * @param {(lobbyId: string) => Promise<object>} deps.getQueueAsync - queue.js
 * @param {{ SONGS_PATH: string, LIBRARY_DIR: string }} deps.library
 * @param {{ read: Function, set: Function }} deps.settings - shared/settings.ts createSettings()
 * @param {{ enabled: boolean }} deps.oidc - the central-login config (oidcConfig.js)
 * @param {import('express').RequestHandler} deps.apiLimiter
 * @param {{ requireAdmin: import('express').RequestHandler }} deps.adminAuth
 * @param {(userId: string, status: string) => Promise<void>} deps.accountStatusChanged
 * @param {(lobbyId: string, opts?: { reason?: string }) => Promise<void>} deps.destroyLobby
 * @param {() => ({ deleteMessage: (id: string) => Promise<boolean> }|null)} deps.getSocial
 * @returns {import('express').Router}
 */
function createAdminRouter({ db, lobby, getQueueAsync, library, settings, oidc, apiLimiter, adminAuth, accountStatusChanged, destroyLobby, getSocial }) {
  const router = express.Router();

  // Admin: list pending users (dashboard auth)
  router.get('/api/auth/users', adminAuth.requireAdmin, async (req, res) => {
    if (!db.isAvailable()) return res.json({ users: [] });
    try {
      const result = await db.query('SELECT id, provider, email, name, avatar_url, status, created_at FROM users ORDER BY created_at DESC');
      res.json({ users: result.rows });
    } catch (err) {
      console.error('List users error:', err.message);
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  // Admin: approve / block a user (dashboard auth). The statuses an admin
  // sets anywhere: approved, or blocked as denied (here) or rejected (the
  // dashboard's reject below); both blocked ones mean the same (userAuth.js).
  router.post('/api/auth/users/:userId/status', adminAuth.requireAdmin, express.json(), async (req, res) => {
    const { status } = req.body || {};
    if (!ADMIN_SET_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Status must be approved, denied or rejected' });
    }
    try {
      await db.query('UPDATE users SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), req.params.userId]);
      await accountStatusChanged(req.params.userId, status);
      res.json({ success: true });
    } catch (err) {
      console.error('Update user status error:', err.message);
      res.status(500).json({ error: 'Failed to update user status' });
    }
  });

  // Dashboard stats endpoint
  router.get('/api/dashboard/stats', adminAuth.requireAdmin, async (req, res) => {
    // Calculate disk usage from songs directory
    let diskUsageBytes = 0;
    let diskFileCount = 0;
    let unregisteredFileCount = 0;
    let unregisteredBytes = 0;
    try {
      const songsDir = library.SONGS_PATH;
      if (fs.existsSync(songsDir)) {
        const knownPathsResult = db.isAvailable()
          ? await db.query('SELECT file_path FROM library_songs')
          : { rows: [] };
        const knownPaths = new Set(knownPathsResult.rows.map(r => r.file_path));

        const files = fs.readdirSync(songsDir).map(f => path.join(songsDir, f));
        if (fs.existsSync(library.LIBRARY_DIR)) {
          files.push(...fs.readdirSync(library.LIBRARY_DIR).map(f => path.join(library.LIBRARY_DIR, f)));
        }
        for (const fullPath of files) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              diskUsageBytes += stat.size;
              diskFileCount++;
              if (!knownPaths.has(fullPath)) {
                unregisteredFileCount++;
                unregisteredBytes += stat.size;
              }
            }
          } catch {}
        }
      }
    } catch {}

    // Private playlists are visible to their owner only — admins included: the
    // dashboard counts them but never lists them.
    const stats = {
      totalLobbies: lobby.lobbies.size,
      privateLobbies: 0,
      totalUsers: 0,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      diskUsage: { bytes: diskUsageBytes, fileCount: diskFileCount, unregisteredFiles: unregisteredFileCount, unregisteredBytes },
      lobbies: []
    };

    for (const [lobbyId, lobbyData] of lobby.lobbies) {
      const users = lobby.getLobbyUsers(lobbyId);
      const userCount = users ? users.length : 0;
      stats.totalUsers += userCount;
      if (access.isPrivate(lobbyData)) { stats.privateLobbies++; continue; }

      const queue = await getQueueAsync(lobbyId);

      stats.lobbies.push({
        id: lobbyId,
        name: lobbyData.name || null,
        userCount,
        queueLength: queue.getSongs().length,
        createdAt: lobbyData.createdAt,
        lastActivity: lobbyData.lastActivity
      });
    }

    res.json(stats);
  });

  // Song cache / cookie management was removed with server-side downloading.
  // Library management (delete songs, tokens, requests): libraryRoutes.js, /api/admin/*.

  // List all registered users (dashboard only)
  router.get('/api/dashboard/users', adminAuth.requireAdmin, async (req, res) => {
    if (!db.isAvailable()) {
      return res.json({ users: [] });
    }

    try {
      const result = await db.query(
        'SELECT id, user_id, username, emoji, email, avatar_url, provider, status, created_at, updated_at, (oidc_sub IS NOT NULL) AS central FROM users ORDER BY created_at DESC'
      );
      res.json({ users: result.rows });
    } catch (err) {
      console.error('List users error:', err.message);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // Sign-in settings (dashboard only; shared/settings.ts). registrations_open: whether a
  // central identity that matches no account gets a new one. Stored in the
  // database (in memory without one), read at every sign-in: no restart. Until
  // saved, REGISTRATIONS_DEFAULT decides (`source: 'default'`).
  router.get('/api/admin/settings', apiLimiter, adminAuth.requireAdmin, async (req, res) => {
    try {
      const r = await settings.read('registrations_open');
      res.json({ registrations_open: r.value !== false, source: r.source, central_login: oidc.enabled });
    } catch (err) {
      console.error('Read settings error:', err.message);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  });
  router.put('/api/admin/settings', apiLimiter, adminAuth.requireAdmin, express.json(), async (req, res) => {
    const value = req.body && req.body.registrations_open;
    if (typeof value !== 'boolean') return res.status(400).json({ error: 'registrations_open must be true or false' });
    try {
      await settings.set('registrations_open', value);
      console.log(`[admin] registrations ${value ? 'opened' : 'closed'}`);
      res.json({ registrations_open: value, source: 'saved', central_login: oidc.enabled });
    } catch (err) {
      console.error('Update settings error:', err.message);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // Approve a user (dashboard only)
  router.put('/api/dashboard/users/:id/approve', adminAuth.requireAdmin, async (req, res) => {
    try {
      const result = await db.query(
        'UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING user_id, username, status',
        ['approved', Date.now(), req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      await accountStatusChanged(req.params.id, 'approved');
      res.json({ success: true, user: result.rows[0] });
    } catch (err) {
      console.error('Approve user error:', err.message);
      res.status(500).json({ error: 'Failed to approve user' });
    }
  });

  // Reject a user (dashboard only)
  router.put('/api/dashboard/users/:id/reject', adminAuth.requireAdmin, async (req, res) => {
    try {
      const result = await db.query(
        'UPDATE users SET status = $1, updated_at = $2 WHERE id = $3 RETURNING user_id, username, status',
        ['rejected', Date.now(), req.params.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      await accountStatusChanged(req.params.id, 'rejected');
      res.json({ success: true, user: result.rows[0] });
    } catch (err) {
      console.error('Reject user error:', err.message);
      res.status(500).json({ error: 'Failed to reject user' });
    }
  });

  // Delete a lobby (dashboard only)
  router.delete('/api/dashboard/lobbies/:id', adminAuth.requireAdmin, async (req, res) => {
    const lobbyId = req.params.id;
    const lobbyData = lobby.getLobby(lobbyId);

    if (!access.canAdminDelete(lobbyData)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    try {
      await destroyLobby(lobbyId, { reason: 'This playlist has been deleted by an administrator.' });
    } catch (err) {
      console.error('Delete playlist error:', err.message);
      return res.status(500).json({ error: 'Failed to delete playlist' });
    }

    console.log(`Lobby ${lobbyId} deleted via dashboard`);
    res.json({ success: true });
  });

  // Admin moderation: delete a global chat message (also possible inline over
  // the socket, chat:delete). Everyone sees it disappear (chat:deleted).
  router.delete('/api/chat/messages/:id', adminAuth.requireAdmin, async (req, res) => {
    const social = getSocial();
    if (!social) return res.status(503).json({ error: 'Chat is not ready' });
    let removed;
    try {
      removed = await social.deleteMessage(req.params.id);
    } catch (err) {
      console.error('Delete chat message error:', err.message);
      return res.status(500).json({ error: 'Failed to delete message' });
    }
    if (!removed) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
  });

  return router;
}

module.exports = { createAdminRouter };
