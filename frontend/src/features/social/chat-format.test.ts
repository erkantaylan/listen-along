// The global chat's pure helpers (chat-format.ts). Moved from
// backend/src/social.test.js, whose server tests stay there.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fmt from './chat-format.ts';

describe('chat-format (frontend): escaping and links', () => {
  it('escapes HTML so nothing can be injected', () => {
    const html = fmt.formatMessageHtml('<script>alert("x")</script> & <img src=x onerror=alert(1)>');
    assert.equal(html, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;');
    assert.ok(!/<(?!\/?a[ >])/.test(html));
  });

  it('auto-links http(s) URLs safely, leaving trailing punctuation out', () => {
    const html = fmt.formatMessageHtml('see https://example.com/a?b=1&c=2. ok');
    assert.equal(html, 'see <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1&amp;c=2</a>. ok');
  });

  it('never links javascript: or data: URLs and cannot break out of the attribute', () => {
    assert.equal(fmt.formatMessageHtml('javascript:alert(1)'), 'javascript:alert(1)');
    assert.equal(fmt.formatMessageHtml('data:text/html,<b>x</b>'), 'data:text/html,&lt;b&gt;x&lt;/b&gt;');
    const html = fmt.formatMessageHtml('https://x.test/"onmouseover="alert(1)');
    assert.ok(!html.includes('"onmouseover'));
  });

  it('groups people: online (playing first) and offline (recently seen first)', () => {
    const g = fmt.groupPeople([
      { id: 1, name: 'zed', online: true },
      { id: 2, name: 'amy', online: true },
      { id: 3, name: 'bob', online: true, nowPlaying: { track: { title: 't' } } },
      { id: 4, name: 'old', online: false, lastSeen: 10 },
      { id: 5, name: 'new', online: false, lastSeen: 20 },
    ]);
    assert.deepEqual(g.online.map(p => p.id), [3, 2, 1]);
    assert.deepEqual(g.offline.map(p => p.id), [5, 4]);
  });

  it('formats last seen', () => {
    const now = 10 * 86_400_000;
    assert.equal(fmt.formatLastSeen(now - 10_000, now), 'just now');
    assert.equal(fmt.formatLastSeen(now - 5 * 60_000, now), '5m ago');
    assert.equal(fmt.formatLastSeen(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(fmt.formatLastSeen(now - 2 * 86_400_000, now), '2d ago');
    assert.equal(fmt.formatLastSeen(null, now), '');
  });
});
