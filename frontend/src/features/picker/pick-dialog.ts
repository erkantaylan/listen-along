// "Pick the video": the step before a download job or a song request is made
// (the Download box; the search page's playlist import). The server looks up what
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
// importPlaylist() is the same checklist for a YouTube playlist the search page
// already looked up, with a destination chooser at the top (a new playlist
// named after it, or one of the user's editable playlists): rows already in the
// destination start unticked. It resolves { picks, destination } or null.
// The rules (selection, swap, payloads, destinations) are in pick-rules.ts.
import { formatDuration, t, trapFocus } from '../../shared/ui.ts';
import { createVirtualList } from '../../shared/virtual-list.ts';
import type { VirtualList } from '../../shared/virtual-list.ts';
import type { LibrarySong, PickVideo } from '../../shared/types.ts';
import {
  allChecked, chosenIds, counts, destinationKeys, importCounts, isSwapped, lookupOutcome, moveIndex, playlistItems,
  swapChoices, swapped, swapQuery, thumbUrl, toggled, watchUrl, withDestination,
} from './pick-rules.ts';
import type { DestinationSong, PickItem, PicksAnswer } from './pick-rules.ts';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';

// A quick answer (the library has it, bad input) never flashes a dialog.
const SHOW_AFTER_MS = 300;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number> = {}): string => t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

async function post(body: { input: string } | { query: string }): Promise<{ status: number; body: PicksAnswer | null }> {
  let res: Response;
  try {
    res = await fetch('/api/jobs/picks', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    return { status: 0, body: null };
  }
  return { status: res.status, body: await res.json().catch(() => null) as PicksAnswer | null };
}

function metaLine(v: PickVideo): string {
  return [v.channel, v.duration_sec ? formatDuration(v.duration_sec) : null].filter(Boolean).join(' · ');
}

// clamp: the title may take two lines (a result); a playlist row has one.
// status (an import row): what confirming does with it, before the meta line;
// already: a badge instead of "In library".
function videoHtml(v: PickVideo, clamp = false, { status = null, already = false }: { status?: string | null; already?: boolean } = {}): string {
  const title = v.title || tf('pick.unknownVideo', 'YouTube video {id}', { id: v.youtube_id });
  const meta = [status, v.title ? metaLine(v) : tf('pick.notLookedUp', 'Could not look it up. You can still download it.')].filter(Boolean).join(' · ');
  const badge = already
    ? `<span class="badge badge-subtle theme-warning pick-badge">${escapeHtml(tf('pick.alreadyInPlaylist', 'Already in playlist'))}</span>`
    : v.in_library && status === null ? `<span class="badge badge-subtle theme-success pick-badge">${escapeHtml(tf('pick.inLibrary', 'In library'))}</span>` : '';
  return `<span class="app-thumb pick-thumb"><img src="${escapeHtml(thumbUrl(v.youtube_id))}" alt="" loading="lazy"></span>
    <div class="min-w-0 flex-grow-1">
      <div class="pick-title${clamp ? '' : ' text-truncate'}" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="fs-sm fg-3 text-truncate">${escapeHtml(meta)}</div>
    </div>
    ${badge}`;
}

// The import's primary button: what confirming does.
function importLabel(c: { now: number; request: number }): string {
  if (c.now && c.request) return tf('pick.importBoth', 'Add {now} now, request {request}', { now: c.now, request: c.request });
  if (c.now) return tf('pick.importNow', 'Add {now} now', { now: c.now });
  if (c.request) return tf('pick.importRequest', 'Request {request}', { request: c.request });
  return tf('pick.importNothing', 'Add');
}

/** What pickSongs resolves with (null: cancelled); see the top of the file. */
export interface PickSongsResult {
  picks?: string[];
  library?: LibrarySong;
  passthrough?: true;
}

/** Where an import goes; checked: what the destination holds was read. */
export type ImportDestination =
  | { kind: 'new'; name: string; checked: boolean }
  | { kind: 'existing'; id: string; name: string; checked: boolean };

/** What importPlaylist resolves with (null: cancelled). */
export interface ImportResult {
  picks: string[];
  destination: ImportDestination;
}

/** importPlaylist's options. */
export interface ImportOptions {
  /** What POST /api/jobs/picks said. */
  playlist: { title: string | null; total: number; videos: PickVideo[] };
  /** The user's editable playlists. */
  destinations?: { id: string; name: string }[] | null;
  /** A playlist's songs (GET /api/playlists/:id/songs). */
  loadSongs: (id: string) => Promise<readonly DestinationSong[]>;
  /** The new playlist's name (the YouTube playlist's). */
  newName: string;
  /** A playlist id to start on, else the new playlist. */
  initial?: string | null;
  returnFocus?: HTMLElement | null;
}

/** An import as openPick holds it. */
interface ImportState {
  playlist: ImportOptions['playlist'];
  destinations: { id: string; name: string }[];
  loadSongs: ImportOptions['loadSongs'];
  newName: string;
  initial: string | null;
}

type View = 'loading' | 'error' | 'single' | 'list' | 'swap';

/** The videos to pick one of: a search or a video link (single), or a swap. */
interface Options {
  videos: PickVideo[];
  selected: number;
}

type Swap = Options & { pos: number } & (
  | { state: 'loading' | 'ready' }
  | { state: 'error'; message: string; final?: boolean }
);

/** The import's destination: 'new' or a playlist id; keys = what it holds. */
interface Destination {
  value: string;
  state: 'ready' | 'loading' | 'error';
  keys: Set<string>;
  seq: number;
}

let closeOpen: (() => void) | null = null;

export function closePickDialog(): void {
  if (closeOpen) closeOpen();
}

/**
 * input: what was typed or pasted; returnFocus gets focus back when the dialog closes.
 */
export function pickSongs({ input, returnFocus = null }: { input: string; returnFocus?: HTMLElement | null }): Promise<PickSongsResult | null> {
  return openPick({ input, returnFocus });
}

/**
 * The checklist for a YouTube playlist already looked up (search.ts); see ImportOptions.
 */
export function importPlaylist({ playlist, destinations, loadSongs, newName, initial = null, returnFocus = null }: ImportOptions): Promise<ImportResult | null> {
  // With `imported`, openPick resolves only { picks, destination } or null (confirm).
  return openPick({ returnFocus, imported: { playlist, destinations: destinations || [], loadSongs, newName, initial } }) as Promise<ImportResult | null>;
}

function openPick({ input = '', returnFocus = null, imported = null }: { input?: string; returnFocus?: HTMLElement | null; imported?: ImportState | null }): Promise<PickSongsResult | ImportResult | null> {
  closePickDialog();
  return new Promise((resolve) => {
    const back = (returnFocus || document.activeElement) as HTMLElement | null;
    let dialog: HTMLDivElement | null = null;
    let done = false;
    let seq = 0;
    let view: View = 'loading'; // loading | error | single | list | swap
    let error = '';
    // TODO type: null until load() sets it, read only by the views that come after (single, list); a view union carrying its data (a refactor) would say so.
    let lookup = null as unknown as PicksAnswer;
    let single: Options = { videos: [], selected: 0 };
    let items: PickItem[] = [];
    let list: VirtualList | null = null; // the playlist's virtual list
    let listScroll = 0;
    // TODO type: set while view is 'swap', null otherwise; a view union carrying its data (a refactor) would say so.
    let swap = null as unknown as Swap; // { pos, state: 'loading' | 'ready' | 'error', videos, selected, message }
    const swapResults = new Map<number, PickVideo[]>(); // item key -> search results
    // The import's destination: 'new' or a playlist id; keys = what it holds.
    let builtAt = 0;
    const dest: Destination | null = imported ? { value: 'new', state: 'ready', keys: new Set(), seq: 0 } : null;

    function finish(result: PickSongsResult | ImportResult | null) {
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
    const showTimer = imported ? undefined : setTimeout(show, SHOW_AFTER_MS);

    // The dialog's own markup, once it is built. Typed as found: a lookup a view
    // may lack (#pick-dest, .pick-options, .pick-count…) is checked by its caller.
    const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => (dialog as HTMLDivElement).querySelector<T>(sel) as T;
    const options = (): Options => (view === 'swap' ? swap : single);

    async function load() {
      if (imported) {
        lookup = { kind: 'playlist', results: imported.playlist.videos, total: imported.playlist.total, title: imported.playlist.title };
        items = playlistItems(lookup.results);
        view = 'list';
        show();
        const start = imported.initial && imported.destinations.some((p) => p.id === imported.initial) ? imported.initial : 'new';
        if (start !== 'new') setDestination(start);
        return;
      }
      view = 'loading';
      render();
      const my = ++seq;
      const r = await post({ input });
      if (done || my !== seq) return;
      const outcome = lookupOutcome(r.status, r.body);
      if (outcome === 'library') return finish({ library: (r.body as PicksAnswer).song as LibrarySong });
      if (outcome === 'passthrough') return finish({ passthrough: true });
      if (outcome === 'error') {
        view = 'error';
        error = (r.body && r.body.error) || tf('pick.failed', 'The search did not work. Check your connection and try again.');
      } else {
        lookup = r.body as PicksAnswer;
        if (lookup.kind === 'playlist') {
          items = playlistItems(lookup.results);
          view = 'list';
        } else {
          single = { videos: lookup.results as PickVideo[], selected: 0 };
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
      builtAt = Date.now();
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
      $<HTMLFormElement>('form').addEventListener('submit', (e) => { e.preventDefault(); confirm(); });
      dialog.addEventListener('click', onClick);
      dialog.addEventListener('dblclick', (e) => { if ((e.target as Element).closest('.pick-option') && !(e.target as Element).closest('a')) confirm(); });
      dialog.addEventListener('change', onChange);
      dialog.addEventListener('keydown', onKeydown);
    }

    // Cancel, or back to the playlist from a swap.
    function goBack() {
      if (view === 'swap') closeSwap();
      else finish(null);
    }

    function onClick(e: MouseEvent) {
      const target = e.target as Element;
      // The second click of a double-click that opened it is not a click outside.
      if (target === dialog) { if (Date.now() - builtAt > 500) finish(null); return; }
      if (target.closest('.pick-retry')) return view === 'swap' ? openSwap(swap.pos) : load();
      if (target.closest('.pick-first')) return finish({ passthrough: true });
      if (target.closest('.pick-all')) {
        items = allChecked(items, counts(items).ticked !== items.length);
        renderList();
        renderFooter();
        $('.pick-all').focus();
        return;
      }
      const swapBtn = target.closest('.pick-swap');
      if (swapBtn) return openSwap((list as VirtualList).positionOf(swapBtn.closest('.pick-row') as HTMLElement));
      const option = target.closest<HTMLElement>('.pick-option');
      if (option && !target.closest('a')) {
        select(Number(option.dataset.pos));
        $('.pick-options').focus();
      }
    }

    // A new destination: what it already holds starts unticked (pick-rules.ts withDestination).
    async function setDestination(value: string) {
      if (!dest || !imported) return; // only an import has one (else this threw)
      const my = ++dest.seq;
      dest.value = value;
      const select = $<HTMLSelectElement>('#pick-dest');
      if (select && select.value !== value) select.value = value;
      if (value === 'new') {
        dest.state = 'ready';
        dest.keys = new Set();
      } else {
        dest.state = 'loading';
        renderDestStatus();
        renderFooter();
        let keys: Set<string> | null = null;
        try { keys = destinationKeys(await imported.loadSongs(value)); } catch { keys = null; }
        if (done || my !== dest.seq) return;
        dest.state = keys ? 'ready' : 'error';
        dest.keys = keys || new Set();
      }
      items = withDestination(items, dest.keys);
      renderDestStatus();
      if (view === 'list' && list) renderList();
      if (view === 'list') renderFooter();
    }

    function renderDestStatus() {
      const el = dialog && $('.pick-dest-status');
      if (!el || !dest) return;
      const already = items.filter((it) => it.already).length;
      let text = '';
      if (dest.state === 'loading') text = tf('pick.destChecking', 'Checking what is already in it…');
      else if (dest.state === 'error') text = tf('pick.destFailed', 'Could not check that playlist. Rows already in it may be added again.');
      else if (dest.value === 'new') text = tf('pick.destNewHint', 'A new playlist, made with your usual settings.');
      else text = already === 1 ? tf('pick.destAlreadyOne', '1 is already in it and is left unticked.')
        : already ? tf('pick.destAlready', '{count} are already in it and are left unticked.', { count: already })
        : tf('pick.destNone', 'None of these are in it yet.');
      el.textContent = text;
    }

    function onChange(e: Event) {
      const target = e.target as HTMLElement;
      if (target.id === 'pick-dest') { setDestination((target as HTMLSelectElement).value); return; }
      const box = target.closest('.pick-check');
      if (!box) return;
      const row = box.closest('.pick-row') as HTMLElement;
      const pos = (list as VirtualList).positionOf(row);
      items = toggled(items, pos);
      row.classList.toggle('pick-off', !items[pos].checked);
      renderFooter();
    }

    function onKeydown(e: KeyboardEvent) {
      const target = e.target as Element;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        goBack();
        return;
      }
      trapFocus(dialog as HTMLDivElement, e);
      if (e.key === 'Enter' && !target.closest('button, a')) {
        e.preventDefault();
        // A held Enter (the one that opened the dialog) confirms nothing.
        if (!e.repeat) confirm();
        return;
      }
      if (target.closest('.pick-options')) {
        const o = options();
        const next = moveIndex(o.selected, e.key, o.videos.length);
        if (next === null) return;
        e.preventDefault();
        select(next);
        return;
      }
      const row = target.closest<HTMLElement>('.pick-row');
      if (!row || !list) return;
      const pos = list.positionOf(row);
      if (e.key === 'ArrowRight' && !target.closest('.pick-swap')) {
        e.preventDefault();
        openSwap(pos);
        return;
      }
      const next = moveIndex(pos, e.key, items.length, list.pageSize);
      if (next === null) return;
      e.preventDefault();
      focusRow(next, target.closest('.pick-swap') ? '.pick-swap' : '.pick-check');
    }

    function focusRow(pos: number, control = '.pick-check') {
      const el = list && list.scrollToIndex(pos);
      const target = el && el.querySelector<HTMLElement>(control);
      if (target) target.focus({ preventScroll: true });
    }

    function select(pos: number) {
      const o = options();
      if (!o.videos[pos]) return;
      o.selected = pos;
      (dialog as HTMLDivElement).querySelectorAll<HTMLElement>('.pick-option').forEach((el) => {
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
        if (!ids.length || (dest && dest.state === 'loading')) return;
        if (!dest) { finish({ picks: ids }); return; }
        const target = dest.value === 'new' ? null : (imported as ImportState).destinations.find((p) => p.id === dest.value);
        // checked: what the destination holds was read, so a ticked row is wanted as it is.
        const checked = dest.state === 'ready';
        finish({ picks: ids, destination: target ? { kind: 'existing', id: target.id, name: target.name, checked } : { kind: 'new', name: (imported as ImportState).newName, checked } });
      } else if (view === 'swap' && swap.state === 'ready') {
        const v = swap.videos[swap.selected];
        if (v) items = swapped(items, swap.pos, v);
        // An import: is the new video already in the destination?
        if (v && dest) items = withDestination(items, dest.keys);
        closeSwap();
      }
    }

    // Other versions of one playlist item: searched only now, once per item.
    async function openSwap(pos: number) {
      const item = items[pos];
      if (!item) return;
      if (view === 'list') listScroll = $('.pick-scroll').scrollTop;
      const ready = (results: PickVideo[] | undefined): Swap => ({ pos, state: 'ready', ...swapChoices(item, results) });
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
      swap = null as unknown as Swap; // see its TODO type
      view = 'list';
      render();
      $('.pick-scroll').scrollTop = listScroll;
      focusRow(pos, '.pick-swap');
    }

    function optionsHtml(o: Options, label: string): string {
      return `<ul class="list-group pick-options" role="listbox" tabindex="0" aria-label="${escapeHtml(label)}" aria-describedby="pick-note" aria-activedescendant="pick-option-${o.selected}">
        ${o.videos.map((v, i) => `<li class="list-group-item pick-item pick-option" role="option" id="pick-option-${i}" data-pos="${i}" aria-selected="${i === o.selected}">
          ${videoHtml(v, true)}
          <a class="btn-text theme-secondary btn-icon btn-sm pick-open" href="${escapeHtml(watchUrl(v.youtube_id))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(tf('pick.openOnYoutube', 'Open on YouTube'))}" title="${escapeHtml(tf('pick.openOnYoutube', 'Open on YouTube'))}">${OPEN_ICON}</a>
        </li>`).join('')}
      </ul>`;
    }

    const statusHtml = (text: string): string => `<div class="app-empty pick-status" role="status">${escapeHtml(text)}</div>`;
    const errorHtml = (message: string, { first = false, retry = true }: { first?: boolean; retry?: boolean } = {}): string => `<div class="alert theme-danger fs-sm mb-3" role="alert">${escapeHtml(message)}</div>
      <div class="d-flex flex-wrap gap-2">
        ${retry ? `<button class="btn btn-sm pick-retry" type="button">${escapeHtml(tf('pick.retry', 'Try again'))}</button>` : ''}
        ${first ? `<button class="btn btn-sm pick-first" type="button">${escapeHtml(tf('pick.firstMatch', 'Take the first match without asking'))}</button>` : ''}
      </div>`;

    function rowHtml(pos: number): string {
      const it = items[pos];
      const title = it.video.title || it.video.youtube_id;
      const status = !dest || it.already ? null
        : it.video.in_library ? tf('pick.statusNow', 'In library, added now') : tf('pick.statusRequest', 'Will be requested');
      return `<li class="list-group-item pick-item pick-row${it.checked ? '' : ' pick-off'}">
        <input type="checkbox" class="check pick-check"${it.checked ? ' checked' : ''} aria-label="${escapeHtml(tf('pick.include', 'Include {title}', { title }))}">
        ${videoHtml(it.video, false, dest ? { status: status || '', already: !!it.already } : {})}
        ${isSwapped(it) ? `<span class="badge badge-subtle theme-secondary pick-badge">${escapeHtml(tf('pick.swappedBadge', 'Swapped'))}</span>` : ''}
        <button class="btn btn-sm pick-swap" type="button" aria-label="${escapeHtml(tf('pick.swapNamed', 'Swap {title} for another video', { title }))}">${escapeHtml(tf('pick.swap', 'Swap'))}</button>
      </li>`;
    }

    function renderList() {
      (list as VirtualList).setSource({
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
          body.innerHTML = statusHtml(tf('pick.noResults', 'No videos found for “{query}”. Try other words.', { query: lookup.query as string }))
            + `<div class="d-flex justify-content-center"><button class="btn btn-sm pick-first" type="button">${escapeHtml(tf('pick.anyway', 'Request it anyway'))}</button></div>`;
        } else {
          noteText = tf('pick.searchNote', 'Results for “{query}”. Pick the right version.', { query: lookup.query as string });
          body.innerHTML = optionsHtml(single, title);
        }
      } else if (view === 'list') {
        title = dest && lookup.title ? tf('pick.titleImport', 'Import “{title}”', { title: lookup.title }) : tf('pick.titlePlaylist', 'Playlist: {count} videos', { count: lookup.total as number });
        noteText = tf('pick.playlistNote', 'Untick what you do not want. Swap replaces a video with another version.')
          + ((lookup.total as number) > items.length ? ` ${tf('pick.playlistCapped', 'Only the first {shown} of {total} are listed.', { shown: items.length, total: lookup.total as number })}` : '');
        body.innerHTML = (dest ? destHtml() : '') + (items.length
          ? `<div class="d-flex align-items-center justify-content-between gap-2 mb-2">
              <span class="fs-sm fg-2 pick-count" role="status"></span>
              <button class="btn-text theme-secondary btn-sm pick-all" type="button"></button>
            </div>
            <div class="pick-scroll"><ul class="list-group pick-playlist" aria-label="${escapeHtml(title)}"></ul></div>`
          : statusHtml(tf('pick.playlistEmpty', 'No videos found in that playlist.')));
        if (items.length) {
          list = createVirtualList({ list: $('.pick-playlist'), scroller: $('.pick-scroll') });
          renderList();
        }
        if (dest) renderDestStatus();
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

    // The destination chooser at the top of an import.
    function destHtml(): string {
      if (!dest || !imported) return ''; // only an import has one (else this threw)
      const option = (value: string, label: string): string => `<option value="${escapeHtml(value)}"${dest.value === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      return `<div class="mb-4 pick-dest-field">
        <label for="pick-dest" class="form-label fw-medium">${escapeHtml(tf('pick.destLabel', 'Add to'))}</label>
        <select id="pick-dest" class="form-control" aria-describedby="pick-dest-status">
          ${option('new', tf('pick.destNew', 'New playlist named “{name}”', { name: imported.newName }))}
          ${imported.destinations.length ? `<optgroup label="${escapeHtml(tf('pick.destExisting', 'Your editable playlists'))}">${imported.destinations.map((p) => option(p.id, p.name)).join('')}</optgroup>` : ''}
        </select>
        <p id="pick-dest-status" class="fs-sm fg-3 mt-1 mb-0 pick-dest-status" aria-live="polite"></p>
      </div>`;
    }

    function renderFooter() {
      const submit = $<HTMLButtonElement>('.pick-submit');
      $('.pick-cancel').textContent = view === 'swap' ? tf('pick.back', 'Back') : tf('pick.cancel', 'Cancel');
      let label = tf('pick.download', 'Download');
      let enabled = false;
      if (view === 'single') {
        const v = single.videos[single.selected];
        enabled = !!v;
        if (v && v.in_library) label = tf('pick.useLibrary', 'Use the library song');
      } else if (view === 'list') {
        const c = counts(items);
        enabled = c.chosen > 0 && !(dest && dest.state === 'loading');
        label = dest ? importLabel(importCounts(items))
          : c.chosen === 1 ? tf('pick.downloadOne', 'Download 1 song') : tf('pick.downloadMany', 'Download {count} songs', { count: c.chosen });
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
      const target = $('.pick-options') || $('.pick-retry') || $('.pick-first') || (view === 'list' && dest ? $('#pick-dest') : null) || (view === 'list' && items.length ? null : $('.pick-cancel'));
      if (target) target.focus({ preventScroll: true });
      else focusRow(0);
    }

    load();
  });
}
