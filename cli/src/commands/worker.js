'use strict';

const os = require('os');
const readline = require('readline');
const { UsageError, CliError, EXIT } = require('../errors');
const { Output } = require('../output');
const { Batch } = require('../batch');
const { downloadAndUpload, isFatal } = require('../pipeline');
const { classify } = require('../youtube');
const proc = require('../proc');
const tools = require('../tools');
const config = require('../config');
const { WorkerClient } = require('../worker');
const pkg = require('../../package.json');

/** Output for one job: progress lines go to the terminal AND to the server. */
class JobOutput extends Output {
  constructor(base, jobId, onProgress) {
    super({ stdout: base.stdout, stderr: base.stderr, json: base.json, quiet: base.quiet, verbose: base.verbose });
    this.prefix = `[job ${String(jobId).slice(0, 8)}] `;
    this.onProgress = onProgress;
  }

  static stageOf(msg) {
    if (/^Downloading /.test(msg)) return 'downloading';
    if (/^(Uploading|Replacing) /.test(msg)) return 'uploading';
    if (/^(Searching|Listing|\s+→|\s+\d+ video)/.test(msg)) return 'resolving';
    if (/^Using local copy/.test(msg)) return 'uploading';
    return 'working';
  }

  info(msg) {
    if (!this.quiet) this.stderr.write(`${this.prefix}${msg}\n`);
    try { this.onProgress(JobOutput.stageOf(msg), String(msg).trim().slice(0, 300)); } catch { /* connection gone */ }
  }

  warn(msg) {
    this.stderr.write(`${this.prefix}warning: ${msg}\n`);
  }
}

/** Short, server-friendly per-item results. */
function itemResult(r) {
  const out = { status: r.status };
  for (const k of ['title', 'artist', 'youtube_id', 'code', 'error', 'reason']) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  const songId = (r.song && r.song.id) || (r.duplicate_of && r.duplicate_of.id);
  if (songId) out.song_id = songId;
  return out;
}

/** Ask a yes/no question on a terminal; false when not interactive. */
async function askYesNo(ctx, question) {
  if (ctx.deps.prompt) return ctx.deps.prompt(question);
  const stdin = process.stdin;
  if (!stdin.isTTY || ctx.out.json) return false;
  const rl = readline.createInterface({ input: stdin, output: ctx.out.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [Y/n] `, resolve));
    return !/^n/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

/**
 * Make sure a usable yt-dlp is there: offer the official standalone binary
 * when it is missing or old (unless LA_YTDLP_BIN pins one).
 * @returns {Promise<string>} the yt-dlp version
 */
async function ensureYtdlp(ctx, values) {
  const pinned = !!ctx.env.LA_YTDLP_BIN;
  const dir = tools.toolsDir(ctx.env);
  const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;
  const install = async () => {
    await tools.installYtdlp({ env: ctx.env, fetch: ctx.deps.fetch || globalThis.fetch, out: ctx.out });
    return ctx.makeYtdlp(values['ytdlp-args']).version();
  };
  let version;
  try {
    version = await ctx.makeYtdlp(values['ytdlp-args']).version();
  } catch (err) {
    if (err.exitCode !== EXIT.DEPENDENCY || pinned) throw err;
    if (values['install-ytdlp'] || await askYesNo(ctx, `yt-dlp is not installed. Download the official yt-dlp for ${osName} into ${dir}?`)) return install();
    err.hint = `Run \`la worker --install-ytdlp\` to download the official yt-dlp into ${dir}, or install it yourself. ${err.hint || ''}`.trim();
    throw err;
  }
  if (tools.isOutdated(version)) {
    const age = tools.versionAgeDays(version);
    const msg = `yt-dlp ${version} is ${age} days old; YouTube downloads often break with an old yt-dlp.`;
    if (!pinned && (values['install-ytdlp'] || await askYesNo(ctx, `${msg} Download the latest official yt-dlp into ${dir}?`))) return install();
    ctx.out.warn(`${msg} Update it${pinned ? ` (LA_YTDLP_BIN=${ctx.env.LA_YTDLP_BIN})` : ' (`la worker --install-ytdlp`)'}.`);
  } else if (values['install-ytdlp'] && !pinned) {
    return install();
  }
  return version;
}

/**
 * Run one job with the download -> upload pipeline. Uploads carry job_id and
 * worker_id so the server records who did it.
 * @returns {Promise<{kind: 'done', result}|{kind: 'release', reason, fatal?}>}
 */
async function runJob(ctx, values, opts, job, { progress, signal, workerId }) {
  const jobOut = new JobOutput(ctx.out, job.id, progress);
  const kind = classify(job.input, { noPlaylist: job.no_playlist !== false }).kind;
  if (kind === 'url') {
    // Only YouTube links and searches: never fetch an arbitrary URL.
    return { kind: 'done', result: { summary: { total: 1, uploaded: 0, skipped: 0, failed: 1 }, results: [{ status: 'failed', code: 'UNSUPPORTED_INPUT', error: 'Not a YouTube link or search' }], error_code: 'UNSUPPORTED_INPUT', error_message: 'Not a YouTube link or search' } };
  }
  const aborted = () => Object.assign(new CliError('Stopped', { code: 'ABORTED' }));
  const children = new Set();
  const killAll = () => { for (const c of children) proc.killTree(c); };
  signal.addEventListener('abort', killAll, { once: true });
  const trackedRun = (bin, args, o = {}) => {
    if (signal.aborted) return Promise.reject(aborted());
    return proc.run(bin, args, {
      ...o,
      detached: true,
      onSpawn: (child) => { children.add(child); child.once('close', () => children.delete(child)); },
    });
  };
  const base = ctx.getApi();
  const api = Object.create(base);
  api.upload = (file, fields) => {
    if (signal.aborted) return Promise.reject(aborted());
    const extra = { job_id: job.id };
    const wid = workerId();
    if (wid) extra.worker_id = wid;
    return base.upload.call(api, file, { ...fields, ...extra });
  };
  const sleep = (ms) => new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  const deps = {
    out: jobOut,
    ytdlp: ctx.makeYtdlp(values['ytdlp-args'], { run: trackedRun, out: jobOut }),
    media: ctx.makeMedia({ run: trackedRun }),
    getApi: () => api,
    sleep: ctx.deps.sleep || sleep,
  };
  const batch = new Batch(jobOut);
  const input = { input: job.input, label: job.title || job.input, noPlaylist: job.no_playlist !== false };
  if (job.request_id) input.request_id = job.request_id;
  try {
    await downloadAndUpload(deps, [input], { ...opts, skipLibraryCheck: true }, batch);
  } catch (err) {
    if (!isFatal(err)) throw err;
    // Auth / server unreachable / missing tool: give the job back.
    const fatal = err.exitCode === EXIT.AUTH || err.exitCode === EXIT.DEPENDENCY ? err : null;
    return { kind: 'release', reason: `${err.code || 'ERROR'}: ${err.message}`.slice(0, 200), fatal };
  } finally {
    signal.removeEventListener('abort', killAll);
  }
  return { kind: 'done', result: { summary: batch.summary(), results: batch.results.map(itemResult) } };
}

module.exports = {
  name: 'worker',
  summary: 'Run as a downloader: take download jobs from the server and upload the songs',
  usage: 'la worker [--name NAME] [--install-ytdlp] [options]',
  description: `Connects OUT to the server (a WebSocket to <server>/api/workers/connect; nothing
listens on this computer) with your token and waits for download jobs. A job
comes from a song request (someone queued a song the library does not have) or
from the web app's Download box (a YouTube video / playlist link, a Spotify
track link, or a search). Each job runs the same pipeline as \`la download\`
(yt-dlp m4a without re-encoding, tags, cover, duplicate checks) and uploads the
result; a request's song is then added to the playlist it was requested from,
a Download-box job's songs to the playlist the requester chose.

One job at a time; --sleep seconds between YouTube downloads (also between
jobs). Routing is done by the server: your own requests go to your own worker
when it is idle, anyone's otherwise. Progress and the result of every job are
reported to the server, which shows them live to whoever asked.

The worker shows up as "<name> (<your name>)" to everyone (uploads read
"uploaded by <name> (<you>)"). Its hostname, OS, IP and versions are visible
to admins only. --name defaults to this computer's hostname; give every
machine you run a worker on its own name.

Connection: reconnects by itself (1s, 2s, 4s … 60s) after a network drop or a
server restart; a job in progress keeps running and is reported after the
reconnect. If the worker disappears mid-job the server gives the job to
another worker after ~20s.

Stopping: Ctrl+C (or SIGTERM; Ctrl+Break on Windows) lets the current job
finish and report, then exits 0. A second Ctrl+C stops the download now and
gives the job back to the server (exit 130). Downloads run in their own
process group, so the first Ctrl+C does not kill them.

Tools: needs ffmpeg/ffprobe (install hint per OS if missing) and yt-dlp. If
yt-dlp is missing or more than ${tools.MAX_AGE_DAYS} days old the worker offers to download the
official standalone binary for this OS into ${tools.toolsDir()}
(LA_TOOLS_DIR overrides), verified against the release checksums;
--install-ytdlp does it without asking (also to update). LA_YTDLP_BIN pins a
yt-dlp and turns this off. The installed copy is also used by \`la download\`.
Needs Node.js 22 or newer.`,
  options: {
    name: { type: 'string', value: 'NAME', desc: 'Worker name shown to everyone (default: this computer\'s hostname)' },
    'install-ytdlp': { type: 'boolean', desc: 'Download / update the official standalone yt-dlp into the tools dir without asking' },
    sleep: { type: 'string', value: 'SEC', desc: 'Seconds between YouTube downloads (config `sleep`, default 3)' },
    keep: { type: 'boolean', desc: 'Also keep a local copy of every downloaded song in the keep dir' },
    'keep-dir': { type: 'string', value: 'DIR', desc: 'Directory for --keep (config `keep-dir`, default ~/Music/listen-along)' },
    'ytdlp-args': { type: 'string', multiple: true, value: 'ARGS', desc: 'Extra yt-dlp arguments, shell-quoted; use the = form' },
  },
  output: `Progress and job lines on stderr. With --json, one JSON object per line on
stdout for each event:
  {"event":"ready","name","server","user","ytdlp_version"}
  {"event":"connected","worker":{"id","name"}}
  {"event":"job_started","job":{"id","kind","input","title","request_id"}}
  {"event":"job_finished","job_id","status":"done|released","summary"?,"reason"?}
  {"event":"disconnected","code"}
  {"event":"stopped","exit_code"}
Exit: 0 after a graceful stop, 130 after a second Ctrl+C, 3 not configured,
4 token refused, 6 missing tool, 1 another worker took this name.`,
  examples: [
    'la worker',
    'la worker --name "living-room-pc"',
    'la worker --install-ytdlp            # get / update the official yt-dlp first',
    'la worker --sleep 10 --keep',
    'la worker --json > worker-events.log',
  ],
  ensureYtdlp,
  runJob,
  JobOutput,
  async run(ctx, values, positionals) {
    if (positionals.length) throw new UsageError(`Unexpected argument: ${positionals[0]}`, 'See `la worker --help`');
    const name = String(values.name ?? os.hostname()).trim().slice(0, 100);
    if (!name) throw new UsageError('--name must not be empty');
    let sleepSec = Number(ctx.cfg.values.sleep);
    if (values.sleep !== undefined) {
      sleepSec = Number(values.sleep);
      if (!Number.isFinite(sleepSec) || sleepSec < 0) throw new UsageError(`--sleep must be a non-negative number, got: ${values.sleep}`);
    }
    const { server, token } = config.requireServer(ctx.cfg);
    const WebSocketImpl = ctx.deps.WebSocket || globalThis.WebSocket;
    if (typeof WebSocketImpl !== 'function') {
      throw new CliError('`la worker` needs Node.js 22 or newer (built-in WebSocket)', { code: 'NODE_TOO_OLD', exitCode: EXIT.DEPENDENCY, hint: 'Install a current Node.js LTS from https://nodejs.org' });
    }
    const out = ctx.out;
    const event = (data) => { if (out.json) out.stdout.write(`${JSON.stringify(data)}\n`); };

    await ctx.makeMedia().check();
    const ytdlpVersion = await ensureYtdlp(ctx, values);
    const me = await ctx.getApi().me();
    const who = (me && (me.user ? me.user.name : me.name)) || 'unknown';
    out.info(`la worker "${name}" for ${who} on ${server} (yt-dlp ${ytdlpVersion}, la ${pkg.version})`);
    event({ event: 'ready', name, server, user: who, ytdlp_version: ytdlpVersion });

    const keepDir = values['keep-dir'] || ctx.cfg.values['keep-dir'];
    const opts = { dryRun: false, keep: !!values.keep, keepDir: keepDir ? keepDir.replace(/^~(?=$|[\\/])/, os.homedir()) : keepDir, sleepSec, upload: true };
    let lastDownloadEnd = 0;
    const wait = ctx.deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    const client = new WorkerClient({
      server,
      token,
      out,
      WebSocket: WebSocketImpl,
      backoffMs: ctx.deps.backoffMs,
      maxBackoffMs: ctx.deps.maxBackoffMs,
      hello: { name, cli_version: pkg.version, ytdlp_version: ytdlpVersion },
      runJob: async (job, ctl) => {
        const since = Date.now() - lastDownloadEnd;
        if (lastDownloadEnd && sleepSec > 0 && since < sleepSec * 1000) await wait(sleepSec * 1000 - since);
        try {
          return await runJob(ctx, values, opts, job, ctl);
        } finally {
          lastDownloadEnd = Date.now();
        }
      },
      onEvent: (type, data) => {
        if (type === 'connected') {
          out.info(`Connected as worker "${data.worker ? data.worker.name : name}"; waiting for jobs…`);
          event({ event: 'connected', worker: data.worker });
        } else if (type === 'disconnected') {
          event({ event: 'disconnected', code: data.code });
        } else if (type === 'job_started') {
          const j = data.job;
          out.info(`Job ${j.id.slice(0, 8)}: ${j.title || j.input}${j.requested_by ? ` (asked by ${j.requested_by})` : ''}`);
          event({ event: 'job_started', job: { id: j.id, kind: j.kind, input: j.input, title: j.title, request_id: j.request_id } });
        } else if (type === 'job_finished') {
          const o = data.outcome;
          if (o.kind === 'done') {
            const s = o.result.summary || {};
            out.info(`Job ${data.job.id.slice(0, 8)} finished: ${s.uploaded || 0} uploaded, ${s.skipped || 0} skipped, ${s.failed || 0} failed`);
            event({ event: 'job_finished', job_id: data.job.id, status: 'done', summary: s });
          } else {
            out.info(`Job ${data.job.id.slice(0, 8)} given back: ${o.reason}`);
            event({ event: 'job_finished', job_id: data.job.id, status: 'released', reason: o.reason });
          }
        }
      },
    });

    // Ctrl+C: finish the job; again: give it back. Windows has no SIGTERM;
    // Ctrl+Break is SIGBREAK, closing the console window SIGHUP.
    const signals = ctx.deps.signals || process;
    let presses = 0;
    const onStop = () => { presses++; client.stop({ abort: presses > 1 }); };
    const onHangup = () => client.stop({ abort: true });
    const names = ['SIGINT', 'SIGTERM', 'SIGBREAK'].filter((s) => s !== 'SIGBREAK' || process.platform === 'win32' || signals !== process);
    for (const s of names) signals.on(s, onStop);
    signals.on('SIGHUP', onHangup);
    try {
      const code = await client.start();
      event({ event: 'stopped', exit_code: code });
      return code;
    } finally {
      for (const s of names) signals.removeListener(s, onStop);
      signals.removeListener('SIGHUP', onHangup);
    }
  },
};
