/**
 * HTTP API for download jobs, downloaders (workers) and the profile activity:
 *
 *   GET  /api/workers                  online downloaders: name, owner, busy (approved users)
 *   GET  /api/jobs                     the caller's jobs, newest first, + worker counts
 *   POST /api/jobs                     { input, playlist_id? } the web "Download" box;
 *                                      { picks: [youtube id], playlist_id? } exactly these videos
 *                                      (answer: jobs, existing, and failed ids if it stopped part way)
 *   POST /api/jobs/picks               { input, match_library? } | { query } what the pick dialog shows
 *   POST /api/jobs/replace             { song_id, input, title?, artist?, album? } replace a song from a video
 *   POST /api/jobs/replace/preview     { song_id, input } what that would do (title, duration, refusal)
 *   GET  /api/jobs/replace/:songId     the caller's job for the song; whether anyone's is active
 *   POST /api/jobs/:id/cancel          a queued job of the caller
 *   POST /api/jobs/:id/retry           a failed / cancelled job of the caller
 *   GET  /api/profile/activity         the caller's own uploads / asks / fulfilments
 *   GET  /api/activity/downloads       everyone's download jobs, reduced (the activity log; approved users)
 *   GET  /api/admin/workers            every worker with IP, OS, versions, cli_outdated (admin)
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
const ytdlp = require('./ytdlp');
const { apiLimiter, make } = require('./rateLimits');
const { isOutdated } = require('./cliRelease');
const { cleanPicks, MAX_PICKS } = require('./picker');

// Each preview may run yt-dlp once on the server; results are kept a while.
const previewLimiter = make(30, 60 * 1000, { message: 'Too many link lookups, slow down' });
const PREVIEW_CACHE_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_SIZE = 200;
// The pick dialog: a search or a playlist listing each (picker.js keeps answers a while).
const pickLimiter = make(30, 60 * 1000, { message: 'Too many searches, slow down' });

/** "Differs a lot": more than 15 seconds and more than 10% of the current length. */
function durationDiffers(current, next) {
  if (!(current > 0) || !(next > 0)) return false;
  return Math.abs(current - next) > Math.max(15, current * 0.1);
}

/**
 * @param {object} hooks
 * @param {Function} hooks.requireUser - approved account; sets req.account { id, name }
 * @param {Function} hooks.requireMember - any non-blocked account; sets req.account
 * @param {object} hooks.hub - workerHub (stats, live, onlineWorkers, dispatch)
 * @param {(playlistId, userId) => Promise<object|null>} hooks.editablePlaylist
 * @param {(url) => Promise<{title, artist}>} hooks.spotifyTrack
 * @param {(playlistId, song, addedBy) => Promise<boolean>} hooks.addSongToPlaylist - true if added now
 * @param {(playlistId, userId) => Promise<object|null>} hooks.visiblePlaylist - the playlist if this user can see it
 * @param {(job) => void} [hooks.onJobUpdated]
 * @param {(videoId) => Promise<{title, channel, duration_sec}|null>} [hooks.previewVideo]
 * @param {object} hooks.picker - picker.js (lookup, search, titles)
 */
function createJobRouter(hooks) {
  const { requireUser, requireMember, hub } = hooks;
  const cliLatest = hooks.cliLatest || (() => null);
  const onJobUpdated = hooks.onJobUpdated || (() => {});
  const router = express.Router();
  router.use(['/api/workers', '/api/jobs', '/api/profile/activity', '/api/activity', '/api/admin/workers', '/api/admin/jobs'], apiLimiter);

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
  const previewVideo = hooks.previewVideo || ytdlp.previewVideo;
  const previews = new Map(); // video id -> { at, value }

  async function cachedPreview(id) {
    const hit = previews.get(id);
    if (hit && Date.now() - hit.at < PREVIEW_CACHE_MS) return hit.value;
    const value = await previewVideo(id).catch(() => null);
    if (previews.size >= PREVIEW_CACHE_SIZE) previews.delete(previews.keys().next().value);
    // A failed lookup may be momentary: only an answer is kept.
    if (value) previews.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * Can this link replace this song? Every rule of a link replace, for the
   * preview and the real thing: { song, youtubeId } or { status, error, code, song? }.
   */
  async function checkReplace(songId, input) {
    const song = library.isUuid(songId) ? await library.getById(songId) : null;
    if (!song) return { status: 404, error: 'Song not found', code: 'not_found' };
    const what = jobs.classifyInput(input);
    if (what.error || what.kind !== 'video') {
      return { status: 400, error: 'Paste a link to a YouTube video', code: 'BAD_INPUT' };
    }
    if (what.youtubeId === song.youtube_id) {
      return { status: 409, error: 'That is the video this song already uses, so there is nothing to replace', code: 'same_video' };
    }
    const other = await library.getByYoutubeId(what.youtubeId);
    if (other && other.id !== song.id) {
      return {
        status: 409,
        error: `This video is already in the library as “${other.title}”${other.artist ? ` by ${other.artist}` : ''}`,
        code: 'already_in_library',
        song: library.toPublic(other),
      };
    }
    if (await jobs.activeReplaceJob(song.id)) {
      return { status: 409, error: 'A replacement is already in progress for this song', code: 'replace_job_active' };
    }
    return { song, youtubeId: what.youtubeId };
  }
  const refuse = (res, c) => res.status(c.status).json({ error: c.error, code: c.code, ...(c.song ? { song: c.song } : {}) });

  router.get('/api/workers', requireUser, (req, res) => {
    res.json({ workers: hub.onlineWorkers(), ...workerCounts() });
  });

  router.get('/api/jobs', requireUser, requireDb, route('list jobs', async (req, res) => {
    const rows = await jobs.listForUser(req.account.id, { limit: 50 });
    res.json({ jobs: rows.map(jobs.toPublic), workers: workerCounts() });
  }));

  // What the pick dialog shows before anything is queued (picker.js for the
  // shapes). `query` is always a search (a playlist item's alternatives);
  // `input` is read like the Download box does. Nothing is created here.
  router.post('/api/jobs/picks', requireUser, requireDb, pickLimiter, express.json(), route('look that up', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      res.json(body.query !== undefined
        ? await hooks.picker.search(body.query)
        : await hooks.picker.lookup(body.input, { matchLibrary: body.match_library === true }));
    } catch (err) {
      if (!err.status) throw err;
      res.status(err.status).json({ error: err.message, code: err.code });
    }
  }));

  router.post('/api/jobs', requireUser, requireDb, express.json(), route('create job', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Chosen in the pick dialog: these videos, no search by the downloader.
    const picks = body.picks === undefined ? null : cleanPicks(body.picks);
    if (body.picks !== undefined && !picks) {
      return res.status(400).json({ error: `picks must be 1 to ${MAX_PICKS} YouTube video ids`, code: 'BAD_INPUT' });
    }
    const what = picks ? null : jobs.classifyInput(body.input);
    if (what && what.error) return res.status(400).json({ error: what.error, code: 'BAD_INPUT' });

    let playlist = null;
    if (body.playlist_id !== undefined && body.playlist_id !== null && body.playlist_id !== '') {
      playlist = await hooks.editablePlaylist(String(body.playlist_id), req.account.id);
      if (!playlist) return res.status(404).json({ error: 'Playlist not found', code: 'PLAYLIST_NOT_FOUND' });
    }
    const requester = req.account.name || 'Someone';

    if (picks) {
      // One video job each (any worker runs those); what the library has is
      // added to the playlist right away. Titles are the server's own.
      const have = await library.getByYoutubeIds(picks);
      const titles = await hooks.picker.titles(picks.filter((id) => !have.has(id)));
      const created = [];
      const existing = [];
      const handled = new Set();
      let added = 0;
      let failure = null;
      try {
        for (const id of picks) {
          const song = have.get(id);
          if (song) {
            if (playlist && await hooks.addSongToPlaylist(playlist.id, song, requester)) added++;
            existing.push(library.toPublic(song));
          } else {
            const row = await jobs.createJob({
              source: 'web',
              kind: 'video',
              input: library.youtubeUrl(id),
              title: titles.get(id) || null,
              playlistId: playlist ? playlist.id : null,
              requestedByUserId: req.account.id,
              requestedBy: requester,
            });
            created.push(row);
            onJobUpdated(row);
          }
          handled.add(id);
        }
      } catch (err) {
        failure = err;
        console.error('[jobs] picked videos: stopped part way:', err);
      } finally {
        // Whatever was queued runs, also when a later one failed.
        if (created.length) hub.dispatch();
      }
      console.log(`[jobs] ${requester} queued ${created.length} picked video job(s), ${existing.length} already in the library${playlist ? ` -> playlist ${playlist.id}` : ''}`);
      if (failure && !handled.size) return res.status(500).json({ error: 'Failed to create job' });
      // Part of it worked: say what, so that the rest (failed) can be retried
      // without queuing the others twice.
      const failed = picks.filter((id) => !handled.has(id));
      return res.status(created.length ? 201 : 200).json({
        jobs: created.map(jobs.toPublic), existing, added_to_playlist: added, playlist_id: playlist ? playlist.id : null, workers: workerCounts(),
        ...(failed.length ? { failed, error: `${failed.length} of ${picks.length} could not be queued` } : {}),
      });
    }

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

  // --- Replace a song from a video (the song dialog) ----------------------
  router.post('/api/jobs/replace/preview', requireUser, requireDb, previewLimiter, express.json(), route('look up the link', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const c = await checkReplace(body.song_id, body.input);
    if (c.status === 404) return refuse(res, c);
    if (c.status) return res.json({ resolved: false, problem: { code: c.code, message: c.error, song: c.song || null } });
    const found = await cachedPreview(c.youtubeId);
    const current = c.song.duration_sec === null ? null : Number(c.song.duration_sec);
    res.json({
      youtube_id: c.youtubeId,
      resolved: !!found,
      title: found ? found.title : null,
      channel: found ? found.channel : null,
      duration_sec: found ? found.duration_sec : null,
      current_duration_sec: current,
      duration_differs: !!found && durationDiffers(current, found.duration_sec),
      problem: null,
    });
  }));

  router.post('/api/jobs/replace', requireUser, requireDb, express.json(), route('replace the song', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const c = await checkReplace(body.song_id, body.input);
    if (c.status) return refuse(res, c);
    const title = body.title === undefined ? c.song.title : library.cleanText(body.title, 300);
    const artist = body.artist === undefined ? c.song.artist : library.cleanText(body.artist, 300);
    const album = body.album === undefined ? (c.song.album || null) : (library.cleanText(body.album, 300) || null);
    if (!title || !artist) return res.status(400).json({ error: 'Title and artist are required', code: 'bad_details' });
    let row;
    try {
      row = await jobs.createReplaceJob({
        song: c.song, youtubeId: c.youtubeId, title, artist, album,
        requestedByUserId: req.account.id, requestedBy: req.account.name || 'Someone',
      });
    } catch (err) {
      if (err.code !== '23505') throw err;
      return res.status(409).json({ error: 'A replacement is already in progress for this song', code: 'replace_job_active' });
    }
    console.log(`[jobs] ${row.requested_by} queued replace job ${row.id}: song ${c.song.id} from ${c.youtubeId}`);
    onJobUpdated(row);
    hub.dispatch();
    res.status(201).json({ job: jobs.toPublic(row), workers: workerCounts() });
  }));

  // The job itself is the requester's only; anyone may learn that one is running.
  router.get('/api/jobs/replace/:songId', requireUser, requireDb, route('load the replace job', async (req, res) => {
    const [active, mine] = await Promise.all([jobs.activeReplaceJob(req.params.songId), jobs.latestReplaceJob(req.params.songId, req.account.id)]);
    res.json({ active: !!active, job: mine ? jobs.toPublic(mine) : null, workers: workerCounts() });
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
    // One page of every list (the page reads the tab it shows).
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [uploaded, asked, fulfilled, counts, workers, webJobs] = await Promise.all([
      // Songs I uploaded: with any token of mine, so via my workers too.
      db.query(
        `SELECT id, title, artist, youtube_id, created_at, uploaded_by_worker AS worker, requested_by
         FROM library_songs WHERE uploaded_by_user_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [me, limit, offset]),
      // Songs I asked for (song requests), whether fulfilled, by whose worker.
      db.query(
        `SELECT r.id, r.title, r.artist, r.youtube_id, r.status, r.created_at, r.updated_at,
                s.id AS song_id, s.title AS song_title, s.artist AS song_artist,
                s.uploaded_by AS fulfilled_by, s.uploaded_by_worker AS fulfilled_worker
         FROM song_requests r LEFT JOIN library_songs s ON s.id = r.song_id
         WHERE r.requested_by_id = $1 ORDER BY r.created_at DESC LIMIT $2`, [me, offset + limit]),
      // Requests my workers fulfilled, and who asked.
      db.query(
        `SELECT s.id, s.title, s.artist, s.youtube_id, s.created_at, s.uploaded_by_worker AS worker, s.requested_by
         FROM library_songs s JOIN download_workers w ON w.id = s.uploaded_by_worker_id
         WHERE w.user_id = $1 AND s.requested_by_user_id IS NOT NULL
         ORDER BY s.created_at DESC, s.id LIMIT $2 OFFSET $3`, [me, limit, offset]),
      db.query(
        `SELECT
           (SELECT count(*)::int FROM library_songs WHERE uploaded_by_user_id = $1::uuid) AS uploaded,
           (SELECT count(*)::int FROM library_songs WHERE uploaded_by_user_id = $1::uuid AND uploaded_by_worker_id IS NOT NULL) AS uploaded_by_workers,
           (SELECT count(*)::int FROM song_requests WHERE requested_by_id = $1::text) AS asked,
           (SELECT count(*)::int FROM song_requests WHERE requested_by_id = $1::text AND status = 'fulfilled') AS asked_fulfilled,
           (SELECT count(*)::int FROM download_jobs WHERE requested_by_user_id = $1::uuid AND source IN ('web', 'replace')) AS downloads,
           (SELECT count(*)::int FROM library_songs s JOIN download_workers w ON w.id = s.uploaded_by_worker_id
              WHERE w.user_id = $1::uuid AND s.requested_by_user_id IS NOT NULL) AS fulfilled_by_my_workers`, [me]),
      jobs.listUserWorkers(me),
      jobs.listForUser(me, { limit: offset + limit, sources: ['web', 'replace'] }),
    ]);
    // The asked tab merges song requests and web downloads: page the merged list.
    const askedPage = [
      ...asked.rows.map((row) => ({ at: row.created_at, row })),
      ...webJobs.map((job) => ({ at: job.created_at, job })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(offset, offset + limit);
    res.json({
      counts: counts.rows[0],
      uploaded: uploaded.rows,
      asked: askedPage.filter((x) => x.row).map((x) => x.row).map((r) => ({
        id: r.id, title: r.title, artist: r.artist, youtube_id: r.youtube_id, status: r.status, created_at: r.created_at,
        song: r.song_id ? { id: r.song_id, title: r.song_title, artist: r.song_artist } : null,
        fulfilled_by: r.song_id ? { name: r.fulfilled_by || null, worker: r.fulfilled_worker || null } : null,
      })),
      downloads: askedPage.filter((x) => x.job).map((x) => jobs.toPublic(x.job)),
      fulfilled_by_my_workers: fulfilled.rows,
      // Own workers: name and state only (machine details are admin-only).
      workers: workers.map((w) => {
        const v = jobs.publicWorkerView(w, hub.live(w.id));
        return { ...v, jobs_done: w.jobs_done || 0, jobs_failed: w.jobs_failed || 0, last_connected_at: w.last_connected_at || null };
      }),
    });
  }));

  // --- The activity log: every download job, for every approved account ------
  // Reduced rows (jobs.toActivity). A job's playlist is looked up now, for this
  // viewer: one they cannot see (private, not theirs) is simply not on the row.
  // Without a database there are no jobs: an empty log.
  router.get('/api/activity/downloads', requireUser, route('load the activity', async (req, res) => {
    if (!db.isAvailable()) return res.json({ jobs: [], workers: workerCounts() });
    const rows = await jobs.listActivity();
    const seen = new Map();
    for (const id of new Set(rows.map((r) => r.playlist_id).filter(Boolean))) {
      seen.set(id, await hooks.visiblePlaylist(id, req.account.id));
    }
    res.json({ jobs: rows.map((r) => jobs.toActivity(r, seen.get(r.playlist_id) || null)), workers: workerCounts() });
  }));

  // --- Admin --------------------------------------------------------------
  router.get('/api/admin/workers', adminAuth.requireAdmin, requireDb, route('list workers', async (req, res) => {
    const rows = await jobs.listWorkers();
    // The la version this server offers: workers below it are flagged (and
    // update themselves from la 0.4.0 on).
    const latest = cliLatest();
    const cliLatestVersion = latest ? latest.version : null;
    res.json({
      workers: rows.map((w) => ({ ...jobs.adminWorkerView(w, hub.live(w.id)), cli_outdated: !!cliLatestVersion && isOutdated(w.cli_version, cliLatestVersion) })),
      cli_latest: cliLatestVersion,
      ...workerCounts(),
    });
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

module.exports = { createJobRouter, durationDiffers };
