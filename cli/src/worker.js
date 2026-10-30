'use strict';

/**
 * `la worker`: a downloader that connects OUT to the server and runs download
 * jobs (no listening port on this machine).
 *
 * Transport: one WebSocket to <server>/api/workers/connect (Node's built-in
 * WebSocket, Node >= 22; no dependencies). JSON messages; the protocol is
 * documented in backend/src/workerHub.js. The token goes in the first
 * message (hello), not the URL, so it never lands in proxy access logs.
 *
 * Reconnects with exponential backoff (1s .. 60s, jittered) after any drop,
 * and when the server has been silent for 3 heartbeats. A job keeps running
 * across a reconnect: its uploads are plain HTTP, the hello names the job
 * still in progress, and a result that could not be sent is sent after the
 * next welcome.
 */

const os = require('os');
const { EXIT, CliError } = require('./errors');

/** Close codes from the server that mean "do not reconnect". */
const FATAL_CLOSE = {
  4001: { code: 'AUTH', exitCode: EXIT.AUTH, message: 'The server refused the token (revoked, or its owner is not approved)' },
  4003: { code: 'REPLACED', exitCode: EXIT.FAILURE, message: 'Another `la worker` connected with the same name; use --name to run more than one' },
  4005: { code: 'NO_DATABASE', exitCode: EXIT.SERVER, message: 'The server has no database; it cannot hand out download jobs' },
};

function workerUrl(server) {
  const u = new URL(server.replace(/\/+$/, '') + '/api/workers/connect');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

/** Machine facts sent in the hello (shown to admins only). */
function machineInfo() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    os_release: `${os.type()} ${os.release()}`.slice(0, 128),
    node_version: process.versions.node,
  };
}

class WorkerClient {
  /**
   * @param {object} o
   * @param {string} o.server - base URL
   * @param {string} o.token
   * @param {object} o.hello - extra hello fields (name, cli_version, ytdlp_version, machine info)
   * @param {(job, ctl: {progress, signal}) => Promise<object>} o.runJob - returns { kind: 'done', result } or { kind: 'release', reason }
   * @param {object} o.out - Output
   * @param {Function} [o.WebSocket]
   * @param {(event, data) => void} [o.onEvent] - connected / disconnected / job_started / job_finished
   * @param {number} [o.backoffMs] - first reconnect delay
   * @param {number} [o.maxBackoffMs]
   */
  constructor(o) {
    this.url = workerUrl(o.server);
    this.token = o.token;
    this.hello = o.hello || {};
    this.runJob = o.runJob;
    this.out = o.out;
    this.WebSocket = o.WebSocket || globalThis.WebSocket;
    this.onEvent = o.onEvent || (() => {});
    this.backoffMs = o.backoffMs ?? 1000;
    this.maxBackoffMs = o.maxBackoffMs ?? 60000;
    this.attempt = 0;
    this.ws = null;
    this.welcomed = false;
    this.worker = null; // { id, name } from welcome
    this.heartbeatMs = 25000;
    this.current = null; // { job, abort: AbortController, promise }
    this.pendingReports = []; // messages to send after the next welcome
    this.stopping = null; // null | 'drain' | 'abort'
    this.reconnectTimer = null;
    this.watchdog = null;
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    this.finished = false;
  }

  /** Connect and keep going until stop() / a fatal close. Resolves with an exit code. */
  start() {
    if (typeof this.WebSocket !== 'function') {
      throw new CliError('`la worker` needs Node.js 22 or newer (built-in WebSocket)', { code: 'NODE_TOO_OLD', exitCode: EXIT.DEPENDENCY, hint: 'Install a current Node.js LTS from https://nodejs.org' });
    }
    this.connect();
    return this.done;
  }

  finish(code, err) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdog);
    if (err) this.rejectDone(err); else this.resolveDone(code);
  }

  send(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.welcomed) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  /** Send now, or after the next welcome if the connection is down. */
  report(msg) {
    if (!this.send(msg)) this.pendingReports.push(msg);
  }

  connect() {
    if (this.finished) return;
    this.welcomed = false;
    let ws;
    try {
      ws = new this.WebSocket(this.url);
    } catch (err) {
      this.out.warn(`Cannot open ${this.url}: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({
        type: 'hello',
        protocol: 1,
        token: this.token,
        ...machineInfo(),
        ...this.hello,
        current_job_id: this.current ? this.current.job.id : undefined,
      }));
      this.armWatchdog();
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      this.armWatchdog();
      this.handle(msg);
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      clearTimeout(this.watchdog);
      const fatal = FATAL_CLOSE[ev.code];
      if (fatal) {
        this.out.error({ code: fatal.code, message: fatal.message });
        this.onEvent('disconnected', { code: ev.code, fatal: fatal.code });
        this.abortCurrent();
        this.finish(fatal.exitCode);
        return;
      }
      if (this.stopping && !this.current) { this.finish(this.stopping === 'abort' ? 130 : EXIT.OK); return; }
      if (wasWelcomed) {
        this.out.warn(`Disconnected from the server${ev.code && ev.code !== 1006 ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : ''}; reconnecting…`);
        this.onEvent('disconnected', { code: ev.code });
      }
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => { /* a close event follows */ });
  }

  armWatchdog() {
    clearTimeout(this.watchdog);
    // No ping (or anything) for 3 heartbeats: the connection is dead.
    this.watchdog = setTimeout(() => {
      this.out.warn('No word from the server; reconnecting…');
      const ws = this.ws;
      this.ws = null;
      try { ws && ws.close(); } catch {}
      this.scheduleReconnect();
    }, this.heartbeatMs * 3 + 5000);
    this.watchdog.unref?.();
  }

  scheduleReconnect() {
    if (this.finished) return;
    if (this.stopping && !this.current) { this.finish(this.stopping === 'abort' ? 130 : EXIT.OK); return; }
    clearTimeout(this.reconnectTimer);
    const base = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this.out.debug(`Reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  handle(msg) {
    switch (msg.type) {
      case 'welcome': {
        this.welcomed = true;
        this.attempt = 0;
        this.worker = msg.worker || null;
        if (Number(msg.heartbeat_ms) > 0) this.heartbeatMs = Number(msg.heartbeat_ms);
        this.armWatchdog();
        this.onEvent('connected', { worker: this.worker, owner: msg.owner || null });
        for (const m of this.pendingReports.splice(0)) this.send(m);
        if (this.stopping) this.send({ type: 'drain' });
        return;
      }
      case 'ping':
        this.send({ type: 'pong', t: msg.t });
        return;
      case 'job':
        this.startJob(msg.job);
        return;
      case 'error':
        this.out.debug(`server: ${msg.code}: ${msg.message}`);
        return;
      default:
    }
  }

  startJob(job) {
    if (!job || typeof job.id !== 'string') return;
    if (this.current || this.stopping) {
      this.send({ type: 'job:reject', job_id: job.id, reason: this.current ? 'busy' : 'shutting down' });
      return;
    }
    const abort = new AbortController();
    const progress = (stage, message) => this.send({ type: 'job:progress', job_id: job.id, stage, message });
    this.onEvent('job_started', { job });
    const current = { job, abort };
    this.current = current;
    current.promise = (async () => {
      let outcome;
      try {
        outcome = await this.runJob(job, { progress, signal: abort.signal, workerId: () => (this.worker ? this.worker.id : null) });
      } catch (err) {
        outcome = { kind: 'done', result: { summary: { total: 1, uploaded: 0, skipped: 0, failed: 1 }, results: [{ status: 'failed', code: err.code || 'ERROR', error: err.message }], error_code: err.code || 'ERROR', error_message: err.message } };
      }
      if (this.current !== current) return; // aborted: already released
      this.current = null;
      if (outcome.kind === 'release') {
        this.report({ type: 'job:release', job_id: job.id, reason: outcome.reason || 'error' });
      } else {
        this.report({ type: 'job:done', job_id: job.id, result: outcome.result });
      }
      this.onEvent('job_finished', { job, outcome });
      if (outcome.fatal) {
        this.out.error(outcome.fatal);
        this.stopping = 'abort';
        this.closeSoon(outcome.fatal.exitCode || EXIT.FAILURE);
        return;
      }
      if (this.stopping) this.closeSoon(EXIT.OK);
    })();
  }

  /** Let the last report flush, then close. */
  closeSoon(code) {
    const ws = this.ws;
    setTimeout(() => {
      try { if (ws) ws.close(1000, 'bye'); } catch {}
      this.finish(code);
    }, 50);
  }

  abortCurrent() {
    const cur = this.current;
    if (!cur) return null;
    this.current = null;
    cur.abort.abort();
    return cur;
  }

  /**
   * Graceful stop: no new jobs; finish the running one, report it, exit 0.
   * Again (or abort=true): give the running job back to the server now.
   */
  stop({ abort = false } = {}) {
    if (this.finished) return;
    if (!abort && !this.stopping) {
      this.stopping = 'drain';
      this.send({ type: 'drain' });
      if (!this.current) { this.closeSoon(EXIT.OK); return; }
      this.out.info(`Finishing the current job (${this.current.job.title || this.current.job.input}); press Ctrl+C again to stop now and give it back.`);
      return;
    }
    this.stopping = 'abort';
    const cur = this.abortCurrent();
    if (cur) {
      this.send({ type: 'job:release', job_id: cur.job.id, reason: 'shutdown' });
      this.out.info('Stopped; the job was given back to the server.');
      this.closeSoon(130);
      return;
    }
    this.closeSoon(EXIT.OK);
  }
}

module.exports = { WorkerClient, workerUrl, machineInfo, FATAL_CLOSE };
