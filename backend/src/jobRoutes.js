/**
 * HTTP API for download jobs, downloaders (workers) and the profile activity:
 *
 *   GET  /api/workers                  online downloaders: name, owner, busy (approved users)
 *   GET  /api/jobs                     the caller's jobs, newest first, + worker counts
 *   POST /api/jobs                     { input, playlist_id? } the web "Download" box
 *   POST /api/jobs/:id/cancel          a queued job of the caller
 *   POST /api/jobs/:id/retry           a failed / cancelled job of the caller
 *   GET  /api/profile/activity         the caller's own uploads / asks / fulfilments
 *   GET  /api/admin/workers            every worker with IP, OS, versions (admin)
 *   GET  /api/admin/jobs               job queue overview (admin)
 *   POST /api/admin/jobs/:id/cancel|retry
 *
 * Worker machine details (hostname, platform, OS, IP) are admin-only;
 * everyone else sees a worker as "<name> (<owner>)".
 */

const express = require('express');
const db = require('./db');
const library = require('./library');
const jobs = require('./downloadJobs');
const adminAuth = require('./adminAuth');
const { apiLimiter } = require('./rateLimits');

/**
 * @param {object} hooks
 * @param {Function} hooks.requireUser - approved account; sets req.account { id, name }
 * @param {Function} hooks.requireMember - any non-blocked account; sets req.account
 * @param {object} hooks.hub - workerHub (stats, live, onlineWorkers, dispatch)
 * @param {(playlistId, userId) => Promise<object|null>} hooks.editablePlaylist
 * @param {(url) => Promise<{title, artist}>} hooks.spotifyTrack
 * @param {(playlistId, song, addedBy) => Promise<boolean>} hooks.addSongToPlaylist - true if added now
 * @param {(job) => void} [hooks.onJobUpdated]
 */
function createJobRouter(hooks) {
  const { requireUser, requireMember, hub } = hooks;
  const onJobUpdated = hooks.onJobUpdated || (() => {});
  const router = express.Router();
  router.use(['/api/workers', '/api/jobs', '/api/profile/activity', '/api/admin/workers', '/api/admin/jobs'], apiLimiter);

  const requireDb = (req, res, next) => {
    if (!db.isAvailable()) return res.status(503).json({ error: 'Downloads need the database' });
    next();
  };
  const route = (label, fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[jobs] ${label} error:`, err);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${label}` });
    });
  };
  const workerCounts = () => hub.stats();

  router.get('/api/workers', requireUser, (req, res) => {
    res.json({ workers: hub.onlineWorkers(), ...workerCounts() });
  });

  router.get('/api/jobs', requireUser, requireDb, route('list jobs', async (req, res) => {
    const rows = await jobs.listForUser(req.account.id, { limit: 50 });
    res.json({ jobs: rows.map(jobs.toPublic), workers: workerCounts() });
  }));

  router.post('/api/jobs', requireUser, requireDb, express.json(), route('create job', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const what = jobs.classifyInput(body.input);
    if (what.error) return res.status(400).json({ error: what.error, code: 'BAD_INPUT' });

    let playlist = null;
    if (body.playlist_id !== undefined && body.playlist_id !== null && body.playlist_id !== '') {
      playlist = await hooks.editablePlaylist(String(body.playlist_id), req.account.id);
      if (!playlist) return res.status(404).json({ error: 'Playlist not found', code: 'PLAYLIST_NOT_FOUND' });
    }
    const requester = req.account.name || 'Someone';

    // A video the library already has: nothing to download.
    if (what.kind === 'video') {
      const song = await library.getByYoutubeId(what.youtubeId);
      if (song) {
        const added = playlist ? await hooks.addSongToPlaylist(playlist.id, song, requester) : false;
        return res.json({ job: null, existing: library.toPublic(song), added_to_playlist: added, playlist_id: playlist ? playlist.id : null });
      }
    }

    let input = what.input;
    let title = what.kind === 'search' ? what.input : null;
    if (what.kind === 'spotify') {
      // The worker searches YouTube for it (the server only reads the page).
      let track;
      try { track = await hooks.spotifyTrack(what.input); } catch (err) {
        return res.status(400).json({ error: `Could not read that Spotify link: ${err.message}`, code: 'BAD_INPUT' });
      }
      const name = track && (track.name || track.title);
      if (!name) return res.status(400).json({ error: 'That Spotify link has no track title', code: 'BAD_INPUT' });
      const artist = track.artist && track.artist !== 'Unknown Artist' ? track.artist : null;
      title = artist ? `${artist} - ${name}` : name;
      input = title;
    }
    const row = await jobs.createJob({
      source: 'web',
      kind: what.kind,
      input,
      title,
      playlistId: playlist ? playlist.id : null,
      requestedByUserId: req.account.id,
      requestedBy: requester,
    });
    console.log(`[jobs] ${requester} queued ${what.kind} job ${row.id}: ${title || input}${playlist ? ` -> playlist ${playlist.id}` : ''}`);
    onJobUpdated(row);
    hub.dispatch();
    res.status(201).json({ job: jobs.toPublic(row), workers: workerCounts() });
  }));

  router.post('/api/jobs/:id/cancel', requireUser, requireDb, route('cancel job', async (req, res) => {
    const row = await jobs.cancel(req.params.id, { userId: req.account.id });
    if (!row) return res.status(409).json({ error: 'Only a job of yours that is still waiting can be cancelled', code: 'NOT_CANCELLABLE' });
    onJobUpdated(row);
    res.json({ job: jobs.toPublic(row) });
  }));

  router.post('/api/jobs/:id/retry', requireUser, requireDb, route('retry job', async (req, res) => {
    const row = await jobs.retry(req.params.id, { userId: req.account.id });
    if (!row) return res.status(409).json({ error: 'Only a failed or cancelled job of yours can be retried', code: 'NOT_RETRYABLE' });
    onJobUpdated(row);
    hub.dispatch();
    res.json({ job: jobs.toPublic(row) });
  }));

  // --- Profile: the caller's own activity (only ever their own) -------------
  router.get('/api/profile/activity', requireMember, requireDb, route('load activity', async (req, res) => {
    const me = req.account.id;
    const limit = 100;
    const [uploaded, asked, fulfilled, counts, workers, webJobs] = await Promise.all([
      // Songs I uploaded: with any token of mine, so via my workers too.
      db.query(
        `SELECT id, title, artist, youtube_id, created_at, uploaded_by_worker AS worker, requested_by
         FROM library_songs WHERE uploaded_by_user_id = $1 ORDER BY created_at DESC LIMIT $2`, [me, limit]),
      // Songs I asked for (song requests), whether fulfilled, by whose worker.
      db.query(
        `SELECT r.id, r.title, r.artist, r.youtube_id, r.status, r.created_at, r.updated_at,
                s.id AS song_id, s.title AS song_title, s.artist AS song_artist,
                s.uploaded_by AS fulfilled_by, s.uploaded_by_worker AS fulfilled_worker
         FROM song_requests r LEFT JOIN library_songs s ON s.id = r.song_id
         WHERE r.requested_by_id = $1 ORDER BY r.created_at DESC LIMIT $2`, [me, limit]),
      // Requests my workers fulfilled, and who asked.
      db.query(
        `SELECT s.id, s.title, s.artist, s.youtube_id, s.created_at, s.uploaded_by_worker AS worker, s.requested_by
         FROM library_songs s JOIN download_workers w ON w.id = s.uploaded_by_worker_id
         WHERE w.user_id = $1 AND s.requested_by_user_id IS NOT NULL
         ORDER BY s.created_at DESC LIMIT $2`, [me, limit]),
      db.query(
        `SELECT
           (SELECT count(*)::int FROM library_songs WHERE uploaded_by_user_id = $1::uuid) AS uploaded,
           (SELECT count(*)::int FROM library_songs WHERE uploaded_by_user_id = $1::uuid AND uploaded_by_worker_id IS NOT NULL) AS uploaded_by_workers,
           (SELECT count(*)::int FROM song_requests WHERE requested_by_id = $1::text) AS asked,
           (SELECT count(*)::int FROM song_requests WHERE requested_by_id = $1::text AND status = 'fulfilled') AS asked_fulfilled,
           (SELECT count(*)::int FROM download_jobs WHERE requested_by_user_id = $1::uuid AND source = 'web') AS downloads,
           (SELECT count(*)::int FROM library_songs s JOIN download_workers w ON w.id = s.uploaded_by_worker_id
              WHERE w.user_id = $1::uuid AND s.requested_by_user_id IS NOT NULL) AS fulfilled_by_my_workers`, [me]),
      jobs.listUserWorkers(me),
      jobs.listForUser(me, { limit }),
    ]);
    res.json({
      counts: counts.rows[0],
      uploaded: uploaded.rows,
      asked: asked.rows.map((r) => ({
        id: r.id, title: r.title, artist: r.artist, youtube_id: r.youtube_id, status: r.status, created_at: r.created_at,
        song: r.song_id ? { id: r.song_id, title: r.song_title, artist: r.song_artist } : null,
        fulfilled_by: r.song_id ? { name: r.fulfilled_by || null, worker: r.fulfilled_worker || null } : null,
      })),
      downloads: webJobs.filter((j) => j.source === 'web').map(jobs.toPublic),
      fulfilled_by_my_workers: fulfilled.rows,
      // Own workers: name and state only (machine details are admin-only).
      workers: workers.map((w) => {
        const v = jobs.publicWorkerView(w, hub.live(w.id));
        return { ...v, jobs_done: w.jobs_done || 0, jobs_failed: w.jobs_failed || 0, last_connected_at: w.last_connected_at || null };
      }),
    });
  }));

  // --- Admin --------------------------------------------------------------
  router.get('/api/admin/workers', adminAuth.requireAdmin, requireDb, route('list workers', async (req, res) => {
    const rows = await jobs.listWorkers();
    res.json({ workers: rows.map((w) => jobs.adminWorkerView(w, hub.live(w.id))), ...workerCounts() });
  }));

  router.get('/api/admin/jobs', adminAuth.requireAdmin, requireDb, route('list jobs', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    if (status !== 'all' && status !== 'active' && !jobs.STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be all, active, queued, assigned, done, failed or cancelled' });
    }
    const [rows, counts] = await Promise.all([jobs.listAll({ status, limit: 200 }), jobs.countByStatus()]);
    res.json({ jobs: rows.map(jobs.toAdmin), counts, workers: workerCounts() });
  }));

  router.post('/api/admin/jobs/:id/cancel', adminAuth.requireAdmin, requireDb, route('cancel job', async (req, res) => {
    const row = await jobs.cancel(req.params.id);
    if (!row) return res.status(409).json({ error: 'Only a waiting job can be cancelled', code: 'NOT_CANCELLABLE' });
    onJobUpdated(row);
    res.json({ job: jobs.toAdmin(row) });
  }));

  router.post('/api/admin/jobs/:id/retry', adminAuth.requireAdmin, requireDb, route('retry job', async (req, res) => {
    const row = await jobs.retry(req.params.id);
    if (!row) return res.status(409).json({ error: 'Only a failed or cancelled job can be retried', code: 'NOT_RETRYABLE' });
    onJobUpdated(row);
    hub.dispatch();
    res.json({ job: jobs.toAdmin(row) });
  }));

  return router;
}

module.exports = { createJobRouter };
