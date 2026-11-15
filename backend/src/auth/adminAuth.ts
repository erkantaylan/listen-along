/**
 * Admin auth for /dashboard: ADMIN_USER (default "admin") and
 * ADMIN_PASSWORD env vars. Logging in sets an HMAC-signed, expiring cookie.
 * The signing key is derived from the credentials, so changing either one logs
 * every admin session out. If ADMIN_PASSWORD is unset, admin is disabled
 * entirely.
 */

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** What reading the admin cookie needs of a request (a handshake's `{ headers }` too). */
export interface HeadersOnly {
  headers: { cookie?: string };
}

export const COOKIE_NAME = 'la_admin';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function password(): string {
  return process.env.ADMIN_PASSWORD || '';
}

function username(): string {
  return process.env.ADMIN_USER || 'admin';
}

export function isEnabled(): boolean {
  return password().length > 0;
}

function signingKey(): Buffer {
  return crypto.createHmac('sha256', password()).update(`listen-along-admin-cookie-v1:${username()}`).digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

function safeEqual(a: unknown, b: unknown): boolean {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Password comparison goes through scrypt (a proper password KDF) with a
// per-process random salt, then a constant-time compare.
const PW_SALT = crypto.randomBytes(16);
let pwCache: { password: string | null; key: Buffer | null } = { password: null, key: null };

function passwordKey(value: unknown): Buffer {
  return crypto.scryptSync(String(value), PW_SALT, 32);
}

export function checkPassword(candidate: unknown): boolean {
  if (!isEnabled() || typeof candidate !== 'string') return false;
  const current = password();
  if (pwCache.password !== current) pwCache = { password: current, key: passwordKey(current) };
  // pwCache.key was set for `current` just above.
  return crypto.timingSafeEqual(passwordKey(candidate), pwCache.key!);
}

export function checkCredentials(user: unknown, candidate: unknown): boolean {
  // Evaluate both so a wrong username takes as long as a wrong password.
  const userOk = typeof user === 'string' && safeEqual(user, username());
  const passOk = checkPassword(candidate);
  return userOk && passOk;
}

export function createSessionValue(now: number = Date.now()): string {
  const payload = String(now + SESSION_MS);
  return `${payload}.${sign(payload)}`;
}

export function verifySessionValue(value: unknown, now: number = Date.now()): boolean {
  if (!isEnabled() || !value || typeof value !== 'string') return false;
  const idx = value.indexOf('.');
  if (idx < 0) return false;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  const expires = Number(payload);
  return Number.isFinite(expires) && expires > now;
}

function readCookie(req: HeadersOnly): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function isAdmin(req: HeadersOnly): boolean {
  return verifySessionValue(readCookie(req));
}

export function setSessionCookie(res: Response): void {
  res.cookie(COOKIE_NAME, createSessionValue(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Express middleware: 404 when admin is disabled, 401 when not logged in. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isEnabled()) return res.status(404).json({ error: 'Admin is disabled (ADMIN_PASSWORD not set)' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin login required' });
  next();
}

