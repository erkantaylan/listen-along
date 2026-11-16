/**
 * The decisions behind OpenTelemetry (telemetry.ts), kept pure and free of any
 * @opentelemetry import so they can be tested, and so that reading them never
 * loads the SDK: when should it start, which requests are not traced at all,
 * and what may leave the process on a span.
 *
 * Off by default: nothing starts unless an OTLP endpoint is configured.
 * Production sets none of these variables today.
 */

/** Any one of these turns telemetry on (the per-signal ones are standard too). */
export const ENDPOINT_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
];

export const DEFAULT_SERVICE_NAME = 'listen-along';

/** OTLP over HTTP only: the gRPC exporter would add @grpc/grpc-js to the image. */
const PROTOCOLS = new Set(['http/protobuf', 'http/json']);

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function positiveInt(raw: unknown, fallback: number, { min = 1, max = 3_600_000 }: { min?: number; max?: number } = {}): number {
  const n = Number(trimmed(raw));
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

type Env = Record<string, string | undefined>;

/** What telemetryConfig() decided. */
export type TelemetryConfig =
  | { enabled: false; reason: string; warn?: boolean }
  | {
    enabled: true; protocol: string; serviceName: string; endpointOrigin: string; sampleRatio: number;
    traceDelayMs: number; metricIntervalMs: number;
  };

/** Decide from the environment whether and how telemetry runs. */
export function telemetryConfig(env: Env = process.env): TelemetryConfig {
  const endpointVar = ENDPOINT_VARS.find((k) => trimmed(env[k]));
  if (!endpointVar) return { enabled: false, reason: 'no OTLP endpoint configured' };
  if (trimmed(env.OTEL_SDK_DISABLED).toLowerCase() === 'true') {
    return { enabled: false, reason: 'OTEL_SDK_DISABLED=true' };
  }
  const protocol = (trimmed(env.OTEL_EXPORTER_OTLP_PROTOCOL) || 'http/protobuf').toLowerCase();
  if (!PROTOCOLS.has(protocol)) {
    return {
      enabled: false,
      reason: `OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported here (use http/protobuf or http/json)`,
      warn: true,
    };
  }
  let endpointOrigin = '(invalid URL)';
  try { endpointOrigin = new URL(trimmed(env[endpointVar])).origin; } catch { /* the exporter reports it */ }

  // The SDK no longer reads these itself (OpenTelemetry JS 3.x); the AppHost
  // sets the first two to 1000 so the dashboard updates within a second.
  const traceDelayMs = positiveInt(env.OTEL_BSP_SCHEDULE_DELAY, 5000);
  const metricIntervalMs = positiveInt(env.OTEL_METRIC_EXPORT_INTERVAL, 60_000, { min: 1000 });
  return {
    enabled: true,
    protocol,
    serviceName: trimmed(env.OTEL_SERVICE_NAME) || DEFAULT_SERVICE_NAME,
    endpointOrigin,
    sampleRatio: sampleRatio(env),
    traceDelayMs,
    metricIntervalMs,
  };
}

/**
 * The share of new traces kept (a parent's decision is always followed).
 * Standard names: OTEL_TRACES_SAMPLER = always_on | always_off |
 * traceidratio | parentbased_always_on | parentbased_always_off |
 * parentbased_traceidratio, OTEL_TRACES_SAMPLER_ARG = the ratio.
 */
export function sampleRatio(env: Env = process.env): number {
  const sampler = trimmed(env.OTEL_TRACES_SAMPLER).toLowerCase();
  if (sampler === 'always_off' || sampler === 'parentbased_always_off') return 0;
  if (sampler === 'traceidratio' || sampler === 'parentbased_traceidratio') {
    const r = Number(trimmed(env.OTEL_TRACES_SAMPLER_ARG));
    return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 1;
  }
  return 1;
}

// Same list as the request log in app/http.ts: static assets are not traced.
const STATIC_ASSET_RE = /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|map|json|webmanifest|txt|html)$/i;

/**
 * Incoming requests that get no span (and no HTTP metric): the health probe
 * (Docker and the AppHost poll it), static files, and Socket.IO's own
 * long-polling transport (a request every few seconds per open page).
 */
export function ignoreIncomingPath(rawUrl: unknown): boolean {
  const path = String(rawUrl || '').split(/[?#]/, 1)[0];
  if (path === '/health') return true;
  if (path.startsWith('/socket.io/')) return true;
  return STATIC_ASSET_RE.test(path);
}

/** "https://u:p@host/a/b?code=x#f" -> "https://host/a/b"; anything else -> its path. */
export function stripUrl(value: unknown): string {
  const s = String(value);
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return s.split(/[?#]/, 1)[0];
  }
}

/** SQL with quoted literals blanked: parameters ($1) are kept, inlined values are not. */
export function stripSqlLiterals(sql: unknown): string {
  return String(sql).replace(/'(?:[^']|'')*'/g, "'?'");
}

// Never exported, whatever an instrumentation (or a future version of one) records.
const DROP_EXACT = new Set([
  'url.query',
  'http.request.body', 'http.response.body',
  'db.postgresql.values', // instrumentation-pg's enhancedDatabaseReporting
  'db.statement.parameters',
  'enduser.id', 'enduser.role', 'enduser.scope', 'user.id', 'user.email', 'user.name',
]);
const DROP_PREFIXES = [
  'http.request.header.', 'http.response.header.', // cookies, Authorization, session ids
  'db.query.parameter.',
  'messaging.message.body',
];
// On a server span the peer is the browser (or the proxy in front of us).
const DROP_ON_SERVER = new Set([
  'client.address', 'client.port', 'http.client_ip', 'net.peer.ip', 'net.peer.port',
  'net.sock.peer.addr', 'net.sock.peer.port', 'network.peer.address', 'network.peer.port',
]);
const URL_KEYS = new Set(['url.full', 'http.url', 'url.original']);
const PATH_KEYS = new Set(['http.target', 'url.path']);
const SQL_KEYS = new Set(['db.statement', 'db.query.text']);

/**
 * The attributes a span may carry out of the process, as a new object.
 * `server`: an incoming request's span.
 */
export function sanitizeAttributes(
  attributes: Record<string, unknown> | null | undefined,
  { server = false }: { server?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (DROP_EXACT.has(key) || DROP_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (server && DROP_ON_SERVER.has(key)) continue;
    if (typeof value === 'string' && URL_KEYS.has(key)) out[key] = stripUrl(value);
    else if (typeof value === 'string' && PATH_KEYS.has(key)) out[key] = value.split(/[?#]/, 1)[0];
    else if (typeof value === 'string' && SQL_KEYS.has(key)) out[key] = stripSqlLiterals(value);
    else if (key === 'http.route') out[key] = pickRoute(value, attributes!['url.path'] ?? attributes!['http.target']);
    else out[key] = value;
  }
  return out;
}

/**
 * A route registered for several paths at once (`app.get(['/api/playlists/:id',
 * '/lobby/:id/library'])`) reaches the span as the joined list. Keep the one the
 * request matched; a template still, never the raw path.
 */
export function pickRoute(route: unknown, path: unknown): unknown {
  if (typeof route !== 'string' || !route.includes(',')) return route;
  const candidates = route.split(',').map((r) => r.trim()).filter(Boolean);
  const p = typeof path === 'string' ? path.split(/[?#]/, 1)[0] : '';
  const matches = (template: string) => {
    const re = new RegExp(`^${template.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`, 'i');
    return re.test(p);
  };
  return candidates.find(matches) || candidates[0];
}

/** A span name never carries a query string (a client span may be named by its URL). */
export function sanitizeSpanName(name: unknown): string {
  const s = String(name);
  return /[?#]/.test(s) ? s.split(/[?#]/, 1)[0] : s;
}
