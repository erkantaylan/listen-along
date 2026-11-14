// The downloads activity log's rules (frontend/activity-rules.js) and the
// server's reduced row (downloadJobs.toActivity).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const downloadJobs = require('./downloadJobs');

let m;
const at = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
const job = (id, min, status = 'done', extra = {}) => ({ id, created_at: at(min), status, ...extra });

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'activity-rules.js')).href);
});

describe('activity-rules: order and bound', () => {
  it('newest first by when it was asked for; ties by id', () => {
    const list = m.orderRows([job('b', 1), job('c', 3), job('a', 1), job('d', 2)]);
    assert.deepEqual(list.map((j) => j.id), ['c', 'd', 'a', 'b']);
  });
  it('drops finished rows past the bound, never an active one', () => {
    const list = m.orderRows([job('new', 9), job('mid', 5, 'failed'), job('old-queued', 2, 'queued'), job('old-running', 1, 'assigned'), job('oldest', 0)], 2);
    assert.deepEqual(list.map((j) => j.id), ['new', 'mid', 'old-queued', 'old-running']);
  });
  it('counts what is waiting or running', () => {
    assert.equal(m.activeCount([job('a', 1, 'queued'), job('b', 2, 'assigned'), job('c', 3, 'done'), job('d', 4, 'cancelled'), job('e', 5, 'failed')]), 2);
  });
});

describe('activity-rules: live updates', () => {
  it('a changed job replaces its row in place: nothing moves', () => {
    const list = [job('c', 3, 'queued'), job('b', 2, 'assigned'), job('a', 1)];
    const next = m.mergeJob(list, job('b', 2, 'done', { finished_at: at(30) }));
    assert.deepEqual(next.map((j) => `${j.id}:${j.status}`), ['c:queued', 'b:done', 'a:done']);
    assert.equal(list[1].status, 'assigned', 'the old list is untouched');
  });
  it('a new job goes on top and the oldest finished row falls off', () => {
    const list = [job('c', 3), job('b', 2, 'queued'), job('a', 1)];
    const next = m.mergeJob(list, job('d', 4, 'queued'), 3);
    assert.deepEqual(next.map((j) => j.id), ['d', 'c', 'b']);
  });
  it('ignores a job without an id', () => {
    const list = [job('a', 1)];
    assert.equal(m.mergeJob(list, null), list);
    assert.equal(m.mergeJob(list, {}), list);
  });
  it('progress writes only on a running row', () => {
    const list = [job('run', 2, 'assigned', { stage: 'assigned', percent: null }), job('fin', 1, 'done')];
    const next = m.applyProgress(list, { id: 'run', stage: 'uploading', percent: 42 });
    assert.equal(next[0].percent, 42);
    assert.equal(next[0].stage, 'uploading');
    assert.equal(next[1], list[1]);
    // The same again, a finished row, an unknown row: the same list.
    assert.equal(m.applyProgress(next, { id: 'run', stage: 'uploading', percent: 42 }), next);
    assert.equal(m.applyProgress(list, { id: 'fin', stage: 'uploading', percent: 99 }), list);
    assert.equal(m.applyProgress(list, { id: 'nope', percent: 1 }), list);
    assert.equal(m.applyProgress(list, null), list);
  });
  it('a row older than the one held is ignored (updated_at)', () => {
    const held = [job('a', 1, 'done', { updated_at: at(9) })];
    assert.equal(m.mergeJob(held, job('a', 1, 'assigned', { updated_at: at(5) })), held);
    assert.equal(m.mergeJob(held, job('a', 1, 'failed', { updated_at: at(9) }))[0].status, 'failed', 'the same moment: the later arrival');
    assert.equal(m.mergeJob(held, job('a', 1, 'queued', { updated_at: at(10) }))[0].status, 'queued');
  });
  it('a list that arrives takes the rows that changed on its way, and never undoes a newer row', () => {
    // The list was read while 'a' was still running; its end arrived meanwhile.
    const listed = [job('a', 1, 'assigned', { updated_at: at(5) }), job('b', 2, 'done', { updated_at: at(8) })];
    const meanwhile = [job('a', 1, 'done', { updated_at: at(6) }), job('c', 3, 'queued', { updated_at: at(6) }), job('b', 2, 'assigned', { updated_at: at(4) })];
    const next = m.applyLoad(listed, meanwhile);
    assert.deepEqual(next.map((j) => `${j.id}:${j.status}`), ['c:queued', 'b:done', 'a:done']);
    assert.deepEqual(m.applyLoad(null, []), []);
  });
});

describe('activity-rules: what a row shows', () => {
  it('title: the job\'s, else the song it became, else the song it replaces, else nothing', () => {
    assert.equal(m.rowTitle({ title: 'Band - Song', song: { title: 'Other' } }), 'Band - Song');
    assert.equal(m.rowTitle({ title: null, song: { title: 'Song', artist: 'Band' } }), 'Band - Song');
    assert.equal(m.rowTitle({ replace: { title: 'Old', artist: null } }), 'Old');
    assert.equal(m.rowTitle({ kind: 'playlist' }), null);
  });
  it('time: when it was asked for while active, when it ended after', () => {
    assert.equal(m.rowTime(job('a', 1, 'assigned', { started_at: at(5) })), Date.parse(at(1)));
    assert.equal(m.rowTime(job('a', 1, 'failed', { finished_at: at(9) })), Date.parse(at(9)));
    assert.equal(m.rowTime(job('a', 1, 'cancelled')), Date.parse(at(1)));
  });
});

describe('activity-rules: wording from codes, not from the downloader\'s text', () => {
  it('a failure code has a sentence key; an unknown one is generic', () => {
    assert.equal(m.failureKey('VIDEO_UNAVAILABLE'), 'unavailable');
    assert.equal(m.failureKey('YTDLP_FAILED'), 'ytdlp');
    assert.equal(m.failureKey('NOT_FOUND'), 'noResults');
    assert.equal(m.failureKey('duplicate_hash'), 'duplicate');
    assert.equal(m.failureKey('WORKER_LOST'), 'workerLost');
    assert.equal(m.failureKey('HTTP_413'), 'server');
    for (const code of ['SOMETHING_NEW', 'ERROR', '', null, undefined, 'toString', 'constructor', 'HTTP_x']) assert.equal(m.failureKey(code), 'generic', String(code));
  });
  it('every failure key has a sentence in both languages', () => {
    const fs = require('fs');
    const keys = new Set(['generic', 'server', ...['VIDEO_UNAVAILABLE', 'VIDEO_PRIVATE', 'VIDEO_RESTRICTED', 'AGE_RESTRICTED', 'REGION_BLOCKED', 'DRM_PROTECTED', 'BOT_CHECK',
      'FORBIDDEN', 'NO_M4A_FORMAT', 'JS_CHALLENGE', 'YTDLP_FAILED', 'MISSING_DEPENDENCY', 'NETWORK', 'UNREACHABLE', 'NOT_FOUND', 'NO_MATCH', 'NOT_M4A', 'BAD_MEDIA', 'CONVERT_FAILED',
      'MISSING_TAGS', 'already_in_library', 'duplicate_hash', 'duplicate_metadata', 'SONG_DELETED', 'WORKER_LOST', 'NOTHING_DOWNLOADED'].map(m.failureKey)]);
    assert.ok(!keys.has(undefined));
    for (const lang of ['en', 'tr']) {
      const fail = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'locales', `${lang}.json`), 'utf8')).activity.fail;
      assert.deepEqual(Object.keys(fail).sort(), [...keys].sort(), lang);
    }
  });
  it('a running row adds the stage and the percent', () => {
    assert.deepEqual(m.progressOf({ status: 'assigned', stage: 'uploading', percent: 42 }), { key: 'uploading', percent: 42 });
    assert.deepEqual(m.progressOf({ status: 'assigned', stage: 'uploading', percent: null }), { key: 'uploading', percent: null });
    assert.deepEqual(m.progressOf({ status: 'assigned', stage: 'resolving' }), { key: 'searching', percent: null });
    assert.equal(m.progressOf({ status: 'assigned', stage: 'downloading' }), null);
    assert.equal(m.progressOf({ status: 'done', stage: 'uploading', percent: 99 }), null);
  });
});

// Free text a worker may send, with what must never reach anyone but the requester.
const WORKER_TEXTS = [
  'No file at /home/John Smith/dl/feed.opus',
  'C:\\Users\\John Smith\\Music\\a.opus missing',
  'open file:///home/bob/dl/x.opus failed',
  'ENOENT {/home/bob/x/y}',
  '>/home/bob/x/y',
  'x;/home/bob/a/b',
  'path=<C:\\Users\\bob\\a.opus>',
  '~bob/dl/x',
  '$HOME/dl/x',
  '../bob/secret/x.opus',
  'https://user:pw@host/x/y',
  'Using local copy /home/bob/.cache/la/abc.opus',
  'yt-dlp reported a file that does not exist: /home/bob/.cache/la/abc.opus',
];
const LEAK = /John|Smith|bob|home|Users|HOME|secret|user:pw|\.opus|cache|feed|Music/;

describe('downloadJobs.toActivity (what everyone may see of a job)', () => {
  const row = {
    id: 'j1', source: 'web', kind: 'video', input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Band - Song',
    playlist_id: 'abcd1234', playlist_name: 'Secret mix', requested_by: 'Alice', requested_by_user_id: 'u-alice',
    status: 'failed', stage: null, progress: null, worker_id: 'w1', worker_name: 'attic', worker_owner: 'Bob',
    attempts: 2, error_code: 'YTDLP_FAILED', error_message: 'yt-dlp reported a file that does not exist: /home/bob/.cache/la/abc.opus',
    result: { summary: { total: 1, failed: 1 }, results: [{ status: 'failed', error: '/home/bob/x' }] },
    request_id: 'r1', created_at: at(1), started_at: at(2), finished_at: at(3),
    hostname: 'attic.lan', last_ip: '10.0.0.7',
  };
  it('names the requester and the worker by name and owner, and nothing of the machine or of ids', () => {
    const v = downloadJobs.toActivity(row);
    assert.equal(v.requested_by, 'Alice');
    assert.deepEqual(v.worker, { name: 'attic', owner: 'Bob' });
    assert.deepEqual(Object.keys(v).sort(), ['created_at', 'error_code', 'finished_at', 'id', 'input', 'kind', 'percent',
      'playlist_id', 'playlist_name', 'progress', 'replace', 'requested_by', 'song', 'source', 'stage', 'started_at', 'status', 'summary', 'title', 'updated_at', 'worker']);
    assert.doesNotMatch(JSON.stringify(v), /u-alice|w1"|attic\.lan|10\.0\.0\.7|r1"/);
  });
  it('the playlist is only what the caller passes: never the joined name', () => {
    const bare = downloadJobs.toActivity(row);
    assert.equal(bare.playlist_id, null);
    assert.equal(bare.playlist_name, null);
    assert.doesNotMatch(JSON.stringify(bare), /Secret mix|abcd1234/);
    const seen = downloadJobs.toActivity(row, { id: 'abcd1234', name: 'Secret mix', ownerId: 'u-alice' });
    assert.equal(seen.playlist_id, 'abcd1234');
    assert.equal(seen.playlist_name, 'Secret mix');
  });
  it('a failure is its code: the worker\'s message is never on the row', () => {
    for (const text of WORKER_TEXTS) {
      const v = downloadJobs.toActivity({ ...row, error_message: text, result: { summary: { total: 1, failed: 1 }, results: [{ status: 'failed', error: text }] } });
      assert.equal(v.error_message, undefined);
      assert.equal(v.error_code, 'YTDLP_FAILED');
      assert.doesNotMatch(JSON.stringify(v), LEAK, text);
    }
    // A code is an identifier or nothing.
    for (const code of WORKER_TEXTS) assert.equal(downloadJobs.toActivity({ ...row, error_code: code }).error_code, null, code);
    assert.equal(downloadJobs.toActivity({ ...row, status: 'done', error_code: 'OLD' }).error_code, null);
  });
  it('a running job is its stage and upload percent: the worker\'s progress line is never on the row', () => {
    const running = { ...row, status: 'assigned', error_code: null, error_message: null, finished_at: null };
    for (const text of WORKER_TEXTS) {
      for (const stage of ['uploading', 'working', text]) {
        const v = downloadJobs.toActivity({ ...running, stage, progress: text });
        assert.equal(v.progress, null);
        assert.equal(v.percent, null);
        assert.doesNotMatch(JSON.stringify(v), LEAK, text);
      }
    }
    const up = downloadJobs.toActivity({ ...running, stage: 'uploading', progress: 'Uploading /home/bob/dl/feed.opus… 42%' });
    assert.deepEqual([up.stage, up.percent, up.progress], ['uploading', 42, null]);
    assert.doesNotMatch(JSON.stringify(up), LEAK);
    assert.equal(downloadJobs.toActivity({ ...running, stage: 'uploading', progress: 'Uploading x… 420%' }).percent, null);
    assert.equal(downloadJobs.toActivity({ ...running, stage: 'downloading', progress: 'Downloading 50%' }).percent, null, 'the percent is the upload\'s');
  });
  it('a note is passed on only when this server wrote it', () => {
    const note = (status, progress) => downloadJobs.toActivity({ ...row, status, stage: null, progress }).progress;
    assert.equal(note('cancelled', 'Request dismissed'), 'Request dismissed');
    assert.equal(note('done', 'Uploaded by someone else'), 'Uploaded by someone else');
    assert.equal(note('queued', 'Downloader went away'), 'Downloader went away');
    // A worker's reason for giving a job back is its own text.
    assert.equal(note('queued', 'Given back: cannot write /home/bob/dl'), null);
    for (const text of WORKER_TEXTS) assert.equal(note('queued', text), null, text);
  });
  it('raw input only when it is the video\'s link', () => {
    assert.equal(downloadJobs.toActivity(row).input, row.input);
    const list = downloadJobs.toActivity({ ...row, kind: 'playlist', title: null, input: 'https://www.youtube.com/playlist?list=PLprivate' });
    assert.equal(list.input, null);
    assert.equal(list.title, null);
    const search = downloadJobs.toActivity({ ...row, kind: 'search', title: null, input: 'band song' });
    assert.equal(search.input, null);
    assert.equal(search.title, 'band song');
  });
});
