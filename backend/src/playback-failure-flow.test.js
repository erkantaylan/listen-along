// The stateful flow of a song that fails to play (frontend/playback-failure-flow.js):
// error -> verdict -> grey / hold -> another song plays -> asked again -> report,
// with a replace, a retry or a failing server in between. The page's questions
// (probe, confirm, report) are faked; `gate` lets a test act while one is pending.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let createFailureFlow;
const DECODE = 3;
const NOT_SUPPORTED = 4;
const MISSING = { status: 404, code: 'FILE_MISSING' };
const ok = (version = 'v1', mime = 'audio/mp4') => ({ status: 200, mime, version });
const song = (id) => ({ libraryId: id, url: `library:${id}`, title: `Song ${id}` });
const srcOf = (id, v = '') => `http://x/api/library/${id}/file${v ? `?v=${v}` : ''}`;

function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

// answers: src -> probe answer, or a function (call number) -> answer.
function setup({ answers = {}, confirm = 'undecodable', canPlay = true, online = true } = {}) {
  const w = {
    answers, confirm, canPlay, online,
    current: null, user: 'u1', accepts: true, reports: new Set(), sent: [], asked: [], probes: [], confirms: [], changes: 0,
    probeGate: null, confirmGate: null,
  };
  const calls = new Map();
  w.flow = createFailureFlow({
    online: () => w.online,
    probe: async (src) => {
      w.probes.push(src);
      if (w.probeGate) await w.probeGate.wait;
      const n = (calls.get(src) || 0) + 1;
      calls.set(src, n);
      const a = w.answers[src];
      return typeof a === 'function' ? a(n) : (a === undefined ? { failed: true } : a);
    },
    canPlay: () => w.canPlay,
    confirm: async (q) => {
      w.confirms.push(q);
      if (w.confirmGate) await w.confirmGate.wait;
      return typeof w.confirm === 'function' ? w.confirm(q) : w.confirm;
    },
    current: () => w.current,
    user: () => w.user,
    hasReport: (track) => w.reports.has(track.libraryId),
    // `accepts`: does the server confirm the song is broken?
    report: async (track) => {
      w.asked.push(`${w.user}:${track.libraryId}`);
      if (!w.accepts) return false;
      w.sent.push(track.libraryId);
      return true;
    },
    changed: () => { w.changes += 1; },
  });
  w.fail = (id, { errorCode = NOT_SUPPORTED, src = srcOf(id), ...rest } = {}) => w.flow.failure({ track: song(id), src, errorCode, ...rest });
  w.play = (id, src = srcOf(id)) => w.flow.played({ track: song(id), src });
  return w;
}

before(async () => {
  ({ createFailureFlow } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'playback-failure-flow.js')).href));
});

describe('playback-failure-flow: the happy paths still report', () => {
  it('a missing file: greyed and skipped, reported once another song has played', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    const r = await w.fail('a');
    assert.equal(r.stale, false);
    assert.equal(r.cause, 'missing');
    assert.deepEqual(r.action, { grey: true, skip: true, stop: false, report: true });
    assert.equal(w.flow.isFailed(song('a')), true);
    assert.deepEqual(w.sent, [], 'held, not sent');
    assert.deepEqual(w.confirms, [], 'no bytes needed: the server said it');

    assert.deepEqual((await w.play('b')).map((t) => t.libraryId), ['a']);
    assert.deepEqual(w.sent, ['a']);
    assert.equal(w.flow.isFailed(song('a')), true, 'still greyed for this page load');
    // The control and the second look both went to the server.
    assert.deepEqual(w.probes, [srcOf('a'), srcOf('b'), srcOf('a')]);
  });

  it('bytes that arrived whole and do not decode: reported after another song (either media error)', async () => {
    for (const errorCode of [NOT_SUPPORTED, DECODE]) {
      const w = setup({ answers: { [srcOf('a')]: ok('etag-a'), [srcOf('b')]: ok('etag-b') }, confirm: 'undecodable' });
      const r = await w.fail('a', { errorCode, position: 42 });
      assert.equal(r.cause, 'undecodable', `code ${errorCode}`);
      assert.deepEqual(w.confirms, [{ src: srcOf('a'), mime: 'audio/mp4', errorCode, position: 42 }]);
      await w.play('b');
      assert.deepEqual(w.sent, ['a'], `code ${errorCode}`);
    }
  });

  it('once per song per page load, and not for a song already on the list', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok(), [srcOf('c')]: MISSING } });
    await w.fail('a');
    await w.play('b');
    assert.equal((await w.fail('a')).action.report, false, 'tried already');
    w.reports.add('c');
    assert.equal((await w.fail('c')).action.report, false, 'someone reported it');
    await w.play('b');
    assert.deepEqual(w.sent, ['a']);
  });

  it('the failed song playing after all clears it and is not reported', async () => {
    const w = setup({ answers: { [srcOf('a')]: (n) => (n === 1 ? MISSING : ok()) } });
    await w.fail('a');
    await w.play('a');
    assert.equal(w.flow.isFailed(song('a')), false);
    assert.deepEqual(w.sent, []);
  });
});

describe('playback-failure-flow: a verdict overtaken while it was looked up', () => {
  it('replaced during the probe: not greyed, not held, the new file is never reported', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    w.probeGate = gate();
    const pending = w.fail('a');
    w.flow.clear(['library:a'], { forget: true }); // library:updated { replaced }
    w.probeGate.open();
    w.probeGate = null;
    assert.deepEqual(await pending, { stale: true });
    assert.equal(w.flow.isFailed(song('a')), false);
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('replaced during the byte check: the same', async () => {
    const w = setup({ answers: { [srcOf('a')]: ok('old'), [srcOf('b')]: ok() } });
    w.confirmGate = gate();
    const pending = w.fail('a', { errorCode: DECODE });
    await new Promise((r) => setImmediate(r));
    w.flow.clear(['library:a'], { forget: true });
    w.confirmGate.open();
    assert.deepEqual(await pending, { stale: true });
    assert.equal(w.flow.isFailed(song('a')), false);
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('played during the lookup (the listener tried again and it worked): not greyed, not reported', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    w.probeGate = gate();
    const pending = w.fail('a');
    const playing = w.play('a');
    w.probeGate.open();
    w.probeGate = null;
    assert.deepEqual(await pending, { stale: true });
    await playing;
    assert.equal(w.flow.isFailed(song('a')), false);
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('the player holds another file of the song by then (the replace event was missed): stale', async () => {
    const w = setup({ answers: { [srcOf('a', 'old')]: MISSING } });
    w.current = { keys: ['library:a'], src: srcOf('a', 'new') };
    assert.deepEqual(await w.fail('a', { src: srcOf('a', 'old') }), { stale: true });
    assert.equal(w.flow.isFailed(song('a')), false);
  });

  it('a stale failure does not count towards the streak', async () => {
    const w = setup({ answers: {} }); // every probe fails: the network
    w.current = { keys: ['library:a'], src: srcOf('a', 'new') };
    await w.fail('a', { src: srcOf('a', 'old') });
    w.current = null;
    assert.equal((await w.fail('b')).action.stop, false);
    assert.equal((await w.fail('c')).action.stop, false);
    assert.equal((await w.fail('d')).action.stop, true);
  });

  it('replaced while the report was held, or while it was asked again: dropped', async () => {
    let w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    await w.fail('a');
    w.flow.clear(['library:a'], { forget: true });
    await w.play('b');
    assert.deepEqual(w.sent, [], 'cleared while held');

    w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    await w.fail('a');
    w.probeGate = gate();
    const playing = w.play('b');
    w.flow.clear(['library:a'], { forget: true });
    w.probeGate.open();
    w.probeGate = null;
    await playing;
    assert.deepEqual(w.sent, [], 'cleared during the second look');
  });
});

describe('playback-failure-flow: a media error is not proof', () => {
  it('a flaky connection (the bytes cannot be fetched whole): greyed, nothing held', async () => {
    const w = setup({ answers: { [srcOf('a')]: ok(), [srcOf('b')]: ok() }, confirm: 'incomplete' });
    const r = await w.fail('a', { errorCode: NOT_SUPPORTED });
    assert.equal(r.cause, 'network');
    assert.equal(r.action.report, false);
    assert.equal(w.flow.isFailed(song('a')), true);
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('MEDIA_ERR_DECODE on a file whose bytes play (device switch, file changed under the url): no report', async () => {
    const w = setup({ answers: { [srcOf('a')]: ok(), [srcOf('b')]: ok() }, confirm: 'decodes' });
    const r = await w.fail('a', { errorCode: DECODE });
    assert.equal(r.cause, 'unknown');
    assert.equal(r.action.report, false);
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('a format this browser does not play: the bytes are not even fetched', async () => {
    const w = setup({ answers: { [srcOf('a')]: ok('v', 'audio/ogg') }, canPlay: false });
    const r = await w.fail('a', { errorCode: DECODE });
    assert.equal(r.cause, 'unsupported');
    assert.deepEqual(w.confirms, []);
  });

  it('offline: nothing is asked, nothing is held', async () => {
    const w = setup({ online: false });
    const r = await w.fail('a');
    assert.equal(r.cause, 'offline');
    assert.deepEqual(w.probes, []);
  });
});

describe('playback-failure-flow: the proof before a report is sent', () => {
  it('storage down, and a cached song sounds: the control is not served, nothing is sent', async () => {
    // Before the server told storage from songs: every file answered FILE_MISSING.
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: MISSING, [srcOf('c')]: MISSING } });
    await w.fail('a');
    await w.fail('b');
    await w.play('c'); // from the browser cache; the server would say FILE_MISSING
    assert.deepEqual(w.sent, []);
    // They are not kept for a later song either.
    w.answers[srcOf('c')] = ok();
    await w.play('c');
    assert.deepEqual(w.sent, []);
  });

  it('storage down, as the server says it now (404 STORAGE_UNAVAILABLE): counts towards the streak, never held', async () => {
    const down = { status: 404, code: 'STORAGE_UNAVAILABLE' };
    const w = setup({ answers: { [srcOf('a')]: down, [srcOf('b')]: down, [srcOf('c')]: down } });
    assert.equal((await w.fail('a')).cause, 'server');
    assert.equal((await w.fail('b')).action.report, false);
    await w.play('c');
    assert.deepEqual(w.sent, []);
  });

  it('the control cannot be reached: nothing is sent', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING } });
    await w.fail('a');
    await w.play('b'); // no answer for b
    assert.deepEqual(w.sent, []);
  });

  it('asked again, the held song is fine now (the file is back): dropped', async () => {
    const w = setup({ answers: { [srcOf('a')]: (n) => (n === 1 ? MISSING : ok()), [srcOf('b')]: ok() } });
    await w.fail('a');
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('asked again, storage went meanwhile: dropped', async () => {
    const w = setup({ answers: { [srcOf('a')]: (n) => (n === 1 ? MISSING : { status: 404, code: 'STORAGE_UNAVAILABLE' }), [srcOf('b')]: ok() } });
    await w.fail('a');
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('undecodable, but another file is served by then (or the file cannot be named): dropped', async () => {
    let w = setup({ answers: { [srcOf('a')]: (n) => ok(n === 1 ? 'old' : 'new'), [srcOf('b')]: ok() } });
    assert.equal((await w.fail('a', { errorCode: DECODE })).action.report, true);
    await w.play('b');
    assert.deepEqual(w.sent, []);

    w = setup({ answers: { [srcOf('a')]: { status: 200, mime: 'audio/mp4', version: null }, [srcOf('b')]: ok() } });
    await w.fail('a', { errorCode: DECODE });
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });

  it('someone reported it while it was held: not sent again', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    await w.fail('a');
    w.reports.add('a');
    await w.play('b');
    assert.deepEqual(w.sent, []);
  });
});

describe('playback-failure-flow: the server has the last word', () => {
  it('the server does not find the song broken: nothing is reported, it stays greyed, and it is not asked again', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    w.accepts = false;
    await w.fail('a');
    assert.deepEqual(await w.play('b'), [], 'no report to announce');
    assert.deepEqual(w.asked, ['u1:a']);
    assert.equal(w.flow.isFailed(song('a')), true);
    // The song fails again later in the same page load: greyed, never sent again.
    assert.equal((await w.fail('a')).action.report, false);
    await w.play('b');
    assert.deepEqual(w.asked, ['u1:a']);
    assert.deepEqual(w.sent, []);
  });

  it('a browser fault on a good file (both elements fail to decode) still goes to the server, which refuses', async () => {
    const w = setup({ answers: { [srcOf('a')]: ok('e1'), [srcOf('b')]: ok('e2') }, confirm: 'undecodable' });
    w.accepts = false;
    assert.equal((await w.fail('a', { errorCode: DECODE })).cause, 'undecodable');
    assert.deepEqual(await w.play('b'), []);
    assert.deepEqual(w.sent, []);
  });

  it('the request itself fails (rate limit, network): dropped, nothing announced', async () => {
    const thrower = createFailureFlow({
      online: () => true,
      probe: async (src) => (src === srcOf('a') ? MISSING : ok()),
      canPlay: () => true,
      confirm: async () => 'undecodable',
      current: () => null,
      user: () => 'u1',
      hasReport: () => false,
      report: async () => { throw new Error('HTTP 429'); },
      changed: () => {},
    });
    await thrower.failure({ track: song('a'), src: srcOf('a'), errorCode: NOT_SUPPORTED });
    assert.deepEqual(await thrower.played({ track: song('b'), src: srcOf('b') }), []);
  });
});

describe('playback-failure-flow: what the element really holds', () => {
  it('a queue entry replaced in place plays from the file url, not its stream url: a later failure is judged, not stale', async () => {
    // player.reloadReplaced loaded /api/library/<id>/file?v=… for a queue entry.
    const entry = { id: 'q1', url: 'library:a', title: 'Song a' };
    const fileUrl = srcOf('a', 'new');
    const w = setup({ answers: { [fileUrl]: MISSING } });
    w.current = { keys: ['library:a'], src: fileUrl }; // audio.currentSrc
    const r = await w.flow.failure({ track: entry, src: fileUrl, errorCode: NOT_SUPPORTED });
    assert.equal(r.stale, false);
    assert.deepEqual(r.action, { grey: true, skip: true, stop: false, report: true });
    assert.equal(w.flow.isFailed(entry), true);
  });
});

describe('playback-failure-flow: the signed-in account', () => {
  it('logout (reset) drops the greyed songs, the streak and the held reports', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: MISSING, [srcOf('c')]: ok() } });
    await w.fail('a');
    await w.fail('b');
    w.flow.reset();
    assert.equal(w.flow.isFailed(song('a')), false);
    await w.play('c');
    assert.deepEqual(w.asked, []);
    assert.equal((await w.fail('b')).action.stop, false, 'the streak started again');
  });

  it('another account signs in without a reload: a held report is never filed under it', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    await w.fail('a');
    w.user = 'u2';
    await w.play('b');
    assert.deepEqual(w.asked, []);
    assert.equal(w.flow.isFailed(song('a')), false, 'the other account starts with a clean list');
  });

  it('the account changes while a verdict or the second look is pending: thrown away', async () => {
    let w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    w.probeGate = gate();
    const pending = w.fail('a');
    w.user = null; // logged out
    w.probeGate.open();
    w.probeGate = null;
    assert.deepEqual(await pending, { stale: true });
    assert.equal(w.flow.isFailed(song('a')), false);

    w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    await w.fail('a');
    w.probeGate = gate();
    const playing = w.play('b');
    w.user = 'u2';
    w.probeGate.open();
    w.probeGate = null;
    await playing;
    assert.deepEqual(w.asked, []);
  });
});

describe('playback-failure-flow: the streak', () => {
  it('three in a row stop playback and drop what was held; a song that plays resets it', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: MISSING, [srcOf('c')]: MISSING, [srcOf('d')]: ok(), [srcOf('e')]: MISSING } });
    assert.equal((await w.fail('a')).action.report, true);
    assert.equal((await w.fail('b')).action.report, true);
    const third = await w.fail('c');
    assert.deepEqual(third.action, { grey: true, skip: false, stop: true, report: false });
    assert.equal(third.onlyNotInLibrary, false);
    await w.play('d');
    assert.deepEqual(w.sent, [], 'the two held ones were dropped with the stop');
    assert.equal((await w.fail('e')).action.stop, false, 'counting starts again');
  });

  it('a streak of songs that are only not in the library yet says so', async () => {
    const nil = { status: 404, code: 'NOT_IN_LIBRARY' };
    const w = setup({ answers: { [srcOf('a')]: nil, [srcOf('b')]: nil, [srcOf('c')]: nil } });
    await w.fail('a');
    await w.fail('b');
    const third = await w.fail('c');
    assert.equal(third.action.stop, true);
    assert.equal(third.onlyNotInLibrary, true);
  });

  it('listening along: greyed, never counted, skipped or held', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: MISSING, [srcOf('c')]: MISSING, [srcOf('d')]: MISSING, [srcOf('e')]: ok() } });
    for (const id of ['a', 'b', 'c', 'd']) {
      const r = await w.fail(id, { driven: true });
      assert.deepEqual(r.action, { grey: true, skip: false, stop: false, report: false }, id);
    }
    assert.equal(w.flow.isFailed(song('d')), true);
    await w.play('e');
    assert.deepEqual(w.sent, []);
  });
});

describe('playback-failure-flow: clearing', () => {
  it('clear un-greys and tells the lists; forget lets a replaced song be reported anew', async () => {
    const w = setup({ answers: { [srcOf('a')]: MISSING, [srcOf('b')]: ok() } });
    await w.fail('a');
    await w.play('b');
    assert.deepEqual(w.sent, ['a']);
    const before = w.changes;
    w.flow.clear(['library:a'], { forget: true });
    assert.equal(w.flow.isFailed(song('a')), false);
    assert.equal(w.changes, before + 1);
    assert.equal((await w.fail('a')).action.report, true, 'the new file can be reported');
  });

  it('a queue entry is greyed under its url, a library track under its id', async () => {
    const w = setup({ answers: { 'http://x/api/stream?q=yt': MISSING } });
    const entry = { id: 'q1', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'T' };
    await w.flow.failure({ track: entry, src: 'http://x/api/stream?q=yt', errorCode: NOT_SUPPORTED });
    assert.equal(w.flow.isFailed({ id: 'q9', url: entry.url }), true);
    w.flow.clear([entry.url]);
    assert.equal(w.flow.isFailed(entry), false);
  });
});
