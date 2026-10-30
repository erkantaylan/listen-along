/**
 * Worker hub: `la worker` processes connect OUT to the server over a
 * WebSocket (GET /api/workers/connect, upgraded; nothing listens on the
 * user's machine) and receive download jobs.
 *
 * Protocol (JSON text messages, one object per message, `type` field):
 *
 *   worker -> server
 *     hello        { token, name, hostname, platform, arch, os_release,
 *                    cli_version, node_version, ytdlp_version, protocol,
 *                    current_job_id? }   first message, within HELLO_TIMEOUT
 *     pong         answer to ping
 *     job:progress { job_id, stage, message }
 *     job:done     { job_id, result: { summary, results, error_code?, error_message? } }
 *     job:release  { job_id, reason }   give a job back (shutdown, fatal error)
 *     job:reject   { job_id, reason }   "busy": never sent a second job, but be safe
 *     drain        stop sending me jobs (graceful shutdown in progress)
 *
 *   server -> worker
 *     welcome      { worker: {id, name}, user: {id, name}|null, heartbeat_ms }
 *     ping         every heartbeat_ms; a worker that hears nothing for ~3x
 *                  reconnects
 *     job          { job: { id, kind, input, title, request_id, requested_by, no_playlist } }
 *     error        { code, message } just before a close
 *
 *   Close codes: 4001 bad/revoked token, 4002 bad hello / protocol,
 *   4003 replaced (another process connected as the same worker), 4005 no DB.
 *
 * Routing (planAssignments): queued jobs oldest first; a job goes to an idle
 * worker of its requester if one is online, otherwise to any idle worker
 * (longest idle first); with no idle worker it stays queued ("waiting for a
 * downloader") and is dispatched when one connects or finishes. One job at a
 * time per worker. A worker that disconnects mid-job gets REQUEUE_GRACE to
 * come back (it reports the job it is still running in its hello); after that
 * the job is queued again for anyone.
 */

const { WebSocketServer } = require('ws');
const jobs = require('./downloadJobs');

const PATH = '/api/workers/connect';
const PROTOCOL = 1;

/**
 * Pure routing: which idle worker gets which queued job.
 * @param {object[]} queued - jobs oldest first ({ id, requested_by_user_id })
 * @param {object[]} idle - idle workers ({ userId, idleSince })
 * @returns {{job, worker}[]}
 */
function planAssignments(queued, idle) {
  const free = [...idle].sort((a, b) => (a.idleSince || 0) - (b.idleSince || 0));
  const plan = [];
  const rest = [];
  // 1. The requester's own idle worker, if any.
  for (const job of queued) {
    const i = job.requested_by_user_id ? free.findIndex((w) => w.userId && w.userId === job.requested_by_user_id) : -1;
    if (i >= 0) plan.push({ job, worker: free.splice(i, 1)[0] });
    else rest.push(job);
  }
  // 2. Anyone idle, oldest job first, longest-idle worker first.
  for (const job of rest) {
    if (!free.length) break;
    plan.push({ job, worker: free.shift() });
  }
  return plan;
}

/**
 * @param {object} opts
 * @param {(token: string) => Promise<object|null>} opts.verifyToken - tokens.verifyToken
 * @param {(req) => string} [opts.ipOf] - client IP of the upgrade request
 * @param {(job: object) => void} [opts.onJobUpdated] - any job state change (row)
 * @param {(job: object, songIds: string[]) => void} [opts.onJobFinished] - a worker finished it
 * @param {() => void} [opts.onWorkersChanged] - a worker connected / went idle / busy / away
 * @param {() => boolean} [opts.dbAvailable]
 * @param {number} [opts.heartbeatMs]
 * @param {number} [opts.requeueGraceMs]
 * @param {number} [opts.helloTimeoutMs]
 * @param {object} [opts.store] - downloadJobs (tests may stub)
 */
function createWorkerHub(opts = {}) {
  const store = opts.store || jobs;
  const verifyToken = opts.verifyToken;
  const ipOf = opts.ipOf || ((req) => (req.socket && req.socket.remoteAddress) || null);
  const onJobUpdated = opts.onJobUpdated || (() => {});
  const onJobFinished = opts.onJobFinished || (() => {});
  const onWorkersChanged = opts.onWorkersChanged || (() => {});
  const dbAvailable = opts.dbAvailable || (() => true);
  const heartbeatMs = opts.heartbeatMs ?? Number(process.env.WORKER_HEARTBEAT_MS || 25000);
  const requeueGraceMs = opts.requeueGraceMs ?? Number(process.env.WORKER_REQUEUE_GRACE_MS ?? 20000);
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10000;

  /** workerId -> conn { ws, worker, userId, ownerName, currentJobId, draining, idleSince, connectedAt, lastSeen } */
  const conns = new Map();
  const graceTimers = new Map(); // jobId -> timeout
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  let dispatching = Promise.resolve();
  let dispatchAgain = false;
  let sweepTimer = null;
  let pingTimer = null;
  let closed = false;

  const log = (...a) => console.log('[workers]', ...a);
  const safe = (fn) => { try { return fn(); } catch (err) { console.error('[workers] hook failed:', err); return undefined; } };
  const notify = (row) => { if (row) safe(() => onJobUpdated(row)); };

  function send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  function closeWith(ws, code, errCode, message) {
    send(ws, { type: 'error', code: errCode, message });
    try { ws.close(code, message.slice(0, 120)); } catch {}
  }

  function workerInfo(conn) {
    return { id: conn.worker.id, name: conn.worker.name, ownerName: conn.ownerName };
  }

  function stats() {
    let online = 0;
    let idle = 0;
    for (const c of conns.values()) {
      if (!c.ready) continue;
      online++;
      if (!c.currentJobId && !c.draining) idle++;
    }
    return { online, idle, busy: online - idle };
  }

  /** Live state of a worker id (for the views), or null if offline. */
  function live(workerId) {
    const c = conns.get(workerId);
    return c && c.ready ? { currentJobId: c.currentJobId, connectedAt: c.connectedAt, draining: c.draining } : null;
  }

  function onlineWorkers() {
    return [...conns.values()].filter((c) => c.ready).map((c) => ({
      id: c.worker.id, name: c.worker.name, owner: c.ownerName, busy: !!c.currentJobId,
    }));
  }

  // --- Dispatch -----------------------------------------------------------------

  /** Hand queued jobs to idle workers. Serialized; coalesces bursts. */
  function dispatch() {
    if (closed) return dispatching;
    dispatchAgain = true;
    dispatching = dispatching.then(async () => {
      while (dispatchAgain && !closed) {
        dispatchAgain = false;
        await dispatchOnce().catch((err) => console.error('[workers] dispatch failed:', err.message));
      }
    });
    return dispatching;
  }

  async function dispatchOnce() {
    if (!dbAvailable()) return;
    const idle = [...conns.values()].filter((c) => c.ready && !c.currentJobId && !c.draining);
    if (!idle.length) return;
    const queued = await store.listQueued(200);
    if (!queued.length) return;
    const plan = planAssignments(queued, idle.map((c) => ({ conn: c, userId: c.userId, idleSince: c.idleSince })));
    for (const { job, worker } of plan) {
      const conn = worker.conn;
      if (conn.currentJobId || conn.draining || conns.get(conn.worker.id) !== conn) continue;
      conn.currentJobId = job.id; // reserve before the await
      const row = await store.assign(job.id, workerInfo(conn));
      if (!row) { conn.currentJobId = null; continue; }
      if (!send(conn.ws, { type: 'job', job: store.toWorker(row) })) {
        conn.currentJobId = null;
        notify(await store.requeue(row.id, { workerId: conn.worker.id, reason: 'Downloader went away' }));
        dispatchAgain = true;
        continue;
      }
      log(`job ${row.id} (${row.title || row.input}) -> ${conn.worker.name} (${conn.ownerName || 'no owner'})`);
      notify(row);
    }
    safe(onWorkersChanged);
  }

  // --- Requeue ------------------------------------------------------------------

  function jobHeldLive(jobId) {
    for (const c of conns.values()) if (c.currentJobId === jobId) return true;
    return false;
  }

  async function requeueNow(jobId, workerId, reason) {
    clearTimeout(graceTimers.get(jobId));
    graceTimers.delete(jobId);
    if (jobHeldLive(jobId)) return;
    const row = await store.requeue(jobId, { workerId, reason }).catch((err) => { console.error('[workers] requeue failed:', err.message); return null; });
    if (row) {
      log(`job ${jobId} ${row.status === 'failed' ? 'failed (worker lost too often)' : 'requeued'}: ${reason}`);
      notify(row);
    }
    dispatch();
  }

  function scheduleRequeue(jobId, workerId, reason) {
    if (requeueGraceMs <= 0) { requeueNow(jobId, workerId, reason); return; }
    clearTimeout(graceTimers.get(jobId));
    graceTimers.set(jobId, setTimeout(() => requeueNow(jobId, workerId, reason), requeueGraceMs));
  }

  // --- Messages -----------------------------------------------------------------

  async function handleHello(ws, req, msg, state) {
    if (!dbAvailable()) return closeWith(ws, 4005, 'NO_DATABASE', 'The server has no database; downloads are unavailable');
    if (!msg || msg.type !== 'hello' || typeof msg.token !== 'string') return closeWith(ws, 4002, 'BAD_HELLO', 'Expected a hello message with a token');
    const apiUser = await verifyToken(msg.token).catch(() => null);
    if (!apiUser) return closeWith(ws, 4001, 'AUTH', 'Invalid or revoked token (or its owner is not approved)');
    if (ws.readyState !== ws.OPEN) return;
    const worker = await store.registerWorker(apiUser, msg, ipOf(req));
    const ownerName = store.workerOwnerName(worker) || apiUser.name;
    const prev = conns.get(worker.id);
    const conn = {
      ws, worker, userId: apiUser.userId || null, tokenId: apiUser.id, ownerName,
      currentJobId: null, draining: false, ready: false,
      idleSince: Date.now(), connectedAt: Date.now(), lastSeen: Date.now(),
    };
    state.conn = conn;
    conns.set(worker.id, conn);
    if (prev && prev.ws !== ws) {
      // The same worker (owner + name) connected again: a reconnect after a
      // network blip, or a second machine using the same name. The old one goes.
      prev.replaced = true;
      closeWith(prev.ws, 4003, 'REPLACED', `Another process connected as worker "${worker.name}"; use --name to run several`);
      if (prev.currentJobId && prev.currentJobId !== msg.current_job_id) {
        requeueNow(prev.currentJobId, worker.id, 'Downloader reconnected without it');
      }
    }
    // Still running a job from before a reconnect / server restart?
    if (typeof msg.current_job_id === 'string' && msg.current_job_id) {
      clearTimeout(graceTimers.get(msg.current_job_id));
      graceTimers.delete(msg.current_job_id);
      conn.currentJobId = msg.current_job_id; // busy either way until it reports
      const row = await store.reclaim(msg.current_job_id, workerInfo(conn)).catch(() => null);
      if (row) notify(row);
    }
    conn.ready = true;
    send(ws, {
      type: 'welcome',
      protocol: PROTOCOL,
      worker: { id: worker.id, name: worker.name },
      user: apiUser.user ? { id: apiUser.user.id, name: apiUser.user.name } : null,
      owner: ownerName,
      heartbeat_ms: heartbeatMs,
    });
    log(`${worker.name} (${ownerName || 'legacy token'}) connected from ${worker.last_ip || '?'}; cli ${worker.cli_version || '?'} on ${worker.platform || '?'}`);
    safe(onWorkersChanged);
    dispatch();
  }

  async function handleMessage(conn, msg) {
    conn.lastSeen = Date.now();
    const jobId = typeof msg.job_id === 'string' ? msg.job_id : null;
    switch (msg.type) {
      case 'pong':
        store.touchWorker(conn.worker.id);
        return;
      case 'drain':
        conn.draining = true;
        safe(onWorkersChanged);
        return;
      case 'job:progress': {
        if (!jobId || conn.currentJobId !== jobId) return;
        await store.setProgress(jobId, conn.worker.id, { stage: msg.stage, message: msg.message }).catch(() => {});
        const row = await store.getJob(jobId).catch(() => null);
        notify(row);
        return;
      }
      case 'job:done': {
        if (!jobId) return;
        const res = await store.finish(jobId, workerInfo(conn), msg.result || {}).catch((err) => {
          console.error('[workers] finish failed:', err.message);
          return null;
        });
        if (conn.currentJobId === jobId) { conn.currentJobId = null; conn.idleSince = Date.now(); }
        if (res) {
          log(`job ${jobId} ${res.job.status} on ${conn.worker.name}${res.job.error_code ? ` [${res.job.error_code}]` : ''}`);
          notify(res.job);
          safe(() => onJobFinished(res.job, res.songIds));
        }
        safe(onWorkersChanged);
        dispatch();
        return;
      }
      case 'job:release':
      case 'job:reject': {
        if (!jobId) return;
        if (conn.currentJobId === jobId) { conn.currentJobId = null; conn.idleSince = Date.now(); }
        if (msg.type === 'job:release') conn.draining = conn.draining || msg.reason === 'shutdown';
        await requeueNow(jobId, conn.worker.id, msg.reason === 'shutdown' ? 'Downloader shut down' : `Given back: ${String(msg.reason || '').slice(0, 200)}`);
        safe(onWorkersChanged);
        return;
      }
      default:
    }
  }

  function onConnection(ws, req) {
    const state = { conn: null, helloDone: false };
    let chain = Promise.resolve();
    const helloTimer = setTimeout(() => {
      if (!state.helloDone) closeWith(ws, 4002, 'HELLO_TIMEOUT', 'No hello received');
    }, helloTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return closeWith(ws, 4002, 'BAD_MESSAGE', 'Messages must be JSON'); }
      if (!msg || typeof msg !== 'object') return;
      // Handle one message at a time, in order.
      chain = chain.then(async () => {
        if (!state.helloDone) {
          state.helloDone = true;
          clearTimeout(helloTimer);
          await handleHello(ws, req, msg, state);
          return;
        }
        if (state.conn && state.conn.ready) await handleMessage(state.conn, msg);
      }).catch((err) => console.error('[workers] message handling failed:', err));
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      chain.then(() => {
        const conn = state.conn;
        if (!conn) return;
        if (conns.get(conn.worker.id) === conn) conns.delete(conn.worker.id);
        store.touchWorker(conn.worker.id);
        if (conn.currentJobId && !conn.replaced) {
          scheduleRequeue(conn.currentJobId, conn.worker.id, 'Downloader disconnected');
        }
        log(`${conn.worker.name} disconnected${conn.replaced ? ' (replaced)' : ''}`);
        safe(onWorkersChanged);
      });
    });
    ws.on('error', () => {});
  }

  wss.on('connection', onConnection);

  /** Attach to the HTTP server: upgrades on PATH become worker connections. */
  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      let pathname;
      try { pathname = new URL(req.url, 'http://x').pathname; } catch { return; }
      if (pathname !== PATH) return; // Socket.IO's own listener handles /socket.io/
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    pingTimer = setInterval(() => {
      const now = Date.now();
      for (const c of conns.values()) {
        if (now - c.lastSeen > heartbeatMs * 3) { try { c.ws.terminate(); } catch {} continue; }
        send(c.ws, { type: 'ping', t: now });
      }
    }, heartbeatMs);
    pingTimer.unref?.();
    // Safety net: jobs queued while dispatch could not run, or assigned to a
    // worker that is gone (missed close, crash during a grace timer).
    sweepTimer = setInterval(() => { sweep().catch(() => {}); }, Math.max(heartbeatMs * 2, 30000));
    sweepTimer.unref?.();
  }

  async function sweep() {
    if (!dbAvailable()) return;
    const active = await store.listAll({ status: 'assigned', limit: 500 });
    for (const j of active) {
      if (jobHeldLive(j.id) || graceTimers.has(j.id)) continue;
      const age = Date.now() - new Date(j.updated_at).getTime();
      if (age > requeueGraceMs) await requeueNow(j.id, j.worker_id, 'Downloader not connected');
    }
    dispatch();
  }

  /** Boot: no worker is connected yet. */
  async function start() {
    if (!dbAvailable()) return;
    const n = await store.requeueAllAssigned();
    if (n) log(`requeued ${n} job(s) that were running when the server stopped`);
  }

  function close() {
    closed = true;
    clearInterval(pingTimer);
    clearInterval(sweepTimer);
    for (const t of graceTimers.values()) clearTimeout(t);
    graceTimers.clear();
    for (const c of conns.values()) { try { c.ws.close(1001, 'Server shutting down'); } catch {} }
    wss.close();
  }

  return { attach, start, dispatch, stats, live, onlineWorkers, close, sweep, PATH, _conns: conns };
}

module.exports = { createWorkerHub, planAssignments, PATH, PROTOCOL };
