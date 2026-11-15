// Static checks on frontend/index.html and the locales: the library place's
// label, and the language setting living on the profile page only.
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
