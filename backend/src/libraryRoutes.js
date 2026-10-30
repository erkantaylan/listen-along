/**
 * HTTP API for the music library, song requests, the admin page (incl. the
 * list of all CLI tokens). Mounted by index.js; also mounted standalone in tests.
 *
 * CLI endpoints authenticate with `Authorization: Bearer <token>`. Read-only
 * endpoints (library list/song/file, requests list) take a Bearer token (CLI,
 * Android app), the admin cookie (admin page) or a logged-in approved web user
 * (hooks.requireWebUser); a token that IS sent must be valid. Without a
 * requireWebUser hook (standalone mounts in tests) web users get 401.
 */

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const library = require('./library');
const requests = require('./requests');
const tokens = require('./tokens');
const adminAuth = require('./adminAuth');
const { apiLimiter } = require('./rateLimits');

function parseIntParam(value, def, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function requireDb(req, res, next) {
  if (!db.isAvailable()) return res.status(503).json({ error: 'Database not available' });
  next();
}

// Safe ASCII filename for Content-Disposition.
function downloadFilename(song) {
  const ext = song.mime_type === 'audio/mpeg' ? '.mp3' : path.extname(song.file_path) || '.m4a';
  const base = `${song.artist && song.artist !== 'Unknown' ? song.artist + ' - ' : ''}${song.title || 'audio'}`
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[/\\?%*:|"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return (base || 'audio') + ext;
}

/**
 * Stream a library song's file with Range support (express sendFile handles
 * Range / 206 / 416 itself).
 */
function sendSongFile(req, res, song, { download = false } = {}) {
  const headers = {
    'Content-Type': song.mime_type || library.mimeForPath(song.file_path),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${downloadFilename(song)}"`;
  res.sendFile(path.resolve(song.file_path), { headers, acceptRanges: true, dotfiles: 'allow' }, (err) => {
    if (!err || res.headersSent) return;
    // send() may already have applied the audio headers (it does for a 416):
    // drop them so the JSON error is not labelled audio/* or cached forever.
    for (const name of ['Content-Type', 'Cache-Control', 'Content-Disposition', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      res.removeHeader(name);
    }
    if (err.status === 416) {
      // Range not satisfiable; send() leaves "Content-Range: bytes */<size>".
      return res.status(416).json({ error: 'Requested range not satisfiable' });
    }
    if (err.status === 404 || err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Audio file missing on server' });
    }
    console.error('[library] sendFile error:', err.message);
    res.status(500).json({ error: 'Failed to read audio file' });
  });
}

/**
 * @param {object} hooks
 * @param {(song: object, fulfilled: object[]) => void} [hooks.onSongAdded] - after an upload is stored
 * @param {() => void} [hooks.onRequestsChanged] - after a request is fulfilled/dismissed
 * @param {(song: object) => void} [hooks.onSongRemoved] - after an admin deletes a song
 * @param {Function} [hooks.loginRateLimit] - middleware for POST /api/admin/login
 * @param {Function} [hooks.requireWebUser] - middleware: is the caller a web user allowed to read?
 */
function createLibraryRouter(hooks = {}) {
  const onSongAdded = hooks.onSongAdded || (() => {});
  const onRequestsChanged = hooks.onRequestsChanged || (() => {});
  const onSongRemoved = hooks.onSongRemoved || (() => {});
  const loginRateLimit = hooks.loginRateLimit || ((req, res, next) => next());
  const requireWebUser = hooks.requireWebUser
    || ((req, res) => res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }));

  // Reads: a Bearer token (must be valid), else the admin cookie, else a
  // logged-in approved web user.
  const readAccess = (req, res, next) => {
    if (tokens.hasBearer(req)) return tokens.requireToken(req, res, next);
    if (adminAuth.isAdmin(req)) return next();
    return requireWebUser(req, res, next);
  };

  const router = express.Router();
  router.use(apiLimiter);
  router.use(express.json());

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try { library.ensureDirs(); cb(null, library.UPLOAD_TMP_DIR); } catch (err) { cb(err); }
      },
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.part`),
    }),
    limits: { fileSize: library.MAX_UPLOAD_BYTES, files: 1, fields: 20, fieldSize: 16 * 1024 },
  });

  const uploadSingle = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large (max ${library.MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
      }
      if (err instanceof multer.MulterError) return res.status(400).json({ error: `Bad upload: ${err.message}` });
      return res.status(400).json({ error: `Bad upload: ${err.message}` });
    });
  };

  // --- CLI identity -------------------------------------------------------
  // name: who uploads are credited to (the owner's display name, or a legacy
  // token's name). user: the owning account, null for a legacy token.
  router.get('/api/me', tokens.requireToken, (req, res) => {
    const { name, label, user } = req.apiUser;
    res.json({ name, user, token: { label, legacy: !user } });
  });

  // --- Library ------------------------------------------------------------
  router.get('/api/library', readAccess, requireDb, async (req, res) => {
    try {
      const youtubeId = req.query.youtube_id ? library.parseYoutubeId(String(req.query.youtube_id)) : null;
      if (req.query.youtube_id && !youtubeId) return res.status(400).json({ error: 'Invalid youtube_id' });
      const result = await library.list({
        q: typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '',
        limit: parseIntParam(req.query.limit, 100, 1, 1000),
        offset: parseIntParam(req.query.offset, 0, 0, 1e9),
        youtubeId,
        sort: typeof req.query.sort === 'string' ? req.query.sort : 'recent',
      });
      res.json(result);
    } catch (err) {
      console.error('[library] list error:', err.message);
      res.status(500).json({ error: 'Failed to list library' });
    }
  });

  router.post('/api/library/upload', tokens.requireToken, uploadSingle, async (req, res) => {
    const cleanupTmp = () => { if (req.file) library.removeUploadTmp(req.file); };
    let fields;
    try {
      library.validateUploadFileMeta(req.file);
      fields = library.validateUploadFields(req.body);
    } catch (err) {
      cleanupTmp();
      return res.status(err.status || 400).json({ error: err.message });
    }

    try {
      const row = await library.ingestUpload(req.file, fields, req.apiUser);
      const song = library.toPublic(row);
      const fulfilled = await requests.fulfillRequests(row, fields.request_id);
      console.log(`[library] ${req.apiUser.name} uploaded "${row.title}" by ${row.artist} (${row.id}); fulfilled ${fulfilled.length} request(s)`);
      try { onSongAdded(row, fulfilled); } catch (err) { console.error('[library] onSongAdded hook failed:', err); }
      if (fulfilled.length) onRequestsChanged();
      res.status(201).json({ song, fulfilled_requests: fulfilled.map((r) => r.id) });
    } catch (err) {
      if (err instanceof library.UploadError) {
        if (err.status === 409 && err.song) {
          // The song already exists — any matching pending request is satisfied by it.
          const fulfilled = await requests.fulfillRequests(err.song, fields.request_id, fields.youtube_id).catch(() => []);
          if (fulfilled.length) {
            try { onSongAdded(err.song, fulfilled); } catch {}
            onRequestsChanged();
          }
          return res.status(409).json({ error: err.message, song: library.toPublic(err.song) });
        }
        return res.status(err.status).json({ error: err.message });
      }
      console.error('[library] upload error:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  router.get('/api/library/:id', readAccess, requireDb, async (req, res) => {
    const song = await library.getById(req.params.id).catch(() => null);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    res.json({ song: library.toPublic(song) });
  });

  router.get('/api/library/:id/file', readAccess, requireDb, async (req, res) => {
    const song = await library.getById(req.params.id).catch(() => null);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    sendSongFile(req, res, song, { download: req.query.dl === '1' || req.query.dl === 'true' });
  });

  // --- Requests -----------------------------------------------------------
  router.get('/api/requests', readAccess, requireDb, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    if (status !== 'all' && !requests.STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status must be pending, fulfilled, dismissed or all' });
    }
    try {
      // Which playlist a request came from is only shown to CLI tokens and
      // admins: a web user must not learn the id of someone's private playlist.
      const reveal = !!req.apiUser || adminAuth.isAdmin(req);
      const list = await requests.listRequests({ status });
      res.json({ requests: reveal ? list : list.map(({ lobby_id, ...rest }) => rest) });
    } catch (err) {
      console.error('[requests] list error:', err.message);
      res.status(500).json({ error: 'Failed to list requests' });
    }
  });

  // Dismiss: a CLI token or a logged-in admin.
  const tokenOrAdmin = (req, res, next) => {
    if (!tokens.hasBearer(req) && adminAuth.isAdmin(req)) return next();
    return tokens.requireToken(req, res, next);
  };
  router.post('/api/requests/:id/dismiss', tokenOrAdmin, requireDb, async (req, res) => {
    const request = await requests.dismissRequest(req.params.id).catch(() => null);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    console.log(`[requests] dismissed ${request.id} (${request.title || request.youtube_id}) by ${req.apiUser ? req.apiUser.name : 'admin'}`);
    onRequestsChanged();
    res.json({ request });
  });

  // --- Admin --------------------------------------------------------------
  router.get('/api/admin/status', (req, res) => {
    res.json({ enabled: adminAuth.isEnabled(), authenticated: adminAuth.isAdmin(req) });
  });

  router.post('/api/admin/login', loginRateLimit, (req, res) => {
    if (!adminAuth.isEnabled()) return res.status(404).json({ error: 'Admin is disabled (ADMIN_PASSWORD not set)' });
    const body = req.body || {};
    if (!adminAuth.checkCredentials(body.username, body.password)) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    adminAuth.setSessionCookie(res);
    res.json({ ok: true });
  });

  router.post('/api/admin/logout', (req, res) => {
    adminAuth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/api/admin/tokens', adminAuth.requireAdmin, requireDb, async (req, res) => {
    res.json({ tokens: await tokens.listTokens() });
  });

  // Tokens are created by their owners on the profile page (/api/tokens,
  // tokenRoutes.js); the admin page only lists and revokes them.

  router.post('/api/admin/tokens/:id/revoke', adminAuth.requireAdmin, requireDb, async (req, res) => {
    if (!library.isUuid(req.params.id)) return res.status(404).json({ error: 'Token not found' });
    const record = await tokens.revokeToken(req.params.id);
    if (!record) return res.status(404).json({ error: 'Token not found' });
    console.log(`[admin] revoked token ${record.prefix}… ("${record.label}", owner ${record.owner ? record.owner.name || record.owner.id : 'legacy'})`);
    res.json({ record });
  });

  router.delete('/api/admin/library/:id', adminAuth.requireAdmin, requireDb, async (req, res) => {
    const song = await library.remove(req.params.id).catch(() => null);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    console.log(`[admin] deleted library song ${song.id} ("${song.title}")`);
    try { onSongRemoved(song); } catch {}
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createLibraryRouter, sendSongFile, downloadFilename };
