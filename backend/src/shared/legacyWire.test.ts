// The wire-rename compatibility shim's own rules (legacyWire.ts). REMOVE with it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_CLIENT_EVENTS, LEGACY_SERVER_EVENTS, playlistIdOf, onPlaylistEvent, withLegacyId, emitPlaylistEvent, presenceContextOf,
} from './legacyWire.ts';

describe('the lobby -> playlist wire shim', () => {
  it('maps every new event to the old one of the same verb', () => {
    for (const map of [LEGACY_CLIENT_EVENTS, LEGACY_SERVER_EVENTS]) {
      for (const [now, before] of Object.entries(map)) assert.equal(before, now.replace(/^playlist:/, 'lobby:'));
    }
  });

  it('reads the id under the new name first, else the old one, as sent', () => {
    assert.equal(playlistIdOf({ playlistId: 'a', lobbyId: 'b' }), 'a');
    assert.equal(playlistIdOf({ lobbyId: 'b' }), 'b');
    assert.equal(playlistIdOf({ lobbyId: 42 }), 42, 'untrusted: passed on as the client sent it');
    assert.equal(playlistIdOf({}), undefined);
    assert.equal(playlistIdOf(null), undefined);
  });

  it('registers a handler under both names', () => {
    const got: string[] = [];
    onPlaylistEvent({ on: (event: string) => { got.push(event); } }, 'playlist:join', () => {});
    assert.deepEqual(got, ['playlist:join', 'lobby:join']);
  });

  it('emits under both names, each payload with both id fields', () => {
    const sent: Array<[string, unknown]> = [];
    emitPlaylistEvent({ emit: (e: string, p?: unknown) => sent.push([e, p]) }, 'playlist:renamed', { playlistId: 'x', name: 'N' });
    assert.deepEqual(sent, [
      ['playlist:renamed', { playlistId: 'x', name: 'N', lobbyId: 'x' }],
      ['lobby:renamed', { playlistId: 'x', name: 'N', lobbyId: 'x' }],
    ]);
    assert.deepEqual(withLegacyId({ playlistId: 'y', songs: [] }), { playlistId: 'y', songs: [], lobbyId: 'y' });
    assert.deepEqual(withLegacyId({ message: 'm' } as { playlistId?: unknown; message: string }), { message: 'm' }, 'nothing to copy');
  });

  it('reads an old presence context as the new one; others pass through', () => {
    assert.deepEqual(presenceContextOf({ type: 'lobby', lobbyId: 'p1' }), { type: 'playlist', playlistId: 'p1' });
    const radio = { type: 'radio' };
    assert.equal(presenceContextOf(radio), radio);
    assert.equal(presenceContextOf(null), null);
  });
});
