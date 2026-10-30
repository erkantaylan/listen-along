// Tests the frontend escapeHtml helper (frontend/ui.js). ui.js is an ES module
// that imports state.js, which looks up DOM elements at load time, so a minimal
// `document` stub is installed before the dynamic import.
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let escapeHtml;

before(async () => {
  globalThis.document ??= {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const uiPath = path.join(__dirname, '..', '..', 'frontend', 'ui.js');
  ({ escapeHtml } = await import(pathToFileURL(uiPath).href));
});

describe('frontend escapeHtml', () => {
  it('escapes & < > " and \'', () => {
    assert.strictEqual(escapeHtml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });

  it('prevents attribute breakout', () => {
    const title = `x" onerror="alert(1)`;
    const html = `<img title="${escapeHtml(title)}">`;
    assert.strictEqual(html, '<img title="x&quot; onerror=&quot;alert(1)">');
    assert.ok(!escapeHtml(`x' onmouseover='alert(1)`).includes("'"));
  });

  it('escapes & first so entities are not double-decoded', () => {
    assert.strictEqual(escapeHtml('&quot;'), '&amp;quot;');
  });

  it('handles null, undefined and non-strings like the old DOM-based version', () => {
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
    assert.strictEqual(escapeHtml(42), '42');
    assert.strictEqual(escapeHtml('Şarkı — 🎵'), 'Şarkı — 🎵');
  });

  it('escapeHtml(JSON.stringify(x)) is safe for inline-handler JS arguments', () => {
    const id = `x');alert(1);('"`;
    const attr = escapeHtml(JSON.stringify(id));
    assert.ok(!/["'<>]/.test(attr));
    // What the browser runs after HTML-decoding the attribute value:
    const decoded = attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.strictEqual(JSON.parse(decoded), id);
  });
});
