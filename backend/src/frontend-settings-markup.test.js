// Static checks on frontend/index.html and the locales: the library place's
// label, the language setting living on the profile page only, and the tab sets
// sharing one segmented-control style.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = (f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8');
const locale = (lang) => JSON.parse(read(`locales/${lang}.json`));
const html = read('index.html');
// The markup of one top-level view, from its opening tag to the next view's.
const viewHtml = (id) => {
  const start = html.indexOf(`<div id="${id}"`);
  assert.ok(start >= 0, id);
  const next = html.indexOf('<div id="', html.indexOf('\n  <!--', start));
  return html.slice(start, next > start ? next : undefined);
};

describe('frontend: Library & Downloads label', () => {
  it('both locales name the place', () => {
    assert.equal(locale('en').landing.library, 'Library & Downloads');
    assert.equal(locale('tr').landing.library, 'Kütüphane ve İndirmeler');
  });
  it('no default text or fallback keeps the old name', () => {
    for (const f of ['index.html', 'lobby.js', 'app.js']) assert.doesNotMatch(read(f), /Music library (&amp;|&) requests/, f);
    const bound = html.match(/<[^>]*data-i18n(-title|-aria-label)?="landing\.library"[^>]*>[^<]*/g) || [];
    assert.ok(bound.length >= 4, 'sidebar, phone row and Home button use the key');
    for (const el of bound) assert.match(el, /Library &amp; Downloads/, el);
  });
});

describe('frontend: language setting', () => {
  it('is one labelled select on the profile page, not on Home', () => {
    assert.equal(html.match(/id="language-selector"/g).length, 1);
    const profile = viewHtml('profile-view');
    assert.match(profile, /<label for="language-selector"[^>]*data-i18n="language\.select"/);
    assert.match(profile, /<select id="language-selector"[^>]*>\s*<option value="en"[^>]*>English<\/option>\s*<option value="tr"[^>]*>Türkçe<\/option>/);
    assert.doesNotMatch(viewHtml('landing-view'), /language-selector/);
  });
  it('both locales have the same language keys', () => {
    assert.deepEqual(Object.keys(locale('tr').language).sort(), Object.keys(locale('en').language).sort());
    assert.ok(locale('en').language.hint && locale('tr').language.hint);
  });
});

describe('frontend: tabs', () => {
  it('every tab set is the shared segmented control, with its switching hooks', () => {
    assert.match(html, /<div id="plnav-chips" class="app-seg app-seg-fill plnav-chips" role="group"/);
    assert.equal((html.match(/<button type="button" data-plnav-filter="(all|mine|public|private)" aria-pressed="(true|false)"/g) || []).length, 4);
    assert.match(html, /<nav class="app-seg[^"]*libpage-tabs"/);
    assert.equal((html.match(/<button class="libpage-tab( active)?" data-libtab="(library|requests|downloads|broken)"/g) || []).length, 4);
    assert.match(html, /<nav class="app-seg[^"]*profile-activity-tabs"/);
    assert.equal((html.match(/data-activity-tab="(uploaded|asked|fulfilled|workers)"/g) || []).length, 4);
    assert.doesNotMatch(html, /nav-underline|plnav-chip"|class="btn btn-sm plnav-chip/);
  });
  it('the current tab is a tint, never an edge', () => {
    const css = read('theme.css');
    const rule = css.match(/\.app-seg > :is\(\.active, \[aria-pressed="true"\]\)[^{]*\{([^}]*)\}/);
    assert.ok(rule, 'current-tab rule');
    assert.match(rule[1], /background-color: var\(--app-accent-subtle\)/);
    assert.doesNotMatch(rule[1], /border|box-shadow|outline/);
    assert.doesNotMatch(css, /\.app-seg[^{]*::?(before|after)/);
  });
});
