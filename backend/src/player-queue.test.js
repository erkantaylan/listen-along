// Tests the player's pure queue/membership rules (frontend/player-queue.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'player-queue.js')).href);
});

describe('player-queue: findTrackIndex', () => {
  const queue = [{ id: 'a', url: 'u1' }, { id: 'b', url: 'u2' }];
  it('finds by id, then by url', () => {
    assert.equal(m.findTrackIndex(queue, { id: 'b' }), 1);
    assert.equal(m.findTrackIndex(queue, { id: 'zz', url: 'u1' }), 0);
    assert.equal(m.findTrackIndex(queue, { id: 'zz', url: 'nope' }), -1);
    assert.equal(m.findTrackIndex(queue, null), -1);
    assert.equal(m.findTrackIndex(null, { id: 'a' }), -1);
  });
});

describe('player-queue: nextIndex', () => {
  it('moves on and stops at the end', () => {
    assert.equal(m.nextIndex({ length: 3, current: 0 }), 1);
    assert.equal(m.nextIndex({ length: 3, current: 2 }), -1);
    assert.equal(m.nextIndex({ length: 3, current: -1 }), 0);
    assert.equal(m.nextIndex({ length: 0, current: -1 }), -1);
  });
  it('wraps with repeat all', () => {
    assert.equal(m.nextIndex({ length: 3, current: 2, repeat: 'all' }), 0);
  });
  it('repeat one replays only when the track ended by itself', () => {
    assert.equal(m.nextIndex({ length: 3, current: 1, repeat: 'one', auto: true }), 1);
    assert.equal(m.nextIndex({ length: 3, current: 1, repeat: 'one' }), 2);
  });
  it('shuffle never picks the current track', () => {
    const seq = [0.1, 0.1, 0.9]; // -> 0 (current), 0 again, then 2
    let k = 0;
    assert.equal(m.nextIndex({ length: 3, current: 0, shuffle: true, random: () => seq[k++] }), 2);
    assert.equal(m.nextIndex({ length: 1, current: 0, shuffle: true }), -1);
  });
});

describe('player-queue: previousIndex', () => {
  it('steps back, restarts at the start, wraps with repeat all', () => {
    assert.equal(m.previousIndex({ length: 3, current: 2 }), 1);
    assert.equal(m.previousIndex({ length: 3, current: 0 }), -1);
    assert.equal(m.previousIndex({ length: 3, current: 0, repeat: 'all' }), 2);
    assert.equal(m.previousIndex({ length: 3, current: -1 }), 0);
    assert.equal(m.previousIndex({ length: 0, current: -1 }), -1);
  });
});

describe('player-queue: lobby membership', () => {
  it('members the playback context and only views other lobbies', () => {
    assert.deepEqual(m.desiredMembership({}), { member: null, viewing: null });
    assert.deepEqual(m.desiredMembership({ viewedLobbyId: 'b' }), { member: 'b', viewing: null });
    assert.deepEqual(m.desiredMembership({ contextLobbyId: 'a' }), { member: 'a', viewing: null });
    assert.deepEqual(m.desiredMembership({ viewedLobbyId: 'a', contextLobbyId: 'a' }), { member: 'a', viewing: null });
    assert.deepEqual(m.desiredMembership({ viewedLobbyId: 'b', contextLobbyId: 'a' }), { member: 'a', viewing: 'b' });
  });

  it('plans the socket events between two states', () => {
    const none = { member: null, viewing: null };
    assert.deepEqual(m.membershipActions(none, none), []);
    assert.deepEqual(m.membershipActions(none, { member: 'b', viewing: null }), [{ type: 'join', lobbyId: 'b' }]);
    // Leaving a lobby page with nothing played from it
    assert.deepEqual(m.membershipActions({ member: 'b', viewing: null }, none), [{ type: 'leave', lobbyId: 'b' }]);
    // Playing from A, opening B
    assert.deepEqual(m.membershipActions({ member: 'a', viewing: null }, { member: 'a', viewing: 'b' }), [{ type: 'view', lobbyId: 'b' }]);
    // ... then C (the server drops the view of B itself)
    assert.deepEqual(m.membershipActions({ member: 'a', viewing: 'b' }, { member: 'a', viewing: 'c' }), [{ type: 'view', lobbyId: 'c' }]);
    // ... then back to landing
    assert.deepEqual(m.membershipActions({ member: 'a', viewing: 'c' }, { member: 'a', viewing: null }), [{ type: 'unview', lobbyId: 'c' }]);
    // Pressing play in viewed B: join B, no unview (the join turns the view into membership)
    assert.deepEqual(m.membershipActions({ member: 'a', viewing: 'b' }, { member: 'b', viewing: null }), [{ type: 'join', lobbyId: 'b' }]);
    // Created B as a member while playing A
    assert.deepEqual(m.membershipActions({ member: 'b', viewing: null }, { member: 'a', viewing: 'b' }),
      [{ type: 'join', lobbyId: 'a' }, { type: 'view', lobbyId: 'b' }]);
  });
});
