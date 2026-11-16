/**
 * Request rate limits for the library / requests / admin HTTP API and audio
 * streaming. Deliberately generous: they exist to stop runaway clients and
 * brute force, not normal use (a playlist streams a few Range requests per song;
 * a bulk `la upload` sends one request per file).
 *
 * Keyed by client IP: req.clientIp (see clientIp.ts: the visitor behind
 * Cloudflare + Traefik), falling back to req.ip / the socket address when the
 * router is mounted without it (tests).
 */

import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { RateLimitRequestHandler, ValueDeterminingMiddleware } from 'express-rate-limit';
import type { Request } from 'express';

/** What a limiter can be told besides its numbers. */
export interface LimiterOptions {
  /** the bucket a request counts against (default: keyFor, the client IP) */
  keyGenerator?: ValueDeterminingMiddleware<string>;
  /** the 429 body's `error` */
  message?: string;
  /** true = this request is not counted */
  skip?: ValueDeterminingMiddleware<boolean>;
}

export type Limiter = RateLimitRequestHandler;

export function clientIpOf(req: Request): string {
  return req.clientIp || req.ip || req.socket?.remoteAddress || '';
}

export function keyFor(req: Request): string {
  return ipKeyGenerator(clientIpOf(req));
}

/**
 * @param limit requests per window
 * @param windowMs the window (default a minute)
 */
export function make(limit: number, windowMs = 60 * 1000, opts: LimiterOptions = {}): Limiter {
  const message = opts.message || 'Too many requests, slow down';
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator || keyFor,
    ...(opts.skip ? { skip: opts.skip } : {}),
    // The client IP is resolved by clientIp.ts (trust proxy + CF-Connecting-IP);
    // skip the library's own proxy-header guesses.
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

/** Library/requests/admin API and audio streaming: 3000 requests/minute. */
export const apiLimiter = make(3000);
