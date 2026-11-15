// The downloads activity log's rules (activity.js renders; the server's row is
// downloadJobs.toActivity). Pure: no DOM, tested in activity-rules.test.ts.
import type { ActivityProgressPayload, ActivityRow } from '../../shared/types.ts';

/** How many rows the log keeps; jobs still waiting or running stay beyond it. */
export const MAX_ROWS = 60;

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'assigned']);

/** Waiting for a downloader or running on one. */
export const isActive = (job: Pick<ActivityRow, 'status'> | null | undefined): boolean => !!job && ACTIVE.has(job.status);

export const activeCount = (list: readonly Pick<ActivityRow, 'status'>[]): number => list.filter(isActive).length;

const time = (v: string | null | undefined): number => { const n = new Date(v as string).getTime(); return Number.isFinite(n) ? n : 0; };

/**
 * Newest first by when it was asked for, which never changes: a row keeps its
 * place while its state moves. Finished rows past `max` are dropped; active
 * ones never are.
 */
export function orderRows(list: readonly ActivityRow[], max = MAX_ROWS): ActivityRow[] {
  const sorted = [...list].sort((a, b) => time(b.created_at) - time(a.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.filter((job, i) => i < max || isActive(job));
}

/**
 * A job arrived (activity:job): replace the row with that id, or add it. One
 * that is older than the row held (updated_at) is ignored: an event that was
 * on its way must not undo a newer list.
 */
export function mergeJob(list: ActivityRow[], job: ActivityRow | null | undefined, max = MAX_ROWS): ActivityRow[] {
  if (!job || !job.id) return list;
  const i = list.findIndex((x) => x.id === job.id);
  if (i >= 0 && time(job.updated_at) < time(list[i].updated_at)) return list;
  const next = i >= 0 ? list.map((x, n) => (n === i ? job : x)) : [...list, job];
  return orderRows(next, max);
}

/**
 * The list arrived (GET /api/activity/downloads): it, with the rows that
 * changed while it was on its way put on top of it (mergeJob keeps the newer).
 */
export function applyLoad(jobs: ActivityRow[] | null | undefined, buffered: readonly ActivityRow[] = [], max = MAX_ROWS): ActivityRow[] {
  return buffered.reduce((list, job) => mergeJob(list, job, max), orderRows(jobs || [], max));
}

/**
 * Progress arrived (activity:progress { id, stage, percent }): only a running
 * row takes it (a late one must not write on a row that already finished).
 * The same list back when nothing changed.
 */
export function applyProgress(list: ActivityRow[], p: ActivityProgressPayload | null | undefined): ActivityRow[] {
  if (!p || !p.id) return list;
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0 || list[i].status !== 'assigned') return list;
  const cur = list[i];
  const stage = p.stage || null;
  const percent = Number.isFinite(p.percent) ? p.percent : null;
  if (cur.stage === stage && cur.percent === percent) return list;
  return list.map((x, n) => (n === i ? { ...x, stage, percent } : x));
}

/**
 * What a running row adds after "Downloading on <downloader>": 'searching',
 * 'uploading' (with the percent when known) or nothing. The server sends the
 * stage and the percent, never the downloader's own words.
 */
export interface RowProgress {
  key: 'searching' | 'uploading';
  percent: number | null;
}

export function progressOf(job: Pick<ActivityRow, 'status' | 'stage' | 'percent'> | null | undefined): RowProgress | null {
  if (!job || job.status !== 'assigned') return null;
  if (job.stage === 'resolving') return { key: 'searching', percent: null };
  if (job.stage === 'uploading') return { key: 'uploading', percent: Number.isFinite(job.percent) ? job.percent : null };
  return null;
}

// Why a job failed, by its error code (the downloader's or the server's): the
// row never carries the downloader's message. Codes: cli/src/ytdlp.js
// parseError, pipeline.js, api.js; backend downloadJobs.js / library.js.
const FAILURES: Readonly<Record<string, string>> = {
  VIDEO_UNAVAILABLE: 'unavailable',
  VIDEO_PRIVATE: 'private',
  VIDEO_RESTRICTED: 'signIn',
  AGE_RESTRICTED: 'ageRestricted',
  REGION_BLOCKED: 'region',
  DRM_PROTECTED: 'drm',
  BOT_CHECK: 'botCheck',
  FORBIDDEN: 'refused',
  NO_M4A_FORMAT: 'noFormat',
  JS_CHALLENGE: 'ytdlp',
  YTDLP_FAILED: 'ytdlp',
  MISSING_DEPENDENCY: 'ytdlp',
  NETWORK: 'network',
  UNREACHABLE: 'network',
  NOT_FOUND: 'noResults',
  NO_MATCH: 'noResults',
  NOT_M4A: 'badAudio',
  BAD_MEDIA: 'badAudio',
  CONVERT_FAILED: 'badAudio',
  MISSING_TAGS: 'noTags',
  already_in_library: 'duplicate',
  duplicate_hash: 'duplicate',
  duplicate_metadata: 'duplicate',
  SONG_DELETED: 'songDeleted',
  WORKER_LOST: 'workerLost',
  NOTHING_DOWNLOADED: 'nothing',
};

/** The key of the sentence for an error code ('generic' for one it does not know). */
export function failureKey(code: unknown): string {
  if (typeof code !== 'string') return 'generic';
  if (Object.hasOwn(FAILURES, code)) return FAILURES[code];
  return /^HTTP_\d{3}$/.test(code) ? 'server' : 'generic';
}

/**
 * What the row is called: the job's title, else the song it became, else null
 * (the caller words the kind: "YouTube video", "YouTube playlist").
 */
export function rowTitle(job: Pick<ActivityRow, 'title' | 'song' | 'replace'>): string | null {
  if (job.title) return job.title;
  if (job.song && job.song.title) return [job.song.artist, job.song.title].filter(Boolean).join(' - ');
  if (job.replace && job.replace.title) return [job.replace.artist, job.replace.title].filter(Boolean).join(' - ');
  return null;
}

/** When the row last meant something: finished rows by their end, the rest by when they were asked for. */
export function rowTime(job: Pick<ActivityRow, 'status' | 'created_at' | 'finished_at'>): number {
  return time(isActive(job) ? job.created_at : (job.finished_at || job.created_at));
}
