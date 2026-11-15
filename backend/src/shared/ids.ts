// Checks for ids that arrive from clients (URL parameters, bodies) before they
// reach a query: a UUID column refuses anything else with an error, so a
// malformed id is answered as "not found" instead.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}
