// Helpers for tests that spawn the real server (src/main.ts) as a child
// process. Not a test file itself (the name matches none of node --test's
// patterns).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { DEV_COOKIE, signDevToken, adminAuth } from '../auth/index.ts';

export const SECRET = 'test-session-secret';
export const ADMIN_PASSWORD = 'test-admin-pw';
const FRONTEND = path.join(import.meta.dirname, '..', '..', '..', 'frontend');

/** The server's entry point, for tests that spawn it themselves. */
export const SERVER_ENTRY = path.join(import.meta.dirname, '..', 'main.ts');

/**
 * A dev sign-in cookie (`la_dev_login`, auth/devLogin.ts) for users.id `userId`.
 * startServer() turns the dev sign-in on unless the test configures central
 * login, so this is the login of every server a test starts without OIDC_*.
 */
export function cookieFor(userId: string, t: number = Date.now(), secret: string = SECRET): string {
  return `${DEV_COOKIE}=${signDevToken(secret, userId, t)}`;
}

/** A valid la_admin cookie for ADMIN_PASSWORD. */
export function adminCookie(password: string = ADMIN_PASSWORD): string {
  const prev = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = password;
  const v = `la_admin=${encodeURIComponent(adminAuth.createSessionValue())}`;
  if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev;
  return v;
}

/**
 * A port that was free a moment ago. Only for something that must know a
 * port before anything listens on it (a dead address, a BASE_URL): another
 * process can take it in between. A server a test starts binds port 0
 * itself and says which port it got (listening()).
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/** What listening() / startServer() reject with: the server's output so far. */
type StartError = Error & { log?: string; exitCode?: number | null };

/**
 * Resolves with the port once a spawned src/main.ts says it listens
 * ("Server running on port N", the port it actually bound); rejects with its
 * output when it exits first, cannot bind (EADDRINUSE: main.ts logs an
 * uncaught exception and stays up, not listening) or takes longer than
 * `timeoutMs`.
 */
export function listening(proc: ChildProcess, timeoutMs = 30_000): Promise<number> {
  let log = '';
  return new Promise((resolve, reject) => {
    const fail = (message: string) => { clearTimeout(timer); reject(Object.assign(new Error(`${message}\n${log}`), { log })); };
    const timer = setTimeout(() => fail('server did not start'), timeoutMs);
    const onData = (d: Buffer | string) => {
      log += d;
      const m = /Server running on port (\d+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); } else if (/EADDRINUSE/.test(log)) fail('server could not bind its port');
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(timer); reject(Object.assign(new Error(`server exited (${code})\n${log}`), { exitCode: code, log })); });
  });
}

/**
 * The central login's counterpart of cookieFor: a server-side session for
 * users.id `userId`, inserted straight into `user_sessions` (no IdP round
 * trip; no refresh token, so it is never re-checked and lasts until
 * OIDC_MAX_UNVERIFIED_SECONDS, 24 h by default). `pg` is a connected pg Client
 * or a connection string. Returns the `la_session=...` cookie.
 */
export async function centralSessionCookie(
  conn: pg.Client | string,
  userId: string | number,
  { sub = `dev-${userId}`, now = Date.now() }: { sub?: string; now?: number } = {},
): Promise<string> {
  let client: pg.Client;
  if (typeof conn === 'string') {
    client = new pg.Client({ connectionString: conn });
    await client.connect();
  } else {
    client = conn;
  }
  try {
    const raw = crypto.randomBytes(32).toString('base64url');
    const idHash = crypto.createHash('sha256').update(raw).digest('hex');
    await client.query(
      `INSERT INTO user_sessions (id_hash, user_id, oidc_sub, created_at, last_checked_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [idHash, userId, sub, now, now + 30 * 24 * 60 * 60 * 1000]
    );
    return `la_session=${raw}`;
  } finally {
    if (client !== conn) await client.end();
  }
}

/** A server started by startServer(). */
export interface TestServer {
  proc: ChildProcess;
  base: string;
  port: number;
  stop: () => Promise<void>;
  log: () => string;
}

type ExtraEnv = Record<string, string>;

/**
 * Start src/main.ts; resolves once it listens. DATABASE_URL only if given.
 * `extraEnv` may be a function of the port (for BASE_URL in central-login tests).
 * The dev sign-in (INSECURE_DEV_LOGIN, cookieFor) is on unless `extraEnv` sets
 * OIDC_ISSUER or OIDC_CLIENT_ID: the server allows one or the other.
 */
export async function startServer(extraEnvOrFn: ExtraEnv | ((port: number) => ExtraEnv) = {}): Promise<TestServer> {
  // The server binds port 0 and reports its port, unless the env needs the port
  // first (a function of it): then a free one is picked, and picked again in
  // the rare case another process took it before the server bound it.
  for (let attempt = 1; ; attempt++) {
    const chosen = typeof extraEnvOrFn === 'function' ? await freePort() : 0;
    try {
      return await spawnServer(chosen, typeof extraEnvOrFn === 'function' ? extraEnvOrFn(chosen) : extraEnvOrFn);
    } catch (err) {
      if (!(typeof extraEnvOrFn === 'function' && attempt < 5 && /EADDRINUSE/.test((err as StartError).log || ''))) throw err;
    }
  }
}

async function spawnServer(chosenPort: number, extraEnv: ExtraEnv): Promise<TestServer> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(chosenPort), SESSION_SECRET: SECRET, NODE_ENV: 'test', ADMIN_PASSWORD,
    PRESENCE_GRACE_MS: '0', FRONTEND_PATH: FRONTEND,
    COVERS_DIR: path.join(os.tmpdir(), 'la-test-covers'),
    INSECURE_DEV_LOGIN: extraEnv.OIDC_ISSUER || extraEnv.OIDC_CLIENT_ID ? '' : '1', ...extraEnv,
  };
  if (!extraEnv.DATABASE_URL) delete env.DATABASE_URL;
  const proc = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  proc.stdout.on('data', (d) => { log += d; });
  let port: number;
  try {
    port = await listening(proc);
  } catch (err) {
    proc.kill('SIGKILL');
    throw err;
  }
  const stop = () => new Promise<void>((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
  return { proc, base: `http://127.0.0.1:${port}`, port, stop, log: () => log };
}

/** What requester()'s helper answers. Server JSON is read freely by the tests. */
export interface TestResponse {
  status: number;
  body: any;
  text: string;
  headers: Headers;
}

/** JSON request helper: req(method, url, { cookie, headers, body }). */
export function requester(base: string) {
  return async function req(
    method: string,
    url: string,
    { cookie, headers = {}, body }: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<TestResponse> {
    const h: Record<string, string> = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  };
}
