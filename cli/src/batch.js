'use strict';

const { EXIT } = require('./errors');

/**
 * Result statuses for one batch item:
 *   uploaded        - new song stored on the server
 *   skipped         - already in the library (pre-check or 409 duplicate)
 *   failed          - error; see `error` / `code`
 *   would_download  - --dry-run: would download + upload
 *   would_upload    - --dry-run: would upload
 *   downloaded      - --no-upload: saved locally only
 *   dismissed       - request dismissed
 */
class Batch {
  constructor(out) {
    this.out = out;
    this.results = [];
    // Optional async follow-up per result (e.g. add to a playlist); runBatch
    // waits for all of them before reporting.
    this.onAdd = null;
    this.pending = [];
  }

  /** Wait for every onAdd follow-up started so far. */
  async settle() {
    while (this.pending.length) await Promise.allSettled(this.pending.splice(0));
  }

  add(result) {
    this.results.push(result);
    const label = result.label || result.input || result.file || result.id;
    const icon = { uploaded: 'uploaded', skipped: 'skipped', failed: 'FAILED', downloaded: 'saved', replaced: 'replaced' }[result.status] || result.status;
    let line = `[${icon}] ${label}`;
    if (result.status === 'failed') line += ` — ${result.error}`;
    else if (result.reason) line += ` (${result.reason})`;
    if (result.duplicate_of) {
      const d = result.duplicate_of;
      line += ` — matches "${d.title}"${d.artist ? ` by ${d.artist}` : ''} [${d.id}]`;
    }
    if (result.status === 'replaced' && result.previous) {
      line += ` — was "${result.previous.title}"${result.previous.artist ? ` by ${result.previous.artist}` : ''} [${result.replaced_id}]`;
    }
    this.out.info(line);
    if (this.onAdd) {
      const p = this.onAdd(result);
      if (p) this.pending.push(p);
    }
    return result;
  }

  summary() {
    const s = { total: this.results.length };
    for (const r of this.results) s[r.status] = (s[r.status] || 0) + 1;
    for (const k of ['uploaded', 'skipped', 'failed']) s[k] = s[k] || 0;
    return s;
  }

  get exitCode() {
    return this.results.some((r) => r.status === 'failed' || r.playlist_status === 'failed') ? EXIT.FAILURE : EXIT.OK;
  }

  /** Print final summary (human) or the full JSON document. */
  finish(extra = {}) {
    const summary = this.summary();
    const { playlistLine, ...doc } = extra;
    this.out.result({ ...doc, summary, results: this.results.map(({ label, ...r }) => r) }, () => {
      const parts = Object.entries(summary).filter(([k, v]) => k !== 'total' && v).map(([k, v]) => `${v} ${k.replace('_', ' ')}`);
      this.out.print(`\nSummary: ${summary.total} item(s)${parts.length ? ': ' + parts.join(', ') : ''}`);
      if (extra.playlistLine) this.out.print(extra.playlistLine());
      const failed = this.results.filter((r) => r.status === 'failed');
      if (failed.length) {
        this.out.print('Failed:');
        for (const r of failed) this.out.print(`  - ${r.label || r.input || r.file}: ${r.error}${r.code ? ` [${r.code}]` : ''}`);
      }
    });
    return this.exitCode;
  }
}

/**
 * Run a batch body. A fatal error (auth, server unreachable, missing tool)
 * aborts the batch: the partial results are still reported, with an
 * `aborted` entry, and the fatal error's exit code is returned.
 */
async function runBatch(out, batch, body, extra = {}) {
  try {
    await body();
    await batch.settle();
  } catch (err) {
    await batch.settle();
    if (!err.exitCode || batch.results.length === 0) throw err;
    out.error(err);
    const aborted = { code: err.code, message: err.message };
    if (err.hint) aborted.hint = err.hint;
    batch.finish({ ...extra, aborted });
    return err.exitCode;
  }
  return batch.finish(extra);
}

module.exports = { Batch, runBatch };
