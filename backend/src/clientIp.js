/**
 * The real client IP behind Cloudflare -> Traefik (Dokploy) -> this app.
 *
 * Production chain: the browser talks to a Cloudflare edge, which connects to
 * Traefik on the server, which proxies to this container over the private
 * Docker network. So:
 *
 *   socket peer        Traefik (a private / loopback address)
 *   X-Forwarded-For    rightmost entry = Traefik's peer = the Cloudflare edge
 *                      (Traefik does not trust incoming X-Forwarded-* by
 *                      default, so everything left of it is client-supplied)
 *   CF-Connecting-IP   the visitor's IP, set by Cloudflare
 *
 * 1. `trust proxy` trusts only private and loopback hops (Traefik / a local
 *    reverse proxy), so req.ip is the first public hop from the right: the
 *    Cloudflare edge in production, the visitor if someone bypasses Cloudflare
 *    and hits Traefik directly, and the socket peer when there is no proxy
 *    at all (local dev: 127.0.0.1 with no X-Forwarded-For).
 * 2. CF-Connecting-IP is believed only when req.ip is inside Cloudflare's
 *    published ranges, i.e. the request really came through Cloudflare.
 *    Anyone else can send that header; it is ignored for them.
 *
 * TRUST_PROXY overrides step 1 with any Express `trust proxy` value
 * ("false" to trust nothing, "1", a CIDR list, ...).
 * CLOUDFLARE_IPS (comma-separated CIDRs) replaces the built-in range list;
 * CLOUDFLARE_IPS=none disables step 2.
 */

const net = require('net');

const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

// https://www.cloudflare.com/ips-v4 and /ips-v6
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function trustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY;
  if (raw === undefined || raw === '') return DEFAULT_TRUST_PROXY;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 -> 1.2.3.4). */
function normalize(ip) {
  const s = String(ip || '').trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

function buildBlockList(ranges) {
  const list = new net.BlockList();
  for (const cidr of ranges) {
    const [addr, bits] = cidr.split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (!net.isIP(addr) || !/^\d+$/.test(bits || '')) throw new Error(`Bad CIDR: ${cidr}`);
    list.addSubnet(addr, Number(bits), type);
  }
  return list;
}

function cloudflareRanges(env = process.env) {
  const raw = env.CLOUDFLARE_IPS;
  if (raw === undefined || raw === '') return CLOUDFLARE_RANGES;
  if (raw === 'none') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * @returns {(req) => string} computes the client IP from req.ip (already
 *   resolved by `trust proxy`) and the CF-Connecting-IP header.
 */
function createClientIp({ ranges = cloudflareRanges() } = {}) {
  const cf = buildBlockList(ranges);
  const isCloudflare = (ip) => {
    const n = normalize(ip);
    const type = net.isIP(n);
    return type !== 0 && cf.check(n, type === 6 ? 'ipv6' : 'ipv4');
  };
  function clientIp(req) {
    const peer = normalize(req.ip || (req.socket && req.socket.remoteAddress) || '');
    if (ranges.length && isCloudflare(peer)) {
      const header = req.headers['cf-connecting-ip'];
      const value = normalize(Array.isArray(header) ? header[0] : header);
      if (net.isIP(value)) return value;
    }
    return peer;
  }
  clientIp.isCloudflare = isCloudflare;
  return clientIp;
}

/**
 * Configure an Express app: `trust proxy`, then req.clientIp on every request
 * (rate limits key on it).
 */
function install(app, { env = process.env } = {}) {
  app.set('trust proxy', trustProxySetting(env));
  const clientIp = createClientIp({ ranges: cloudflareRanges(env) });
  app.use((req, res, next) => {
    req.clientIp = clientIp(req);
    next();
  });
  return clientIp;
}

module.exports = {
  DEFAULT_TRUST_PROXY,
  CLOUDFLARE_RANGES,
  trustProxySetting,
  cloudflareRanges,
  createClientIp,
  install,
  normalize,
};
