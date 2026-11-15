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

describe('frontend: the shell top bar and the playlist header', () => {
  const css = read('app.css');
  it('the search field is one top bar outside every view, before the views in the tab order', () => {
    const form = html.match(/<form id="app-search"[^>]*>/);
    assert.ok(form, 'form');
    assert.match(form[0], /role="search"/);
    assert.equal((html.match(/id="app-search-input"/g) || []).length, 1);
    const at = html.indexOf('<form id="app-search"');
    assert.ok(at < html.indexOf('<div id="search-view"') && at < html.indexOf('<div id="landing-view"'), 'before the views');
    for (const id of ['search-view', 'landing-view', 'lobby-view', 'profile-view']) assert.doesNotMatch(viewHtml(id), /id="app-search"/, id);
    assert.doesNotMatch(read('search.js'), /\.prepend\(bar\)|is-stuck/, 'never moved into a page');
  });
  it('every column starts under it (--app-top), centred field, no rule or accent edge', () => {
    for (const sel of ['body.has-plnav .app-sidebar {', 'body.has-social .social-rail {', 'body.has-social:not(.social-collapsed) .social-panel {']) {
      const rule = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
      assert.match(rule, /top: var\(--app-top\)/, sel);
    }
    assert.match(css, /\.library-page \{[^}]*inset: var\(--app-top\)/);
    assert.match(css, /body\.has-plnav \.view \{[^}]*margin: var\(--app-top\)/);
    const bar = css.match(/body\.has-topbar \.app-search \{([^}]*)\}/);
    assert.ok(bar, 'top bar rule');
    assert.match(bar[1], /justify-content: center/);
    assert.match(bar[1], /left: 0/);
    assert.match(bar[1], /right: 0/);
    assert.doesNotMatch(bar[1], /border|box-shadow/);
  });
  it('the playlist page: header, then one toolbar; no Add songs, library button or stats pills', () => {
    const lobby = viewHtml('lobby-view');
    assert.doesNotMatch(lobby, /add-songs-btn|browse-library-btn|class="playlist-stats"|add-song"/);
    assert.match(lobby, /id="playlist-meta-text"[^>]*>.*id="playlist-owner".*id="playlist-stats".*id="user-count"/);
    const toolbar = lobby.slice(lobby.indexOf('queue-toolbar'), lobby.indexOf('playlist-download-progress'));
    for (const id of ['queue-search-input', 'queue-sort', 'download-queue-btn', 'clear-queue-btn']) assert.match(toolbar, new RegExp(`id="${id}"`), id);
    assert.ok(toolbar.indexOf('queue-search-input') < toolbar.indexOf('queue-sort'), 'filter first');
    for (const lang of ['en', 'tr']) {
      const l = locale(lang);
      for (const k of ['addSongs', 'addSongsHint', 'openLibrary', 'musicLibrary']) assert.equal(l.search[k], undefined, `${lang} search.${k}`);
      for (const k of ['emptyHintReadOnly', 'emptyHintSearch', 'emptyHintTouch', 'findSongs']) assert.ok(l.queue[k], `${lang} queue.${k}`);
      assert.match(l.queue.emptyHintSearch, /\{key\}/);
    }
  });
  it('the library is as wide as the page panel', () => {
    assert.match(css, /\.libpage-container \{ max-width: none;/);
    assert.doesNotMatch(css, /\.libpage-header > \.container \{ max-width: 56rem/);
  });
});

describe('frontend: GitHub link in the sidebar', () => {
  const head = (() => {
    const start = html.indexOf('class="d-flex align-items-center gap-1 plnav-head"');
    assert.ok(start >= 0, 'sidebar head');
    return html.slice(start, html.indexOf('</div>', start));
  })();
  it('is a real new-tab link in the top panel head, next to profile and the toggle', () => {
    const link = head.match(/<a id="plnav-github"[^>]*>/);
    assert.ok(link, 'link in the head');
    assert.match(link[0], /href="https:\/\/github\.com\/erkantaylan\/listen-along"/);
    assert.match(link[0], /target="_blank"/);
    assert.match(link[0], /rel="noopener"/);
    assert.match(link[0], /class="btn-text theme-secondary btn-icon[^"]*"/);
    assert.match(link[0], /data-i18n-aria-label="appMeta\.source"/);
    assert.ok(head.indexOf('plnav-github') < head.indexOf('plnav-profile') && head.indexOf('plnav-profile') < head.indexOf('plnav-toggle'));
  });
  it('keeps the About card link and has a name in both locales', () => {
    assert.match(viewHtml('profile-view'), /href="https:\/\/github\.com\/erkantaylan\/listen-along"/);
    assert.ok(locale('en').appMeta.source && locale('tr').appMeta.source);
  });
});
