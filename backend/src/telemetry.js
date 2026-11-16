// The old path of the OpenTelemetry preload (NODE_OPTIONS=--require=/app/src/telemetry.js),
// kept so that the old opt-in cannot stop the server from starting. It never
// starts telemetry: the app is ES modules, which a --require preload cannot
// instrument (and the loader hook it needs cannot be registered from one). The
// preload is now telemetry.ts, loaded with --import:
//   NODE_OPTIONS=--import=/app/src/telemetry.ts
// Without an OTLP endpoint this file does nothing and prints nothing, as the
// preload did; with one it says, once, why there is no telemetry.
import { telemetryConfig } from './telemetryRules.ts';

if (telemetryConfig(process.env).enabled) {
  console.warn('[telemetry] not started: --require of src/telemetry.js is the old opt-in; use NODE_OPTIONS=--import=/app/src/telemetry.ts (README "OpenTelemetry")');
}
