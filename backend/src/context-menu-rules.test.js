// The context menu's submenu placement (frontend/context-menu-rules.js).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'context-menu-rules.js')).href);
});

const viewport = { width: 1440, height: 900 };
const size = { width: 200, height: 100 };

describe('context-menu-rules: submenuPosition', () => {
  it('opens to the right of the menu, level with its item', () => {
    assert.deepEqual(m.submenuPosition({ parent: { left: 100, right: 340 }, size, itemTop: 300, viewport }), { left: 338, top: 292, side: 'right' });
  });
  it('flips to the left near the right edge', () => {
    assert.deepEqual(m.submenuPosition({ parent: { left: 1150, right: 1390 }, size, itemTop: 300, viewport }), { left: 952, top: 292, side: 'left' });
  });
  it('stays on screen when neither side fits (narrow phone)', () => {
    const at = m.submenuPosition({ parent: { left: 40, right: 320 }, size: { width: 300, height: 100 }, itemTop: 300, viewport: { width: 360, height: 640 } });
    assert.equal(at.left, 8);
    assert.ok(at.left + 300 <= 352);
  });
  it('moves up near the bottom and down near the top', () => {
    assert.equal(m.submenuPosition({ parent: { left: 100, right: 340 }, size, itemTop: 880, viewport }).top, 792);
    assert.equal(m.submenuPosition({ parent: { left: 100, right: 340 }, size, itemTop: 2, viewport }).top, 8);
  });
});
