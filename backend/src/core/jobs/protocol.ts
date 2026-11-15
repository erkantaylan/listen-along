// The worker protocol (workerHub.ts has the full description): the JSON
// messages `la worker` and the server exchange over /api/workers/connect.
// Types only, mirroring what the hub checks at run time: a message from a
// worker is untrusted until those checks ran (workerHub reads every field as
// unknown first), and nothing here changes what is accepted or sent.
import type { WorkerJob } from './downloadJobs.ts';

/** Feature flags a worker's hello may list (beyond protocol 1). */
export type Capability = 'replace' | 'update';

// --- worker -> server --------------------------------------------------------

/** The first message, within the hello timeout. Only `type` and `token` are required. */
export interface HelloMessage {
  type: 'hello';
  token: string;
  name?: unknown;
  hostname?: unknown;
  platform?: unknown;
  arch?: unknown;
  os_release?: unknown;
  cli_version?: unknown;
  node_version?: unknown;
  ytdlp_version?: unknown;
  protocol?: unknown;
  /** read only when it is an array */
  capabilities?: unknown;
  /** a job it is still running from before a reconnect / restart (read only when a non-empty string) */
  current_job_id?: unknown;
}

export interface PongMessage { type: 'pong' }
export interface DrainMessage { type: 'drain' }
/** Free text for the requester; at most about one per second (each one is a DB write + jobs:update). */
export interface ProgressMessage { type: 'job:progress'; job_id?: unknown; stage?: unknown; message?: unknown }
/** result: { summary, results, error_code?, error_message? } (downloadJobs.trimResult keeps what it knows). */
export interface DoneMessage { type: 'job:done'; job_id?: unknown; result?: unknown }
/** Give a job back (shutdown, fatal error); reason 'shutdown' also means "send me no more". */
export interface ReleaseMessage { type: 'job:release'; job_id?: unknown; reason?: unknown }
/** "Busy": never sent a second job, but be safe. */
export interface RejectMessage { type: 'job:reject'; job_id?: unknown; reason?: unknown }

/** Any message after the hello. Anything else is ignored. */
export type WorkerMessage = PongMessage | DrainMessage | ProgressMessage | DoneMessage | ReleaseMessage | RejectMessage;

// --- server -> worker --------------------------------------------------------

/** The la bundle this server offers (cliRelease.latest). */
export interface CliLatest {
  version: string;
  sha256: string;
  url: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  protocol: number;
  worker: { id: string; name: string };
  user: { id: string; name: string } | null;
  owner: string | null;
  heartbeat_ms: number;
  /** only when the server ships a bundle; workers before la 0.4 ignore it */
  cli_latest?: CliLatest;
}

export interface PingMessage { type: 'ping'; t: number }
export interface JobMessage { type: 'job'; job: WorkerJob }
/** Sent just before a close. */
export interface ErrorMessage { type: 'error'; code: string; message: string }

export type ServerMessage = WelcomeMessage | PingMessage | JobMessage | ErrorMessage;

/**
 * Close codes: 4001 bad/revoked token, 4002 bad hello / protocol / message,
 * 4003 replaced by another process with the same worker, 4005 no database,
 * 4010 outdated (a reminder, the worker reconnects).
 */
export type CloseCode = 4001 | 4002 | 4003 | 4005 | 4010;
