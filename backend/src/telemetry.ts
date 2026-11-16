/**
 * OpenTelemetry for the server: traces (HTTP server via Express routes,
 * outgoing http / fetch, pg queries), metrics (HTTP + Node runtime) and the
 * trace id on log lines, exported over OTLP/HTTP.
 *
 * OFF BY DEFAULT. Without an OTLP endpoint (OTEL_EXPORTER_OTLP_ENDPOINT, or the
 * per-signal _TRACES_ / _METRICS_ variant) this file returns after reading the
 * environment: no @opentelemetry module is loaded, nothing is patched, no timer,
 * no socket, no log line. OTEL_SDK_DISABLED=true also keeps it off.
 *
 * It is a PRELOAD (`--import`), never imported by the app: instrumentation
 * patches modules (http, express, pg) as they load, so it has to run before
 * main.ts imports them, or the dashboard silently stays empty.
 *
 *   node --import ./src/telemetry.ts src/main.ts                (AppHost, backend/)
 *   NODE_OPTIONS=--import=/app/src/telemetry.ts                 (the Docker image)
 *
 * The app is ES modules: a `require` hook alone does not see `import express`.
 * So, once on, this first registers import-in-the-middle's loader hook
 * (@opentelemetry/instrumentation/hook.mjs) for the packages the
 * instrumentations patch, then loads the SDK with a plain synchronous require
 * (no top-level await) and creates the instrumentations, which patch those
 * packages whether they are imported or required. Off, it registers nothing.
 * The old `--require=/app/src/telemetry.js` path is a shim (telemetry.js).
 *
 * What is recorded and what is not: telemetryRules.ts. In short, no bodies, no
 * headers (cookies, Authorization, session ids), no query strings (the OIDC
 * callback's ?code=), no client addresses, no SQL parameter values or quoted
 * literals; span names are route templates (`GET /api/playlists/:id`).
 * /health, static files and Socket.IO polling are not traced.
 *
 * Settings (all standard): OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS / _PROTOCOL
 * (http/protobuf, the default, or http/json; grpc is refused with a warning),
 * OTEL_SERVICE_NAME (default listen-along), OTEL_RESOURCE_ATTRIBUTES,
 * OTEL_TRACES_SAMPLER (+ _ARG), OTEL_BSP_SCHEDULE_DELAY, OTEL_METRIC_EXPORT_INTERVAL,
 * OTEL_LOG_LEVEL (the SDK's own messages; default warn).
 */
import { createRequire, register } from 'node:module';
import * as rules from './telemetryRules.ts';
import type { TelemetryConfig } from './telemetryRules.ts';
import type * as Api from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/** What the preload did: tests read it; the app never imports this file. */
export interface Telemetry {
  started: boolean;
  reason?: string;
  shutdown: () => Promise<void>;
}

/**
 * The modules whose ES-module imports the loader hook wraps: what the
 * instrumentations patch (http and https for the incoming and outgoing
 * requests, Express for the route, pg). Nothing else goes through it.
 */
const HOOKED_PACKAGES = ['http', 'https', 'node:http', 'node:https', 'express', 'pg', 'pg-pool'];

const config = rules.telemetryConfig(process.env);

const telemetry: Telemetry = config.enabled ? start(config) : off(config);
export default telemetry;

function off(cfg: Extract<TelemetryConfig, { enabled: false }>): Telemetry {
  // The only case that says anything: telemetry was asked for but cannot run.
  if (cfg.warn) console.warn(`[telemetry] not started: ${cfg.reason}`);
  return { started: false, reason: cfg.reason, shutdown: async () => {} };
}

function start(cfg: Extract<TelemetryConfig, { enabled: true }>): Telemetry {
  // Stable HTTP / database attribute names (url.path, http.route, db.query.text)
  // unless the operator chose otherwise. Read by the instrumentations below.
  if (!process.env.OTEL_SEMCONV_STABILITY_OPT_IN) process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http,database';

  // ES-module imports of the patched packages go through import-in-the-middle,
  // which hands them to the instrumentations' hooks. Before anything imports
  // them: this preload runs before the app's first module.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, { data: { include: HOOKED_PACKAGES } });

  // The SDK is CommonJS: required synchronously, and only here.
  const require = createRequire(import.meta.url);
  const api: typeof Api = require('@opentelemetry/api');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const { W3CTraceContextPropagator } = require('@opentelemetry/core');
  const { resourceFromAttributes, envDetector, detectResources } = require('@opentelemetry/resources');
  const {
    TracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler,
  } = require('@opentelemetry/sdk-trace');
  const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
  const { RuntimeNodeInstrumentation } = require('@opentelemetry/instrumentation-runtime-node');
  const json = cfg.protocol === 'http/json';
  const { OTLPTraceExporter } = json
    ? require('@opentelemetry/exporter-trace-otlp-http')
    : require('@opentelemetry/exporter-trace-otlp-proto');
  const { OTLPMetricExporter } = json
    ? require('@opentelemetry/exporter-metrics-otlp-http')
    : require('@opentelemetry/exporter-metrics-otlp-proto');

  const level = String(process.env.OTEL_LOG_LEVEL || 'warn').toUpperCase();
  api.diag.setLogger(new api.DiagConsoleLogger(), api.DiagLogLevel[level as keyof typeof api.DiagLogLevel] ?? api.DiagLogLevel.WARN);

  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  // OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES (envDetector) win over the default name.
  const resource = resourceFromAttributes({ 'service.name': rules.DEFAULT_SERVICE_NAME })
    .merge(detectResources({ detectors: [envDetector] }));

  const sampler = new ParentBasedSampler({
    root: cfg.sampleRatio >= 1 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(cfg.sampleRatio),
  });
  const tracerProvider = new TracerProvider({
    resource,
    sampler,
    // OpenTelemetry JS 3.x: one options object, the exporter inside it.
    spanProcessors: [new BatchSpanProcessor({
      exporter: sanitizing(new OTLPTraceExporter()),
      scheduledDelayMillis: cfg.traceDelayMs,
    })],
  });
  api.trace.setGlobalTracerProvider(tracerProvider);

  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: cfg.metricIntervalMs,
      exportTimeoutMillis: Math.min(30_000, cfg.metricIntervalMs),
    })],
  });
  api.metrics.setGlobalMeterProvider(meterProvider);

  registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: { url?: string }) => rules.ignoreIncomingPath(req.url),
        // Never: headers to attributes (cookies, Authorization). This is the default; said here so it stays so.
        headersToSpanAttributes: { client: {}, server: {} },
      }),
      // Only for the route template (span name `GET /api/playlists/:id`): no
      // span per middleware / router layer.
      new ExpressInstrumentation({ ignoreLayersType: ['middleware', 'request_handler', 'router'] }),
      // No parameter values (enhancedDatabaseReporting stays false), no
      // connect spans, and only queries made while serving something.
      new PgInstrumentation({ enhancedDatabaseReporting: false, ignoreConnectSpans: true, requireParentSpan: true }),
      new UndiciInstrumentation({ requireParentforSpans: true }),
      new RuntimeNodeInstrumentation(),
    ],
  });

  correlateLogs(api);

  let shuttingDown: Promise<void> | null = null;
  const shutdown = () => {
    if (!shuttingDown) {
      shuttingDown = Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]).then(() => {});
    }
    return shuttingDown;
  };
  flushOnExit(shutdown);

  console.log(`[telemetry] OpenTelemetry on: traces and metrics to ${cfg.endpointOrigin} (${cfg.protocol}) as "${resource.attributes['service.name']}"`);
  return { started: true, shutdown };

  /** Wraps the OTLP exporter: every span leaves through telemetryRules. */
  function sanitizing(inner: SpanExporter): SpanExporter {
    return {
      export: (spans, done) => inner.export(spans.map(cleanSpan), done),
      shutdown: () => inner.shutdown(),
      forceFlush: () => (inner.forceFlush ? inner.forceFlush() : Promise.resolve()),
    };
  }

  function cleanSpan(span: ReadableSpan): ReadableSpan {
    const server = span.kind === api.SpanKind.SERVER;
    const attributes = rules.sanitizeAttributes(span.attributes, { server });
    let name = rules.sanitizeSpanName(span.name);
    const route = span.attributes['http.route'];
    // `GET /api/playlists/:id,/api/lobbies/:id` -> the one that matched.
    if (typeof route === 'string' && attributes['http.route'] !== route) name = name.replace(route, attributes['http.route'] as string);
    return {
      name,
      kind: span.kind,
      spanContext: () => span.spanContext(),
      parentSpanContext: span.parentSpanContext,
      startTime: span.startTime,
      endTime: span.endTime,
      status: span.status,
      attributes: attributes as ReadableSpan['attributes'],
      links: span.links,
      events: span.events.map((e) => ({ ...e, attributes: (e.attributes && rules.sanitizeAttributes(e.attributes, { server })) as typeof e.attributes })),
      duration: span.duration,
      ended: span.ended,
      resource: span.resource,
      instrumentationScope: span.instrumentationScope,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    };
  }
}

/**
 * `trace_id=… span_id=…` at the end of a console line written while a sampled
 * span is active (the request log, errors in a handler). shared/logger.ts wraps
 * console after this preload, so its timestamp prefix still comes first.
 */
function correlateLogs(api: typeof Api) {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[method];
    console[method] = function withTraceId(this: Console, ...args: unknown[]) {
      const span = api.trace.getActiveSpan();
      const ctx = span && span.spanContext();
      if (ctx && (ctx.traceFlags & api.TraceFlags.SAMPLED)) args.push(`trace_id=${ctx.traceId} span_id=${ctx.spanId}`);
      return orig.apply(this, args);
    };
  }
}

/**
 * Flush what is buffered when the process ends, without changing how it ends.
 * main.ts owns SIGTERM / SIGINT (close the server, the sockets, the pool, then
 * process.exit(0)). On those signals the flush starts at once, and the exit that
 * follows waits for it, 2 seconds at most. Other exits are not delayed.
 * A process with no handler of its own for the signal still ends on it.
 */
function flushOnExit(shutdown: () => Promise<void>) {
  const FLUSH_TIMEOUT_MS = 2000;
  const realExit = process.exit;
  let flushing: Promise<unknown> | null = null;

  const startFlush = () => {
    if (!flushing) {
      flushing = Promise.race([shutdown(), new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS).unref())]);
    }
    return flushing;
  };

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, function onSignal() {
      startFlush();
      if (process.listenerCount(signal) === 1) {
        // Nobody else handles it: end as the default handler would have.
        flushing!.then(() => {
          process.removeListener(signal, onSignal);
          process.kill(process.pid, signal);
        });
      }
    });
  }

  process.exit = function exit(code?: number | string | null) {
    if (!flushing) return realExit.call(process, code);
    const finalCode = code === undefined ? process.exitCode : code;
    flushing.then(() => realExit.call(process, finalCode));
    return undefined as never;
  } as typeof process.exit;

  process.once('beforeExit', () => { startFlush(); });
}
