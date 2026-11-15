// The sidebar with folders (folder-tree.ts, pure): sections, what shows where,
// the tabs, search, sort, pins, the rail and the edge cases (hidden, deleted,
// empty, limits).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSidebarTree, folderIndex, folderNameError, moveTargets, parseCollapsed, showsFolders, sortFolders } from './folder-tree.ts';
import type { FolderLike, SidebarTree, TreeOptions } from './folder-tree.ts';

interface P { id: string; name: string; ownerName?: string; isOwner?: boolean; visibility?: 'public' | 'private'; pinnedByMe?: boolean; pinnedAt?: number | null; createdAt?: number }
const pl = (id: string, name: string, extra: Partial<P> = {}): P => ({ id, name, isOwner: true, visibility: 'public', createdAt: 0, ...extra });
const folder = (id: string, name: string, playlistIds: string[], createdAt = 0): FolderLike => ({ id, name, playlistIds, createdAt });

// What a tree shows, as plain ids: ['pinned: a b', 'folder F1 (open): c d', 'mine: e', ...]
function shape(tree: SidebarTree<P>): string[] {
  return tree.sections.flatMap((s) => (s.kind === 'folders'
    ? s.folders.map((n) => `folder ${n.folder.id} (${n.expanded ? 'open' : 'closed'}${n.nameMatch ? ', match' : ''}): ${n.rows.map((p) => p.id).join(' ')}`.trimEnd())
    : [`${s.key}: ${s.rows.map((p) => p.id).join(' ')}`]));
}
const build = (playlists: P[], folders: FolderLike[], opts: TreeOptions<P> = {}) => buildSidebarTree(playlists, folders, opts);

const lists = [
  pl('mine1', 'Morning', { createdAt: 5 }),
  pl('mine2', 'Gym', { createdAt: 4 }),
  pl('priv', 'Diary', { visibility: 'private', createdAt: 3 }),
  pl('other1', 'Road Trip', { isOwner: false, ownerName: 'Bob', createdAt: 2 }),
  pl('other2', 'Jazz', { isOwner: false, ownerName: 'Ayşe', createdAt: 1 }),
];

describe('folder tree: the default view', () => {
  it('without folders it is exactly the old sidebar', () => {
    assert.deepEqual(shape(build(lists, [])), ['mine: mine1 mine2 priv', 'others: other1 other2']);
    assert.deepEqual(shape(build(lists, [], { sort: 'name' })), ['rest: priv mine2 other2 mine1 other1']);
  });
  it('a filed playlist shows inside its folder and not again in its group; folders sit between Pinned and the groups', () => {
    const t = build(lists, [folder('F', 'Sport', ['mine2', 'other1'])]);
    assert.deepEqual(shape(t), ['folder F (open): mine2 other1', 'mine: mine1 priv', 'others: other2']);
    assert.equal(t.count, 5);
    assert.equal(t.folderCount, 1);
    assert.equal(t.flat, false);
    assert.equal(t.folderOf.get('mine2')?.id, 'F');
  });
  it('Pinned stays a shortcut: a pinned, filed playlist shows in Pinned and in its folder', () => {
    const pinned = lists.map((p) => (p.id === 'other1' ? { ...p, pinnedByMe: true, pinnedAt: 9 } : p));
    const t = build(pinned, [folder('F', 'Sport', ['mine2', 'other1'])]);
    assert.deepEqual(shape(t), ['pinned: other1', 'folder F (open): mine2 other1', 'mine: mine1 priv', 'others: other2']);
    assert.equal(t.count, 5, 'counted once');
  });
  it('the sort applies inside each folder and to the folders', () => {
    const folders = [folder('A', 'Zeta', ['other2', 'mine1'], 1), folder('B', 'alpha', ['mine2'], 2), folder('C', 'Çay', [], 3)];
    assert.deepEqual(shape(build(lists, folders)), [
      'folder C (open):', 'folder B (open): mine2', 'folder A (open): mine1 other2', 'mine: priv', 'others: other1',
    ]);
    assert.deepEqual(shape(build(lists, folders, { sort: 'name' })), [
      'folder B (open): mine2', 'folder C (open):', 'folder A (open): other2 mine1', 'rest: priv other1',
    ]);
  });
  it('collapsed folders keep their rows (for counts) but are closed', () => {
    const t = build(lists, [folder('F', 'Sport', ['mine2']), folder('G', 'Work', ['mine1'], 1)], { collapsed: new Set(['F']) });
    assert.deepEqual(shape(t), ['folder G (open): mine1', 'folder F (closed): mine2', 'mine: priv', 'others: other1 other2']);
    assert.equal(t.count, 5);
  });
  it('an empty folder shows, with nothing in it', () => {
    const t = build(lists, [folder('E', 'Later', [])]);
    assert.deepEqual(shape(t)[0], 'folder E (open):');
    assert.equal(t.empty, false);
    assert.equal(build([], [folder('E', 'Later', [])]).empty, false, 'a folder alone is something to show');
    assert.equal(build([], []).empty, true);
  });
});

describe('folder tree: what the user may not see, and what is gone', () => {
  it('a filed playlist missing from the list (deleted, or someone else\'s gone private) is simply not there', () => {
    const t = build(lists, [folder('F', 'Mixed', ['gone', 'mine2', 'bobsPrivate'])]);
    assert.deepEqual(shape(t), ['folder F (open): mine2', 'mine: mine1 priv', 'others: other1 other2']);
    assert.equal(t.folderOf.has('gone'), false);
    assert.equal(t.folderOf.has('bobsPrivate'), false);
  });
  it('a folder whose playlists all went away is an empty folder, not an error', () => {
    assert.deepEqual(shape(build(lists, [folder('F', 'Old', ['gone1', 'gone2'])]))[0], 'folder F (open):');
  });
  it('and it is back in its folder when the list has it again', () => {
    const f = [folder('F', 'Watch', ['back'])];
    assert.deepEqual(shape(build(lists, f))[0], 'folder F (open):');
    const again = [...lists, pl('back', 'Back again', { isOwner: false, createdAt: 9 })];
    assert.deepEqual(shape(build(again, f))[0], 'folder F (open): back');
    assert.ok(!shape(build(again, f)).some((s) => s.startsWith('others') && s.includes('back')));
  });
  it('a playlist listed in two folders (a stale copy) shows in the first only', () => {
    const t = build(lists, [folder('A', 'One', ['mine1'], 2), folder('B', 'Two', ['mine1'], 1)]);
    assert.deepEqual(shape(t).slice(0, 2), ['folder A (open): mine1', 'folder B (open):']);
    assert.deepEqual(folderIndex([folder('A', 'One', ['x']), folder('B', 'Two', ['x'])], new Set(['x'])).get('x')?.id, 'A');
  });
});

describe('folder tree: tabs', () => {
  const folders = [folder('F', 'Sport', ['mine2', 'other1']), folder('O', 'Theirs', ['other2'], 1), folder('E', 'Empty', [], 2)];
  it('Mine shows own playlists inside folders, hides a folder of only others\' playlists, keeps empty ones', () => {
    assert.deepEqual(shape(build(lists, folders, { filter: 'mine' })), ['folder E (open):', 'folder F (open): mine2', 'mine: mine1 priv']);
  });
  it('Public and Private are flat (a folder is neither), and say where filed playlists are', () => {
    const pub = build(lists, folders, { filter: 'public' });
    assert.deepEqual(shape(pub), ['mine: mine1 mine2', 'others: other1 other2']);
    assert.equal(pub.flat, true);
    assert.equal(pub.folderOf.get('other1')?.name, 'Sport');
    assert.deepEqual(shape(build(lists, folders, { filter: 'private' })), ['mine: priv']);
    assert.equal(showsFolders('all') && showsFolders('mine') && !showsFolders('public') && !showsFolders('private'), true);
  });
  it('the rail lists everything: folders as icons, their playlists not repeated, whatever the filter or search', () => {
    const t = build(lists, folders, { filter: 'private', query: 'zzz', rail: true, collapsed: new Set(['F']) });
    assert.deepEqual(shape(t), ['folder E (open):', 'folder O (open): other2', 'folder F (closed): mine2 other1', 'mine: mine1 priv']);
  });
});

describe('folder tree: search', () => {
  const folders = [folder('F', 'Sport', ['mine2', 'other1']), folder('W', 'Work stuff', ['mine1'], 1)];
  it('is flat: matching playlists in their groups, filed or not; matching folders above them', () => {
    // "o": the folders Sport and Work stuff, Morning (in Work), Road Trip (in Sport), Bob; not Gym, Diary, Jazz.
    const t = build(lists, folders, { query: 'o' });
    assert.equal(t.flat, true);
    assert.deepEqual(shape(t), ['folder W (open, match): mine1', 'folder F (open, match): mine2 other1']);
    const t2 = build(lists, folders, { query: 'morn' });
    assert.deepEqual(shape(t2), ['mine: mine1']);
  });
  it('a folder whose name matches shows expanded (even when collapsed) with its playlists, not repeated below', () => {
    const t = build(lists, folders, { query: 'sport', collapsed: new Set(['F']) });
    assert.deepEqual(shape(t), ['folder F (open, match): mine2 other1']);
    assert.equal(t.count, 2);
  });
  it('a matching folder closed during the search stays closed for it, without touching the saved state', () => {
    const t = build(lists, folders, { query: 'sport', collapsed: new Set(), closedInSearch: new Set(['F']) });
    assert.deepEqual(shape(t), ['folder F (closed, match): mine2 other1']);
    assert.deepEqual(shape(build(lists, folders, { closedInSearch: new Set(['F']) }))[0], 'folder W (open): mine1');
  });
  it('a matching playlist in another folder is listed flat with its folder known', () => {
    const t = build(lists, folders, { query: 'gym' });
    assert.deepEqual(shape(t), ['mine: mine2']);
    assert.equal(t.folderOf.get('mine2')?.name, 'Sport');
  });
  it('folder names fold Turkish letters like playlist names', () => {
    const t = build(lists, [folder('T', 'Şarkılar', ['mine1'])], { query: 'sarki' });
    assert.deepEqual(shape(t), ['folder T (open, match): mine1']);
  });
  it('the tab still applies inside a matching folder, and Pinned still shows', () => {
    const pinned = lists.map((p) => (p.id === 'other1' ? { ...p, pinnedByMe: true } : p));
    assert.deepEqual(shape(build(pinned, folders, { query: 'sport', filter: 'mine' })), ['folder F (open, match): mine2']);
    assert.deepEqual(shape(build(pinned, folders, { query: 'road' })), ['pinned: other1']);
  });
  it('no match at all is empty', () => {
    const t = build(lists, folders, { query: 'nothing like it' });
    assert.equal(t.empty, true);
    assert.equal(t.count, 0);
  });
});

describe('folder tree: helpers', () => {
  it('sorts folders by name (Turkish, numbers as numbers) or newest first', () => {
    const fs = [folder('a', 'İkinci', [], 1), folder('b', 'ilk 10', [], 3), folder('c', 'ilk 9', [], 2), folder('d', 'Çok', [], 4)];
    assert.deepEqual(sortFolders(fs, 'name').map((f) => f.id), ['d', 'a', 'c', 'b']);
    assert.deepEqual(sortFolders(fs, 'date').map((f) => f.id), ['d', 'b', 'c', 'a']);
  });
  it('move targets: every folder by name, the current one marked, filtered by a search', () => {
    const fs = [folder('a', 'Work', ['p']), folder('b', 'Chill', [])];
    assert.deepEqual(moveTargets(fs, 'p').map((x) => [x.folder.id, x.current]), [['b', false], ['a', true]]);
    assert.deepEqual(moveTargets(fs, 'p', 'wor').map((x) => x.folder.id), ['a']);
    assert.deepEqual(moveTargets([], 'p'), []);
  });
  it('reads the collapsed set defensively and drops folders that are gone', () => {
    assert.deepEqual([...parseCollapsed('["a","b",3,null]')], ['a', 'b']);
    assert.deepEqual([...parseCollapsed('["a","b"]', new Set(['b']))], ['b']);
    for (const bad of [null, '', 'nope', '{"a":1}', '42']) assert.equal(parseCollapsed(bad).size, 0);
    assert.equal(parseCollapsed(JSON.stringify(Array.from({ length: 900 }, (_, i) => `f${i}`))).size, 500);
  });
  it('checks a folder name as the server does', () => {
    assert.equal(folderNameError(' Mixes '), null);
    assert.equal(folderNameError('   '), 'required');
    assert.equal(folderNameError('x'.repeat(51)), 'tooLong');
    assert.equal(folderNameError('x'.repeat(50)), null);
    assert.equal(folderNameError('a\nb'), 'invalid');
  });
  it('handles a hundred folders and a thousand playlists quickly', () => {
    const many = Array.from({ length: 1000 }, (_, i) => pl(`p${i}`, `Playlist ${i}`, { createdAt: i, isOwner: i % 2 === 0 }));
    const fs = Array.from({ length: 100 }, (_, i) => folder(`f${i}`, `Folder ${i}`, many.slice(i * 5, i * 5 + 5).map((p) => p.id), i));
    const started = performance.now();
    const t = build(many, fs, { sort: 'name' });
    assert.ok(performance.now() - started < 200);
    assert.equal(t.folderCount, 100);
    assert.equal(t.count, 1000);
  });
});
