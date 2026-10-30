'use strict';

/**
 * Process exit codes. Documented in `la --help` and README so scripts/agents
 * can branch on them.
 */
const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1, // generic error, or a batch where at least one item failed
  USAGE: 2, // bad arguments / unknown command
  CONFIG: 3, // server or token not configured
  AUTH: 4, // server rejected the token (401/403)
  SERVER: 5, // server unreachable, or unexpected HTTP error
  DEPENDENCY: 6, // yt-dlp / ffmpeg / ffprobe missing
});

/** An error that carries an exit code and a stable machine-readable code. */
class CliError extends Error {
  /**
   * @param {string} message - human-readable message
   * @param {object} [opts]
   * @param {number} [opts.exitCode]
   * @param {string} [opts.code] - stable identifier, e.g. 'NOT_CONFIGURED'
   * @param {string} [opts.hint] - extra advice printed after the message
   */
  constructor(message, { exitCode = EXIT.FAILURE, code = 'ERROR', hint } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    if (hint) this.hint = hint;
  }
}

class UsageError extends CliError {
  constructor(message, hint) {
    super(message, { exitCode: EXIT.USAGE, code: 'USAGE', hint });
    this.name = 'UsageError';
  }
}

module.exports = { EXIT, CliError, UsageError };
