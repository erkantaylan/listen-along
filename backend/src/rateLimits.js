/**
 * Request rate limits for the library / requests / admin HTTP API and audio
 * streaming. Deliberately generous: they exist to stop runaway clients and
 * brute force, not normal use (a lobby streams a few Range requests per song;
 * a bulk `la upload` sends one request per file).
 *
 * Keyed by client IP. Note: without `trust proxy`, every client behind the
 * same reverse proxy shares one IP bucket, which is why the limit is high.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function keyFor(req) {
  return ipKeyGenerator(req.ip || req.socket?.remoteAddress || '');
}

function make(limit, windowMs = 60 * 1000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyFor,
    // We don't set `trust proxy` (the IP is the proxy's); skip the
    // library's proxy-header warnings.
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    handler: (req, res) => res.status(429).json({ error: 'Too many requests, slow down' }),
  });
}

/** Library/requests/admin API and audio streaming: 3000 requests/minute. */
const apiLimiter = make(3000);

module.exports = { apiLimiter, keyFor, make };
