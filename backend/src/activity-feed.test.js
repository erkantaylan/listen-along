// activityFeed.js against a stand-in Socket.IO server: who gets which row, and
// how progress is held back. (The real server and sockets: worker-jobs.test.js.)
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityFeed } = require('./activityFeed');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ROOM = 'app';
const userRoom = (id) => `user:${id}`;

/** Sockets are { id, rooms: [..] }; emits land in `sent` as [socketId, event, payload]. */
function fakeIo(sockets) {
  const sent = [];
  const inRoom = (room) => sockets.filter((s) => s.id === room || s.rooms.includes(room));
  const target = (rooms, except = []) => ({
    except: (room) => target(rooms, [...except, room]),
    emit: (event, payload) => {
      const out = new Set(except.flatMap((r) => inRoom(r).map((s) => s.id)));
      for (const s of new Set(rooms.flatMap(inRoom))) if (!out.has(s.id)) sent.push([s.id, event, payload]);
    },
  });
  const rooms = { get: (room) => { const ids = inRoom(room).map((s) => s.id); return ids.length ? new Set(ids) : undefined; } };
  return { sent, to: (room) => target([room]), sockets: { adapter: { rooms } } };
}

const sockets = [
  { id: 's-owner', rooms: [ROOM, userRoom('owner')] },
  { id: 's-owner-pending-tab', rooms: [userRoom('owner')] }, // same account, not in the approved room
  { id: 's-other', rooms: [ROOM, userRoom('other')] },
  { id: 's-pending', rooms: [userRoom('pending')] },
];
const playlists = {
  pub: { id: 'pub', name: 'Open', visibility: 'public', ownerId: 'owner' },
  priv: { id: 'priv', name: 'Hidden', visibility: 'private', ownerId: 'owner' },
};
const row = (extra = {}) => ({
  id: 'j1', source: 'web', kind: 'search', input: 'x', title: 'Band - Song', requested_by: 'Owner', requested_by_user_id: 'owner',
  status: 'queued', created_at: new Date(0), ...extra,
});
function setup(progressMs = 40) {
  const io = fakeIo(sockets);
  const feed = createActivityFeed({ io, room: ROOM, userRoom, getPlaylist: async (id) => playlists[id], progressMs });
  return { io, feed };
}
const jobsFor = (io, socketId) => io.sent.filter((x) => x[0] === socketId && x[1] === 'activity:job').map((x) => x[2].job);

describe('activityFeed: who gets what', () => {
  it('no playlist: one row to every approved socket, none to the others', async () => {
    const { io, feed } = setup();
    feed.jobChanged(row());
    await tick();
    assert.deepEqual(io.sent.map((x) => x[0]).sort(), ['s-other', 's-owner']);
    assert.equal(jobsFor(io, 's-other')[0].requested_by, 'Owner');
  });
  it('public playlist: named to everyone approved', async () => {
    const { io, feed } = setup();
    feed.jobChanged(row({ playlist_id: 'pub', playlist_name: 'Open' }));
    await tick();
    assert.equal(jobsFor(io, 's-other')[0].playlist_name, 'Open');
    assert.equal(jobsFor(io, 's-owner')[0].playlist_id, 'pub');
    assert.equal(io.sent.length, 2);
  });
  it('private playlist: named to the owner\'s approved sockets only; the rest get the row without it', async () => {
    const { io, feed } = setup();
    feed.jobChanged(row({ playlist_id: 'priv', playlist_name: 'Hidden' }));
    await tick();
    assert.deepEqual(jobsFor(io, 's-owner').map((j) => j.playlist_name), ['Hidden']);
    assert.deepEqual(jobsFor(io, 's-other').map((j) => [j.playlist_id, j.playlist_name, j.title]), [[null, null, 'Band - Song']]);
    assert.equal(jobsFor(io, 's-owner-pending-tab').length, 0);
    assert.equal(jobsFor(io, 's-pending').length, 0);
    assert.doesNotMatch(JSON.stringify(io.sent.filter((x) => x[0] !== 's-owner')), /Hidden|priv/);
  });
  it('a deleted playlist is not named, whatever the job row still says', async () => {
    const { io, feed } = setup();
    feed.jobChanged(row({ playlist_id: 'gone', playlist_name: 'Was here' }));
    await tick();
    assert.deepEqual(jobsFor(io, 's-owner').map((j) => j.playlist_id), [null]);
    assert.doesNotMatch(JSON.stringify(io.sent), /Was here|gone/);
  });
  it('the playlist is looked up at every emit: once it is private it is no longer named', async () => {
    const { io, feed } = setup();
    const shifting = { id: 'shift', name: 'Shifting', visibility: 'public', ownerId: 'owner' };
    playlists.shift = shifting;
    feed.jobChanged(row({ playlist_id: 'shift' }));
    await tick();
    assert.equal(jobsFor(io, 's-other')[0].playlist_name, 'Shifting');
    shifting.visibility = 'private';
    feed.jobChanged(row({ playlist_id: 'shift', status: 'assigned', worker_id: 'w1', worker_name: 'pc' }));
    await tick();
    assert.equal(jobsFor(io, 's-other')[1].playlist_name, null);
    assert.equal(jobsFor(io, 's-owner')[1].playlist_name, 'Shifting');
    delete playlists.shift;
  });
});

describe('activityFeed: progress', () => {
  const running = (extra = {}) => row({ status: 'assigned', worker_id: 'w1', worker_name: 'pc', playlist_id: 'priv', ...extra });
  const progressFor = (io, socketId) => io.sent.filter((x) => x[0] === socketId && x[1] === 'activity:progress').map((x) => x[2]);

  it('is a small event (stage and percent, no playlist, none of the worker\'s text), at most one per window, and the latest wins', async () => {
    const { io, feed } = setup(40);
    feed.jobChanged(running());
    feed.jobChanged(running({ stage: 'downloading', progress: 'Downloading /home/bob/dl/x.opus' }));
    for (const pct of [10, 20, 30]) feed.jobChanged(running({ stage: 'uploading', progress: `Uploading /home/John Smith/dl/feed.opus… ${pct}%` }));
    await tick();
    assert.deepEqual(progressFor(io, 's-other'), [{ id: 'j1', stage: 'downloading', percent: null }]);
    await tick(80);
    assert.deepEqual(progressFor(io, 's-other').slice(1), [{ id: 'j1', stage: 'uploading', percent: 30 }]);
    assert.deepEqual(progressFor(io, 's-owner'), progressFor(io, 's-other'));
    assert.equal(progressFor(io, 's-pending').length, 0);
    assert.equal(jobsFor(io, 's-other').length, 1, 'no full row per tick');
    assert.doesNotMatch(JSON.stringify(io.sent), /bob|Smith|home|opus/);
  });
  it('a worker\'s free text never leaves, in a progress event or a row', async () => {
    const texts = ['No file at /home/John Smith/dl/feed.opus', 'C:\\Users\\John Smith\\Music\\a.opus missing', 'open file:///home/bob/dl/x.opus failed',
      'ENOENT {/home/bob/x/y}', '>/home/bob/x/y', 'x;/home/bob/a/b', 'path=<C:\\Users\\bob\\a.opus>', '~bob/dl/x', '$HOME/dl/x', '../bob/secret/x.opus', 'https://user:pw@host/x/y'];
    const { io, feed } = setup(0);
    feed.jobChanged(running());
    for (const text of texts) feed.jobChanged(running({ stage: 'working', progress: text }));
    for (const text of texts) feed.jobChanged(running({ stage: text, progress: text }));
    feed.jobChanged(running({ status: 'queued', worker_id: null, worker_name: null, progress: `Given back: ${texts[0]}` }));
    for (const text of texts) feed.jobChanged(running({ id: `f${texts.indexOf(text)}`, status: 'failed', error_code: 'YTDLP_FAILED', error_message: text, progress: text }));
    await tick(20);
    assert.ok(io.sent.length > texts.length);
    assert.doesNotMatch(JSON.stringify(io.sent), /John|Smith|bob|home|Users|HOME|secret|user:pw|opus|Given back/);
  });
  it('a replace job\'s details changed while it runs: a full row, not a progress tick', async () => {
    const { io, feed } = setup(1000);
    const replacing = (extra = {}) => running({ source: 'replace', playlist_id: null, replace_song_id: 's1', replace_title: 'Old title', replace_artist: 'Band', ...extra });
    feed.jobChanged(replacing());
    feed.jobChanged(replacing({ stage: 'uploading', progress: 'Uploading 10%' }));
    feed.jobChanged(replacing({ stage: 'uploading', progress: 'Uploading 10%', replace_title: 'New title' }));
    await tick();
    assert.deepEqual(jobsFor(io, 's-other').map((j) => j.replace.title), ['Old title', 'New title']);
    assert.equal(jobsFor(io, 's-other')[1].percent, 10);
    // And progress goes on as progress after it.
    feed.jobChanged(replacing({ stage: 'uploading', progress: 'Uploading 20%', replace_title: 'New title' }));
    await tick();
    assert.equal(jobsFor(io, 's-other').length, 2);
    assert.deepEqual(progressFor(io, 's-other').pop(), { id: 'j1', stage: 'uploading', percent: 20 });
  });
  it('a state change is sent at once and drops a held progress line', async () => {
    const { io, feed } = setup(40);
    feed.jobChanged(running());
    feed.jobChanged(running({ progress: 'Uploading 1%' }));
    feed.jobChanged(running({ progress: 'Uploading 99%' }));
    feed.jobChanged(running({ status: 'done', progress: null }));
    await tick(80);
    assert.deepEqual(io.sent.filter((x) => x[0] === 's-other').map((x) => x[1]), ['activity:job', 'activity:progress', 'activity:job']);
    assert.equal(jobsFor(io, 's-other')[1].status, 'done');
  });
  it('a job that moved to another worker is a new row state, not progress', async () => {
    const { io, feed } = setup(40);
    feed.jobChanged(running());
    feed.jobChanged(running({ worker_id: 'w2', worker_name: 'laptop' }));
    await tick();
    assert.deepEqual(jobsFor(io, 's-other').map((j) => j.worker.name), ['pc', 'laptop']);
  });
});
