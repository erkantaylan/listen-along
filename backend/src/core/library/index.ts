// The music library (core): songs, uploads, duplicates, replace and edit,
// broken-song reports and the server's own check of them, the relevance
// search, covers, the audio routes, and the silence measurements behind the
// web player's "Skip silence". index.js builds the routers; the other areas
// use the modules below (always through this file).
//
// library.ts comes first: the routes below import the jobs and requests areas,
// which import this file back (a cycle that only calls functions, never at
// load time).
export * as library from './library.ts';
export type {
  PublicSong, PublicSongRow, LeanSong, LeanSongRow, QueueEntryFields, UploadFields, UploadFile, Uploader, NewSong,
  ReplacementRow, DuplicateMatch, DuplicateQuery, SongChange, SongPage, ListOptions, Probe, UploadVerdict,
} from './library.ts';
export { toLeanSong } from './library.ts';
export * as songMatch from './songMatch.ts';
export * as songSearch from './songSearch.ts';
export * as songReports from './songReports.ts';
export { OPEN_REPORT_EXISTS_SQL } from './songReports.ts';
export type { ReportRow, ReportView, Reporter } from './songReports.ts';
export * as songVerify from './songVerify.ts';
export type { StorageHealth, Verdict } from './songVerify.ts';
export * as covers from './covers.ts';
export type { CoverInfo } from './covers.ts';
// GET|POST /api/library…, /api/requests…, /api/me (CLI), /api/admin/… (dashboard).
export { createLibraryRouter, sendSongFile, downloadFilename } from './libraryRoutes.ts';
export type { LibraryHooks, SendSongFile, SongFileRow, SongRequestView } from './libraryRoutes.ts';
// GET /api/stream (a queue entry's audio) and /api/covers/:id.
export { createMediaRouter, isAllowedCoverUrl, coverRedirectTarget } from './mediaRoutes.ts';
export type { MediaRouterDeps } from './mediaRoutes.ts';
// The silence measurements (silence.ts) and their routes.
export { createSilenceScanner, measureFile, parseSilencedetect, edgeSilence, SILENCE_NOISE_DB, SILENCE_MIN_S } from './silence.ts';
export type { SilenceScanner, SilenceStats, EdgeSilence } from './silence.ts';
export { createSilenceRouter, silenceOf } from './silenceRoutes.ts';
export type { SongSilence } from './silenceRoutes.ts';
