'use strict';

/**
 * Output conventions:
 *  - stdout carries the result only (human text, or one JSON document with --json)
 *  - stderr carries progress, warnings and errors
 */
class Output {
  constructor({ stdout = process.stdout, stderr = process.stderr, json = false, quiet = false, verbose = false } = {}) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.json = json;
    this.quiet = quiet;
    this.verbose = verbose;
  }

  /** Progress line (stderr; suppressed by --quiet). */
  info(msg) {
    if (!this.quiet) this.stderr.write(`${msg}\n`);
  }

  /** Debug line (stderr; only with --verbose). */
  debug(msg) {
    if (this.verbose) this.stderr.write(`${msg}\n`);
  }

  warn(msg) {
    this.stderr.write(`warning: ${msg}\n`);
  }

  /** Raw text to stdout. */
  print(text = '') {
    this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /**
   * Emit the command result: JSON document in --json mode, otherwise call
   * `human()` to print text.
   */
  result(data, human) {
    if (this.json) this.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    else if (human) human();
  }

  /** Report a fatal error (stderr; JSON object in --json mode). */
  error(err) {
    if (this.json) {
      const body = { error: { code: err.code || 'ERROR', message: err.message } };
      if (err.hint) body.error.hint = err.hint;
      if (err.status) body.error.status = err.status;
      this.stderr.write(`${JSON.stringify(body)}\n`);
    } else {
      this.stderr.write(`error: ${err.message}\n`);
      if (err.hint) this.stderr.write(`hint: ${err.hint}\n`);
    }
  }
}

/** Render rows as an aligned plain-text table. */
function table(rows, columns) {
  if (!rows.length) return '';
  const cells = rows.map((r) => columns.map((c) => {
    const v = typeof c.get === 'function' ? c.get(r) : r[c.key];
    return v === undefined || v === null ? '' : String(v);
  }));
  const widths = columns.map((c, i) => Math.min(c.max || 60, Math.max(c.title.length, ...cells.map((row) => row[i].length))));
  const fmt = (vals) => vals.map((v, i) => {
    const w = widths[i];
    const s = v.length > w ? `${v.slice(0, w - 1)}…` : v;
    return i === vals.length - 1 ? s : s.padEnd(w);
  }).join('  ').trimEnd();
  return [fmt(columns.map((c) => c.title)), ...cells.map(fmt)].join('\n');
}

function formatDuration(sec) {
  const n = Math.round(Number(sec));
  if (!Number.isFinite(n) || n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = String(n % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

module.exports = { Output, table, formatDuration };
