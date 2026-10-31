// The sidebar's search and grouping (frontend/playlist-filter.js, pure ES module).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let foldText, matchesQuery, groupPlaylists;
before(async () => {
  ({ foldText, matchesQuery, groupPlaylists } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'playlist-filter.js')).href));
});

describe('sidebar search', () => {
  it('treats i, ı, I and İ as one letter', () => {
    for (const [name, q] of [['İSTANBUL', 'istanbul'], ['istanbul', 'İST'], ['ISPARTA', 'ısp'], ['Kırık', 'KIRIK'], ['Kırık', 'kirik'], ['DİYARBAKIR', 'diyarbakır']]) {
      assert.ok(matchesQuery({ name }, q), `${name} ~ ${q}`);
    }
  });
  it('ignores Turkish accents both ways', () => {
    assert.ok(matchesQuery({ name: 'Şarkılar' }, 'sarki'));
    assert.ok(matchesQuery({ name: 'cogul gunes' }, 'çoğul güneş'));
    assert.equal(foldText('  ÇÖĞÜŞ  x '), 'cogus x');
  });
  it('needs every word, in the name or the owner', () => {
    assert.ok(matchesQuery({ name: 'Road trip', ownerName: 'Ayşe' }, 'trip ayse'));
    assert.ok(!matchesQuery({ name: 'Road trip', ownerName: 'Ayşe' }, 'trip bob'));
    assert.ok(matchesQuery({ name: null }, '   '));
  });
  it('groups pins first (last pinned first), then own and others newest first', () => {
    const list = [
      { id: 'a', name: 'a', isOwner: true, createdAt: 1 },
      { id: 'b', name: 'b', isOwner: true, createdAt: 2 },
      { id: 'c', name: 'c', isOwner: false, createdAt: 3 },
      { id: 'd', name: 'd', isOwner: true, createdAt: 4, pinnedByMe: true, pinnedAt: 10 },
      { id: 'e', name: 'e', isOwner: false, createdAt: 5, pinnedByMe: true, pinnedAt: 20 },
    ];
    const g = groupPlaylists(list);
    assert.deepEqual(g.pinned.map(p => p.id), ['e', 'd']);
    assert.deepEqual(g.mine.map(p => p.id), ['b', 'a']);
    assert.deepEqual(g.others.map(p => p.id), ['c']);
    assert.deepEqual(groupPlaylists(list, 'e').pinned.map(p => p.id), ['e']);
  });
});
