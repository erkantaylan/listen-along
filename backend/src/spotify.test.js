const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseSpotifyUrl } = require('./spotify');

describe('spotify', () => {
  describe('parseSpotifyUrl', () => {
    it('parses a track URL', () => {
      const result = parseSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
      assert.deepStrictEqual(result, { type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });
    });

    it('parses a playlist URL', () => {
      const result = parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
      assert.deepStrictEqual(result, { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
    });

    it('parses a track URL with query parameters', () => {
      const result = parseSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abcdef123456');
      assert.deepStrictEqual(result, { type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' });
    });

    it('returns null for YouTube URLs', () => {
      assert.strictEqual(parseSpotifyUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
    });

    it('returns null for non-Spotify URLs', () => {
      assert.strictEqual(parseSpotifyUrl('https://example.com/track/abc'), null);
    });

    it('returns null for Spotify URLs without type', () => {
      assert.strictEqual(parseSpotifyUrl('https://open.spotify.com/'), null);
    });

    it('returns null for unsupported Spotify types', () => {
      assert.strictEqual(parseSpotifyUrl('https://open.spotify.com/album/abc123'), null);
    });

    it('returns null for null input', () => {
      assert.strictEqual(parseSpotifyUrl(null), null);
    });

    it('returns null for undefined input', () => {
      assert.strictEqual(parseSpotifyUrl(undefined), null);
    });

    it('returns null for empty string', () => {
      assert.strictEqual(parseSpotifyUrl(''), null);
    });

    it('returns null for non-URL string', () => {
      assert.strictEqual(parseSpotifyUrl('not a url'), null);
    });
  });
});
