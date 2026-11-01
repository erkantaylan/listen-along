// The sidebar's search and grouping (frontend/playlist-filter.js, pure ES module).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let foldText, matchesQuery, groupPlaylists, matchesFilter, arrangePlaylists;
before(async () => {
  ({ foldText, matchesQuery, groupPlaylists, matchesFilter, arrangePlaylists } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'playlist-filter.js')).href));
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

describe('sidebar filter and sort', () => {
  const list = [
    { id: 'zeb', name: 'Zebra', isOwner: true, visibility: 'public', createdAt: 5 },
    { id: 'sec', name: 'Secret', isOwner: true, visibility: 'private', createdAt: 6 },
    { id: 'oth', name: 'Others', isOwner: false, visibility: 'public', createdAt: 9 },
    { id: 'leg', name: 'Legacy', ownerId: null, isOwner: false, visibility: 'public', createdAt: 1 },
    { id: 'pin', name: 'Bolero', isOwner: false, visibility: 'public', createdAt: 2, pinnedByMe: true, pinnedAt: 99 },
    { id: 'pim', name: 'Anthem', isOwner: true, visibility: 'private', createdAt: 3, pinnedByMe: true, pinnedAt: 50 },
  ];
  const ids = (r) => r.groups.flatMap(g => g.rows.map(p => p.id));
  const keys = (r) => r.groups.map(g => g.key);

  it('filters on the server fields only', () => {
    assert.ok(!matchesFilter({ ownerId: 'me', ownerName: 'me' }, 'mine'), 'no isOwner means not mine');
    assert.ok(matchesFilter({ isOwner: true }, 'mine'));
    assert.ok(matchesFilter({ visibility: 'private' }, 'private'));
    assert.ok(!matchesFilter({ visibility: 'private' }, 'public'));
    assert.ok(matchesFilter({ visibility: 'private' }, 'all'));
  });
  it('by date keeps the groups, newest first in each, pins on top', () => {
    const r = arrangePlaylists(list);
    assert.deepEqual(keys(r), ['pinned', 'mine', 'others']);
    assert.deepEqual(ids(r), ['pim', 'pin', 'sec', 'zeb', 'oth', 'leg']);
    assert.equal(r.count, 6);
  });
  it('by name is one A-Z list below the pins, which are A-Z too', () => {
    const r = arrangePlaylists(list, { sort: 'name' });
    assert.deepEqual(keys(r), ['pinned', 'rest']);
    assert.deepEqual(ids(r), ['pim', 'pin', 'leg', 'oth', 'sec', 'zeb']);
  });
  it('Mine hides everyone else, pinned ones too', () => {
    const r = arrangePlaylists(list, { filter: 'mine' });
    assert.deepEqual(keys(r), ['pinned', 'mine']);
    assert.deepEqual(ids(r), ['pim', 'sec', 'zeb']);
  });
  it('Public and Private split the list', () => {
    assert.deepEqual(ids(arrangePlaylists(list, { filter: 'private' })), ['pim', 'sec']);
    assert.deepEqual(ids(arrangePlaylists(list, { filter: 'public' })), ['pin', 'zeb', 'oth', 'leg']);
  });
  it('search combines with filter and sort', () => {
    const r = arrangePlaylists(list, { query: 'e', filter: 'mine', sort: 'name' });
    assert.deepEqual(ids(r), ['pim', 'sec', 'zeb']);
    const none = arrangePlaylists(list, { query: 'others', filter: 'mine' });
    assert.equal(none.count, 0);
    assert.deepEqual(none.groups, []);
  });
  it('sorts names in Turkish alphabet order', () => {
    const names = ['Zil', 'İpek', 'Ilık', 'ılık', 'Şafak', 'Sabah', 'Tan', 'Çay', 'Cam', 'Dağ', 'Öykü', 'Oda', 'Pul', 'Üzüm', 'Uçak', 'Vadi', 'Ğ', 'Gül', 'iğne'];
    const sorted = ids(arrangePlaylists(names.map(n => ({ id: n, name: n })), { sort: 'name' }));
    const expected = ['Cam', 'Çay', 'Dağ', 'Gül', 'Ğ', 'ılık', 'Ilık', 'iğne', 'İpek', 'Oda', 'Öykü', 'Pul', 'Sabah', 'Şafak', 'Tan', 'Uçak', 'Üzüm', 'Vadi', 'Zil'];
    assert.deepEqual(sorted, expected);
  });
  it('keeps "Family: Name" families together, numbers in order', () => {
    const names = ['Rock: Zeppelin', 'Rocky', 'Pop: 10', 'Rock: Abba', 'Rock Klasik', 'Pop: 2', 'Radyo'];
    const sorted = ids(arrangePlaylists(names.map(n => ({ id: n, name: n })), { sort: 'name' }));
    assert.deepEqual(sorted.filter(n => n.startsWith('Pop')), ['Pop: 2', 'Pop: 10']);
    const a = sorted.indexOf('Rock: Abba');
    assert.equal(sorted[a + 1], 'Rock: Zeppelin');
  });
  it('is stable for equal keys and survives missing fields', () => {
    const same = [{ id: 'b', name: 'X', createdAt: 1 }, { id: 'a', name: 'X', createdAt: 1 }, { id: 'c', name: null }];
    assert.deepEqual(ids(arrangePlaylists(same, { sort: 'name', titleOf: (p) => p.name || 'Playlist' })), ['c', 'a', 'b']);
    assert.deepEqual(ids(arrangePlaylists(same)), ['a', 'b', 'c']);
  });
});
