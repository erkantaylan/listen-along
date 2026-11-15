// What everyone may see of a download job (downloadJobs.toActivity): the
// server's reduced row for the activity log. The log's frontend rules are
// tested in frontend/src/features/social/activity-rules.test.ts.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { downloadJobs } = require('./core/jobs/index.ts');

const at = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();

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
