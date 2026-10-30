/**
 * Request rate limits for the library / requests / admin HTTP API and audio
 * streaming. Deliberately generous: they exist to stop runaway clients and
 * brute force, not normal use (a lobby streams a few Range requests per song;
 * a bulk `la upload` sends one request per file).
 *
 * Keyed by client IP: req.clientIp (see clientIp.js: the visitor behind
 * Cloudflare + Traefik), falling back to req.ip / the socket address when the
 * router is mounted without it (tests).
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function clientIpOf(req) {
  return req.clientIp || req.ip || req.socket?.remoteAddress || '';
}

function keyFor(req) {
  return ipKeyGenerator(clientIpOf(req));
}

/**
 * @param {number} limit - requests per window
 * @param {number} [windowMs]
 * @param {{keyGenerator?: Function, message?: string}} [opts]
 */
function make(limit, windowMs = 60 * 1000, opts = {}) {
  const message = opts.message || 'Too many requests, slow down';
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator || keyFor,
    // The client IP is resolved by clientIp.js (trust proxy + CF-Connecting-IP);
    // skip the library's own proxy-header guesses.
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

/** Library/requests/admin API and audio streaming: 3000 requests/minute. */
const apiLimiter = make(3000);

module.exports = { apiLimiter, keyFor, clientIpOf, make };
