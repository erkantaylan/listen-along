// Listen along (follow a user): the pure follow graph, then the real server
// (in-memory, no Postgres) over Socket.IO with four signed-in users.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createListenGraph, createSourceResolver } = require('./listenAlong');
const { startServer, cookieFor } = require('./testServer');

describe('listen-along graph', () => {
  it('collapses chains: everyone hears the root', () => {
    const g = createListenGraph();
    assert.deepEqual(g.follow('A', 'B', 'sa'), { ok: true, root: 'B' });
    assert.deepEqual(g.follow('B', 'C', 'sb'), { ok: true, root: 'C' });
    assert.equal(g.root('A'), 'C', 'A is switched to C when B follows C');
    assert.deepEqual(g.followersOf('C').sort(), ['A', 'B']);
    assert.deepEqual(g.followersOf('B'), [], 'a follower has no followers of its own');
    // Attaching to someone who listens along attaches to their root.
    assert.deepEqual(g.follow('D', 'A', 'sd'), { ok: true, root: 'C' });
  });

  it('refuses yourself and loops', () => {
    const g = createListenGraph();
    assert.equal(g.follow('A', 'A', 's').error, 'self');
    g.follow('A', 'B', 'sa');
    g.follow('B', 'C', 'sb');
    assert.equal(g.follow('C', 'A', 'sc').error, 'cycle');
    assert.equal(g.isFollowing('C'), false);
  });

  it('a middle person who stops becomes a root for those who picked them', () => {
    const g = createListenGraph();
    g.follow('A', 'B', 'sa');
    g.follow('B', 'C', 'sb');
    g.follow('E', 'C', 'se');
    g.unfollow('B');
    assert.equal(g.root('A'), 'B', 'A picked B: now hears B');
    assert.equal(g.root('E'), 'C', 'E picked C: unaffected');
    assert.deepEqual(g.followersOf('C'), ['E']);
  });

  it('a middle person whose tab goes away is spliced out (the music continues)', () => {
    const g = createListenGraph();
    g.follow('A', 'B', 'sa');
    g.follow('B', 'C', 'sb');
    assert.deepEqual(g.usersOnSocket('sb'), ['B']);
    g.splice('B');
    assert.equal(g.chosen('A'), 'C');
    assert.equal(g.root('A'), 'C');
    assert.equal(g.isFollowing('B'), false);
  });

  it('dissolves the whole tree of a root that goes offline', () => {
    const g = createListenGraph();
    g.follow('A', 'B', 'sa');
    g.follow('B', 'C', 'sb');
    g.follow('X', 'Y', 'sx');
    assert.deepEqual(g.endTree('C').sort(), ['A', 'B']);
    assert.equal(g.isFollowing('A'), false);
    assert.equal(g.root('X'), 'Y');
  });

  it('resolves library urls without a database and others through the lookup', async () => {
    const id = '0b6f3a3e-1c1d-4a4e-9b7e-0123456789ab';
    let calls = 0;
    const resolve = createSourceResolver(async (url) => { calls++; return url.includes('watch') ? id : null; });
    assert.equal(await resolve(`library:${id}`), id);
    assert.equal(await resolve('library:../../etc'), null);
    assert.equal(await resolve('https://www.youtube.com/watch?v=abc'), id);
    assert.equal(await resolve('https://www.youtube.com/watch?v=abc'), id);
    assert.equal(calls, 1, 'cached');
    assert.equal(await resolve(null), null);
  });
});

const U = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  D: '00000000-0000-4000-8000-00000000000d',
};
const SONG1 = '11111111-1111-4111-8111-111111111111';
const SONG2 = '22222222-2222-4222-8222-222222222222';

describe('listen along against a running server', { timeout: 60_000 }, () => {
  let srv;
  const sockets = [];
  const s = {};

  before(async () => { srv = await startServer(); });
  after(async () => {
    for (const x of sockets) x.disconnect();
    if (srv) await srv.stop();
  });

  function connect(userId, name) {
    const sock = ioClient(srv.base, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: cookieFor(userId) } });
    sockets.push(sock);
    return new Promise((resolve, reject) => {
      sock.on('connect', () => { sock.emit('social:hello', { name }); resolve(sock); });
      sock.on('connect_error', reject);
    });
  }
  const ask = (sock, event, arg) => new Promise((resolve) => sock.emit(event, arg, resolve));
  function next(sock, event, pred = () => true, ms = 1500) {
    return new Promise((resolve) => {
      const h = (data) => { if (pred(data)) { clearTimeout(timer); sock.off(event, h); resolve(data); } };
      const timer = setTimeout(() => { sock.off(event, h); resolve('timeout'); }, ms);
      sock.on(event, h);
    });
  }
  // Collect every payload of `event` for `ms`.
  function collect(sock, event, ms = 400) {
    return new Promise((resolve) => {
      const got = [];
      const h = (d) => got.push(d);
      sock.on(event, h);
      setTimeout(() => { sock.off(event, h); resolve(got); }, ms);
    });
  }
  const play = (sock, { song = SONG1, title = 'Song One', playing = true, position = 0, context = { type: 'library' } } = {}) =>
    sock.emit('presence:now-playing', { track: { id: 'q1', title, artist: 'Artist', url: `library:${song}` }, context, playing, position, duration: 200 });

  let privId;

  it('setup: four users online; C plays from a private playlist', async () => {
    s.A = await connect(U.A, 'Ann');
    s.B = await connect(U.B, 'Ben');
    s.C = await connect(U.C, 'Cem');
    s.D = await connect(U.D, 'Dee');
    const r = await fetch(`${srv.base}/api/playlists`, {
      method: 'POST', headers: { cookie: cookieFor(U.C), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Cem Secret Mix', visibility: 'private' }),
    });
    privId = (await r.json()).id;
    assert.ok(privId);
    const seen = next(s.A, 'people:now-playing', d => d.userId === U.C);
    play(s.C, { position: 30, context: { type: 'lobby', lobbyId: privId } });
    assert.notEqual(await seen, 'timeout');
  });

  it('B listens along with C: gets the song and position anchor, never the private playlist', async () => {
    const atC = next(s.C, 'listen:followers', d => d.count === 1);
    const res = await ask(s.B, 'listen:follow', { userId: U.C });
    assert.equal(res.ok, true);
    assert.deepEqual(res.leader, { id: U.C, name: 'Cem' });
    assert.equal(res.sync.track.title, 'Song One');
    assert.equal(res.sync.track.src, `/api/library/${SONG1}/file`);
    assert.equal(res.sync.playing, true);
    assert.ok(res.sync.position >= 30 && res.sync.updatedAt > 0 && res.sync.serverNow >= res.sync.updatedAt);
    const json = JSON.stringify(res);
    assert.ok(!json.includes(privId), 'no private playlist id');
    assert.ok(!json.includes('Secret'), 'no private playlist name');
    assert.ok(!json.includes('"context"'));
    assert.deepEqual(await atC, { count: 1, names: ['Ben'] });
  });

  it('follows the leader live: seek, pause, track change', async () => {
    let sync = next(s.B, 'listen:sync');
    play(s.C, { position: 95, context: { type: 'lobby', lobbyId: privId } });
    let got = await sync;
    assert.equal(got.position, 95);
    assert.ok(!JSON.stringify(got).includes(privId));

    sync = next(s.B, 'listen:sync');
    play(s.C, { position: 96, playing: false });
    got = await sync;
    assert.equal(got.playing, false);

    sync = next(s.B, 'listen:sync');
    play(s.C, { song: SONG2, title: 'Song Two', position: 0 });
    got = await sync;
    assert.equal(got.track.title, 'Song Two');
    assert.equal(got.track.src, `/api/library/${SONG2}/file`);
    assert.equal(got.playing, true);
  });

  it('a song that is not a library file reaches the follower without a source', async () => {
    const sync = next(s.B, 'listen:sync');
    s.C.emit('presence:now-playing', { track: { title: 'Mystery', url: 'file:///etc/passwd' }, context: null, playing: true, position: 0 });
    const got = await sync;
    assert.equal(got.track.title, 'Mystery');
    assert.equal(got.track.src, null);
    play(s.C, { song: SONG2, title: 'Song Two', position: 5 });
  });

  it('refuses yourself, loops, and someone who plays nothing', async () => {
    assert.match((await ask(s.A, 'listen:follow', { userId: U.A })).error, /yourself/);
    assert.match((await ask(s.C, 'listen:follow', { userId: U.B })).error, /already listening along with you/);
    assert.match((await ask(s.A, 'listen:follow', { userId: U.D })).error, /not playing/);
    assert.match((await ask(s.A, 'listen:follow', { userId: 'nobody' })).error, /not online/);
  });

  it('cannot make someone else listen along (identity comes from the socket)', async () => {
    const atD = collect(s.D, 'listen:sync', 500);
    const atC = next(s.C, 'listen:followers', d => d.count === 2);
    const res = await ask(s.A, 'listen:follow', { userId: U.C, follower: U.D, followerId: U.D });
    assert.equal(res.ok, true);
    assert.deepEqual(await atD, [], 'D received nothing');
    // C's list is Ben + Ann (whoever made the request), never Dee.
    assert.deepEqual((await atC).names.sort(), ['Ann', 'Ben']);
    // D cannot stop A either.
    await ask(s.D, 'listen:stop');
    const sync = next(s.A, 'listen:sync');
    play(s.C, { song: SONG2, title: 'Song Two', position: 10 });
    assert.notEqual(await sync, 'timeout', 'A still listens along');
    await ask(s.A, 'listen:stop');
  });

  it('chains collapse: A follows B, then B follows C -> both hear C; counts broadcast', async () => {
    // B stops listening along and plays their own song.
    await ask(s.B, 'listen:stop');
    play(s.B, { song: SONG1, title: 'Ben Song', position: 3 });
    await next(s.A, 'people:now-playing', d => d.userId === U.B);

    const atB = next(s.B, 'listen:followers', d => d.count === 1);
    let res = await ask(s.A, 'listen:follow', { userId: U.B });
    assert.equal(res.leader.id, U.B);
    assert.deepEqual(await atB, { count: 1, names: ['Ann'] });

    const moved = next(s.A, 'listen:following');
    const syncA = next(s.A, 'listen:sync', d => d.leaderId === U.C);
    const atC = next(s.C, 'listen:followers', d => d.count === 2);
    const bZero = next(s.B, 'listen:followers', d => d.count === 0);
    res = await ask(s.B, 'listen:follow', { userId: U.C });
    assert.equal(res.leader.id, U.C);
    const m = await moved;
    assert.deepEqual(m.leader, { id: U.C, name: 'Cem' });
    assert.equal(m.chosen, U.B, 'A still picked B');
    assert.equal((await syncA).track.title, 'Song Two');
    const c = await atC;
    assert.deepEqual(c.names.sort(), ['Ann', 'Ben']);
    assert.notEqual(await bZero, 'timeout');

    // Someone new attaching to a follower attaches to the root.
    play(s.D, { title: 'Dee Song' });
    await next(s.A, 'people:now-playing', d => d.userId === U.D);
  });

  it('a middle person who stops listening along takes back those who picked them', async () => {
    const moved = next(s.A, 'listen:following', d => d.leader && d.leader.id === U.B);
    const atC = next(s.C, 'listen:followers', d => d.count === 0);
    const atB = next(s.B, 'listen:followers', d => d.count === 1);
    await ask(s.B, 'listen:stop');
    assert.notEqual(await moved, 'timeout', 'A now hears B');
    assert.notEqual(await atC, 'timeout');
    assert.deepEqual(await atB, { count: 1, names: ['Ann'] });
    // Back to: A and B both listening along with C, for the offline test.
    await ask(s.B, 'listen:follow', { userId: U.C });
    await next(s.C, 'listen:followers', d => d.count === 2);
  });

  it('the leader stopping playback (still online) pauses followers; they stay attached', async () => {
    const sync = next(s.A, 'listen:sync');
    s.C.emit('presence:now-playing', { track: null });
    const got = await sync;
    assert.equal(got.track, null);
    assert.equal(got.playing, false);
    const again = next(s.A, 'listen:sync', d => d.track);
    play(s.C, { song: SONG2, title: 'Song Two', position: 40 });
    assert.equal((await again).position, 40);
  });

  it('a follower tab closing updates the count', async () => {
    const extra = await connect(U.D, 'Dee');
    await ask(extra, 'listen:follow', { userId: U.C });
    await next(s.C, 'listen:followers', d => d.count === 3);
    const down = next(s.C, 'listen:followers', d => d.count === 2);
    extra.disconnect();
    assert.deepEqual((await down).names.sort(), ['Ann', 'Ben']);
  });

  it('the leader going offline: followers get listen:end (finish the song, then stop) — no pause first', async () => {
    const syncsA = collect(s.A, 'listen:sync', 800);
    const endA = next(s.A, 'listen:end');
    const endB = next(s.B, 'listen:end');
    s.C.disconnect();
    const a = await endA;
    assert.deepEqual(a, { reason: 'offline', leader: { id: U.C, name: 'Cem' } });
    assert.equal((await endB).reason, 'offline');
    assert.deepEqual((await syncsA).filter(x => x.track === null), [], 'no pause sync before the song ends');
    // Listening along is over: a stop is a no-op and nobody is followed.
    assert.match((await ask(s.A, 'listen:follow', { userId: U.C })).error, /not online/);
  });
});
