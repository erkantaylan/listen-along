// Prefix every console line with an ISO-8601 timestamp + level, so server logs
// can be correlated with external events (e.g. the exact time of a Cloudflare
// 504). Patches console globally for side effect — require this ONCE, as the
// first line of the entry point, before anything else logs.
//
// Kept intentionally dependency-free and tiny. Multi-line values (stack traces)
// get the prefix on their first line only, which is the normal console behaviour.

const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function withStamp(level, fn) {
  return (...args) => fn(`[${new Date().toISOString()}] [${level}]`, ...args);
}

console.log = withStamp('INFO', orig.log);
console.info = withStamp('INFO', orig.info);
console.warn = withStamp('WARN', orig.warn);
console.error = withStamp('ERROR', orig.error);
console.debug = withStamp('DEBUG', orig.debug);

module.exports = {};
