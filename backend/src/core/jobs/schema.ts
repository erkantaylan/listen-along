// Downloaders ("workers") and download jobs (workerHub.ts, downloadJobs.ts).
// Run by shared/db.ts, in the order of its SCHEMA list.
import type { Migration } from '../../shared/db.ts';

export const tables: readonly string[] = [
  // Downloaders ("workers"): `la worker` processes on users' own machines
  // that connect out to the server and run download jobs (core/jobs/workerHub.ts).
  // One row per (owner, name); a legacy ownerless token keys on token_id.
  // hostname / platform / os_release / last_ip are admin-only.
  `
    CREATE TABLE IF NOT EXISTS download_workers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      token_id UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
      owner_name VARCHAR(255),
      name VARCHAR(100) NOT NULL,
      hostname VARCHAR(255),
      platform VARCHAR(32),
      arch VARCHAR(32),
      os_release VARCHAR(128),
      cli_version VARCHAR(32),
      ytdlp_version VARCHAR(64),
      node_version VARCHAR(32),
      last_ip VARCHAR(64),
      jobs_done INTEGER NOT NULL DEFAULT 0,
      jobs_failed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_connected_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ
    )
  `,
  // Download jobs: a song request (automatic) or the web "Download" box.
  // Routed to a connected worker (core/jobs/workerHub.ts); survive restarts (an
  // 'assigned' job whose worker is gone goes back to 'queued').
  // status: queued | assigned | done | failed | cancelled.
  // request_id / playlist_id / song_id have no FKs that cascade: the job
  // history outlives a deleted request, playlist or song.
  `
    CREATE TABLE IF NOT EXISTS download_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source VARCHAR(16) NOT NULL DEFAULT 'web',
      kind VARCHAR(16) NOT NULL DEFAULT 'search',
      input TEXT NOT NULL,
      title TEXT,
      request_id UUID,
      playlist_id VARCHAR(8),
      requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      requested_by VARCHAR(255),
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      worker_id UUID REFERENCES download_workers(id) ON DELETE SET NULL,
      worker_name VARCHAR(100),
      worker_owner VARCHAR(255),
      attempts INTEGER NOT NULL DEFAULT 0,
      stage VARCHAR(32),
      progress TEXT,
      result JSONB,
      error_code VARCHAR(64),
      error_message TEXT,
      song_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `,
];

export const migrations: readonly Migration[] = [
  `CREATE INDEX IF NOT EXISTS idx_download_workers_user ON download_workers(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status, created_at)`,
  // Migration: replace jobs (source 'replace'). The job downloads a video and
  // replaces this song, keeping these details. No FK: a deleted song fails the
  // job with a clear error, and its history stays. One active job per song.
  `ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS replace_song_id UUID`,
  `ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS replace_title TEXT`,
  `ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS replace_artist TEXT`,
  `ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS replace_album TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_download_jobs_replace_active ON download_jobs(replace_song_id) WHERE replace_song_id IS NOT NULL AND status IN ('queued', 'assigned')`,
  `CREATE INDEX IF NOT EXISTS idx_download_jobs_requester ON download_jobs(requested_by_user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_download_jobs_request ON download_jobs(request_id)`,
  // The activity log reads the newest jobs of everyone.
  `CREATE INDEX IF NOT EXISTS idx_download_jobs_created ON download_jobs(created_at DESC, id)`,
];
