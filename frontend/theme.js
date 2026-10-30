// Colour mode (light / dark) for every page. Loaded as a classic script in
// <head>, before the stylesheets, so the stored choice applies before the first
// paint. See DESIGN.md "Light and dark".
//
// - No stored choice: <html> has no data-bs-theme and Bootstrap follows the
//   OS (prefers-color-scheme) through `color-scheme: light dark`.
// - A choice made with a [data-theme-toggle] button is stored in localStorage
//   under 'listen-theme' and set as data-bs-theme on <html>.
(function () {
  var KEY = 'listen-theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  var SUN = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM3.5 4.9l1.4-1.4 2.1 2.1-1.4 1.4zm12.9 12.9 1.4-1.4 2.1 2.1-1.4 1.4zM1 11h3v2H1zm19 0h3v2h-3zM3.5 19.1l2.1-2.1 1.4 1.4-2.1 2.1zM16.4 6.2l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>';
  var MOON = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.3 22c5.5 0 10-4.5 10-10 0-.5 0-1-.1-1.5A7 7 0 0 1 12.5 2c-.5-.1-1-.1-1.5-.1C5.5 2 1 6.5 1 12s4.5 10 10 10h1.3z"/></svg>';

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) { return null; }
  }

  function store(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode: not remembered */ }
  }

  function effective() {
    return stored() || (media && media.matches ? 'dark' : 'light');
  }

  function apply(mode) {
    if (mode) root.setAttribute('data-bs-theme', mode);
    else root.removeAttribute('data-bs-theme');
  }

  function syncToggles() {
    var dark = effective() === 'dark';
    var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].innerHTML = dark ? SUN : MOON;
      buttons[i].setAttribute('aria-label', label);
      buttons[i].title = label;
    }
  }

  apply(stored());

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    var next = effective() === 'dark' ? 'light' : 'dark';
    store(next);
    apply(next);
    syncToggles();
  });

  // Bootstrap 6 range inputs paint the filled part of the track from
  // --bs-range-fill (0..1); keep it in step with the value.
  function syncRange(input) {
    var min = Number(input.min) || 0;
    var max = Number(input.max) || 100;
    var fill = max > min ? (Number(input.value) - min) / (max - min) : 0;
    input.style.setProperty('--bs-range-fill', String(Math.min(1, Math.max(0, fill))));
  }
  document.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('.form-range-input')) syncRange(e.target);
  });

  function init() {
    syncToggles();
    var ranges = document.querySelectorAll('.form-range-input');
    for (var i = 0; i < ranges.length; i++) syncRange(ranges[i]);
  }

  if (media && media.addEventListener) media.addEventListener('change', syncToggles);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
