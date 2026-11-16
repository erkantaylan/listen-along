// The server's composition root: reads the configuration, builds the stores
// and services, builds each area through its create…({ deps }) factory, mounts
// the routers and registers the socket handlers, then starts listening.
// Mount order is semantics in Express: the guard comes first. Rate limits:
// the general one (rateLimits.apiLimiter, one budget per client address)
// counts each request ONCE, where its route is: a route or router lists it
// itself, or a path-scoped app.use(paths, apiLimiter) sits right before the
// router that serves those paths. Nothing counts requests that only pass by.
//
// The order of the imports is the order the modules load in: the logger
// first (timestamp + level on all console output), then .env, then the areas.
import './shared/logger.ts';
import 'dotenv/config';

import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import { requests as songRequests, createResolver, ytdlp, spotify } from './core/requests/index.ts';
import {
  playlist, access, playlistPins, createPlaylistRoutes, createPlaylistFolderRouter, createPlaylistSockets,
} from './core/playlists/index.ts';
import { getQueueAsync, deleteQueue, hasQueue, createQueueSockets } from './core/queue/index.ts';
import db from './shared/db.ts';
import { library, covers, createLibraryRouter, sendSongFile, createMediaRouter, createSilenceScanner, createSilenceRouter } from './core/library/index.ts';

import { apiLimiter, make as makeLimiter } from './shared/rateLimits.ts';
import { createSettings, parseRegistrationsDefault } from './shared/settings.ts';

import { createPicker } from './features/picker/index.ts';

import { createAppRelease } from './features/app-release/index.ts';
import { downloadJobs, createWorkerHub, createJobRouter, createCliRelease, createCliRouter } from './core/jobs/index.ts';
import {
  readOidcConfig, readDevLogin, adminAuth, tokens, createTokenRouter, createUserAuth, createOidcClient, createSessionStore, createOidcSessions,
  createAuthRoutes,
} from './auth/index.ts';
import type { OidcConfig, Account } from './auth/index.ts';
import { chat, createPresence, createSocial } from './features/social/index.ts';
import type { Social } from './features/social/index.ts';
import { createListenAlong, createSourceResolver } from './features/listen-along/index.ts';
import type { ListenAlong } from './features/listen-along/index.ts';

import { createActivityFeed } from './features/activity/index.ts';
import { createStationRouter } from './features/radio/index.ts';
import { createArtistRouter } from './features/artists/index.ts';
import {
  createInfoRouter, createPageRouter, createProfileRouter, createAdminRouter,
  APP_ROOM, userRoom, sessionRoom, createSocketServer, attachSocketHandlers, createReactions, createHttpApp,
} from './app/index.ts';
import { createMemoryRateLimit } from './shared/memoryRateLimit.ts';

// The web's "pick the video" dialog (features/picker): lookups for it, and what they
// said about each video, for the title of a chosen one.
const picker = createPicker();
const resolver = createResolver({ videoTitles: picker.titles });

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

// The admin login's in-memory limit (shared/memoryRateLimit.ts; core/library/libraryRoutes.ts loginRateLimit).
const rateLimit = createMemoryRateLimit();

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Sign-in, fixed at boot. Central login (OIDC, see auth/oidcConfig.ts) is the only
// one in production and is required there. Local development and the tests may
// use the dev sign-in instead (INSECURE_DEV_LOGIN=1, auth/devLogin.ts), which is
// refused unless NODE_ENV is development or test. A missing, half or broken
// configuration, or no sign-in at all, stops the server here, on purpose.
let OIDC: OidcConfig;
let DEV_LOGIN: boolean;
let REGISTRATIONS_DEFAULT_OPEN: boolean;
try {
  DEV_LOGIN = readDevLogin(process.env);
} catch (err) {
  console.error(`[auth] ${(err as Error).message}`);
  process.exit(1);
}
try {
  OIDC = readOidcConfig(process.env);
  // Registrations before an admin has saved the switch (shared/settings.ts).
  REGISTRATIONS_DEFAULT_OPEN = parseRegistrationsDefault(process.env);
} catch (err) {
  console.error(`[oidc] ${(err as Error).message}`);
  process.exit(1);
}
if (!OIDC.enabled && !DEV_LOGIN) {
  console.error('[auth] no sign-in configured: set OIDC_ISSUER, OIDC_CLIENT_ID, BASE_URL (or FRONTEND_URL) and SESSION_SECRET (central login, CENTRAL-LOGIN.md), or for local development only INSECURE_DEV_LOGIN=1 with NODE_ENV=development');
  process.exit(1);
}
if (DEV_LOGIN) console.warn('[auth] INSECURE_DEV_LOGIN is on: anyone can sign in as anyone at /auth/dev/login. Development and tests only.');

// DATABASE_URL set but no pool = an outage: central login then fails closed
// (no in-memory users or sessions; those are for the no-database dev mode).
const DB_EXPECTED = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
const settings = createSettings({ db, dbExpected: DB_EXPECTED, defaults: { registrations_open: REGISTRATIONS_DEFAULT_OPEN } });
const oidcClient = OIDC.enabled ? createOidcClient(OIDC, { secret: SESSION_SECRET }) : null;
const sessionStore = OIDC.enabled ? createSessionStore({ db, secret: SESSION_SECRET, dbExpected: DB_EXPECTED }) : null;
// The store and the client exist whenever OIDC.enabled (just above).
const oidcSessions = OIDC.enabled ? createOidcSessions({
  store: sessionStore!,
  client: oidcClient!,
  cfg: OIDC,
  cookieName: OIDC.sessionCookie,
  // A session ended by a re-check (the IdP refused, expired, unverified too
  // long): its sockets go too.
  onEnded: (idHash) => io.in(sessionRoom(idHash)).disconnectSockets(true),
}) : null;

// Who is calling: the la_session server-side session (central login) or the
// signed la_dev_login cookie (dev sign-in) + the account's status
// (approved / pending / denied). See auth/userAuth.ts for the levels.
const userAuth = createUserAuth({ secret: SESSION_SECRET, db, sessions: oidcSessions, devLogin: DEV_LOGIN });

// Serve static frontend files
// In Docker: /app/src/main.ts -> /app/frontend (../frontend)
// Local dev: FRONTEND_PATH (npm run dev, the AppHost: the checkout's frontend/)
const frontendPath = path.resolve(process.env.FRONTEND_PATH || path.join(import.meta.dirname, '../frontend'));

// CORS configuration (the HTTP API and Socket.IO)
const corsOptions = {
  origin: FRONTEND_URL,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
};

// The Express app and its HTTP server, with what runs before every route:
// client IP, CORS, JSON bodies, the request log, the static files (app/http.ts).
const { app, server, upgradeIpOf } = createHttpApp({ corsOptions, frontendPath });

if (!process.env.SESSION_SECRET) {
  console.log('Warning: SESSION_SECRET not set, using random secret (logins will not survive a restart)');
}

// Socket.IO setup with CORS (app/sockets.ts, which also names the rooms).
const io = createSocketServer({ server, cors: corsOptions });

// Sign-in over HTTP (auth/authRoutes.ts): the guard here, before every route; the
// legacy status checks and the sign-in / sign-out routes further down.
const auth = createAuthRoutes({
  oidc: OIDC, devLogin: DEV_LOGIN, sessionSecret: SESSION_SECRET, dbExpected: DB_EXPECTED, env: process.env, frontendPath,
  db, settings, userAuth, oidcClient, sessionStore, oidcSessions, tokens, apiLimiter, makeLimiter, io, sessionRoom,
});
app.use(auth.guard); // also counts the playlist API against apiLimiter, before any credential is checked

// Health, build info, changelog, the playlist QR code (app/appRoutes.ts). The
// changelog routes count against apiLimiter themselves; /health never does.
app.use(createInfoRouter({ db, ytdlp, frontendPath, apiLimiter }));

// Legacy status checks: POST /api/auth/register, GET /api/auth/status (auth/authRoutes.ts).
app.use(auth.statusRouter);

// The downloads activity log, live (features/activity; fed by emitJob).
const activityFeed = createActivityFeed({
  io,
  room: APP_ROOM,
  userRoom,
  getPlaylist: (id) => playlist.getPlaylistAsync(id),
  progressMs: process.env.ACTIVITY_PROGRESS_MS ? Number(process.env.ACTIVITY_PROGRESS_MS) : undefined,
});

// Cross-area reactions (app/reactions.ts): what happens elsewhere when a job
// changes, a song is added / replaced / edited, a playlist changes or goes
// away, or an account is blocked. Areas get these functions, never each other.
const {
  emitJob, addJobSongsToPlaylist, workersChanged, queueRequestJob, notifyPlaylistsChanged, accountStatusChanged,
  destroyPlaylist, addLibrarySongToPlaylist, emitUnavailableSongs, handleLibrarySongReplaced, handleLibrarySongDetailsChanged,
  handleLibrarySongAdded,
} = createReactions({
  io, db, playlist, getQueueAsync, hasQueue, deleteQueue, library, covers, downloadJobs, playlistPins, userAuth, sessionStore,
  activityFeed, getWorkerHub: () => workerHub, getSocial: () => social, APP_ROOM, userRoom, sessionRoom,
});

// Download workers (`la worker` on users' machines) and their jobs: see
// core/jobs/workerHub.ts (WebSocket, routing), core/jobs/downloadJobs.ts (store), core/jobs/jobRoutes.ts
// (HTTP API). Live job status goes to the requester's sockets (jobs:update),
// worker counts to every approved socket (workers:update), and a reduced
// view of every job to every approved socket (features/activity).
// The la CLI this image ships (cli/): offered to workers in the welcome and
// through /api/cli/latest|bundle so they update themselves (core/jobs/cliRelease.ts).
const cliRelease = createCliRelease();
cliRelease.load();
app.use(createCliRouter({ release: cliRelease, requireToken: tokens.requireToken, limiter: apiLimiter }));
const workerHub = createWorkerHub({
  cliLatest: () => cliRelease.latest(),
  verifyToken: (token) => tokens.verifyToken(token),
  ipOf: upgradeIpOf,
  dbAvailable: () => db.isAvailable(),
  onJobUpdated: emitJob,
  onJobFinished: (job, songIds) => {
    Promise.all(songIds.map((id) => library.getById(id).catch(() => null)))
      .then((songs) => addJobSongsToPlaylist(job, songs))
      .catch((err) => console.error('[jobs] playlist add failed:', (err as Error).message));
  },
  onWorkersChanged: workersChanged,
});
workerHub.attach(server);

// Silence at the start / end of each song (core/library/silence.ts): measured
// after uploads and replaces, and in the background for the rest of the library.
// Off in tests unless asked for (SILENCE_SCAN=on), and anywhere with SILENCE_SCAN=off.
const envMs = (name: string) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : undefined);
const silenceScanner = createSilenceScanner({
  db, songsPath: library.SONGS_PATH, songsFile: (p) => library.songsFile(p),
  enabled: process.env.SILENCE_SCAN ? process.env.SILENCE_SCAN !== 'off' : process.env.NODE_ENV !== 'test',
  startDelayMs: envMs('SILENCE_START_DELAY_MS'), pauseMs: envMs('SILENCE_PAUSE_MS'),
});

// Music library, song requests, CLI tokens and admin API (see core/library/libraryRoutes.ts)
app.use(createLibraryRouter({
  onJobUpload: (job, song) => { addJobSongsToPlaylist(job, [song]).catch(err => console.error('[jobs] playlist add failed:', err.message)); },
  onRequestDismissed: (request) => {
    downloadJobs.cancelForRequest(request.id).then((rows) => rows.forEach(emitJob)).catch(() => {});
  },
  onSongAdded: (song, fulfilled) => { silenceScanner.songAdded(song); handleLibrarySongAdded(song, fulfilled).catch(err => console.error('[library] post-upload handling failed:', err)); },
  onRequestsChanged: () => io.to(APP_ROOM).emit('requests:updated'),
  onSongRemoved: (song) => {
    io.to(APP_ROOM).emit('library:updated', { removed: song.id });
    downloadJobs.failReplaceJobsForSong(song.id).then((rows) => rows.forEach(emitJob)).catch(() => {});
  },
  // Marked / unmarked broken, or reports dismissed: badges everywhere refresh.
  onReportsChanged: (songId) => io.to(APP_ROOM).emit('library:updated', { reports: { id: songId } }),
  onSongReplaced: (song, previous) => { silenceScanner.songReplaced(song); handleLibrarySongReplaced(song, previous).catch(err => console.error('[library] post-replace handling failed:', err)); },
  onSongDetailsChanged: (song, previous) => { handleLibrarySongDetailsChanged(song, previous).catch(err => console.error('[library] post-edit handling failed:', err)); },
  onJobUpdated: emitJob,
  loginRateLimit: rateLimit,
  // Library / requests reads from the web app: an approved account.
  requireWebUser: userAuth.requireLevel('approved')
}));

// Radio stations (features/radio). Approved accounts only, by the guard's default.
// These three areas count against apiLimiter here.
app.use(['/api/stations', '/api/artists', '/api/tokens'], apiLimiter);
app.use(createStationRouter());

// Artists: read-only song lists per library artist (features/artists). Approved accounts only, by the guard's default.
app.use(createArtistRouter());

// The caller's own CLI tokens (profile page). Approved accounts only.
app.use(createTokenRouter({
  requireUser: (req, res, next) => userAuth.requireLevel('approved')(req, res, () => {
    req.account = req._listenAuth!.account as Account; // set by requireLevel, which let it through
    next();
  }),
}));

// Download jobs, workers, profile activity (core/jobs/jobRoutes.ts).
const withAccount = (level: 'approved' | 'member'): RequestHandler => (req, res, next) => userAuth.requireLevel(level)(req, res, () => {
  req.account = req._listenAuth!.account as Account; // set by requireLevel, which let it through
  next();
});
app.use(createJobRouter({
  requireUser: withAccount('approved'),
  requireMember: withAccount('member'),
  hub: workerHub,
  cliLatest: () => cliRelease.latest(),
  editablePlaylist: async (playlistId, userId) => {
    const l = await playlist.getPlaylistAsync(playlistId);
    return access.canEdit(l, userId) ? l! : null;
  },
  spotifyTrack: (url) => spotify.getTrack(url),
  addSongToPlaylist: async (playlistId, song, addedBy, { allowDuplicates = false } = {}) => {
    const entry = await addLibrarySongToPlaylist(playlistId, song, addedBy, { skipIfQueued: !allowDuplicates });
    if (!entry) return false;
    const queue = await getQueueAsync(playlistId);
    io.to(playlistId).emit('queue:update', { lobbyId: playlistId, songs: queue.getSongs() });
    return true;
  },
  visiblePlaylist: async (playlistId, userId) => {
    const l = await playlist.getPlaylistAsync(playlistId);
    return access.canView(l, userId) ? l! : null;
  },
  onJobUpdated: emitJob,
  picker,
}));

// The latest Android release for the /app page (features/app-release).
const appRelease = createAppRelease(process.env.APP_RELEASES_API_URL ? { apiUrl: process.env.APP_RELEASES_API_URL } : {});
// Redirects, SPA views, the Android release, the dashboard shell, "/" (app/appRoutes.ts).
app.use(createPageRouter({ frontendPath, apiLimiter, adminAuth, appRelease }));

// Audio for queue entries and their covers (core/library/mediaRoutes.ts).
app.use(createMediaRouter({ db, library, covers, apiLimiter, sendSongFile }));
// The silence numbers of a queue entry's song, and the scan's progress for admins.
app.use(createSilenceRouter({ db, resolveQueueUrl: (url) => library.resolveQueueUrl(url), apiLimiter, requireAdmin: adminAuth.requireAdmin, scanner: silenceScanner }));

// Playlists over HTTP, songs included (core/playlists/playlistRoutes.ts).
const { router: playlistRouter, ownerNames } = createPlaylistRoutes({
  io, db, playlist, getQueueAsync, library, playlistPins, userAuth, adminAuth, getSocial: () => social, userRoom,
  notifyPlaylistsChanged, destroyPlaylist, addLibrarySongToPlaylist,
});
app.use(playlistRouter);

// The caller's own playlist folders (core/playlists). Approved accounts by the
// guard's default (web session, Android app session; no CLI tokens). A playlist
// counts only while the caller can see it, decided from the in-memory playlists
// (no database lookup, so a hidden one answers exactly like a missing one).
app.use('/api/playlist-folders', apiLimiter);
app.use(createPlaylistFolderRouter({
  userIdFor: (req) => userAuth.userIdFor(req),
  canSee: async (id, userId) => access.canView(playlist.playlists.get(id), userId),
  exists: async (id) => playlist.playlists.has(id),
  notifyUser: (userId) => io.to(userRoom(String(userId))).emit('playlists:changed'),
}));

// Central login / dev sign-in round trips, /api/auth/me, logout, the login
// page and /api/auth/providers (auth/authRoutes.ts). /api/auth/* counts against
// apiLimiter here (the dashboard's /api/auth/users too, on its way to adminRoutes).
app.use('/api/auth', apiLimiter);
app.use(auth.router);

// The caller's own profile (app/profileRoutes.ts). /api/profile/activity was
// answered (and counted) by jobRoutes above, so it never gets here.
app.use('/api/profile', apiLimiter);
app.use(createProfileRouter({ db, userAuth, getSocial: () => social }));

// Dashboard APIs: users, statuses, settings, stats, playlist and chat
// moderation (app/adminRoutes.ts). All behind adminAuth.requireAdmin. The
// settings routes count against apiLimiter themselves.
app.use(['/api/dashboard', '/api/chat'], apiLimiter);
app.use(createAdminRouter({
  db, playlist, getQueueAsync, library, settings, oidc: OIDC, apiLimiter, adminAuth,
  accountStatusChanged, destroyPlaylist, getSocial: () => social,
}));

// Playlist membership and queue socket handlers (core/playlists/playlistSockets.ts,
// core/queue/queueSockets.ts), registered per connection below.
const playlistSockets = createPlaylistSockets({
  io, playlist, getQueueAsync, adminAuth, getSocial: () => social, ownerNames, notifyPlaylistsChanged, emitUnavailableSongs,
});
const queueSockets = createQueueSockets({
  io, db, getQueueAsync, resolver, songRequests, addLibrarySongToPlaylist, queueRequestJob, APP_ROOM,
});

// The handshake, the central-login re-check of open sockets, and every
// connection's handlers (app/sockets.ts).
attachSocketHandlers({
  io, env: process.env, db, userAuth, oidc: OIDC, oidcSessions,
  getSocial: () => social, getListenAlong: () => listenAlong, playlistSockets, queueSockets,
});

// Global chat + presence. Created in start() once we know whether there is a
// database (chat history in Postgres, else in memory like the other modules).
const graceEnv = Number.parseInt(process.env.PRESENCE_GRACE_MS as string, 10);
const presence = createPresence({ graceMs: Number.isFinite(graceEnv) ? graceEnv : 5000 });
let social: Social | null = null;
let listenAlong: ListenAlong | null = null;

// Initialize database and start server
async function start() {
  // Initialize database if DATABASE_URL is set
  const dbAvailable = await db.init();

  // Central login: metadata that cannot work stops the server; an IdP that
  // cannot be reached right now does not (sign-in retries discovery).
  if (OIDC.enabled) {
    try {
      await oidcClient!.bootCheck();
    } catch (err) {
      console.error(`[oidc] ${(err as Error).message}`);
      process.exit(1);
    }
    // Both exist with central login (OIDC.enabled), above.
    const purge = () => sessionStore!.purgeExpired()
      .then((n) => { if (n) console.log(`[oidc] ${n} expired session(s) removed`); })
      .catch((err) => console.error('[oidc] session purge failed:', err.message));
    purge();
    setInterval(purge, 60 * 60 * 1000).unref();
  }

  social = createSocial({
    io,
    db,
    presence,
    store: dbAvailable ? chat.createPgStore(db) : chat.createMemoryStore(),
    getLobby: (id) => playlist.getPlaylist(id),
    isAdmin: (headers) => adminAuth.isAdmin({ headers }),
    listenerCount: (id) => (listenAlong ? listenAlong.graph.followersOf(id).length : 0),
  });

  listenAlong = createListenAlong({
    io,
    presence,
    nameOf: (id) => social!.nameOf(id), // created just above
    isApproved: (id) => userAuth.getAccount(id).then(a => !!a && a.status === 'approved').catch(() => false),
    resolveSource: createSourceResolver(dbAvailable
      ? async (url) => { const song = await library.resolveQueueUrl(url); return song ? song.id : null; }
      : null),
  });

  if (dbAvailable) {
    console.log('Database persistence enabled');

    // Restore lobbies from database into memory so lobby list works after restart
    await playlist.loadPlaylistsFromDB();

    // Download jobs that were running when the server stopped go back in the
    // queue; workers reconnect and pick them up (or reclaim their own).
    await workerHub.start().catch(err => console.error('[workers] start failed:', err.message));

    // Register the legacy yt-dlp cache into the library (idempotent). Runs in
    // the background: hashing a large cache can take a while. Library songs
    // are permanent — there is no age-based cleanup any more.
    try { library.ensureDirs(); } catch (err) { console.error('Could not create songs dir:', (err as Error).message); }
    library.migrateLegacyCache().catch(err => {
      console.error('Legacy cache migration failed:', err.message);
    }).then(() => library.backfillMetaKeys()).catch(err => {
      // Duplicate-detection keys for songs from before they existed (or from
      // an older normalization). Background, batched; retried next boot.
      console.error('Duplicate-key backfill failed:', err.message);
    });
    // Lead-in / tail silence of songs not measured yet: niced, one at a time, after a delay.
    silenceScanner.start().catch(err => console.error('[silence] could not start:', err.message));
  } else {
    console.log('Running in memory-only mode');
  }

  server.listen(PORT, () => {
    // The bound port: PORT=0 (tests) lets the system pick one, and this line says which.
    const { port } = server.address() as AddressInfo;
    console.log(`Server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    ytdlp.availableCached().catch(() => {}); // warm the /health cache
    if (dbAvailable) {
      console.log(`Music library: ${library.SONGS_PATH}`);
    }
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown handling
const shutdown = (signal: string) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  const lastSeenDone = social ? social.flushLastSeen().catch(() => {}) : Promise.resolve();
  presence.close();
  workerHub.close();
  silenceScanner.stop();

  server.close(async () => {
    console.log('HTTP server closed');
    await lastSeenDone;

    io.close(async () => {
      console.log('Socket.IO server closed');

      if (db.isAvailable()) {
        try {
          await db.close();
          console.log('Database connection closed');
        } catch (err) {
          console.error('Error closing database:', (err as Error).message);
        }
      }

      process.exit(0);
    });
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Global crash guards: a stray promise rejection or thrown exception would
// otherwise kill the process and trigger a restart (the main cause of the
// 504s users were seeing). We deliberately log and KEEP THE PROCESS ALIVE.
// Trade-off: after an uncaughtException the process state can be undefined,
// but staying up is the intentional choice here to avoid a restart-storm.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
