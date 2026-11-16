// Dead air at the start and end of library songs, for the web player's "Skip
// silence" (frontend/src/player/skip-silence-rules.ts). Many songs come from
// video uploads with seconds of nothing before or after the music.
//
// Measured by the server, never by a client: `nice -n 19 ffmpeg … -af
// silencedetect=noise=-50dB:d=1 -f null -` decodes the whole first audio
// stream. Only silence touching the very START (from 0) or running to the very
// END counts; a quiet passage in the middle never does. The numbers:
// - -50 dBFS (sample amplitude 0.0032): digital silence, encoder noise and room
//   hiss in a video's dead air are far below it; real music is not. A
//   pianissimo classical intro peaking at -40 or -46 dBFS is kept whole, and a
//   fade-in from silence loses only the few milliseconds under -50 dBFS, which
//   d=1 then ignores (tested in silence.ffmpeg.test.ts with generated files).
// - at least 1 s: shorter gaps are the song's own breath.
// Stored as library_songs.lead_silence_ms / trail_silence_ms (ms, NULL = not
// measured yet; 0 = measured, none). The web reads them through GET
// /api/stream/silence (silenceRoutes.ts) and in the song views (additive).
//
// The scanner: strictly one ffmpeg at a time, niced, with a time limit, a pause
// between songs, and a bounded queue. New uploads and replaced files go first
// (main.ts hooks: songAdded / songReplaced, which only queue and return); in
// between it backfills the library, newest songs first, one pass per boot over
// the songs still NULL, so a restart simply continues. Missing files and
// failed decodes are skipped for this pass (retried at the next boot); a path
// outside the songs folder (library.songsFile) is never opened. Off
// without a database, without ffmpeg, without the songs folder, or with
// SILENCE_SCAN=off. It has its own queue: uploads and the decode check of
// automatic reports (core/library/songVerify.ts) never wait for it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Queryable } from '../../shared/db.ts';

export const SILENCE_NOISE_DB = -50;
export const SILENCE_MIN_S = 1;
/** A silence that starts within this of 0 is the lead-in; one that ends within this of the end is the tail. */
export const EDGE_S = 0.05;

export interface SilenceEvent { start: number; end: number | null }
export interface ParsedSilence { events: SilenceEvent[]; duration: number | null }
export interface EdgeSilence { leadMs: number; trailMs: number }

function toSeconds(hms: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(hms.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** ffmpeg's stderr -> the silences it reported and the decoded length. */
export function parseSilencedetect(stderr: string): ParsedSilence {
  const events: SilenceEvent[] = [];
  for (const line of String(stderr || '').split(/\r?\n|\r/)) {
    const start = /silence_start:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (start) { events.push({ start: Math.max(0, Number(start[1])), end: null }); continue; }
    const end = /silence_end:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (end && events.length && events[events.length - 1].end === null) events[events.length - 1].end = Number(end[1]);
  }
  // The decoded length: the last progress / summary "time=", else the container's Duration.
  let duration: number | null = null;
  const times = [...String(stderr || '').matchAll(/time=\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/g)];
  if (times.length) duration = toSeconds(times[times.length - 1][1]);
  if (duration === null) {
    const d = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(String(stderr || ''));
    if (d) duration = toSeconds(d[1]);
  }
  return { events, duration: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null };
}

/** The silence at the very start and the very end (ms); null when the length is unknown. */
export function edgeSilence({ events, duration }: ParsedSilence): EdgeSilence | null {
  if (duration === null) return null;
  let leadMs = 0;
  let trailMs = 0;
  const first = events[0];
  if (first && first.start <= EDGE_S) {
    const end = first.end === null ? duration : Math.min(first.end, duration);
    leadMs = Math.round(end * 1000);
  }
  const last = events[events.length - 1];
  if (last && (last.end === null || last.end >= duration - EDGE_S) && last.start > EDGE_S) {
    trailMs = Math.round(Math.max(0, duration - last.start) * 1000);
  }
  // A file that is silence from end to end: the lead-in is all of it; nothing to call a tail.
  if (last && last === first && first.start <= EDGE_S && (first.end === null || first.end >= duration - EDGE_S)) trailMs = 0;
  return { leadMs, trailMs };
}

const STDERR_HEAD = 64 * 1024;
const STDERR_TAIL = 8 * 1024;

export interface MeasureOptions {
  ffmpeg?: string;
  timeoutMs?: number;
  nice?: boolean;
}

/** One file -> its edge silence, or null (no file, ffmpeg failed or timed out, unknown length). */
export function measureFile(filePath: string, { ffmpeg = process.env.SILENCE_FFMPEG || 'ffmpeg', timeoutMs = 120_000, nice = true }: MeasureOptions = {}): Promise<EdgeSilence | null> {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-threads', '1', '-i', filePath,
      '-map', '0:a:0', '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_S}`, '-f', 'null', '-'];
    let proc;
    try {
      proc = nice ? spawn('nice', ['-n', '19', ffmpeg, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
        : spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    // Keep the head (the first silences) and the tail (the last ones and the length).
    let head = '';
    let tail = '';
    let done = false;
    const finish = (value: EdgeSilence | null) => { if (!done) { done = true; clearTimeout(watchdog); resolve(value); } };
    const watchdog = setTimeout(() => { proc.kill('SIGKILL'); finish(null); }, timeoutMs);
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      if (head.length < STDERR_HEAD) head += s.slice(0, STDERR_HEAD - head.length);
      tail = (tail + s).slice(-STDERR_TAIL);
    });
    proc.on('error', () => finish(null));
    proc.on('close', (code: number | null, signal: string | null) => {
      if (code !== 0 || signal) { finish(null); return; }
      // Lines cut where head and tail meet are dropped by the parser.
      finish(edgeSilence(parseSilencedetect(head.length < STDERR_HEAD ? head : `${head}\n${tail}`)));
    });
  });
}

/** ffmpeg answers at all (the scanner stays off without it). */
export function ffmpegAvailable(ffmpeg = process.env.SILENCE_FFMPEG || 'ffmpeg'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpeg, ['-hide_banner', '-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// ------------------------------------------------------------------ scanner

export interface SilenceDb extends Queryable {
  isAvailable(): boolean;
}

export interface SilenceScannerDeps {
  db: SilenceDb;
  /** The songs folder (library.SONGS_PATH): off when it is not there. */
  songsPath?: string | null;
  /** library.songsFile: a row's path inside the songs folder, or a throw (never read a file outside it). */
  songsFile?: (filePath: string) => string;
  measure?: (filePath: string) => Promise<EdgeSilence | null>;
  ffmpegCheck?: () => Promise<boolean>;
  /** Wait after boot before the backfill starts. */
  startDelayMs?: number;
  /** Pause between two songs. */
  pauseMs?: number;
  /** At most this many uploads / replaces waiting (the backfill picks up the rest). */
  maxQueued?: number;
  log?: (msg: string) => void;
  enabled?: boolean;
}

export interface SilenceStats {
  enabled: boolean;
  /** Why it is off, when it is. */
  reason: string | null;
  running: boolean;
  measured: number | null;
  unmeasured: number | null;
  /** This boot's backfill pass is over (what is left failed or has no file). */
  passDone: boolean;
  /** Done in this boot: measured, skipped. */
  done: number;
  skipped: number;
}

export interface SilenceScanner {
  start(): Promise<void>;
  /** An upload was stored: measure it soon. */
  songAdded(song: { id: string } | null | undefined): void;
  /** A song's audio was replaced: forget the old numbers, measure the new file soon. */
  songReplaced(song: { id: string } | null | undefined): void;
  stats(): Promise<SilenceStats>;
  stop(): void;
  /** Tests: resolves when nothing is queued and the backfill pass is over. */
  idle(): Promise<void>;
}

interface Row { id: string; file_path: string; created_at: Date | string }

export function createSilenceScanner({
  db, songsPath = null, songsFile = (f) => f, measure = (f) => measureFile(f), ffmpegCheck = () => ffmpegAvailable(),
  startDelayMs = 30_000, pauseMs = 2_000, maxQueued = 200, log = (m) => console.log(m),
  enabled = process.env.SILENCE_SCAN !== 'off',
}: SilenceScannerDeps): SilenceScanner {
  let on = false;
  let reason: string | null = enabled ? 'not started' : 'switched off';
  let stopped = false;
  let looping = false;
  let passDone = false;
  let cursor: { created_at: Date | string; id: string } | null = null;
  const queue: { id: string; reset: boolean }[] = [];
  let done = 0;
  let skipped = 0;
  let wake: (() => void) | null = null;
  let idleWaiters: (() => void)[] = [];
  let lastProgress = Date.now();
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;

  const pause = (ms: number) => new Promise<void>((r) => { pauseTimer = setTimeout(r, ms); pauseTimer.unref?.(); });

  function enqueue(id: string, reset: boolean): void {
    if (!on || stopped || !id) return;
    const at = queue.findIndex((q) => q.id === id);
    if (at >= 0) { queue[at].reset = queue[at].reset || reset; return; }
    if (queue.length >= maxQueued) return; // still NULL: the next boot's pass measures it
    queue.push({ id, reset });
    if (wake) { const w = wake; wake = null; w(); }
  }

  async function nextUnmeasured(): Promise<Row | null> {
    const r = cursor
      ? await db.query<Row>(
        `SELECT id::text AS id, file_path, created_at FROM library_songs
          WHERE lead_silence_ms IS NULL AND (created_at, id) < ($1, $2::uuid)
          ORDER BY created_at DESC, id DESC LIMIT 1`, [cursor.created_at, cursor.id])
      : await db.query<Row>(
        `SELECT id::text AS id, file_path, created_at FROM library_songs
          WHERE lead_silence_ms IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`);
    return r.rows[0] || null;
  }

  async function measureRow(row: { id: string; file_path: string }): Promise<boolean> {
    let file: string;
    try { file = songsFile(row.file_path); } catch { return false; } // outside the songs folder: never touched
    try { await fs.promises.access(file, fs.constants.R_OK); } catch { return false; }
    const result = await measure(file);
    if (!result) return false;
    // Only while the song still has this file (a replace may have committed meanwhile).
    await db.query(
      'UPDATE library_songs SET lead_silence_ms = $2, trail_silence_ms = $3 WHERE id = $1 AND file_path = $4',
      [row.id, result.leadMs, result.trailMs, row.file_path]);
    return true;
  }

  function progress(force = false): void {
    if (!force && done % 100 !== 0 && Date.now() - lastProgress < 10 * 60_000) return;
    lastProgress = Date.now();
    db.query<{ n: number }>('SELECT count(*)::int AS n FROM library_songs WHERE lead_silence_ms IS NULL')
      .then((r) => log(`[silence] ${done} measured, ${skipped} skipped this boot; ${r.rows[0].n} songs still unmeasured`))
      .catch(() => {});
  }

  async function loop(): Promise<void> {
    if (looping) return;
    looping = true;
    try {
      while (!stopped) {
        const job = queue.shift();
        let row: { id: string; file_path: string } | null = null;
        if (job) {
          if (job.reset) await db.query('UPDATE library_songs SET lead_silence_ms = NULL, trail_silence_ms = NULL WHERE id = $1', [job.id]).catch(() => {});
          const r = await db.query<Row>('SELECT id::text AS id, file_path, created_at FROM library_songs WHERE id = $1', [job.id]).catch(() => ({ rows: [] as Row[] }));
          row = r.rows[0] || null;
        } else if (!passDone) {
          const next = await nextUnmeasured().catch((err) => { log(`[silence] backfill query failed: ${err.message}`); return null; });
          if (next) { cursor = { created_at: next.created_at, id: next.id }; row = next; }
          else {
            passDone = true;
            log(`[silence] backfill pass done: ${done} measured, ${skipped} skipped (missing file or no answer from ffmpeg; tried again at the next start)`);
          }
        }
        if (!row) {
          if (!job) {
            // Nothing to do: wait for an upload or a replace.
            for (const w of idleWaiters) w();
            idleWaiters = [];
            await new Promise<void>((r) => { wake = r; });
          }
          continue;
        }
        const ok = await measureRow(row).catch(() => false);
        if (ok) done += 1; else skipped += 1;
        progress();
        if (!stopped && pauseMs > 0) await pause(pauseMs);
      }
    } finally {
      looping = false;
    }
  }

  return {
    async start() {
      if (!enabled) { log('[silence] off (SILENCE_SCAN)'); return; }
      if (!db.isAvailable()) { reason = 'no database'; return; }
      if (songsPath && !fs.existsSync(songsPath)) { reason = `no songs folder (${songsPath})`; log(`[silence] off: ${reason}`); return; }
      if (!(await ffmpegCheck())) { reason = 'ffmpeg not found'; log('[silence] off: ffmpeg not found'); return; }
      on = true;
      reason = null;
      const begin = () => {
        if (stopped) return;
        db.query<{ n: number }>('SELECT count(*)::int AS n FROM library_songs WHERE lead_silence_ms IS NULL')
          .then((r) => log(`[silence] measuring lead-in / tail silence: ${r.rows[0].n} songs to go (niced, one at a time, ${pauseMs} ms apart)`))
          .catch(() => {});
        loop().catch((err) => log(`[silence] stopped: ${err.message}`));
      };
      if (startDelayMs > 0) { startTimer = setTimeout(begin, startDelayMs); startTimer.unref?.(); } else begin();
    },
    songAdded(song) { if (song && song.id) enqueue(String(song.id), false); },
    songReplaced(song) { if (song && song.id) enqueue(String(song.id), true); },
    async stats() {
      let measured: number | null = null;
      let unmeasured: number | null = null;
      if (db.isAvailable()) {
        const r = await db.query<{ measured: number; unmeasured: number }>(
          `SELECT count(*) FILTER (WHERE lead_silence_ms IS NOT NULL)::int AS measured,
                  count(*) FILTER (WHERE lead_silence_ms IS NULL)::int AS unmeasured FROM library_songs`).catch(() => null);
        if (r && r.rows[0]) ({ measured, unmeasured } = r.rows[0]);
      }
      return { enabled: on, reason, running: looping && !passDone, measured, unmeasured, passDone, done, skipped };
    },
    stop() {
      stopped = true;
      if (startTimer) clearTimeout(startTimer);
      if (pauseTimer) clearTimeout(pauseTimer);
      if (wake) { const w = wake; wake = null; w(); }
    },
    idle() {
      if (!on || stopped || (passDone && !queue.length && !looping) || (passDone && !queue.length && wake)) return Promise.resolve();
      return new Promise((r) => { idleWaiters.push(r); });
    },
  };
}
