// Wire types: the JSON the server (backend/src) sends to the web client, and
// the socket events in both directions. Types only, no runtime code.
//
// Derived from the server code that builds each payload (named above each
// type). Field names are exactly as sent. Timestamps:
//   - ISO string: Postgres TIMESTAMPTZ columns (a pg Date serialises to ISO).
//   - number (ms): Date.now(), or a BIGINT column the server converts itself.
//   - string: a BIGINT column sent raw (node-postgres returns int8 as a string;
//     db.js sets no type parser), e.g. users.created_at on the dashboard.
// For one release after the playlist rename the server also emits every
// playlist:* event under its old name and adds the old id field next to
// `playlistId` (backend/src/shared/legacyWire.ts, for tabs opened before the
// deploy); this client uses only the new names, so neither is typed here.

// ------------------------------------------------------------------ shared

/** users.status. 'rejected' is set by the dashboard, 'denied' by /api/auth/users/:id/status. */
export type AccountStatus = 'approved' | 'pending' | 'denied' | 'rejected';

/** core/playlists/playlist.ts VISIBILITIES */
export type Visibility = 'public' | 'private';

/** Error body of most JSON routes: `{ error, code? }`. */
export interface ApiError {
  error: string;
  code?: string;
}

// ------------------------------------------------------------------ library

// songReports.toView (one open "needs replacement" report)
export interface SongReport {
  id: string;
  reason: string | null;
  auto: boolean;
  /** Reporter's display name (no user id). */
  reported_by: string;
  /** ISO string (TIMESTAMPTZ). */
  created_at: string;
  /** ISO string (TIMESTAMPTZ). */
  updated_at: string;
  mine: boolean;
}

// library.toPublic (+ songReports.attachReports where noted)
export interface LibrarySong {
  /** UUID */
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_sec: number | null;
  source_url: string | null;
  uploaded_by: string;
  uploaded_by_worker: string | null;
  requested_by: string | null;
  /** ISO string (TIMESTAMPTZ). */
  created_at: string;
  /** First 16 hex chars of the file's sha256; changes when the audio is replaced. */
  file_version: string | null;
  /** ISO string (TIMESTAMPTZ), null until the audio was replaced. */
  replaced_at: string | null;
  /** ms of silence at the very start / end of the file; null until the server measured it. Additive. */
  lead_silence_ms?: number | null;
  trail_silence_ms?: number | null;
  /** Open reports. Only on GET /api/library, GET|PATCH /api/library/:id and report answers (attachReports), not on socket payloads. */
  reports?: SongReport[];
  /** reports.length; present together with `reports`. */
  report_count?: number;
}

// libraryRoutes GET /api/library (library.list / library.searchRelevant)
export interface LibraryListResponse {
  songs: LibrarySong[];
  total: number;
}

// GET /api/stream/silence?q=<queue url> (core/library/silenceRoutes.ts): what the player trims (skip silence).
export interface SongSilence {
  lead_silence_ms: number | null;
  trail_silence_ms: number | null;
}

// stations.toStationSong (lean row; also the artist page's rows, artists.js)
export interface StationSong {
  id: string;
  youtube_id: string | null;
  title: string;
  artist: string;
  duration_sec: number | null;
  file_version: string | null;
}

/** artists.js GET /api/artists/:key/songs uses stations.toStationSong: same shape. */
export type ArtistSong = StationSong;

// stations.js summary() — GET /api/stations/:id
export interface Station {
  id: string;
  count: number;
  duration_sec: number;
}

// stations.js songs() — GET /api/stations/:id/songs (each song also has its album, for Radio's search)
export interface StationWithSongs extends Station {
  songs: (StationSong & { album?: string | null })[];
}

// artists.js summaryOf — an item of GET /api/artists
export interface Artist {
  key: string;
  name: string;
  count: number;
  duration_sec: number;
  cover_youtube_id: string | null;
}

// artists.js GET /api/artists
export interface ArtistListResponse {
  count: number;
  artists: Artist[];
}

// artists.js GET /api/artists/:key/songs
export interface ArtistWithSongs extends Artist {
  songs: ArtistSong[];
}

// libraryRoutes POST /api/library/:id/report (201/200 with a report, or 200 not confirmed for auto)
export type SongReportResponse =
  | { report: SongReport; song: LibrarySong }
  // report?: undefined (never sent) so callers can read `data.report` on either answer.
  | { reported: false; code: 'NOT_CONFIRMED'; report?: undefined };

// libraryRoutes PATCH /api/library/:id and GET /api/library/:id
export interface LibrarySongResponse {
  song: LibrarySong;
}

// core/requests/requests.ts rows (SELECT * FROM song_requests); GET /api/requests drops playlist_id for web users
export interface SongRequest {
  id: string;
  youtube_id: string | null;
  url: string | null;
  title: string | null;
  artist: string | null;
  requested_by: string;
  requested_by_id: string | null;
  /** Only for CLI tokens and admins on GET /api/requests; always on socket payloads. */
  playlist_id?: string | null;
  status: 'pending' | 'fulfilled' | 'dismissed';
  song_id: string | null;
  /** ISO string (TIMESTAMPTZ). */
  created_at: string;
  /** ISO string (TIMESTAMPTZ). */
  updated_at: string;
}

// ------------------------------------------------------------------ playlists / queue

// core/queue/queue.ts Queue.addSong / loadFromDB (+ _loadArtists) — an entry of queue:update
export interface QueueEntry {
  /** Queue entry id (UUID), not the library id. */
  id: string;
  /** YouTube watch URL, `library:<uuid>`, or a legacy URL. */
  url: string;
  title: string;
  duration: number;
  addedBy: string;
  thumbnail: string | null;
  /** From the library song; null for entries the library does not match. Absent if the artist lookup failed on load. */
  artistName?: string | null;
  /** ms (Date.now() or parsed BIGINT). */
  addedAt: number;
}

// ------------------------------------------------------------------ player (client side)

// What the player plays (player.ts): a playlist's QueueEntry, or a library
// song made into a track (library.ts libraryTrack, listen-along.ts trackFrom:
// libraryId + url `library:<id>` + src, the file's address). One flat shape
// with the fields either kind may have, as the player and the pages read them.
export interface Track {
  /** Queue entry id (queue entries only). */
  id?: string;
  /** A queue entry's url, or `library:<id>`. */
  url: string;
  /** Where the audio is (library tracks); else /api/stream?q=<url>. */
  src?: string;
  libraryId?: string;
  title: string;
  artist?: string;
  artistName?: string | null;
  youtubeId?: string | null;
  thumbnail: string | null;
  duration?: number;
  addedBy?: string;
  addedAt?: number;
}

// core/playlists/playlist.ts joinPlaylist — a listener of a playlist (getPlaylistUsers)
export interface PlaylistUser {
  socketId: string;
  username: string;
  emoji: string | null;
  /** ms */
  joinedAt: number;
  currentTrack: { title: string; thumbnail: string | null } | null;
}

// core/playlists/playlistRoutes.ts playlistInfo — an item of GET /api/playlists (also PATCH /:id answer)
export interface PlaylistSummary {
  id: string;
  name: string | null;
  visibility: Visibility;
  ownerId: string | null;
  ownerName: string | null;
  isOwner: boolean;
  canManage: boolean;
  canEdit: boolean;
  /** The old shared pin (playlist:pin). */
  pinned: boolean;
  pinnedByMe: boolean;
  /** ms, null when not pinned by the viewer. */
  pinnedAt: number | null;
  userCount: number;
  songCount: number;
  /** ms */
  createdAt: number;
}

// core/playlists/playlistRoutes.ts GET /api/playlists
export interface PlaylistListResponse {
  playlists: PlaylistSummary[];
}

// core/playlists/folders.ts FolderView — the caller's own sidebar folder (GET /api/playlist-folders;
// `folder` of POST / PATCH). playlistIds: only playlists the caller can see now, in filing order.
export interface PlaylistFolder {
  id: string;
  name: string;
  position: number;
  /** ms */
  createdAt: number;
  playlistIds: string[];
}

// core/playlists/folders.ts GET /api/playlist-folders
export interface PlaylistFolderList {
  folders: PlaylistFolder[];
  limits?: { folders: number; nameLength: number };
}

// core/playlists/playlistRoutes.ts POST /api/playlists (201)
export interface PlaylistCreated extends PlaylistSummary {
  link: string;
}

// core/playlists/playlistRoutes.ts GET /api/playlists/:id
export interface PlaylistDetail extends PlaylistSummary {
  users: PlaylistUser[];
}

// core/playlists/playlistRoutes.ts setPlaylistPin — PUT|DELETE /api/playlists/:id/pin
export interface PlaylistPinResponse {
  id: string;
  pinnedByMe: boolean;
  /** ms when pinned; null on unpin. */
  pinnedAt: number | null;
}

// core/playlists/playlistRoutes.ts playlistSongViews — GET /api/playlists/:id/songs, move answer
export interface PlaylistSongView {
  position: number;
  entry_id: string;
  library_id: string | null;
  youtube_id: string | null;
  title: string;
  artist: string | null;
  duration_sec: number | null;
  url: string;
  thumbnail: string | null;
  added_by: string | null;
  added_at: number | null;
  /** null without a database. */
  available: boolean | null;
}

// core/playlists/playlistRoutes.ts GET /api/playlists/:id/songs
export interface PlaylistSongsResponse {
  playlist: PlaylistSummary;
  songs: PlaylistSongView[];
}

// core/playlists/playlistRoutes.ts POST /api/playlists/:id/songs — one result per ref
export type PlaylistAddResult =
  | { input: unknown; status: 'invalid' | 'not_in_library'; code: 'INVALID' | 'NOT_IN_LIBRARY'; error: string }
  | { input: unknown; status: 'already_in_playlist'; song: LibrarySong }
  | { input: unknown; status: 'added'; song: LibrarySong; entry_id: string };

// core/playlists/playlistRoutes.ts POST /api/playlists/:id/songs
export interface PlaylistAddResponse {
  playlist_id: string;
  summary: { total: number; added: number; already_in_playlist: number; not_in_library: number; invalid: number };
  results: PlaylistAddResult[];
  song_count: number;
}

// core/playlists/playlistSockets.ts sendPlaylistState — playlist:joined
export interface PlaylistJoinedPayload {
  playlistId: string;
  viewing: boolean;
  name: string | null;
  pinned: boolean;
  visibility: Visibility;
  ownerId: string | null;
  ownerName: string | null;
  isOwner: boolean;
  canEdit: boolean;
  /** Set when this socket just joined as a member. */
  user: PlaylistUser | null;
  users: PlaylistUser[];
}

/** The playlist state a client keeps from playlist:joined. */
export type PlaylistState = PlaylistJoinedPayload;

// core/playlists/playlistSockets.ts playlist:create handler — playlist:created (no canEdit: the creator owns it)
export interface PlaylistCreatedPayload {
  playlistId: string;
  viewing: boolean;
  name: string | null;
  visibility: Visibility;
  ownerId: string | null;
  ownerName: string | null;
  isOwner: true;
  pinned: boolean;
  user: PlaylistUser | null;
  users: PlaylistUser[];
}

// core/playlists/playlistRoutes.ts broadcastPlaylistUpdated — playlist:updated
export interface PlaylistUpdatedPayload {
  playlistId: string;
  name: string | null;
  visibility: Visibility;
  ownerId: string | null;
  ownerName: string | null;
}

// core/playlists/playlistSockets.ts / core/playlists/playlistRoutes.ts — playlist:renamed (socket rename and HTTP PATCH)
export interface PlaylistRenamedPayload {
  playlistId: string;
  name: string | null;
}

// core/playlists/playlistSockets.ts playlist:pin handler — playlist:pinned
export interface PlaylistPinnedPayload {
  playlistId: string;
  pinned: boolean;
}

// app/reactions.ts destroyPlaylist / core/playlists/playlistRoutes.ts evictNonOwners — playlist:closed
export interface PlaylistClosedPayload {
  playlistId: string;
  message: string;
}

// core/playlists/playlistSockets.ts playlist:join / playlist:view — playlist:not-found (echoes the id the client sent)
export interface PlaylistNotFoundPayload {
  playlistId: string;
}

// core/playlists/playlistSockets.ts — playlist:error (code only from refusePending)
export interface PlaylistErrorPayload {
  message: string;
  code?: 'ACCOUNT_PENDING';
}

// core/playlists/playlistSockets.ts playlist:join handler / handleLeave — playlist:user-joined, playlist:user-left
export interface PlaylistUserChangePayload {
  playlistId: string;
  user: PlaylistUser;
  users: PlaylistUser[];
}

// core/playlists/playlistSockets.ts user:update / listener:now-playing — users:updated
export interface UsersUpdatedPayload {
  playlistId: string;
  users: PlaylistUser[];
}

// core/queue/queueSockets.ts, app/reactions.ts — queue:update
export interface QueueUpdatePayload {
  playlistId: string;
  songs: QueueEntry[];
}

// queue:song-added — the server never sends it (no emit in backend/src);
// app.ts still listens for it (queue.ts handleSongAdded reads these fields).
export interface QueueSongAddedPayload {
  playlistId?: string;
  song: QueueEntry;
}

// core/queue/queueSockets.ts queue:add handler — queue:error
export interface QueueErrorPayload {
  message: string;
  /** Echoes the client's libraryId on "Already in the queue". */
  libraryId?: string;
}

// core/queue/queueSockets.ts queue:add handler — queue:adding
export interface QueueAddingPayload {
  status: string;
}

// core/queue/queueSockets.ts queue:add handler — queue:requested
export interface QueueRequestedPayload {
  request: SongRequest;
  created: boolean;
  message: string;
}

// app/reactions.ts handleLibrarySongAdded — request:fulfilled
export interface RequestFulfilledPayload {
  request: SongRequest;
  song: LibrarySong;
  addedToQueue: boolean;
  message: string;
}

// app/reactions.ts emitUnavailableSongs / handleLibrarySong{Added,Replaced} — download:status
// (the absent field is spelled out as `?: undefined` so the client can read
// `data.percent` / `data.error` on either kind, playback.ts handleDownloadStatus)
export type DownloadStatusPayload =
  | { url: string; status: 'unavailable'; error: string; percent?: undefined }
  | { url: string; status: 'ready'; percent: 100; error?: undefined };

// download:progress — the server never sends it (no emit in backend/src);
// app.ts still listens for it (playback.ts handleDownloadProgress).
export interface DownloadProgressPayload {
  url: string;
  percent: number;
}

// app/reactions.ts library hooks / handleLibrarySong{Added,Replaced,DetailsChanged} — library:updated
export type LibraryUpdatedPayload =
  /** A song was deleted (onSongRemoved). */
  | { removed: string }
  /** Reports changed on a song (onReportsChanged). */
  | { reports: { id: string } }
  /** The audio was replaced under the same id. */
  | { song: LibrarySong; replaced: { id: string; oldUrls: string[]; url: string; file_version: string | null } }
  /** Title / artist / album edited. */
  | { song: LibrarySong; details: { id: string; oldUrls: string[]; url: string } }
  /** A song was uploaded (or an existing one fulfilled requests). */
  | { song: LibrarySong };

// ------------------------------------------------------------------ account

// auth/authRoutes.ts GET /api/auth/me
export interface AuthUser {
  /** users.id (UUID) */
  id: string;
  provider: string;
  email: string | null;
  /** display_name || name */
  name: string | null;
  displayName: string | null;
  emoji: string | null;
  avatarUrl: string | null;
  status: AccountStatus | null;
}

// auth/authRoutes.ts GET /api/auth/me (`user` is never sent with authenticated: false;
// declared `?: undefined` there so `data.user` can be read on either branch)
export type AuthMeResponse =
  | { authenticated: false; user?: undefined }
  | { authenticated: true; user: AuthUser };

// auth/authRoutes.ts sendOwnStatus — GET /api/auth/status, POST /api/auth/register
export interface AuthStatusResponse {
  status: AccountStatus | 'unregistered';
  userId: string | null;
}

// auth/authRoutes.ts GET /api/auth/providers
export interface AuthProvidersResponse {
  central: boolean;
  dev: boolean;
}

// auth/authRoutes.ts POST /api/auth/logout (redirect only with central login)
export interface LogoutResponse {
  success: true;
  redirect?: string;
}

// app/profileRoutes.ts GET /api/profile
export interface Profile {
  id: string;
  displayName: string;
  emoji: string | null;
  email: string | null;
  avatarUrl: string | null;
}

// libraryRoutes GET /api/me (CLI Bearer token only; the web uses /api/auth/me)
export interface Me {
  name: string;
  /** The token's owner; null for a legacy ownerless token. */
  user: { id: string; name: string } | null;
  token: { label: string; legacy: boolean };
  upload_formats: string[];
}

/** The signed-in web user. */
export type User = AuthUser;

// tokens.toPublic — GET /api/tokens (own), GET /api/admin/tokens (all)
export interface ApiToken {
  id: string;
  name: string;
  label: string;
  prefix: string;
  /** ISO string (TIMESTAMPTZ). */
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
  owner: { id: string; name: string | null } | null;
}

// ------------------------------------------------------------------ people / chat / presence

// presence.viewNowPlaying context
export type NowPlayingContext =
  | { type: 'library' }
  | { type: 'radio' }
  | { type: 'artist'; key: string; name: string | null }
  /** Only when the viewer may see the playlist. */
  | { type: 'playlist'; playlistId: string; name: string | null; socketId: string };

// presence.viewNowPlaying
export interface NowPlayingView {
  track: { id: string | null; title: string; artist: string | null; thumbnail: string | null };
  context: NowPlayingContext | null;
  playing: boolean;
  /** Seconds at `updatedAt`. */
  position: number;
  duration: number;
  /** ms, server time of the report. */
  updatedAt: number;
}

// social.js person() — an entry of the people list
export interface PresenceEntry {
  id: string;
  name: string;
  emoji: string | null;
  avatarUrl: string | null;
  pending: boolean;
  online: boolean;
  /** ms, null if never seen. */
  lastSeen: number | null;
  nowPlaying: NowPlayingView | null;
  /** How many listen along with them. */
  listeners: number;
}

/** social.js people:presence / people:user: person() with nowPlaying set to undefined (dropped by JSON). */
export type PresenceUpdate = Omit<PresenceEntry, 'nowPlaying'>;

// chat.js rowToMessage / createMemoryStore add
export interface ChatMessage {
  id: number;
  userId: string | null;
  authorName: string;
  authorEmoji: string | null;
  authorAvatar: string | null;
  text: string;
  /** ms */
  createdAt: number;
}

// social.js people:list ack
export type PeopleListAck =
  | { me: string; isAdmin: boolean; people: PresenceEntry[] }
  | { error: string };

// social.js chat:history ack (store.page)
export type ChatHistoryAck =
  | { messages: ChatMessage[]; hasMore: boolean }
  | { error: string };

// social.js chat:send ack
export type ChatSendAck =
  | { ok: true; message: ChatMessage }
  | { error: string };

// social.js chat:delete ack
export type ChatDeleteAck = { ok: true } | { error: string };

// ------------------------------------------------------------------ listen along

// listenAlong.js person()
export interface ListenPerson {
  id: string;
  name: string;
}

// listenAlong.js buildSync — listen:sync, and `sync` of the listen:follow ack
export interface ListenSyncPayload {
  leaderId: string;
  track: {
    title: string;
    artist: string | null;
    thumbnail: string | null;
    libraryId: string | null;
    /** `/api/library/<id>/file`, null when the song is not in the library. */
    src: string | null;
  } | null;
  playing: boolean;
  position: number;
  duration: number;
  /** The leader's playback speed; absent from older servers (= 1). */
  rate?: number;
  /** ms */
  updatedAt: number;
  /** ms */
  serverNow: number;
}

// listenAlong.js reconcile — listen:following
export interface ListenFollowingPayload {
  leader: ListenPerson | null;
  chosen: string | null;
  reason: 'changed' | 'stopped' | 'left';
}

// listenAlong.js presence 'offline' — listen:end
export interface ListenEndPayload {
  reason: 'offline';
  leader: ListenPerson | null;
}

// listenAlong.js followersPayload — listen:followers
export interface ListenFollowersPayload {
  count: number;
  /** At most 3. */
  names: string[];
}

// listenAlong.js emitFollowers — people:listeners
export interface PeopleListenersPayload {
  userId: string;
  count: number;
}

// listenAlong.js listen:follow ack
export type ListenFollowAck =
  | { ok: true; leader: ListenPerson | null; chosen: string; sync: ListenSyncPayload }
  | { error: string };

// listenAlong.js listen:stop ack
export interface ListenStopAck {
  ok: true;
}

// ------------------------------------------------------------------ downloads

/** downloadJobs.STATUSES */
export type JobStatus = 'queued' | 'assigned' | 'done' | 'failed' | 'cancelled';
/** downloadJobs createJob / createReplaceJob */
export type JobSource = 'web' | 'request' | 'replace';
/** downloadJobs.classifyInput / requestInput */
export type JobKind = 'search' | 'video' | 'playlist' | 'spotify';
/** downloadJobs STAGES: the stages the activity log passes on. */
export type ActivityStage = 'assigned' | 'resolving' | 'downloading' | 'uploading' | 'working';

// downloadJobs.summaryOf
export interface JobSummary {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
  replaced: number;
}

// workerHub.stats — workers:update, and `workers` / spread in job answers
export interface WorkerStats {
  online: number;
  idle: number;
  busy: number;
  can_replace: number;
}

// downloadJobs.toPublic — the requester's view (jobs:update, /api/jobs…)
export interface DownloadJob {
  id: string;
  source: JobSource;
  kind: JobKind;
  input: string;
  title: string | null;
  request_id: string | null;
  playlist_id: string | null;
  playlist_name: string | null;
  requested_by: string | null;
  status: JobStatus;
  /** Free text from the worker (any stage name). */
  stage: string | null;
  /** Free text from the worker or the server. */
  progress: string | null;
  worker: { name: string; owner: string | null } | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  summary: JobSummary | null;
  song: { id: string; title: string | null; artist: string | null } | null;
  replace: { song_id: string; title: string | null; artist: string | null; album: string | null } | null;
  /** ISO string (TIMESTAMPTZ). */
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// downloadJobs.toAdmin — GET /api/admin/jobs
export interface AdminJob extends DownloadJob {
  requested_by_user_id: string | null;
  worker_id: string | null;
  /** The worker's trimmed batch result (JSONB). */
  result: unknown;
}

// downloadJobs.toActivity — the activity log's row (no ids of people, no worker text)
export interface ActivityRow {
  id: string;
  source: JobSource;
  kind: JobKind;
  /** Only for a video job. */
  input: string | null;
  title: string | null;
  /** Only when the viewer may see the playlist now. */
  playlist_id: string | null;
  playlist_name: string | null;
  requested_by: string | null;
  status: JobStatus;
  /** Running jobs only. */
  stage: ActivityStage | null;
  /** Upload percent, while uploading. */
  percent: number | null;
  /** Only a server-written note (downloadJobs SERVER_NOTES), never while running. */
  progress: string | null;
  worker: { name: string; owner: string | null } | null;
  /** Failed jobs only. */
  error_code: string | null;
  summary: JobSummary | null;
  song: { id: string; title: string | null; artist: string | null } | null;
  replace: { song_id: string; title: string | null; artist: string | null } | null;
  /** ISO strings (TIMESTAMPTZ). */
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
}

// jobRoutes GET /api/activity/downloads
export interface ActivityListResponse {
  jobs: ActivityRow[];
  workers: WorkerStats;
}

// activityFeed.js sendJob — activity:job
export interface ActivityJobPayload {
  job: ActivityRow;
}

// activityFeed.js sendProgress — activity:progress
export interface ActivityProgressPayload {
  id: string;
  stage: ActivityStage | null;
  percent: number | null;
}

// app/reactions.ts emitJob — jobs:update
export interface JobsUpdatePayload {
  job: DownloadJob;
  workers: WorkerStats;
}

// downloadJobs.publicWorkerView
export interface PublicWorker {
  id: string;
  name: string;
  owner: string | null;
  online: boolean;
  busy: boolean;
}

// downloadJobs.adminWorkerView (+ cli_outdated from jobRoutes GET /api/admin/workers)
export interface AdminWorker extends PublicWorker {
  owner_id: string | null;
  legacy_token: boolean;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  os_release: string | null;
  cli_version: string | null;
  ytdlp_version: string | null;
  node_version: string | null;
  last_ip: string | null;
  jobs_done: number;
  jobs_failed: number;
  /** ISO strings (TIMESTAMPTZ). */
  created_at: string;
  last_connected_at: string | null;
  last_seen_at: string | null;
  /** ISO string (new Date(...).toISOString()), null when offline. */
  connected_since: string | null;
  current_job_id: string | null;
  cli_outdated: boolean;
}

// jobRoutes GET /api/admin/workers
export interface AdminWorkersResponse extends WorkerStats {
  workers: AdminWorker[];
  cli_latest: string | null;
}

// jobRoutes GET /api/admin/jobs
export interface AdminJobsResponse {
  jobs: AdminJob[];
  counts: Record<JobStatus, number>;
  workers: WorkerStats;
}

// workerHub.onlineWorkers — GET /api/workers
export interface OnlineWorker {
  id: string;
  name: string;
  owner: string | null;
  busy: boolean;
}

// jobRoutes GET /api/workers
export interface WorkersResponse extends WorkerStats {
  workers: OnlineWorker[];
}

// jobRoutes GET /api/jobs
export interface JobsListResponse {
  jobs: DownloadJob[];
  workers: WorkerStats;
}

// jobRoutes POST /api/jobs (with picks)
export interface CreatePickedJobsResponse {
  jobs: DownloadJob[];
  existing: LibrarySong[];
  added_to_playlist: number;
  /** YouTube ids of library songs the playlist already held (skipped). */
  already_in_playlist: string[];
  playlist_id: string | null;
  workers: WorkerStats;
  /** Present when part of it failed. */
  failed?: string[];
  error?: string;
}

// jobRoutes POST /api/jobs (input, no picks)
export type CreateJobResponse =
  /** A video the library already has: nothing queued. */
  | { job: null; existing: LibrarySong; added_to_playlist: boolean; playlist_id: string | null }
  | { job: DownloadJob; workers: WorkerStats };

// jobRoutes POST /api/jobs/replace/preview
export type ReplacePreviewResponse =
  | { resolved: false; problem: { code: string; message: string; song: LibrarySong | null } }
  | {
    youtube_id: string;
    resolved: boolean;
    title: string | null;
    channel: string | null;
    duration_sec: number | null;
    current_duration_sec: number | null;
    duration_differs: boolean;
    problem: null;
  };

// jobRoutes GET /api/jobs/replace/:songId
export interface ReplaceJobState {
  active: boolean;
  job: DownloadJob | null;
  workers: WorkerStats;
}

// jobRoutes GET /api/profile/activity — uploaded / fulfilled_by_my_workers rows (raw SELECT)
export interface ProfileSongRow {
  id: string;
  title: string;
  artist: string;
  youtube_id: string | null;
  /** ISO string (TIMESTAMPTZ). */
  created_at: string;
  worker: string | null;
  requested_by: string | null;
}

// jobRoutes GET /api/profile/activity
export interface ProfileActivity {
  counts: {
    uploaded: number;
    uploaded_by_workers: number;
    asked: number;
    asked_fulfilled: number;
    downloads: number;
    fulfilled_by_my_workers: number;
  };
  uploaded: ProfileSongRow[];
  asked: {
    id: string;
    title: string | null;
    artist: string | null;
    youtube_id: string | null;
    status: SongRequest['status'];
    created_at: string;
    song: { id: string; title: string; artist: string } | null;
    fulfilled_by: { name: string | null; worker: string | null } | null;
  }[];
  downloads: DownloadJob[];
  fulfilled_by_my_workers: ProfileSongRow[];
  workers: (PublicWorker & { jobs_done: number; jobs_failed: number; last_connected_at: string | null })[];
}

// ------------------------------------------------------------------ pick the video

// picker.js toVideo + mark
export interface PickVideo {
  youtube_id: string;
  title: string | null;
  channel: string | null;
  duration_sec: number | null;
  in_library: { id: string; title: string; artist: string | null } | null;
}

// picker.js lookup / search — POST /api/jobs/picks, discriminated on `kind`
export type PickResult =
  | { kind: 'library'; song: LibrarySong }
  | { kind: 'search'; query: string; results: PickVideo[] }
  /** One result; its title is null when the lookup failed. */
  | { kind: 'video'; results: PickVideo[] }
  | { kind: 'playlist'; results: PickVideo[]; total: number; title: string | null };

// ------------------------------------------------------------------ admin dashboard

// libraryRoutes GET /api/admin/status
export interface AdminStatus {
  enabled: boolean;
  authenticated: boolean;
}

// app/adminRoutes.ts GET|PUT /api/admin/settings
export interface AdminSettings {
  registrations_open: boolean;
  source: string;
  central_login: boolean;
}

// app/adminRoutes.ts GET /api/dashboard/stats — stats.playlists items (public playlists only)
export interface DashboardPlaylist {
  id: string;
  name: string | null;
  userCount: number;
  queueLength: number;
  /** ms */
  createdAt: number;
  /** ms */
  lastActivity: number;
}

// app/adminRoutes.ts GET /api/dashboard/stats
export interface DashboardStats {
  totalPlaylists: number;
  privatePlaylists: number;
  totalUsers: number;
  /** Seconds (process.uptime()). */
  uptime: number;
  /** process.memoryUsage() */
  memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  diskUsage: { bytes: number; fileCount: number; unregisteredFiles: number; unregisteredBytes: number };
  playlists: DashboardPlaylist[];
}

// app/adminRoutes.ts GET /api/dashboard/users (raw users rows)
export interface DashboardUser {
  id: string;
  user_id: string | null;
  username: string | null;
  emoji: string | null;
  email: string | null;
  avatar_url: string | null;
  provider: string;
  status: AccountStatus | null;
  /** BIGINT ms, sent as a string by node-postgres. */
  created_at: string;
  /** BIGINT ms, sent as a string by node-postgres. */
  updated_at: string | null;
  /** Linked to the central login (oidc_sub set). */
  central: boolean;
  /**
   * NOT sent: the SELECT in app/adminRoutes.ts GET /api/dashboard/users does not include
   * users.name. The dashboard's user list (features/admin/dashboard.ts) reads it
   * anyway (search + display name, falling back to username), so it is typed
   * optional to keep that code as it is.
   */
  name?: string | null;
}

// app/adminRoutes.ts GET /api/dashboard/users
export interface DashboardUsersResponse {
  users: DashboardUser[];
}

// app/adminRoutes.ts PUT /api/dashboard/users/:id/approve|reject
export interface DashboardUserStatusResponse {
  success: true;
  user: { user_id: string | null; username: string | null; status: AccountStatus };
}

// libraryRoutes GET /api/admin/tokens (tokens.listTokens: every token)
export interface AdminTokensResponse {
  tokens: ApiToken[];
}

// libraryRoutes GET /api/requests (requests.listRequests)
export interface RequestListResponse {
  requests: SongRequest[];
}

// ------------------------------------------------------------------ tokens / app

// tokenRoutes GET /api/tokens (tokens.listUserTokens: the caller's active tokens)
export interface TokenListResponse {
  tokens: ApiToken[];
}

// tokenRoutes POST /api/tokens (201; the plaintext token is shown once)
export interface TokenCreatedResponse {
  token: string;
  record: ApiToken;
}

// appRelease.js pickLatest view — a release of GET /api/app/latest
export interface AppRelease {
  version: string;
  tag: string;
  /** ISO string from GitHub (published_at), or null. */
  publishedAt: string | null;
  releaseUrl: string;
  apk: { name: string; url: string; size: number | null };
  sha256: string | null;
}

// appRelease.js latest() — GET /api/app/latest (always 200)
export type AppLatestResponse =
  | ({ available: true; releasesUrl: string; stale: boolean } & AppRelease)
  | { available: false; reason: 'none' | 'unavailable'; releasesUrl: string };

// ------------------------------------------------------------------ socket events

// Every event the server emits to web sockets (core/playlists/playlistSockets.ts, core/queue/queueSockets.ts, app/reactions.ts, social.js,
// listenAlong.js, activityFeed.js). For Socket<ServerToClientEvents, ClientToServerEvents>.
export interface ServerToClientEvents {
  // playlists (core/playlists/playlistSockets.ts, core/playlists/playlistRoutes.ts, app/reactions.ts)
  'playlist:joined': (p: PlaylistJoinedPayload) => void;
  'playlist:created': (p: PlaylistCreatedPayload) => void;
  'playlist:updated': (p: PlaylistUpdatedPayload) => void;
  'playlist:renamed': (p: PlaylistRenamedPayload) => void;
  'playlist:pinned': (p: PlaylistPinnedPayload) => void;
  'playlist:closed': (p: PlaylistClosedPayload) => void;
  'playlist:not-found': (p: PlaylistNotFoundPayload) => void;
  'playlist:error': (p: PlaylistErrorPayload) => void;
  'playlist:user-joined': (p: PlaylistUserChangePayload) => void;
  'playlist:user-left': (p: PlaylistUserChangePayload) => void;
  'users:updated': (p: UsersUpdatedPayload) => void;
  /** No payload: refetch /api/playlists. */
  'playlists:changed': () => void;
  // queue (core/queue/queueSockets.ts, app/reactions.ts)
  'queue:update': (p: QueueUpdatePayload) => void;
  /** Never sent by the server (no emit in backend/src); app.ts keeps a listener. */
  'queue:song-added': (p: QueueSongAddedPayload) => void;
  'queue:error': (p: QueueErrorPayload) => void;
  'queue:adding': (p: QueueAddingPayload) => void;
  'queue:requested': (p: QueueRequestedPayload) => void;
  'request:fulfilled': (p: RequestFulfilledPayload) => void;
  /** No payload: refetch /api/requests. */
  'requests:updated': () => void;
  // library (app/reactions.ts)
  'library:updated': (p: LibraryUpdatedPayload) => void;
  'download:status': (p: DownloadStatusPayload) => void;
  /** Never sent by the server (no emit in backend/src); app.ts keeps a listener. */
  'download:progress': (p: DownloadProgressPayload) => void;
  // downloads (app/reactions.ts, activityFeed.js)
  'jobs:update': (p: JobsUpdatePayload) => void;
  'workers:update': (p: WorkerStats) => void;
  'activity:job': (p: ActivityJobPayload) => void;
  'activity:progress': (p: ActivityProgressPayload) => void;
  // chat + people (social.js, listenAlong.js)
  'chat:message': (p: ChatMessage) => void;
  'chat:deleted': (p: { id: number }) => void;
  'people:presence': (p: { user: PresenceUpdate }) => void;
  'people:user': (p: { user: PresenceUpdate }) => void;
  'people:removed': (p: { userId: string }) => void;
  'people:now-playing': (p: { userId: string; nowPlaying: NowPlayingView | null }) => void;
  'people:listeners': (p: PeopleListenersPayload) => void;
  // listen along (listenAlong.js)
  'listen:sync': (p: ListenSyncPayload) => void;
  'listen:following': (p: ListenFollowingPayload) => void;
  'listen:end': (p: ListenEndPayload) => void;
  'listen:followers': (p: ListenFollowersPayload) => void;
}

// presence.normalizeReport input (what the web sends: features/social/social.ts reportNowPlaying)
export type PresenceContextReport =
  | { type: 'library' }
  | { type: 'radio' }
  | { type: 'artist'; key: string; name?: string | null }
  | { type: 'playlist'; playlistId: string };

// presence.normalizeReport input
export type NowPlayingReport =
  | {
    track: { id?: string | null; title: string; artist?: string | null; thumbnail?: string | null; url?: string | null };
    context?: PresenceContextReport | null;
    playing?: boolean;
    position?: number;
    duration?: number;
    /** Playback speed (1 = normal); listen-along followers read it (speed-rules.ts). Additive. */
    rate?: number;
  }
  /** Nothing is playing. */
  | { track: null };

// Every event the server handles from a web socket (core/playlists/playlistSockets.ts, core/queue/queueSockets.ts, social.js,
// listenAlong.js), payloads as the handlers read them. `userId` in playlist:*
// payloads is sent by the web and ignored by the server (it uses the login).
export interface ClientToServerEvents {
  'playlist:create': (p: {
    username?: string;
    emoji?: string | null;
    name?: string;
    visibility?: Visibility;
    asViewer?: boolean;
    userId?: string | null;
  }) => void;
  'playlist:join': (p: { playlistId: string; username?: string; emoji?: string | null; userId?: string | null }) => void;
  'playlist:view': (p: { playlistId: string; userId?: string | null }) => void;
  /** The server ignores the payload. */
  'playlist:unview': (p?: { playlistId?: string | null }) => void;
  /** No playlistId: leave the member playlist. */
  'playlist:leave': (p: { playlistId?: string | null }) => void;
  'user:update': (p: { playlistId?: string; username?: string; emoji?: string | null }) => void;
  'listener:now-playing': (p: { playlistId?: string; track: { title: string; thumbnail?: string | null } | null }) => void;
  /** Handled by the server; the web no longer emits it. */
  'playlist:pin': (p: { playlistId?: string; pinned: boolean }) => void;
  /** Handled by the server; the web renames over PATCH /api/playlists/:id. */
  'playlist:rename': (p: { playlistId?: string; name: string }) => void;
  /** Handled by the server; the web adds over HTTP (CLAUDE.md "Duplicates on the web"). */
  'queue:add': (p: {
    playlistId: string;
    query?: string;
    url?: string;
    title?: string;
    libraryId?: string;
    /** YouTube ids from POST /api/jobs/picks. */
    picks?: string[];
    addedBy?: string;
  }) => void;
  'queue:remove': (p: { playlistId: string; songId: string }) => void;
  'queue:restore': (p: { playlistId: string; songId: string }) => void;
  'queue:reorder': (p: { playlistId: string; songId: string; newIndex: number }) => void;
  'queue:clear': (p: { playlistId: string }) => void;
  /** Handled by the server (answers queue:update); the web does not emit it. The payload is the bare id. */
  'queue:get': (playlistId: string) => void;
  // social.js
  /** Only used without a database. */
  'social:hello': (p: { name: string; emoji?: string | null }) => void;
  'people:list': (arg: unknown, ack: (res: PeopleListAck) => void) => void;
  /** before: a message id (keyset pagination). */
  'chat:history': (p: { before?: number; limit?: number }, ack: (res: ChatHistoryAck) => void) => void;
  'chat:send': (p: { text: string }, ack: (res: ChatSendAck) => void) => void;
  /** Admin cookie only. */
  'chat:delete': (p: { id: number }, ack: (res: ChatDeleteAck) => void) => void;
  'presence:now-playing': (report: NowPlayingReport) => void;
  // listenAlong.js
  'listen:follow': (p: { userId: string }, ack: (res: ListenFollowAck) => void) => void;
  'listen:stop': (p: Record<string, never>, ack?: (res: ListenStopAck) => void) => void;
}
