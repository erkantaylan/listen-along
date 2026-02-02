const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const { parseError, isPlaylistUrl } = require('./ytdlp');

describe('ytdlp', () => {
  describe('isPlaylistUrl', () => {
    it('detects YouTube playlist URL with list parameter', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
      assert.strictEqual(isPlaylistUrl(url), true);
    });

    it('detects YouTube playlist URL without video', () => {
      const url = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
      assert.strictEqual(isPlaylistUrl(url), true);
    });

    it('returns false for regular video URL', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      assert.strictEqual(isPlaylistUrl(url), false);
    });

    it('returns false for short YouTube URL', () => {
      const url = 'https://youtu.be/dQw4w9WgXcQ';
      assert.strictEqual(isPlaylistUrl(url), false);
    });

    it('returns false for null input', () => {
      assert.strictEqual(isPlaylistUrl(null), false);
    });

    it('returns false for undefined input', () => {
      assert.strictEqual(isPlaylistUrl(undefined), false);
    });

    it('returns false for non-URL string', () => {
      assert.strictEqual(isPlaylistUrl('not a url'), false);
    });

    it('returns false for empty string', () => {
      assert.strictEqual(isPlaylistUrl(''), false);
    });
  });

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
