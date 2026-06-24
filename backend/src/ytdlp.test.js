const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const { parseError, stripListParam } = require('./ytdlp');

describe('ytdlp', () => {
  describe('stripListParam', () => {
    it('strips the list param so only the single video is fetched', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
      assert.strictEqual(stripListParam(url), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('strips list and index params', () => {
      const url = 'https://www.youtube.com/watch?v=abc&list=PL123&index=4';
      assert.strictEqual(stripListParam(url), 'https://www.youtube.com/watch?v=abc');
    });

    it('leaves a plain video URL untouched', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      assert.strictEqual(stripListParam(url), url);
    });

    it('passes through search terms unchanged', () => {
      assert.strictEqual(stripListParam('rick astley never gonna give you up'), 'rick astley never gonna give you up');
    });

    it('passes through non-string input unchanged', () => {
      assert.strictEqual(stripListParam(null), null);
      assert.strictEqual(stripListParam(undefined), undefined);
    });
  });

  describe('parseError', () => {
    it('detects video unavailable', () => {
      const err = parseError('ERROR: Video unavailable', 1);
      assert.strictEqual(err.code, 'VIDEO_UNAVAILABLE');
    });

    it('detects DRM-protected content', () => {
      const err = parseError('ERROR: [DRM] The requested site is known to use DRM protection.', 1);
      assert.strictEqual(err.code, 'DRM_PROTECTED');
    });

    it('detects HTTP 404 as not found', () => {
      const err = parseError('WARNING: HTTP Error 404: Not Found. Retrying', 1);
      assert.strictEqual(err.code, 'NOT_FOUND');
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
