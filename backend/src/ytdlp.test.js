const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const { parseError, stripListParam, parsePlaylistId } = require('./ytdlp');

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

  describe('parsePlaylistId', () => {
    it('returns the list id for a real playlist on a watch URL', () => {
      assert.strictEqual(
        parsePlaylistId('https://www.youtube.com/watch?v=abc&list=PLyUKaKIB05bRZnk6sQK&index=7'),
        'PLyUKaKIB05bRZnk6sQK'
      );
    });

    it('returns the list id for a playlist page URL', () => {
      assert.strictEqual(parsePlaylistId('https://www.youtube.com/playlist?list=OLAK5uy_abc'), 'OLAK5uy_abc');
    });

    it('ignores auto-generated radio/mix lists (RD…)', () => {
      assert.strictEqual(parsePlaylistId('https://www.youtube.com/watch?v=abc&list=RDabc'), null);
    });

    it('returns null for a plain watch URL, search term, or non-string', () => {
      assert.strictEqual(parsePlaylistId('https://www.youtube.com/watch?v=abc'), null);
      assert.strictEqual(parsePlaylistId('never gonna give you up'), null);
      assert.strictEqual(parsePlaylistId(null), null);
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
      assert.strictEqual(err.code, 'AGE_RESTRICTED');
    });

    it('detects bot/IP check distinctly from age restriction', () => {
      const err = parseError("ERROR: Sign in to confirm you're not a bot", 1);
      assert.strictEqual(err.code, 'BOT_CHECK');
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

describe('ytdlp availability cache (/health)', () => {
  const { createAvailabilityCache } = require('./ytdlp');

  it('spawns one check for many /health calls within maxAge', async () => {
    let calls = 0;
    let t = 0;
    const cached = createAvailabilityCache({ check: async () => { calls++; return true; }, maxAgeMs: 1000, now: () => t });
    assert.strictEqual(await cached(), true);
    for (let i = 0; i < 50; i++) { t += 10; assert.strictEqual(await cached(), true); }
    assert.strictEqual(calls, 1);
  });

  it('shares one in-flight check between concurrent callers', async () => {
    let calls = 0;
    const cached = createAvailabilityCache({ check: () => { calls++; return new Promise((r) => setTimeout(() => r(true), 20)); } });
    const all = await Promise.all([cached(), cached(), cached()]);
    assert.deepStrictEqual(all, [true, true, true]);
    assert.strictEqual(calls, 1);
  });

  it('answers a stale value at once and refreshes in the background', async () => {
    let calls = 0;
    let t = 0;
    let result = true;
    let release;
    const cached = createAvailabilityCache({
      check: () => { calls++; return calls === 1 ? result : new Promise((r) => { release = () => r(false); }); },
      maxAgeMs: 100, now: () => t,
    });
    assert.strictEqual(await cached(), true);
    t = 500;
    assert.strictEqual(await cached(), true, 'stale value, no waiting on the refresh');
    assert.strictEqual(calls, 2);
    release();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(await cached(), false, 'refreshed value');
  });

  it('a throwing check counts as unavailable', async () => {
    const cached = createAvailabilityCache({ check: () => { throw new Error('boom'); } });
    assert.strictEqual(await cached(), false);
  });
});
