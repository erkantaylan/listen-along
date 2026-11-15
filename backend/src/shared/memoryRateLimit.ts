/**
 * The simple in-memory rate limits (20 per minute): the HTTP one for the
 * admin login (core/library/libraryRoutes.ts loginRateLimit), keyed by client IP, and a
 * per-socket one for expensive socket operations (queue:add). The library /
 * API limiters are express-rate-limit (rateLimits.ts).
 */
import type { RequestHandler } from 'express';

export const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 20; // 20 requests per minute

/** Keyed by req.clientIp. */
export function createMemoryRateLimit(): RequestHandler {
  const rateLimitMap = new Map<string | undefined, { count: number; resetTime: number }>(); // key: IP

  return function rateLimit(req, res, next) {
    const ip = req.clientIp || req.ip || req.socket.remoteAddress;
    const now = Date.now();
    const record = rateLimitMap.get(ip);

    if (!record || now > record.resetTime) {
      rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
      return next();
    }

    if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }

    record.count++;
    next();
  };
}

/** One socket's budget: returns check(), false once the window's budget is spent. */
export function createSocketRateLimit(): () => boolean {
  const socketRateLimit = { count: 0, resetTime: Date.now() + RATE_LIMIT_WINDOW };
  return () => {
    const now = Date.now();
    if (now > socketRateLimit.resetTime) {
      socketRateLimit.count = 0;
      socketRateLimit.resetTime = now + RATE_LIMIT_WINDOW;
    }
    if (socketRateLimit.count >= RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }
    socketRateLimit.count++;
    return true;
  };
}
