'use strict';

/**
 * `la worker` runs as two processes so it can restart itself after a
 * self-update (Node cannot exec in place):
 *
 *   parent (this file, run by bin/la.js): spawns
 *     <node> [execArgv] <install>/bin/la.js worker <same args>
 *   with stdio inherited plus an IPC channel and LA_WORKER_CHILD=1, forwards
 *   stop signals to it, and exits with its exit code. When the child exits
 *   with RESTART_EXIT_CODE (it has just replaced the files), the parent spawns
 *   it again, so the new code runs. The parent stays the old code but needs
 *   nothing else: keep this file tiny, built-ins only, and keep the contract
 *   (that command line, LA_WORKER_CHILD=1, the IPC message
 *   { type: 'la:signal', signal } and exit code 75) stable across versions,
 *   because a parent from an older la starts the child of a newer one.
 *
 * Signals: SIGINT / SIGTERM / SIGHUP (and SIGBREAK on Windows) reaching the
 * parent are sent to the child as an IPC message (works on Windows too). A
 * Ctrl+C in a terminal (POSIX or a Windows console) and systemd's default
 * KillMode reach both processes: the child counts a direct signal and the
 * parent's forward of it once (createSignalRouter). The parent stays the main
 * PID for systemd; it never exits before the child.
 */

const childProcess = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const RESTART_EXIT_CODE = 75;
const CHILD_ENV = 'LA_WORKER_CHILD';
const SIGNAL_MESSAGE = 'la:signal';
const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };

function stopSignals(platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/**
 * Run `la worker` under supervision. Resolves with the exit code to use.
 * @param {object} o
 * @param {string[]} o.argv - arguments after the program name ('worker', ...)
 * @param {string} [o.script] - bin/la.js of this install
 * @param {object} [o.env]
 * @param {Function} [o.spawn]
 * @param {EventEmitter} [o.signals] - process
 * @param {string} [o.platform]
 * @param {{write: Function}} [o.stderr]
 * @param {number} [o.maxRestarts] - restarts allowed within restartWindowMs
 * @param {number} [o.restartWindowMs]
 */
function runSupervisor(o) {
  const {
    argv,
    script = path.join(__dirname, '..', 'bin', 'la.js'),
    env = process.env,
    spawn = childProcess.spawn,
    signals = process,
    platform = process.platform,
    stderr = process.stderr,
    execPath = process.execPath,
    execArgv = process.execArgv,
    maxRestarts = 5,
    restartWindowMs = 10 * 60 * 1000,
  } = o;
  const names = stopSignals(platform);
  const restarts = [];
  let child = null;
  let stopping = false;

  return new Promise((resolve) => {
    const handlers = {};
    const finish = (code) => {
      for (const s of names) signals.removeListener(s, handlers[s]);
      resolve(code);
    };
    for (const s of names) {
      handlers[s] = () => {
        stopping = true;
        const c = child;
        if (!c || c.exitCode !== null || c.signalCode !== null) return;
        let sent = false;
        try { if (c.connected) { c.send({ type: SIGNAL_MESSAGE, signal: s }); sent = true; } } catch { /* channel gone */ }
        if (!sent && platform !== 'win32') { try { c.kill(s); } catch { /* gone */ } }
      };
      signals.on(s, handlers[s]);
    }

    const start = () => {
      try {
        child = spawn(execPath, [...execArgv, script, ...argv], {
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          env: { ...env, [CHILD_ENV]: '1' },
        });
      } catch (err) {
        stderr.write(`error: cannot start the worker: ${err.message}\n`);
        finish(1);
        return;
      }
      const c = child;
      let settled = false;
      c.once('error', (err) => {
        if (settled) return;
        settled = true;
        stderr.write(`error: cannot start the worker: ${err.message}\n`);
        finish(1);
      });
      c.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        if (code === RESTART_EXIT_CODE) {
          if (stopping) { finish(0); return; }
          const now = Date.now();
          while (restarts.length && now - restarts[0] > restartWindowMs) restarts.shift();
          if (restarts.length >= maxRestarts) {
            stderr.write(`error: la worker restarted ${restarts.length} times in ${Math.round(restartWindowMs / 60000)} minutes after updates; stopping. Check the install, or run \`la worker --no-auto-update\`.\n`);
            finish(1);
            return;
          }
          restarts.push(now);
          start();
          return;
        }
        finish(code !== null ? code : 128 + (SIGNUM[signal] || 1));
      });
    };
    start();
  });
}

/**
 * The child's view of stop signals: an EventEmitter of 'SIGINT' / 'SIGTERM' /
 * 'SIGHUP' / 'SIGBREAK', one event per real stop request, whether it reached
 * this process directly, through the parent's forward, or both. A forward is
 * acted on at once; a direct signal waits `delayMs` for its forward and is
 * dropped if one comes (or came within `windowMs`). The parent going away
 * (IPC disconnect) is a 'SIGHUP': stop now and give the job back.
 * @param {object} [o]
 * @param {object} [o.proc] - process
 * @param {string} [o.platform]
 */
function createSignalRouter({ proc = process, platform = process.platform, windowMs = 1000, delayMs = 400 } = {}) {
  const em = new EventEmitter();
  const names = stopSignals(platform);
  const lastForward = {};
  const pending = {};
  const listeners = {};
  let closed = false;

  const forwarded = (sig) => {
    lastForward[sig] = Date.now();
    const t = (pending[sig] || []).shift();
    if (t) clearTimeout(t);
    em.emit(sig);
  };
  const direct = (sig) => {
    if (Date.now() - (lastForward[sig] || 0) < windowMs) return;
    const list = (pending[sig] = pending[sig] || []);
    const t = setTimeout(() => {
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
      if (!closed) em.emit(sig);
    }, delayMs);
    list.push(t);
  };
  const onMessage = (m) => {
    if (m && m.type === SIGNAL_MESSAGE && names.includes(m.signal)) forwarded(m.signal);
  };
  const onDisconnect = () => { if (!closed) em.emit('SIGHUP'); };

  for (const s of names) {
    listeners[s] = () => direct(s);
    proc.on(s, listeners[s]);
  }
  proc.on('message', onMessage);
  proc.on('disconnect', onDisconnect);
  // The channel must not keep the worker alive once it is done.
  try { proc.channel && proc.channel.unref(); } catch { /* old node */ }

  em.close = () => {
    closed = true;
    for (const s of names) proc.removeListener(s, listeners[s]);
    proc.removeListener('message', onMessage);
    proc.removeListener('disconnect', onDisconnect);
    for (const list of Object.values(pending)) for (const t of list) clearTimeout(t);
  };
  return em;
}

/** True in the child a supervisor started (it can restart us). */
function isSupervisedChild(env = process.env, proc = process) {
  return env[CHILD_ENV] === '1' && typeof proc.send === 'function';
}

module.exports = { runSupervisor, createSignalRouter, isSupervisedChild, stopSignals, RESTART_EXIT_CODE, CHILD_ENV, SIGNAL_MESSAGE };
