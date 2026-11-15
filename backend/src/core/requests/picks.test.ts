// A chosen-videos list from the web's pick dialog (picks.ts): what POST
// /api/jobs and socket queue:add accept as `picks`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPicks, MAX_PICKS } from './index.ts';

const vid = (n: number) => `video${String(n).padStart(6, '0')}`;
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

describe('cleanPicks', () => {
  it('takes 1 to MAX_PICKS video ids, each once', () => {
    assert.deepEqual(cleanPicks([vid(1)]), [vid(1)]);
    assert.deepEqual(cleanPicks([vid(1), vid(2), vid(1)]), [vid(1), vid(2)]);
    assert.equal(cleanPicks(Array.from({ length: MAX_PICKS }, (_, i) => vid(i)))!.length, MAX_PICKS);
  });
  it('refuses anything else', () => {
    for (const bad of [null, undefined, '', vid(1), {}, [], [vid(1), 'short'], [42], [null], [`${vid(1)}x`], [watch(vid(1))],
      Array.from({ length: MAX_PICKS + 1 }, (_, i) => vid(i))]) {
      assert.equal(cleanPicks(bad), null, String(JSON.stringify(bad)).slice(0, 40));
    }
  });
});
