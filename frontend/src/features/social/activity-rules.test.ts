// The downloads activity log's rules (activity-rules.ts). The server's reduced
// row (downloadJobs.toActivity) is tested in backend/src/activity-row.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as m from './activity-rules.ts';
import type { ActivityProgressPayload, ActivityRow } from '../../shared/types.ts';

// frontend/ (this file is frontend/src/features/social/).
const FRONTEND = path.join(import.meta.dirname, '..', '..', '..');
const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
// Rows carry only the fields a test needs: fakes where a full ActivityRow is expected.
const fake = (row: object) => row as ActivityRow;
const job = (id: string, min: number, status = 'done', extra: object = {}) => fake({ id, created_at: at(min), status, ...extra });

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
    assert.equal(m.mergeJob(list, fake({})), list);
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
    assert.equal(m.applyProgress(list, { id: 'nope', percent: 1 } as ActivityProgressPayload), list);
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
    assert.equal(m.rowTitle(fake({ title: 'Band - Song', song: { title: 'Other' } })), 'Band - Song');
    assert.equal(m.rowTitle(fake({ title: null, song: { title: 'Song', artist: 'Band' } })), 'Band - Song');
    assert.equal(m.rowTitle(fake({ replace: { title: 'Old', artist: null } })), 'Old');
    assert.equal(m.rowTitle(fake({ kind: 'playlist' })), null);
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
    const keys = new Set<string | undefined>(['generic', 'server', ...['VIDEO_UNAVAILABLE', 'VIDEO_PRIVATE', 'VIDEO_RESTRICTED', 'AGE_RESTRICTED', 'REGION_BLOCKED', 'DRM_PROTECTED', 'BOT_CHECK',
      'FORBIDDEN', 'NO_M4A_FORMAT', 'JS_CHALLENGE', 'YTDLP_FAILED', 'MISSING_DEPENDENCY', 'NETWORK', 'UNREACHABLE', 'NOT_FOUND', 'NO_MATCH', 'NOT_M4A', 'BAD_MEDIA', 'CONVERT_FAILED',
      'MISSING_TAGS', 'already_in_library', 'duplicate_hash', 'duplicate_metadata', 'SONG_DELETED', 'WORKER_LOST', 'NOTHING_DOWNLOADED'].map(m.failureKey)]);
    assert.ok(!keys.has(undefined));
    for (const lang of ['en', 'tr']) {
      const fail = (JSON.parse(fs.readFileSync(path.join(FRONTEND, 'locales', `${lang}.json`), 'utf8')) as { activity: { fail: Record<string, string> } }).activity.fail;
      assert.deepEqual(Object.keys(fail).sort(), [...keys].sort(), lang);
    }
  });
  it('a running row adds the stage and the percent', () => {
    assert.deepEqual(m.progressOf({ status: 'assigned', stage: 'uploading', percent: 42 }), { key: 'uploading', percent: 42 });
    assert.deepEqual(m.progressOf({ status: 'assigned', stage: 'uploading', percent: null }), { key: 'uploading', percent: null });
    assert.deepEqual(m.progressOf(fake({ status: 'assigned', stage: 'resolving' })), { key: 'searching', percent: null });
    assert.equal(m.progressOf(fake({ status: 'assigned', stage: 'downloading' })), null);
    assert.equal(m.progressOf({ status: 'done', stage: 'uploading', percent: 99 }), null);
  });
  it('the in-progress count never writes to the profile\'s count badges', () => {
    // profile-activity.ts owns [data-activity-count="<tab>"]; activity.ts once
    // wrote (and hid) every [data-activity-count], profile tabs included.
    const read = (f: string) => fs.readFileSync(path.join(FRONTEND, f), 'utf8');
    const html = read('index.html');
    const bare = html.match(/data-activity-count(?!=)/g) || [];
    assert.equal(bare.length, 0, 'every data-activity-count names its profile tab');
    assert.match(html, /data-activity-active-count/);
    assert.doesNotMatch(read('src/features/social/activity.ts'), /querySelectorAll\(['"]\[data-activity-count\]/);
  });
});
