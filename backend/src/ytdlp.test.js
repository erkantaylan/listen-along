const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const { parseError } = require('./ytdlp');

describe('ytdlp', () => {
  describe('parseError', () => {
    it('detects video unavailable', () => {
      const err = parseError('ERROR: Video unavailable', 1);
      assert.strictEqual(err.code, 'VIDEO_UNAVAILABLE');
    });

    it('detects private video', () => {
      const err = parseError('ERROR: Private video', 1);
      assert.strictEqual(err.code, 'VIDEO_PRIVATE');
    });

    it('detects age-restricted video', () => {
      const err = parseError('ERROR: Sign in to confirm your age', 1);
      assert.strictEqual(err.code, 'VIDEO_RESTRICTED');
    });

    it('detects region blocked video', () => {
      const err = parseError('ERROR: not available in your country', 1);
      assert.strictEqual(err.code, 'VIDEO_BLOCKED');
    });

    it('detects no results', () => {
      const err = parseError('ERROR: Unable to extract video', 1);
      assert.strictEqual(err.code, 'NOT_FOUND');
    });

    it('detects no format available', () => {
      const err = parseError('ERROR: No video formats found', 1);
      assert.strictEqual(err.code, 'NO_FORMAT');
    });

    it('returns generic error for unknown errors', () => {
      const err = parseError('ERROR: Something weird happened', 42);
      assert.strictEqual(err.code, 'YTDLP_ERROR');
      assert.ok(err.message.includes('code 42'));
    });
  });
});
