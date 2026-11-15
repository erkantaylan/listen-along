// The double-click on a playlist row (row-double-click.ts).
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as m from './row-double-click.ts';
import type { RowDoubleClick } from './row-double-click.ts';

let played: (string | undefined)[];
let g: RowDoubleClick;

// Fakes for the few fields the gesture reads; cast where a DOM type is expected.
type FakeEvent = Record<string, unknown> & { stopped: boolean; prevented: boolean };

// Just enough of an element: closest() answers from the selectors it is in.
const el = ({ id = 'p1', control = false, row = true } = {}) => ({
  id: '',
  dataset: { playlistId: id },
  closest(sel: string) {
    if (sel.startsWith('button')) return control ? this : null;
    return row ? this : null;
  },
});
const event = (target: unknown, extra: Record<string, unknown> = {}): FakeEvent => ({
  target, detail: 1, button: 0, clientX: 10, clientY: 10, stopped: false, prevented: false,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
  ...extra,
});
const asMouse = (e: FakeEvent) => e as unknown as MouseEvent;
// A click as the browser sends it, for press number `detail`.
function press(target: unknown, detail = 1, extra: Record<string, unknown> = {}) {
  const down = event(target, { detail, ...extra });
  const up = event(target, { detail, ...extra });
  g.mousedown(asMouse(down));
  g.clickCapture(asMouse(up));
  if (!up.stopped) g.click(asMouse(up));
  return { down, up };
}
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

  it('an artist card plays as artist:<key>', () => {
    const card = { id: '', dataset: { artistKey: 'barismanco' }, closest(sel: string) { return sel.startsWith('button') ? null : this; } };
    assert.deepEqual(m.rowTarget(card as unknown as EventTarget), { id: 'artist:barismanco' });
    press(card);
    press(card, 2);
    assert.deepEqual(played, ['artist:barismanco']);
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
    g.pointerdown({ pointerType: 'touch' } as PointerEvent);
    press(el());
    g.pointerdown({ pointerType: 'touch' } as PointerEvent);
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
    const radio: object = { id: 'plnav-radio', dataset: {}, closest: (s: string) => (s.startsWith('button') ? null : radio) };
    assert.deepEqual(m.rowTarget(radio as EventTarget), { id: 'radio' });
  });
});
