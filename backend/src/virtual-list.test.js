// The arithmetic of the windowed list (frontend/virtual-list.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'virtual-list.js')).href);
});

describe('windowRange', () => {
  const base = { rowHeight: 56, viewHeight: 560, count: 2500, overscan: 5 };
  it('is empty without rows', () => {
    assert.deepEqual(m.windowRange({ ...base, count: 0, viewTop: 0 }), { start: 0, end: 0 });
  });
  it('renders the top while the list has not reached the viewport', () => {
    assert.deepEqual(m.windowRange({ ...base, viewTop: -200 }), { start: 0, end: 12 });
  });
  it('covers the viewport plus overscan, in the middle', () => {
    assert.deepEqual(m.windowRange({ ...base, viewTop: 5600 }), { start: 95, end: 115 });
  });
  it('stops at the last row', () => {
    assert.deepEqual(m.windowRange({ ...base, viewTop: 56 * 2495 }), { start: 2490, end: 2500 });
  });
  it('stays small at any depth', () => {
    for (const viewTop of [0, 56 * 1000, 56 * 2490]) {
      const { start, end } = m.windowRange({ ...base, viewTop });
      assert.ok(end - start <= 20);
    }
  });
});

describe('scrollTopFor', () => {
  const base = { rowHeight: 56, viewHeight: 500, stickyTop: 32, scrollTop: 1000 };
  it('leaves a visible row alone', () => {
    assert.equal(m.scrollTopFor({ ...base, rowTop: 1100 }), 1000);
  });
  it('clears the sticky header above', () => {
    assert.equal(m.scrollTopFor({ ...base, rowTop: 1010 }), 978);
  });
  it('brings a lower row up to the bottom edge', () => {
    assert.equal(m.scrollTopFor({ ...base, rowTop: 2000 }), 1556);
  });
  it('centres on request, never above zero', () => {
    assert.equal(m.scrollTopFor({ ...base, rowTop: 2000, align: 'center' }), 2000 - 32 - (500 - 32 - 56) / 2);
    assert.equal(m.scrollTopFor({ ...base, rowTop: 0, align: 'center' }), 0);
  });
});
