// Who takes how much width (layout-rules.ts): the columns at every window
// size, what a dragged width does, and when the sidebar is a rail.
// (Moved from backend/src/queue-rows.test.js.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as f from './layout-rules.ts';

describe('dragged column widths', () => {
  it('never dragged: the automatic widths, at every size', () => {
    for (let width = 768; width <= 2000; width += 1) {
      for (const chatDocked of [false, true]) {
        for (const pref of [null, 'rail', 'expanded'] as const) {
          const c = f.resolveColumns({ width, pref, chatDocked });
          const docked = chatDocked && width >= 1010;
          const right = docked ? (width >= 1200 ? 320 : 280) : width >= 1010 ? 56 : 0;
          const rail = pref === 'rail' || (pref !== 'expanded' && (width <= 1100 || width - 264 - right < 616));
          assert.equal(c.rail, rail, `${width} ${chatDocked} ${pref}`);
          assert.equal(c.left, rail ? 72 : width >= 1440 ? 304 : 264, `${width} ${chatDocked} ${pref}`);
          assert.equal(c.right, docked ? right : null);
        }
      }
    }
  });

  it('clamps what applies, never below the floor, and the wish comes back with room', () => {
    for (let width = 1010; width <= 2000; width += 1) {
      for (const pref of [null, 'rail', 'expanded'] as const) {
        const c = f.resolveColumns({ width, pref, chatDocked: true, left: 420, right: 420 });
        assert.ok(c.main >= f.MAIN_FLOOR, `${width} ${pref}: ${c.main}`);
        assert.ok(c.right !== null && c.right >= f.CHAT_MIN && c.right <= f.CHAT_MAX);
        assert.ok(c.rail ? c.left === 72 : c.left !== null && c.left >= f.SIDEBAR_MIN && c.left <= f.SIDEBAR_MAX);
      }
    }
    const wish = { pref: 'expanded', chatDocked: true, left: 400, right: 400 };
    const small = f.resolveColumns({ width: 1010, ...wish });
    assert.deepEqual([small.left, small.right, small.main], [200, 394, 416]);
    const big = f.resolveColumns({ width: 1920, ...wish });
    assert.deepEqual([big.left, big.right], [400, 400]);
  });

  it('automatic: a dragged sidebar shrinks to the comfortable page, then rails', () => {
    const at = (width: number) => f.resolveColumns({ width, chatDocked: true, left: 400 });
    assert.deepEqual([at(1400).rail, at(1400).left, at(1400).main], [false, 400, 680]);
    assert.deepEqual([at(1200).rail, at(1200).left, at(1200).main], [false, 264, 616]);
    assert.deepEqual([at(1101).rail, at(1101).left], [false, 205]); // 1101 - 280 - 616
    assert.equal(at(1100).rail, true, 'the rail range, whatever was dragged');
    // Past the rail range the room still decides: a wide chat leaves under 200.
    assert.equal(f.resolveColumns({ width: 1235, chatDocked: true, left: 400, right: 420 }).rail, true);
    assert.equal(f.resolveColumns({ width: 1236, chatDocked: true, left: 400, right: 420 }).rail, false);
  });

  it('a wide chat alone follows the same automatic rule', () => {
    assert.equal(f.resolveColumns({ width: 1300, chatDocked: true, right: 420 }).rail, false);
    assert.equal(f.resolveColumns({ width: 1299, chatDocked: true, right: 420 }).rail, true);
  });

  it('no sidebar on the page: the chat takes its wish', () => {
    const c = f.resolveColumns({ width: 1010, chatDocked: true, hasSidebar: false, right: 420 });
    assert.deepEqual([c.left, c.right, c.main], [null, 420, 590]);
  });
});

describe('library rail rule', () => {
  it('collapses the library before the chat, automatically', () => {
    const rail = (width: number, chatDocked: boolean) => f.sidebarRail({ width, chatDocked });
    assert.equal(rail(767, false), false, 'drawer, not a rail');
    assert.equal(rail(768, false), true);
    assert.equal(rail(1000, false), true);
    assert.equal(rail(1100, false), true);
    assert.equal(rail(1101, false), false, 'chat closed: expanded from 1101');
    assert.equal(rail(1010, true), true);
    assert.equal(rail(1101, true), true, 'chat docked: the page column keeps 616');
    assert.equal(rail(1159, true), true);
    assert.equal(rail(1160, true), false);
    assert.equal(rail(1200, true), false);
    // With the chat docked the rail range is never narrower than without it.
    for (let width = 768; width <= 2000; width += 1) {
      if (rail(width, false)) assert.equal(rail(width, true), true, `${width}`);
    }
  });

  it("the user's choice wins, and is never a rail on phones", () => {
    assert.equal(f.sidebarRail({ width: 1920, pref: 'rail', chatDocked: true }), true);
    assert.equal(f.sidebarRail({ width: 1010, pref: 'expanded', chatDocked: true }), false);
    assert.equal(f.sidebarRail({ width: 900, pref: 'expanded' }), false, 'expand inside the rail range');
    assert.equal(f.sidebarRail({ width: 1440, pref: 'rail' }), true, 'collapse where it is expanded by default');
    assert.equal(f.sidebarRail({ width: 500, pref: 'rail' }), false);
  });
});
