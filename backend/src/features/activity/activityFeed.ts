/**
 * The live side of the downloads activity log (the third tab of the chat and
 * people panel): every download job, as it changes, for every approved account.
 * The list itself is GET /api/activity/downloads (jobRoutes.js); the row is
 * downloadJobs.toActivity.
 *
 * Server -> client (APP_ROOM: sockets of approved accounts)
 *   activity:job      { job }                  a job is new or changed state
 *   activity:progress { id, stage, percent }   a running job's stage / upload percent
 *
 * The playlist a job was asked for is named only to a viewer who can see it
 * now (playlistAccess, looked up at every emit): a public one goes to the
 * whole room, a private one to its owner's sockets, and everyone else gets the
 * same row without it.
 *
 * Progress arrives about once a second per running job and here it goes to
 * everyone, so it is a small event of its own, sent at most once per
 * `progressMs` per job (the latest is sent when the wait is over). It carries
 * the stage and the percent only, never the worker's text (downloadJobs
 * "The activity log's row"). Anything else that changes on the row (state,
 * worker, a replace job's details) is a full row, never held back.
 */

import { access } from '../../core/playlists/index.ts';
import { downloadJobs as jobsModule } from '../../core/jobs/index.ts';
import type { JobWithJoins, Playlist } from '../../shared/types.ts';

export const PROGRESS_MS = 1500;

/** What the feed reads of a playlist: who may see it, and what a row may name (toActivity's playlist_id / playlist_name). */
export type ActivityPlaylist = Pick<Playlist, 'id' | 'name' | 'visibility' | 'ownerId'>;

/**
 * A job as downloadJobs.getJob returns it. The feed itself reads the id, the
 * status and the playlist; the rest goes to downloadJobs' views.
 */
export type ActivityJobRow = Pick<JobWithJoins, 'id' | 'status'> & Partial<JobWithJoins>;

/** What the feed uses of the Socket.IO server (the real one fits). */
interface Broadcast {
  emit(event: string, payload: unknown): unknown;
  except(room: string): Broadcast;
}
export interface ActivityIo {
  to(room: string): Broadcast;
  sockets: { adapter: { rooms: { get(room: string): Set<string> | undefined } } };
}

/** What this feed uses of downloadJobs. */
interface JobViews {
  /** The activity log's row: what every approved account may see of a job (activity:job's `job`). */
  toActivity(row: ActivityJobRow, playlist: ActivityPlaylist | null): object | null;
  /** A running job's known stage and upload percent. */
  publicProgress(row: ActivityJobRow): { stage: string | null; percent: number | null };
}
const jobs: JobViews = jobsModule;

export interface ActivityFeedDeps {
  /** Socket.IO server */
  io: ActivityIo;
  /** the room of approved accounts' sockets */
  room: string;
  /** (userId) -> the room of one account's sockets */
  userRoom: (userId: string) => string;
  /** (playlistId) -> the playlist, or undefined when it is gone */
  getPlaylist: (playlistId: string) => Promise<ActivityPlaylist | null | undefined>;
  /** least time between two progress events of one job */
  progressMs?: number;
}

export interface ActivityFeed {
  /** A job was created or changed (the row, as downloadJobs.getJob returns it). */
  jobChanged(row: ActivityJobRow | null | undefined): void;
}

/** activity:progress */
export interface ActivityProgress {
  id: string;
  stage: string | null;
  percent: number | null;
}

interface Running {
  shape: string;
  at: number;
  timer: NodeJS.Timeout | null;
  pending: ActivityJobRow | null;
}

export function createActivityFeed({ io, room, userRoom, getPlaylist, progressMs = PROGRESS_MS }: ActivityFeedDeps): ActivityFeed {
  // Jobs waiting or running: id -> { shape, at, timer, pending }
  const running = new Map<string, Running>();
  // Emits leave in the order the changes came, also past the playlist lookup.
  let chain: Promise<unknown> = Promise.resolve();
  const later = (fn: () => unknown) => {
    chain = chain.then(fn).catch((err) => console.error('[activity] emit failed:', err.message));
  };

  async function sendJob(row: ActivityJobRow): Promise<void> {
    const l = row.playlist_id ? await getPlaylist(row.playlist_id) : null;
    if (!l || !access.isPrivate(l)) {
      io.to(room).emit('activity:job', { job: jobs.toActivity(row, l || null) });
      return;
    }
    const bare = { job: jobs.toActivity(row, null) };
    if (!l.ownerId) { io.to(room).emit('activity:job', bare); return; }
    io.to(room).except(userRoom(l.ownerId)).emit('activity:job', bare);
    // The owner's sockets that are in the room (an account's room also holds
    // its sockets from before it was approved).
    const approved = io.sockets.adapter.rooms.get(room);
    for (const id of io.sockets.adapter.rooms.get(userRoom(l.ownerId)) || []) {
      if (approved && approved.has(id)) io.to(id).emit('activity:job', { job: jobs.toActivity(row, l) });
    }
  }

  function sendProgress(row: ActivityJobRow): void {
    const { stage, percent } = jobs.publicProgress(row);
    const progress: ActivityProgress = { id: row.id, stage, percent };
    later(() => io.to(room).emit('activity:progress', progress));
  }

  // The row without what a progress tick moves: two emits with the same shape
  // differ in progress only.
  function shapeOf(row: ActivityJobRow): string {
    return JSON.stringify({ ...jobs.toActivity(row, null), stage: null, percent: null, progress: null, updated_at: null });
  }

  function jobChanged(row: ActivityJobRow | null | undefined): void {
    if (!row || !row.id) return;
    const state = running.get(row.id);
    const shape = shapeOf(row);
    // Still running and nothing else on the row changed: only its progress moved.
    if (state && row.status === 'assigned' && state.shape === shape) {
      const wait = state.at + progressMs - Date.now();
      if (wait <= 0) {
        state.at = Date.now();
        sendProgress(row);
      } else {
        state.pending = row;
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = null;
            state.at = Date.now();
            if (state.pending) sendProgress(state.pending);
            state.pending = null;
          }, wait);
          if (state.timer.unref) state.timer.unref();
        }
      }
      return;
    }
    if (state && state.timer) clearTimeout(state.timer);
    if (row.status === 'queued' || row.status === 'assigned') {
      running.set(row.id, { shape, at: 0, timer: null, pending: null });
    } else {
      running.delete(row.id);
    }
    later(() => sendJob(row));
  }

  return { jobChanged };
}
