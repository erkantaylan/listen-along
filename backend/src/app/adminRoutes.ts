/**
 * The dashboard's APIs that are not about the library, jobs or tokens (those
 * are in core/library and core/jobs). Every route is behind
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

import express from 'express';
import type { RequestHandler, Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { access } from '../core/playlists/index.ts';
import type { playlist as playlistModule } from '../core/playlists/index.ts';
import type { Queue } from '../core/queue/index.ts';
import type { Settings } from '../shared/settings.ts';
import type { Db } from '../shared/types.ts';

// What the status route accepts: exactly what the dashboard's actions write.
const ADMIN_SET_STATUSES = ['approved', 'denied', 'rejected'];

export interface AdminRouterDeps {
  db: Db;
  /** core/playlists playlist.ts */
  playlist: Pick<typeof playlistModule, 'playlists' | 'getPlaylist' | 'getPlaylistUsers'>;
  /** core/queue */
  getQueueAsync: (playlistId: string) => Promise<Queue>;
  library: { SONGS_PATH: string; LIBRARY_DIR: string };
  /** shared/settings.ts createSettings() */
  settings: Pick<Settings, 'read' | 'set'>;
  /** the central-login config (auth/oidcConfig.ts) */
  oidc: { enabled: boolean };
  apiLimiter: RequestHandler;
  adminAuth: { requireAdmin: RequestHandler };
  accountStatusChanged: (userId: string, status: string) => Promise<void>;
  destroyPlaylist: (playlistId: string, opts?: { reason?: string }) => Promise<void>;
  getSocial: () => { deleteMessage(id: string): Promise<boolean> } | null;
}

/** One public playlist on the dashboard's stats. */
interface StatsPlaylist {
  id: string;
  name: string | null;
  userCount: number;
  queueLength: number;
  createdAt: number;
  lastActivity: number;
}

export function createAdminRouter({ db, playlist, getQueueAsync, library, settings, oidc, apiLimiter, adminAuth, accountStatusChanged, destroyPlaylist, getSocial }: AdminRouterDeps): Router {
  const router = express.Router();

  // Admin: list pending users (dashboard auth)
  router.get('/api/auth/users', adminAuth.requireAdmin, async (req, res) => {
    if (!db.isAvailable()) return res.json({ users: [] });
    try {
      const result = await db.query('SELECT id, provider, email, name, avatar_url, status, created_at FROM users ORDER BY created_at DESC');
      res.json({ users: result.rows });
    } catch (err) {
      console.error('List users error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  // Admin: approve / block a user (dashboard auth). The statuses an admin
  // sets anywhere: approved, or blocked as denied (here) or rejected (the
  // dashboard's reject below); both blocked ones mean the same (auth/userAuth.ts).
  router.post('/api/auth/users/:userId/status', adminAuth.requireAdmin, express.json(), async (req, res) => {
    const { status: sent }: { status?: unknown } = req.body || {};
    if (!ADMIN_SET_STATUSES.includes(sent as string)) {
      return res.status(400).json({ error: 'Status must be approved, denied or rejected' });
    }
    // One of ADMIN_SET_STATUSES.
    const status = sent as string;
    try {
      await db.query('UPDATE users SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), req.params.userId]);
      await accountStatusChanged(req.params.userId, status);
      res.json({ success: true });
    } catch (err) {
      console.error('Update user status error:', (err as Error).message);
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
          ? await db.query<{ file_path: string }>('SELECT file_path FROM library_songs')
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
      totalLobbies: playlist.playlists.size,
      privateLobbies: 0,
      totalUsers: 0,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      diskUsage: { bytes: diskUsageBytes, fileCount: diskFileCount, unregisteredFiles: unregisteredFileCount, unregisteredBytes },
      lobbies: [] as StatsPlaylist[]
    };

    for (const [playlistId, data] of playlist.playlists) {
      const users = playlist.getPlaylistUsers(playlistId);
      const userCount = users ? users.length : 0;
      stats.totalUsers += userCount;
      if (access.isPrivate(data)) { stats.privateLobbies++; continue; }

      let queue;
      try {
        queue = await getQueueAsync(playlistId);
      } catch (err) {
        // A playlist's songs could not be loaded: say so, never count them as 0.
        console.error('Dashboard stats: a playlist could not be loaded:', (err as Error).message);
        return res.status(503).json({ error: 'A playlist could not be loaded, try again', code: 'QUEUE_UNAVAILABLE' });
      }

      stats.lobbies.push({
        id: playlistId,
        name: data.name || null,
        userCount,
        queueLength: queue.getSongs().length,
        createdAt: data.createdAt,
        lastActivity: data.lastActivity
      });
    }

    res.json(stats);
  });

  // Song cache / cookie management was removed with server-side downloading.
  // Library management (delete songs, tokens, requests): core/library, /api/admin/*.

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
      console.error('List users error:', (err as Error).message);
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
      console.error('Read settings error:', (err as Error).message);
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
      console.error('Update settings error:', (err as Error).message);
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
      console.error('Approve user error:', (err as Error).message);
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
      console.error('Reject user error:', (err as Error).message);
      res.status(500).json({ error: 'Failed to reject user' });
    }
  });

  // Delete a playlist (dashboard only)
  router.delete('/api/dashboard/lobbies/:id', adminAuth.requireAdmin, async (req, res) => {
    const playlistId = req.params.id;
    const data = playlist.getPlaylist(playlistId);

    if (!access.canAdminDelete(data)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    try {
      await destroyPlaylist(playlistId, { reason: 'This playlist has been deleted by an administrator.' });
    } catch (err) {
      console.error('Delete playlist error:', (err as Error).message);
      return res.status(500).json({ error: 'Failed to delete playlist' });
    }

    console.log(`Lobby ${playlistId} deleted via dashboard`);
    res.json({ success: true });
  });

  // Admin moderation: delete a global chat message (also possible inline over
  // the socket, chat:delete). Everyone sees it disappear (chat:deleted).
  router.delete('/api/chat/messages/:id', adminAuth.requireAdmin, async (req, res) => {
    const social = getSocial();
    if (!social) return res.status(503).json({ error: 'Chat is not ready' });
    let removed: boolean;
    try {
      removed = await social.deleteMessage(req.params.id);
    } catch (err) {
      console.error('Delete chat message error:', (err as Error).message);
      return res.status(500).json({ error: 'Failed to delete message' });
    }
    if (!removed) return res.status(404).json({ error: 'Message not found' });
    res.json({ success: true });
  });

  return router;
}

