// The double-click on a playlist row (frontend/row-double-click.js).
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let m;
let played;
let g;

// Just enough of an element: closest() answers from the selectors it is in.
const el = ({ id = 'p1', control = false, row = true } = {}) => ({
  id: '',
  dataset: { playlistId: id },
  closest(sel) {
    if (sel.startsWith('button')) return control ? this : null;
    return row ? this : null;
  },
});
const event = (target, extra = {}) => ({
  target, detail: 1, button: 0, clientX: 10, clientY: 10, stopped: false, prevented: false,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
  ...extra,
});
// A click as the browser sends it, for press number `detail`.
function press(target, detail = 1, extra = {}) {
  const down = event(target, { detail, ...extra });
  const up = event(target, { detail, ...extra });
  g.mousedown(down);
  g.clickCapture(up);
  if (!up.stopped) g.click(up);
  return { down, up };
}

before(async () => {
  m = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'row-double-click.js')).href);
});
beforeEach(() => {
  played = [];
  g = m.createRowDoubleClick((id) => played.push(id));
});

describe('row-double-click', () => {
  it('a single click plays nothing and is left alone', () => {
    const { down, up } = press(el());
    assert.deepEqual(played, []);
    assert.equal(down.prevented, false);
    assert.equal(up.stopped, false);
  });

  it('a double-click plays once and takes the second press', () => {
    press(el());
    const { down, up } = press(el(), 2);
    assert.deepEqual(played, ['p1']);
    assert.equal(down.prevented, true);
    assert.equal(down.stopped, true);
    assert.equal(up.stopped, true);
  });

  it('plays the first row even when something else is under the second press', () => {
    press(el({ id: 'p9' }));
    const { up } = press(el({ row: false }), 2);
    assert.deepEqual(played, ['p9']);
    assert.equal(up.stopped, true, 'whatever replaced the row must not be clicked');
  });

  it('a third click plays nothing more and is still taken', () => {
    press(el());
    press(el(), 2);
    const { up } = press(el(), 3);
    assert.deepEqual(played, ['p1']);
    assert.equal(up.stopped, true);
    press(el());
    assert.deepEqual(played, ['p1']);
  });

  it('a row control is never a double-click, first or second press', () => {
    press(el({ control: true }));
    const a = press(el({ control: true }), 2);
    assert.equal(a.up.stopped, false);
    press(el());
    const b = press(el({ control: true }), 2);
    assert.equal(b.up.stopped, false);
    assert.deepEqual(played, []);
  });

  it('outside a row nothing happens', () => {
    press(el({ row: false }));
    const { up } = press(el({ row: false }), 2);
    assert.equal(up.stopped, false);
    assert.deepEqual(played, []);
  });

  it('a double tap is two taps', () => {
    g.pointerdown({ pointerType: 'touch' });
    press(el());
    g.pointerdown({ pointerType: 'touch' });
    const { up } = press(el(), 2);
    assert.deepEqual(played, []);
    assert.equal(up.stopped, false);
  });

  it('a second press elsewhere, a modified first click or a keyboard click do not count', () => {
    press(el());
    press(el(), 2, { clientX: 200 });
    press(el(), 1, { ctrlKey: true });
    press(el(), 2);
    press(el(), 0);
    press(el(), 2);
    assert.deepEqual(played, []);
  });

  it('Radio has its own id', () => {
    const radio = { id: 'plnav-radio', dataset: {}, closest: (s) => (s.startsWith('button') ? null : radio) };
    assert.deepEqual(m.rowTarget(radio), { id: 'radio' });
  });
});
