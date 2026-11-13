// "Pick the video": the step before a download job or a song request is made
// (the Download box and a playlist's add-song box). The server looks up what
// was typed (POST /api/jobs/picks, backend/src/picker.js) and this dialog
// shows it:
//   search text, Spotify track   the first YouTube results, the top one selected
//   a YouTube video link         that one video, to confirm
//   a YouTube playlist link      every video ticked; "Swap" searches for other
//                                versions of one item, only when asked
// pickSongs() resolves with
//   { picks: [youtube id] }   confirmed: exactly these videos
//   { library: song }         nothing to pick, the library has it
//   { passthrough: true }     carry on as without a dialog (the input is not
//                             something to look up, or "first match anyway")
//   null                      cancelled
// No dialog appears for the last three unless the lookup takes a while.
// The rules (selection, swap, payloads) are in pick-rules.js.
import { formatDuration, t, trapFocus } from './ui.js';
import { createVirtualList } from './virtual-list.js';
import {
  allChecked, chosenIds, counts, isSwapped, lookupOutcome, moveIndex, playlistItems,
  swapChoices, swapped, swapQuery, thumbUrl, toggled, watchUrl,
} from './pick-rules.js';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';

// A quick answer (the library has it, bad input) never flashes a dialog.
const SHOW_AFTER_MS = 300;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key, fallback, vars = {}) => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

async function post(body) {
  let res;
  try {
    res = await fetch('/api/jobs/picks', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, body: null };
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

function metaLine(v) {
  return [v.channel, v.duration_sec ? formatDuration(v.duration_sec) : null].filter(Boolean).join(' · ');
}

// clamp: the title may take two lines (a result); a playlist row has one.
function videoHtml(v, clamp = false) {
  const title = v.title || tf('pick.unknownVideo', 'YouTube video {id}', { id: v.youtube_id });
  const meta = v.title ? metaLine(v) : tf('pick.notLookedUp', 'Could not look it up. You can still download it.');
  return `<span class="app-thumb pick-thumb"><img src="${escapeHtml(thumbUrl(v.youtube_id))}" alt="" loading="lazy"></span>
    <div class="min-w-0 flex-grow-1">
      <div class="pick-title${clamp ? '' : ' text-truncate'}" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="fs-sm fg-3 text-truncate">${escapeHtml(meta)}</div>
    </div>
    ${v.in_library ? `<span class="badge badge-subtle theme-success pick-badge">${escapeHtml(tf('pick.inLibrary', 'In library'))}</span>` : ''}`;
}

let closeOpen = null;

export function closePickDialog() {
  if (closeOpen) closeOpen();
}

/**
 * @param {object} o
 * @param {string} o.input - what was typed or pasted
 * @param {boolean} [o.matchLibrary] - a playlist's add-song box: a song the
 *   library already has is the answer, without a dialog
 * @param {Element} [o.returnFocus] - gets focus back when the dialog closes
 */
export function pickSongs({ input, matchLibrary = false, returnFocus = null }) {
  closePickDialog();
  return new Promise((resolve) => {
    const back = returnFocus || document.activeElement;
    let dialog = null;
    let done = false;
    let seq = 0;
    let view = 'loading'; // loading | error | single | list | swap
    let error = '';
    let lookup = null;
    let single = { videos: [], selected: 0 };
    let items = [];
    let list = null; // the playlist's virtual list
    let listScroll = 0;
    let swap = null; // { pos, state: 'loading' | 'ready' | 'error', videos, selected, message }
    const swapResults = new Map(); // item key -> search results

    function finish(result) {
      if (done) return;
      done = true;
      seq++;
      clearTimeout(showTimer);
      closeOpen = null;
      if (dialog) {
        dialog.remove();
        if (back && document.contains(back)) back.focus({ preventScroll: true });
      }
      resolve(result);
    }
    closeOpen = () => finish(null);
    const showTimer = setTimeout(show, SHOW_AFTER_MS);

    const $ = (sel) => dialog.querySelector(sel);
    const options = () => (view === 'swap' ? swap : single);

    async function load() {
      view = 'loading';
      render();
      const my = ++seq;
      const r = await post(matchLibrary ? { input, match_library: true } : { input });
      if (done || my !== seq) return;
      const outcome = lookupOutcome(r.status, r.body);
      if (outcome === 'library') return finish({ library: r.body.song });
      if (outcome === 'passthrough') return finish({ passthrough: true });
      if (outcome === 'error') {
        view = 'error';
        error = (r.body && r.body.error) || tf('pick.failed', 'The search did not work. Check your connection and try again.');
      } else {
        lookup = r.body;
        if (lookup.kind === 'playlist') {
          items = playlistItems(lookup.results);
          view = 'list';
        } else {
          single = { videos: lookup.results, selected: 0 };
          view = 'single';
        }
      }
      show();
    }

    function show() {
      clearTimeout(showTimer);
      if (done) return;
      if (!dialog) build();
      render();
      focusView();
    }

    function build() {
      dialog = document.createElement('div');
      dialog.id = 'pick-dialog';
      dialog.className = 'app-modal pick-overlay';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'pick-title');
      dialog.innerHTML = `<form class="card app-modal-card pick-form" novalidate>
        <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
          <h2 id="pick-title" class="h6 mb-0 text-truncate"></h2>
          <button class="btn-text theme-secondary btn-icon btn-sm pick-close" type="button" aria-label="${escapeHtml(tf('pick.close', 'Close'))}">${CLOSE_ICON}</button>
        </div>
        <div class="card-body vstack gap-3">
          <p class="fs-sm fg-3 mb-0 pick-note" id="pick-note"></p>
          <div class="pick-body"></div>
        </div>
        <div class="card-footer d-flex justify-content-end gap-2">
          <button class="btn pick-cancel" type="button"></button>
          <button class="btn-solid theme-primary pick-submit" type="submit"></button>
        </div>
      </form>`;
      document.body.appendChild(dialog);

      $('.pick-close').addEventListener('click', () => finish(null));
      $('.pick-cancel').addEventListener('click', goBack);
      $('form').addEventListener('submit', (e) => { e.preventDefault(); confirm(); });
      dialog.addEventListener('click', onClick);
      dialog.addEventListener('dblclick', (e) => { if (e.target.closest('.pick-option') && !e.target.closest('a')) confirm(); });
      dialog.addEventListener('change', onChange);
      dialog.addEventListener('keydown', onKeydown);
    }

    // Cancel, or back to the playlist from a swap.
    function goBack() {
      if (view === 'swap') closeSwap();
      else finish(null);
    }

    function onClick(e) {
      if (e.target === dialog) return finish(null);
      if (e.target.closest('.pick-retry')) return view === 'swap' ? openSwap(swap.pos) : load();
      if (e.target.closest('.pick-first')) return finish({ passthrough: true });
      if (e.target.closest('.pick-all')) {
        items = allChecked(items, counts(items).ticked !== items.length);
        renderList();
        renderFooter();
        $('.pick-all').focus();
        return;
      }
      const swapBtn = e.target.closest('.pick-swap');
      if (swapBtn) return openSwap(list.positionOf(swapBtn.closest('.pick-row')));
      const option = e.target.closest('.pick-option');
      if (option && !e.target.closest('a')) {
        select(Number(option.dataset.pos));
        $('.pick-options').focus();
      }
    }

    function onChange(e) {
      const box = e.target.closest('.pick-check');
      if (!box) return;
      const row = box.closest('.pick-row');
      const pos = list.positionOf(row);
      items = toggled(items, pos);
      row.classList.toggle('pick-off', !items[pos].checked);
      renderFooter();
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        goBack();
        return;
      }
      trapFocus(dialog, e);
      if (e.key === 'Enter' && !e.target.closest('button, a')) {
        e.preventDefault();
        // A held Enter (the one that opened the dialog) confirms nothing.
        if (!e.repeat) confirm();
        return;
      }
      if (e.target.closest('.pick-options')) {
        const o = options();
        const next = moveIndex(o.selected, e.key, o.videos.length);
        if (next === null) return;
        e.preventDefault();
        select(next);
        return;
      }
      const row = e.target.closest('.pick-row');
      if (!row || !list) return;
      const pos = list.positionOf(row);
      if (e.key === 'ArrowRight' && !e.target.closest('.pick-swap')) {
        e.preventDefault();
        openSwap(pos);
        return;
      }
      const next = moveIndex(pos, e.key, items.length, list.pageSize);
      if (next === null) return;
      e.preventDefault();
      focusRow(next, e.target.closest('.pick-swap') ? '.pick-swap' : '.pick-check');
    }

    function focusRow(pos, control = '.pick-check') {
      const el = list && list.scrollToIndex(pos);
      const target = el && el.querySelector(control);
      if (target) target.focus({ preventScroll: true });
    }

    function select(pos) {
      const o = options();
      if (!o.videos[pos]) return;
      o.selected = pos;
      dialog.querySelectorAll('.pick-option').forEach((el) => {
        const on = Number(el.dataset.pos) === pos;
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) el.scrollIntoView({ block: 'nearest' });
      });
      $('.pick-options').setAttribute('aria-activedescendant', `pick-option-${pos}`);
      renderFooter();
    }

    function confirm() {
      if (view === 'single') {
        const v = single.videos[single.selected];
        if (v) finish({ picks: [v.youtube_id] });
      } else if (view === 'list') {
        const ids = chosenIds(items);
        if (ids.length) finish({ picks: ids });
      } else if (view === 'swap' && swap.state === 'ready') {
        const v = swap.videos[swap.selected];
        if (v) items = swapped(items, swap.pos, v);
        closeSwap();
      }
    }

    // Other versions of one playlist item: searched only now, once per item.
    async function openSwap(pos) {
      const item = items[pos];
      if (!item) return;
      if (view === 'list') listScroll = $('.pick-scroll').scrollTop;
      const ready = (results) => ({ pos, state: 'ready', ...swapChoices(item, results) });
      view = 'swap';
      const query = swapQuery(item);
      if (swapResults.has(item.key)) {
        swap = ready(swapResults.get(item.key));
      } else if (!query) {
        swap = { pos, state: 'error', videos: [], selected: 0, message: tf('pick.swapNoTitle', 'This video has no title to search for.'), final: true };
      } else {
        swap = { pos, state: 'loading', videos: [], selected: 0 };
        render();
        focusView();
        const my = ++seq;
        const r = await post({ query });
        if (done || my !== seq) return;
        if (r.status === 200 && r.body && Array.isArray(r.body.results)) {
          swapResults.set(item.key, r.body.results);
          swap = ready(r.body.results);
        } else {
          swap = { pos, state: 'error', videos: [], selected: 0, message: (r.body && r.body.error) || tf('pick.failed', 'The search did not work. Check your connection and try again.') };
        }
      }
      render();
      focusView();
    }

    function closeSwap() {
      const pos = swap.pos;
      seq++;
      swap = null;
      view = 'list';
      render();
      $('.pick-scroll').scrollTop = listScroll;
      focusRow(pos, '.pick-swap');
    }

    function optionsHtml(o, label) {
      return `<ul class="list-group pick-options" role="listbox" tabindex="0" aria-label="${escapeHtml(label)}" aria-describedby="pick-note" aria-activedescendant="pick-option-${o.selected}">
        ${o.videos.map((v, i) => `<li class="list-group-item pick-item pick-option" role="option" id="pick-option-${i}" data-pos="${i}" aria-selected="${i === o.selected}">
          ${videoHtml(v, true)}
          <a class="btn-text theme-secondary btn-icon btn-sm pick-open" href="${escapeHtml(watchUrl(v.youtube_id))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(tf('pick.openOnYoutube', 'Open on YouTube'))}" title="${escapeHtml(tf('pick.openOnYoutube', 'Open on YouTube'))}">${OPEN_ICON}</a>
        </li>`).join('')}
      </ul>`;
    }

    const statusHtml = (text) => `<div class="app-empty pick-status" role="status">${escapeHtml(text)}</div>`;
    const errorHtml = (message, { first = false, retry = true } = {}) => `<div class="alert theme-danger fs-sm mb-3" role="alert">${escapeHtml(message)}</div>
      <div class="d-flex flex-wrap gap-2">
        ${retry ? `<button class="btn btn-sm pick-retry" type="button">${escapeHtml(tf('pick.retry', 'Try again'))}</button>` : ''}
        ${first ? `<button class="btn btn-sm pick-first" type="button">${escapeHtml(tf('pick.firstMatch', 'Take the first match without asking'))}</button>` : ''}
      </div>`;

    function rowHtml(pos) {
      const it = items[pos];
      const title = it.video.title || it.video.youtube_id;
      return `<li class="list-group-item pick-item pick-row${it.checked ? '' : ' pick-off'}">
        <input type="checkbox" class="check pick-check"${it.checked ? ' checked' : ''} aria-label="${escapeHtml(tf('pick.include', 'Include {title}', { title }))}">
        ${videoHtml(it.video)}
        ${isSwapped(it) ? `<span class="badge badge-subtle theme-secondary pick-badge">${escapeHtml(tf('pick.swappedBadge', 'Swapped'))}</span>` : ''}
        <button class="btn btn-sm pick-swap" type="button" aria-label="${escapeHtml(tf('pick.swapNamed', 'Swap {title} for another video', { title }))}">${escapeHtml(tf('pick.swap', 'Swap'))}</button>
      </li>`;
    }

    function renderList() {
      list.setSource({
        count: items.length,
        keyOf: (pos) => items[pos].key,
        indexOfKey: (key) => items.findIndex((it) => it.key === key),
        renderRow: rowHtml,
      });
    }

    function render() {
      if (!dialog) return;
      const body = $('.pick-body');
      const note = $('.pick-note');
      let title = tf('pick.title', 'Pick the video');
      let noteText = '';
      list = null;
      if (view === 'loading') {
        body.innerHTML = statusHtml(tf('pick.searching', 'Searching YouTube…'));
      } else if (view === 'error') {
        body.innerHTML = errorHtml(error, { first: true });
      } else if (view === 'single') {
        if (lookup.kind === 'video') {
          title = tf('pick.titleVideo', 'Download this video?');
          body.innerHTML = optionsHtml(single, title);
        } else if (!single.videos.length) {
          // As before the dialog: it can still be asked for by its name.
          body.innerHTML = statusHtml(tf('pick.noResults', 'No videos found for “{query}”. Try other words.', { query: lookup.query }))
            + `<div class="d-flex justify-content-center"><button class="btn btn-sm pick-first" type="button">${escapeHtml(tf('pick.anyway', 'Request it anyway'))}</button></div>`;
        } else {
          noteText = tf('pick.searchNote', 'Results for “{query}”. Pick the right version.', { query: lookup.query });
          body.innerHTML = optionsHtml(single, title);
        }
      } else if (view === 'list') {
        title = tf('pick.titlePlaylist', 'Playlist: {count} videos', { count: lookup.total });
        noteText = tf('pick.playlistNote', 'Untick what you do not want. Swap replaces a video with another version.')
          + (lookup.total > items.length ? ` ${tf('pick.playlistCapped', 'Only the first {shown} of {total} are listed.', { shown: items.length, total: lookup.total })}` : '');
        body.innerHTML = items.length
          ? `<div class="d-flex align-items-center justify-content-between gap-2 mb-2">
              <span class="fs-sm fg-2 pick-count" role="status"></span>
              <button class="btn-text theme-secondary btn-sm pick-all" type="button"></button>
            </div>
            <div class="pick-scroll"><ul class="list-group pick-playlist" aria-label="${escapeHtml(title)}"></ul></div>`
          : statusHtml(tf('pick.playlistEmpty', 'No videos found in that playlist.'));
        if (items.length) {
          list = createVirtualList({ list: $('.pick-playlist'), scroller: $('.pick-scroll') });
          renderList();
        }
      } else {
        const item = items[swap.pos];
        title = tf('pick.titleSwap', 'Swap “{title}”', { title: item.original.title || item.original.youtube_id });
        if (swap.state === 'loading') body.innerHTML = statusHtml(tf('pick.searching', 'Searching YouTube…'));
        else if (swap.state === 'error') body.innerHTML = errorHtml(swap.message, { retry: !swap.final });
        else {
          noteText = tf('pick.swapNote', 'The first one is the playlist’s own video. Pick the version to take instead.');
          body.innerHTML = optionsHtml(swap, title);
        }
      }
      $('#pick-title').textContent = title;
      note.textContent = noteText;
      note.hidden = !noteText;
      renderFooter();
    }

    function renderFooter() {
      const submit = $('.pick-submit');
      $('.pick-cancel').textContent = view === 'swap' ? tf('pick.back', 'Back') : tf('pick.cancel', 'Cancel');
      let label = tf('pick.download', 'Download');
      let enabled = false;
      if (view === 'single') {
        const v = single.videos[single.selected];
        enabled = !!v;
        if (v && v.in_library) label = tf('pick.useLibrary', 'Use the library song');
      } else if (view === 'list') {
        const c = counts(items);
        enabled = c.chosen > 0;
        label = c.chosen === 1 ? tf('pick.downloadOne', 'Download 1 song') : tf('pick.downloadMany', 'Download {count} songs', { count: c.chosen });
        const count = $('.pick-count');
        if (count) {
          count.textContent = tf('pick.chosenCount', '{chosen} of {total} selected', { chosen: c.ticked, total: c.total })
            + (c.inLibrary ? ` · ${tf('pick.chosenInLibrary', '{count} already in the library', { count: c.inLibrary })}` : '');
        }
        const all = $('.pick-all');
        if (all) all.textContent = c.ticked === c.total ? tf('pick.selectNone', 'Select none') : tf('pick.selectAll', 'Select all');
      } else if (view === 'swap') {
        label = tf('pick.useThis', 'Use this one');
        enabled = swap.state === 'ready' && !!swap.videos[swap.selected];
      }
      submit.textContent = label;
      submit.disabled = !enabled;
    }

    function focusView() {
      if (!dialog) return;
      const target = $('.pick-options') || $('.pick-retry') || $('.pick-first') || (view === 'list' && items.length ? null : $('.pick-cancel'));
      if (target) target.focus({ preventScroll: true });
      else focusRow(0);
    }

    load();
  });
}
