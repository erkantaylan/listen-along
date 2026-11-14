// What happens when a song fails to play (frontend/playback-failure-rules.js):
// grey and skip always, an automatic "needs replacement" report only when the
// song itself is at fault and the surroundings are known to work.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
const DECODE = 3;
const NOT_SUPPORTED = 4;
const served = (mime = 'audio/mp4') => ({ status: 200, mime });

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'playback-failure-rules.js')).href);
});

describe('playback-failure-rules: failureCause', () => {
  it('offline wins over everything', () => {
    assert.equal(m.failureCause({ online: false, errorCode: DECODE, probe: served(), canPlay: true, bytes: 'undecodable' }), 'offline');
    assert.equal(m.failureCause({ online: false, errorCode: NOT_SUPPORTED, probe: { status: 404, code: 'FILE_MISSING' } }), 'offline');
  });

  it('no answer, a timeout or a server error is the network / server, never the song', () => {
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: null }), 'network');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { failed: true } }), 'network');
    for (const status of [500, 502, 503, 504, 429, 408]) {
      assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status } }), 'server', String(status));
    }
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 404, code: 'STORAGE_UNAVAILABLE' } }), 'server', 'a 404 like a missing file, but it is the storage, not the song');
    assert.equal(m.isSongFault(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 404, code: 'STORAGE_UNAVAILABLE' } })), false);
  });

  it('401 / 403 is an expired session', () => {
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 401 } }), 'session');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 403, code: 'FILE_MISSING' } }), 'session');
  });

  it('404: only the server saying "the file is missing" blames the song', () => {
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 404, code: 'FILE_MISSING' } }), 'missing');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 404, code: 'NOT_IN_LIBRARY' } }), 'not-in-library');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 404, code: 'NOT_FOUND' } }), 'gone');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 410 } }), 'gone');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 404 } }), 'unknown', 'a proxy 404');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 416 } }), 'unknown');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: { status: 302 } }), 'unknown');
  });

  it('a served file: a media error alone never blames the song, whichever code', () => {
    for (const errorCode of [DECODE, NOT_SUPPORTED]) {
      assert.equal(m.failureCause({ errorCode, probe: served(), canPlay: true }), 'network', `code ${errorCode}, bytes not checked`);
      assert.equal(m.failureCause({ errorCode, probe: served(), canPlay: true, bytes: 'incomplete' }), 'network', `code ${errorCode}, bytes not fetched whole`);
      assert.equal(m.failureCause({ errorCode, probe: served(), canPlay: true, bytes: 'decodes' }), 'unknown', `code ${errorCode}, the bytes play`);
      assert.equal(m.failureCause({ errorCode, probe: served(), canPlay: true, bytes: 'undecodable' }), 'undecodable', `code ${errorCode}`);
    }
  });

  it('a served file in a format this browser does not play is not the song', () => {
    assert.equal(m.failureCause({ errorCode: DECODE, probe: served('audio/ogg'), canPlay: false }), 'unsupported');
    assert.equal(m.failureCause({ errorCode: NOT_SUPPORTED, probe: served('audio/ogg'), canPlay: false, bytes: 'undecodable' }), 'unsupported');
  });

  it('a served file: a network or aborted media error is not the song', () => {
    assert.equal(m.failureCause({ errorCode: 2, probe: served(), canPlay: true, bytes: 'undecodable' }), 'network');
    assert.equal(m.failureCause({ errorCode: 1, probe: served(), canPlay: true, bytes: 'undecodable' }), 'unknown');
    assert.equal(m.failureCause({ errorCode: 0, probe: served(), canPlay: true }), 'unknown');
  });

  it('isSongFault: missing and undecodable only', () => {
    const faults = ['offline', 'network', 'session', 'server', 'not-in-library', 'gone', 'missing', 'unsupported', 'undecodable', 'unknown'].filter(m.isSongFault);
    assert.deepEqual(faults, ['missing', 'undecodable']);
  });
});

describe('playback-failure-rules: sameFault (a held report, asked again before it is sent)', () => {
  it('missing: the server still says so', () => {
    assert.equal(m.sameFault('missing', null, { status: 404, code: 'FILE_MISSING' }), true);
    assert.equal(m.sameFault('missing', null, { status: 404, code: 'STORAGE_UNAVAILABLE' }), false);
    assert.equal(m.sameFault('missing', null, { status: 404, code: 'NOT_FOUND' }), false);
    assert.equal(m.sameFault('missing', null, { status: 200, version: 'a' }), false, 'the file is back');
    assert.equal(m.sameFault('missing', null, { failed: true }), false);
    assert.equal(m.sameFault('missing', null, null), false);
  });
  it('undecodable: the same file is still served', () => {
    assert.equal(m.sameFault('undecodable', 'etag-1', { status: 200, version: 'etag-1' }), true);
    assert.equal(m.sameFault('undecodable', 'etag-1', { status: 200, version: 'etag-2' }), false, 'another file now');
    assert.equal(m.sameFault('undecodable', null, { status: 200, version: null }), false, 'cannot tell');
    assert.equal(m.sameFault('undecodable', 'etag-1', { status: 404, code: 'FILE_MISSING' }), false);
  });
  it('nothing else is ever sent', () => {
    for (const cause of ['network', 'server', 'unknown', 'unsupported', 'gone']) assert.equal(m.sameFault(cause, 'v', { status: 200, version: 'v' }), false, cause);
  });
  it('isServed: a 2xx answer', () => {
    assert.equal(m.isServed({ status: 200 }), true);
    assert.equal(m.isServed({ status: 206 }), true);
    assert.equal(m.isServed({ status: 404, code: 'FILE_MISSING' }), false);
    assert.equal(m.isServed({ failed: true }), false);
    assert.equal(m.isServed(null), false);
  });
});

describe('playback-failure-rules: codecQuery', () => {
  it('asks with the codec for the two stored formats', () => {
    assert.equal(m.codecQuery('audio/mp4'), 'audio/mp4; codecs="mp4a.40.2"');
    assert.equal(m.codecQuery('Audio/OGG; charset=binary'), 'audio/ogg; codecs="opus"');
  });
  it('anything else has no question (so nothing is reported)', () => {
    assert.equal(m.codecQuery('application/json'), null);
    assert.equal(m.codecQuery('text/html'), null);
    assert.equal(m.codecQuery(null), null);
  });
});

describe('playback-failure-rules: failureAction', () => {
  it('every failure greys; a single one is skipped', () => {
    for (const cause of ['offline', 'network', 'server', 'session', 'not-in-library', 'gone', 'unsupported', 'unknown']) {
      assert.deepEqual(m.failureAction({ cause, streak: 1 }), { grey: true, skip: true, stop: false, report: false }, cause);
    }
  });

  it('a song at fault is put up for a report', () => {
    assert.deepEqual(m.failureAction({ cause: 'missing', streak: 1 }), { grey: true, skip: true, stop: false, report: true });
    assert.deepEqual(m.failureAction({ cause: 'undecodable', streak: 2 }), { grey: true, skip: true, stop: false, report: true });
  });

  it('once per song per session, and not when it is on the list already', () => {
    assert.equal(m.failureAction({ cause: 'missing', tried: true }).report, false);
    assert.equal(m.failureAction({ cause: 'missing', reported: true }).report, false);
  });

  it('the streak limit stops instead of skipping, and reports nothing', () => {
    assert.equal(m.STREAK_LIMIT, 3);
    assert.deepEqual(m.failureAction({ cause: 'network', streak: 3 }), { grey: true, skip: false, stop: true, report: false });
    assert.deepEqual(m.failureAction({ cause: 'missing', streak: 3 }), { grey: true, skip: false, stop: true, report: false });
    assert.equal(m.failureAction({ cause: 'missing', streak: 7 }).stop, true);
  });

  it('listening along: greyed only, the leader decides', () => {
    assert.deepEqual(m.failureAction({ cause: 'missing', streak: 0, driven: true }), { grey: true, skip: false, stop: false, report: false });
    assert.deepEqual(m.failureAction({ cause: 'undecodable', streak: 5, driven: true }), { grey: true, skip: false, stop: false, report: false });
  });
});

describe('playback-failure-rules: settleReports', () => {
  const a = { keys: ['library:a', 'https://youtu.be/a'] };
  const b = { keys: ['library:b'] };

  it('held until a song plays; then sent', () => {
    assert.deepEqual(m.settleReports([a, b], 'failed'), { send: [], held: [a, b] });
    assert.deepEqual(m.settleReports([a, b], 'played', ['library:c']), { send: [a, b], held: [] });
  });

  it('the song that plays after all is not reported (under any of its keys)', () => {
    assert.deepEqual(m.settleReports([a, b], 'played', ['https://youtu.be/a']), { send: [b], held: [] });
    assert.deepEqual(m.settleReports([a, b], 'played', ['library:b', 'x']), { send: [a], held: [] });
  });

  it('a stop for too many failures drops them all', () => {
    assert.deepEqual(m.settleReports([a, b], 'stopped'), { send: [], held: [] });
  });
});

describe('playback-failure-rules: trackKeys', () => {
  it('a library track: its id; a queue entry: its url; both when it has both', () => {
    assert.deepEqual(m.trackKeys({ libraryId: 'x', url: 'library:x' }), ['library:x']);
    assert.deepEqual(m.trackKeys({ id: 'q1', url: 'https://www.youtube.com/watch?v=abc' }), ['https://www.youtube.com/watch?v=abc']);
    assert.deepEqual(m.trackKeys({ libraryId: 'x', url: 'https://y/1' }), ['library:x', 'https://y/1']);
    assert.deepEqual(m.trackKeys(null), []);
  });
});
