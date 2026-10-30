# listen-along design guide

The web frontend is **stock Bootstrap 6 with a dark-only theme on top**. It is not a
custom design system: reach for a Bootstrap component or utility first, and add
CSS only for what Bootstrap does not cover. The look is calm: soft dark greys (never
black), muted text, one restrained accent. There is no light mode and no colour-mode toggle.

## Files

| File | Loaded by | What it holds |
| --- | --- | --- |
| `frontend/vendor/bootstrap-6.0.0-alpha.1/css/bootstrap.min.css` (+ `.map`, `LICENSE`) | every page | Bootstrap itself, vendored (no CDN). |
| `frontend/theme.css` | every page, after Bootstrap | Palette (token overrides) and shared rules (navbar, icons, thumbs, empty states). |
| `frontend/app.css` | `index.html` only | Layout of the single-page app (views, playlist, player, library, dashboard). |

Pages: `index.html` (login, landing, playlist, profile, pending, dashboard views, the
music-library overlay and the chat-and-people panel), `admin.html`, `youtube-playlist.html`,
`changelog.html`. `admin.html`, `youtube-playlist.html` and `changelog.html` use
only Bootstrap + `theme.css`; keep it that way.

### Bootstrap version

**6.0.0-alpha.1** (the only 6.x release on npm when this was set up; `next` dist-tag).
It is a pre-release, and its API differs from Bootstrap 5:

- Buttons are `.btn-solid` / `.btn-outline` / `.btn-subtle` / `.btn-text` combined
  with a theme class (`.theme-primary`, `.theme-secondary`, `.theme-danger`,
  `.theme-success`, `.theme-warning`). Plain `.btn` is a neutral grey button.
  There is no `.btn-primary`.
- `.btn-icon` is a square icon button. Sizes: `.btn-xs`, `.btn-sm`, `.btn-lg`.
- Badges: `.badge` (+ `.badge-subtle` + theme class). Alerts: `.alert.theme-*`.
- Responsive utilities use a prefix: `sm:d-inline`, `md:d-none` (escaped `sm\:` in CSS).
- Spacing scale is finer: `1`=.25rem `2`=.375rem `3`=.5rem `4`=.75rem `5`=1rem
  `6`=1.25rem `7`=1.5rem … `12`=3rem. So `p-3` is **0.5rem**, not 1rem.
- Text colour utilities are `fg-*` (`fg-3` = muted, `fg-primary`), font sizes `fs-xs|sm|md|lg|xl|2xl…`.
- Checkbox: `<input type="checkbox" class="check">`. Select: `select.form-control` (no `.form-select`).
- Range: `<div class="form-range"><input type="range" class="form-range-input"></div>`;
  the filled track is painted from `--bs-range-fill` (0..1). `ui.js` keeps it in step
  on user input; after setting `.value` from code call `syncRangeFill(input)` from `ui.js`.
- `.card-header` is `flex-direction: column`; add `flex-row` when you `d-flex` it.
- Adjacent `.card-body` siblings get a divider line between them; use one body if you don't want it.
- Modals are `.dialog` (native `<dialog>`), offcanvas is `.drawer`. **We do not load
  Bootstrap's JS**: our overlays are plain elements (see "Overlays" below).

To upgrade: `npm pack bootstrap@<version>`, copy `dist/css/bootstrap.min.css`, its map and
`LICENSE` into a new `frontend/vendor/bootstrap-<version>/`, update the `<link>` in the four
HTML files, delete the old folder, and re-check the notes above. The version in the path busts
caches (Cloudflare rewrites cache headers, so never reuse a path for new content).

### CSS layers

Bootstrap 6 ships its CSS in cascade layers:
`colors, config, root, reboot, layout, content, forms, components, custom, helpers, utilities`.

- Token overrides (`:root { --bs-… }`) in `theme.css` are **unlayered** and win by coming after Bootstrap.
- All other rules in `theme.css` and `app.css` go inside **`@layer custom { … }`**. That beats
  Bootstrap's components regardless of specificity, but **utilities still win**, so `d-none`,
  `mb-3`, `text-truncate` on an element always work. Never write unlayered rules.
- `[hidden]` is `display: none !important` in Bootstrap's reboot layer and beats everything;
  the JS shows/hides with the `hidden` attribute, so don't fight it.

## Palette

There is one palette, dark, defined in `theme.css`. Every page sets `data-bs-theme="dark"`
statically on `<html>` (so Bootstrap's own dark tokens and `color-scheme: dark` apply with no
flash and no script), and `theme.css` overrides the tokens on top. Use the tokens, never literal
colours (two documented exceptions: the white quiet zone behind the QR code, and the placeholder
text on the black YouTube frame).

| Role | Token | Value |
| --- | --- | --- |
| Page background | `--app-page-bg` | `#232528` |
| Surface (cards, navbars, inputs, list groups) | `--bs-bg-body` | `#2c2f33` |
| Subtle fills / hover | `--bs-bg-1` … `--bs-bg-4` | `#33363a` → `#4c5056` |
| Body text | `--bs-fg-body` | `#e3e6e9` |
| Secondary text | `--bs-fg-2` | `#bfc4c9` |
| Muted text | `--bs-fg-3` | `#a1a8ae` |
| Faint (icons, timestamps) | `--bs-fg-4` | `#7f868d` |
| Borders | `--bs-border-color` | `#3f4348` |
| Accent (solid) | `--bs-primary-bg` | `#557799` |
| Accent text/links | `--bs-primary-fg` | `#9db8d6` |
| Accent tint | `--bs-primary-bg-subtle` | `#34404d` |
| Backdrop | `--app-backdrop` | near-black 55% |

The accent is a muted slate blue and is the **only** brand colour. Use it for the one primary
action in a view, the current/playing item, active toggles, links and focus rings. Neutral
actions are grey (`.btn`, `.btn-outline.theme-secondary`, `.btn-text.theme-secondary`).
Success/danger/warning are Bootstrap's own (solid fills slightly calmed) and appear only for
status: subtle badges, destructive buttons (`.btn-outline.theme-danger`), toasts.

The key idea: `--bs-bg-body` is the *surface*, not the page. Everything Bootstrap paints
"body coloured" (cards, inputs, list groups, navbars, toasts) becomes the raised grey surface,
and `body` itself sits on the slightly darker `--app-page-bg`.

Do not reintroduce a light mode, `light-dark()` pairs, `[data-bs-theme=light]` rules or a
toggle. A new page must carry `data-bs-theme="dark"` on its `<html>`.

## Typography and spacing

- Bootstrap's system font stack, 16px base. Headings in the UI are small: page titles in
  navbars are `h6`, card titles `h6`/`h5`, the landing card `h4`. No display sizes.
- Secondary information: `fs-sm` / `fs-xs` with `fg-3`. Truncate long titles with `text-truncate`
  (parent needs `min-w-0` inside flex rows).
- Spacing: Bootstrap utilities on the fine scale above. Page content uses `.container`
  (`.app-narrow` = 40rem for forms/settings; the playlist page and library use 56rem).
  Vertical rhythm between cards: `mb-4`/`mb-5` or `vstack gap-6`.
- Radii and shadows: Bootstrap defaults (buttons .5rem, cards .75rem). Shadows only on
  floating things (modals, drawer, toasts).

## Components and when to use them

| Need | Use |
| --- | --- |
| Top bar | `nav.navbar.app-navbar > .container` (brand `.app-brand` or back button + `h1.h6`, actions on the right). |
| Grouped content | `.card` with `.card-header` (h6) / `.card-body` / `.card-footer`. |
| Lists of items (songs, playlists, users, tokens) | `ul.list-group` with `li.list-group-item` (flex row: `.app-thumb`, text block `min-w-0 flex-grow-1`, actions). Clickable rows: `.list-group-item-action` + `tabindex="0"` + Enter/Space handler. Empty state: `li.list-group-item.app-empty`. |
| Song lists (playlist queue, library) | Normal vs edit mode, see "Song rows: normal and edit mode" below. |
| Playing / current row | `.is-playing` (shared) or `.queue-item.playing` (playlist): accent tint + 3px accent left edge. |
| Primary action | `.btn-solid.theme-primary` — one per view. |
| Secondary action | `.btn` (grey) or `.btn-outline.theme-secondary`. |
| Icon-only action | `.btn-text.theme-secondary.btn-icon` with `aria-label` + `title`; toggled state = `.active` (accent tint). |
| Destructive | `.btn-outline.theme-danger` (or `.btn-text.theme-danger.btn-icon` for a small ×). |
| Inputs | `.form-control` (also on `<select>`), `.input-group` to attach buttons, `.form-label` or `aria-label`. |
| Tabs | `nav.nav.nav-underline` with `button.nav-link` (`.active` for the current one). |
| Status / counts | `.badge.badge-subtle.theme-*`. |
| Pagination | `ul.pagination.pagination-sm > li.page-item > button.page-link` (`.active`, `.disabled`). |
| Progress | `.progress > .progress-bar` (inline `width`). Seek/volume: `.form-range`. |
| Notices | `.alert.theme-warning|danger|success`. |
| Toasts | `showToast(message, type)` in `ui.js` → `.toast.show` in `#toast-container` (fixed, bottom centre). |
| Overlays | `.app-modal` (fixed backdrop, toggled with `hidden`) wrapping a `.card.app-modal-card`; give it `role="dialog" aria-modal="true" aria-labelledby`. Full-screen panels (music library) are fixed layers with their own navbar. The dashboard sidebar becomes a slide-in drawer below 1024px (`.open` class). |
| Cover art | `.app-thumb` (3rem square, grey placeholder with a music-note SVG). |
| Chat / people | The one `#social-panel` (see "Chat and people panel"). Never add a second chat or people list. |
| Player | The one app-wide `#player-bar` (`section.sticky-player.player-bar` in `index.html`, outside the views): see "Player bar" below. Never add a second player or a per-page `<audio>`. |
| Context menu / small popover | `context-menu.js` (see "Context menu" below). Never a second menu implementation. |
| Icons | Inline SVG (Material paths), `fill="currentColor"`, `aria-hidden="true"`. Inside buttons they are sized automatically (1.25rem, 1rem in `.btn-sm`); elsewhere add `.icon` or `.icon-sm`. |

## Page layouts

- **Login / pending**: navbar + one centred card (`.app-center`, `.login-card` 26rem).
- **Landing**: navbar (brand, profile), narrow column: "New playlist" card
  (name input, Visibility `select.form-control` Public/Private with a one-line hint
  under it, primary "Create playlist" button, library button), then the "Playlists"
  card: a flush list group of every public playlist plus your own private ones. Each
  row: name, a subtle "Private" badge with a lock icon on private ones, then a muted
  line "by you / by <owner> / shared" (shared = ownerless legacy playlist), listener
  and song counts, age. Your own playlists get icon buttons on the right: lock/globe
  (make private / make public) and a danger trash (delete). Footer (version, language, GitHub). On load, a "Back to your last playlist?"
  prompt names the last playlist you opened (looked up first; not shown if it is gone or no
  longer visible to you).
- **Playlist** (`/playlist/<id>`; internally the "lobby" view): full-height column —
  navbar (back, name/rename, a muted line with the "Private" badge, owner and listener
  count; owner-only lock/globe visibility button, pin, share), scrolling body (56rem)
  with the queue (no tabs: who is listening and what they play is the global people
  panel, your name/avatar is on the profile page). There is no per-playlist chat; there
  is one global chat (see "Chat and people panel"). Playback is the app-wide player bar, like
  every other page. The back button only navigates; it never leaves the playlist or stops
  audio. Users who may edit the playlist (public: every signed-in user; private: its owner —
  the server sends `canEdit` with `lobby:joined`) get a grey "Edit" text button in the navbar
  (solid primary "Done" while editing) and the add-song bar; the others see neither. Queue rows
  follow "Song rows: normal and edit mode" below; there is no per-song YouTube button (the
  player keeps the source link). The "Clear queue" button shows only in edit mode.
  A playlist you cannot see (missing, deleted, someone else's private one) shows a
  "Playlist not found" toast and returns to the landing page.
- **Music library**: fixed full-screen layer over landing or a playlist: navbar (back, title, "adding
  to" context), tabs Songs/Requested/Download/Broken with count badges, search + sort toolbar, list group of
  songs (clicking / tapping the row, or Enter / Space on it, plays it — the song already playing is
  resumed, never restarted —; play button — plays in the app-wide player, shows pause on the song that is playing —, a grey
  icon button "Replace audio…" (swap arrows), Add / disabled "Added" button, ⋮ song menu), 20 per page: a compact
  "‹ Page n of m ›" pager above the list and the full numbered pagination + range below it
  (both follow `?page=`, both hidden when there is one page).
  "Replace audio…" opens an `.app-modal` card (any approved user): a one-line muted
  explanation, file input (.m4a), Title / Artist / Album prefilled from the song,
  "Source link" (a YouTube URL also sets the YouTube id), a danger alert for errors
  (e.g. "this file is already in the library as …"), footer Cancel + primary Replace
  ("Uploading…" while busy). Escape / backdrop / × close it without closing the library.
  Third tab **Download** (`jobs.js`, `?tab=downloads`; badge = your waiting + running jobs):
  a card with the Download box — text input (YouTube video / playlist link, Spotify track
  link or a search) with a one-line muted hint, "Add it to" `select.form-control` (the
  library only, or a playlist you can see; defaults to the playlist the library was opened
  from), primary "Download" button and next to it a status line with a small dot (success =
  a downloader is online, grey = none: "No downloader online — jobs wait until someone runs
  `la worker`"), a danger alert for errors — then "Your downloads": a list group of your
  jobs (Download-box jobs and the jobs of songs you requested in a playlist), newest first.
  Row: thumb, title, one `fg-2` status line ("Waiting for a downloader", "Downloading on
  living-room-pc (Ayşe) · Uploading …", "In the library: … · added to Road trip",
  "Failed: … (AGE_RESTRICTED)"), a muted origin line, a subtle status badge (warning
  waiting, primary downloading, success done, danger failed, secondary cancelled) and a
  grey Cancel (waiting) / Retry (failed, cancelled) button. Live over the socket
  (`jobs:update`, `workers:update`); a finished or failed Download-box job also toasts when
  the tab is not on screen. Song rows elsewhere in the library read "uploaded by
  <worker> (<owner>)" when a downloader uploaded them, plus "asked by <name>".
- **Profile**: navbar with back; avatar + display-name card (the only place to edit your
  name/avatar; the chat and people panel show them); connected-accounts card; Sign out.
  Approved accounts also get a "CLI tokens" card: label input + grey "Create token"
  button (the display-name Save stays the one primary), a success alert that shows a new
  token once (read-only input + Copy, a `pre` "how to use" snippet that scrolls sideways,
  Done), and a list group of active tokens (label, prefix, created, last used, danger
  Revoke). Then **Your activity** (`profile-activity.js`, approved accounts, only ever
  your own; "Only you can see this" in the header): a one-line `fg-2` summary of counts,
  underline tabs with count badges — Uploaded (also by your downloaders), Asked for (song
  requests + Download-box jobs, with status badge and "uploaded by <worker> (<owner>)"),
  My downloaders fulfilled (with "asked by"), My downloaders (name, jobs done, online /
  busy / offline badge; never host, OS or IP) — and one list group below them.
- **Social** (`/social`): on phones the chat-and-people panel as a full-screen view; on
  desktop the URL just opens the sidebar over the landing page. See below.
- **Dashboard**: navbar (hamburger below 1024px), 15rem sidebar list group, main area with
  stat cards grid, public playlists and users list groups (private playlists are only counted, never listed).
- **/admin, /youtube-playlist, /changelog**: navbar + narrow column of cards; Bootstrap and
  utilities only. `/admin` starts with **Downloaders**, then **Broken songs** (see "Context menu"), (every `la worker` ever connected:
  name · owner, host / platform / OS, IP and versions in muted lines, online / busy /
  offline badge, Refresh button — the only place machine details appear) and **Download
  jobs** (status filter select, counts in the header, rows with requester, playlist,
  worker, error code, status badge and Cancel / Retry); both refresh every 10s.

### Song rows: normal and edit mode

Song lists behave like Spotify's. **Normal mode** (always the default):

- The whole row is the play target: click / tap anywhere on it (or Enter / Space on the focused
  row, `tabindex="0"`, `.list-group-item-action`) plays the list from that song in the app-wide
  player. The row that is playing has `.playing` / `.is-playing` (+ `aria-current`); clicking it
  again resumes it if paused and never restarts it.
- Rows stay clean: thumb, title (+ broken-report icon), one muted meta line, and only the ⋮ song
  menu button on the right (the library keeps its play / replace / Add buttons). No drag handles,
  arrows, remove or play buttons. Buttons and links inside a row never trigger the row.
- Right-click / long-press / ⋮ open the song menu as always (see "Context menu").

**Edit mode** (playlist queue only; "Edit" → "Done" in the navbar, only for users who may edit;
leaving the page always ends it; `queue-edit.js`):

- Each row gets a drag handle on the left (`.queue-item-handle`, `.btn-text.theme-secondary.btn-icon.btn-sm`,
  `touch-action: none`) and a remove button on the right (`.queue-item-remove`, `.btn-text.theme-danger.btn-icon.btn-sm`,
  minus-circle). Handles and remove grow to 2.5rem on coarse pointers. The list always shows the real
  queue order (the sort select is disabled).
- Clicking a row does nothing. Drag the handle (pointer events: mouse, touch and pen alike) — the row
  lifts (`--bs-bg-2` + shadow) and the others slide out of its way; the list auto-scrolls near the
  edges; Escape cancels. Keyboard: focus the handle and press ↑ / ↓ (Alt+↑ / ↓ anywhere on the row);
  Delete removes the focused row. Focus stays on the moved row.
- Moves and removals apply at once locally and go through `queue:reorder` / `queue:remove`, so every
  viewer updates live. A removal shows a toast with an **Undo** action (6s; `showToast(msg, type,
  { action, duration })` in `ui.js`) that sends `queue:restore` — the server puts the song back where
  it was, within a minute. Prefer undo over confirm dialogs for reversible removals.

### Context menu

One reusable component, `frontend/context-menu.js` (styles: "Context menu" in `app.css`),
Bootstrap 6 `.menu` / `.menu-item` / `.menu-header` / `.menu-divider` markup, no Bootstrap JS.

- `openContextMenu({ x, y } | { anchor }, items, { label, trigger, returnFocus, focusFirst, kind })`
  opens one fixed `.menu.app-ctx-menu` (z-index `--bs-z-popover`, above the player bar and the
  library overlay) at the pointer, or under an element right-aligned; it flips and clamps to stay
  inside the viewport (8px margin). Items: `{ label, description?, icon?, theme?, disabled?, onSelect }`,
  `{ header }`, `{ divider: true }`, `{ text, muted? }`. `kind: 'popover'` renders the same box as
  `role="dialog"` for read-only details (e.g. a song's reports).
- `bindContextMenu(root, { rowSelector, triggerSelector, getItems, label })` wires a list
  (delegated, rows may re-render): right-click, a 500ms long-press on touch/pen (cancelled by
  >10px movement; swallows the click that follows), the keyboard context-menu key / Shift+F10
  on a focused row (anchored to the row), and a visible ⋮ trigger in each row
  (`.btn-text.theme-secondary.btn-icon.btn-sm`, `aria-haspopup="menu"`, `aria-expanded`).
  The browser's own menu is suppressed **only on rows**, and kept on links/inputs and with Shift held.
- ARIA and keys: `role="menu"` + `role="menuitem"` buttons; ↑/↓ (wrapping), Home/End, Enter/Space;
  Escape and Tab close and return focus to the trigger/row; outside click, any scroll, resize and
  window blur close it. Opened from the keyboard, focus goes to the first item. Coarse pointers get
  2.75rem items.
- Song rows use it through `song-reports.js` (`bindSongMenu`, `songMenuItems`): library rows,
  playlist queue rows and the player bar's current song (right-click / long-press on the song,
  plus `#player-menu-btn`, hidden in the slim phone bar where long-press is the way in). Add new
  song actions to `songMenuItems` — keep labels short ("Mark as broken", "Unmark broken").

**Broken songs ("needs replacement").** A reported song shows a small muted-warning icon button
(`.song-broken-btn`, warning triangle, `aria-label` + `title` "Needs replacement — marked as broken
by n people") right after its title in library rows, queue rows and the player bar — never a text
badge on rows. Clicking it opens the details popover (count, each reason, reporter, time). The
"Mark as broken" dialog is an `.app-modal` card: preset reason buttons (Wrong song, Bad audio,
Cut off, …; `.active` when chosen), a free-text input (max 200, counter), Cancel + primary
"Mark as broken" / "Update". The library's fourth tab **Broken** (`?tab=broken`, warning count
badge) is the Songs list filtered to reported songs with every report listed under the row; `/admin`
has a **Broken songs** card (reasons, reporters, per-report Dismiss, Dismiss all). Short labels
("Broken") are fine on tabs, cards and badges there.

### Player bar

One persistent bar, fixed to the bottom of every signed-in SPA page (landing, library
overlay, profile, dashboard, every playlist page), Spotify-style. Markup: `#player-bar` in
`index.html`; behaviour: `player.js` (the only thing that touches `<audio id="audio-player">`),
`player-bar.js` (visibility, padding, empty state, "from" line) and `playback.js` (title,
art, times, buttons).

- Listen-along strip (`#listen-strip`, `role="status"`, hidden when idle): one line in
  `fs-xs` accent text with a headphones icon above the row. Follower: "Listening along
  with Ayşe" + a `.btn-text.theme-secondary.btn-xs` "Stop listening along" (after the
  leader goes offline: "Ayşe went offline · stops after this song"). The person being
  listened to: "Ayşe and 2 others are listening along", no button. While listening
  along the second line reads "artist · Listening along with Ayşe" and the open button
  is disabled — never a playlist name (it may be private).
- Desktop row: cover + title / "artist · context" (one button that opens the context:
  the playlist page, or `/library`), repeat, shuffle, prev, play (`.btn-solid.theme-primary`
  pill), next, chat (`#social-toggle`, unread badge on its corner; toggles the sidebar on
  desktop, opens `/social` on phones), mute + volume; seek `.form-range` with times below.
- Below 768px the volume slider hides. Below 576px it is the slim form: cover, title,
  play/pause, next, chat and a thin seek line (`.player-extra` and times hidden).
- Empty state (`.is-empty`): "Nothing playing", controls disabled (Play stays enabled on
  a playlist page whose queue has songs).
- It sits above the library overlay (`--bs-z-fixed` + 1). Its measured height is
  `--app-player-height` on `body` (`.has-player-bar`), which pads `.view` and the library
  body and lifts toasts and prompts; new fixed bottom elements must use it too.
- Hidden only on the login / pending views.

### Chat and people panel

One `aside#social-panel` in `index.html`, driven by `social.js` (pure helpers in
`chat-format.js`; server in `backend/src/social.js`). It is shown by body classes,
never by `[hidden]`: `has-social` (signed in, socket up), `social-collapsed`
(desktop, remembered in localStorage), `social-route` (the `/social` URL).

- **Desktop (>= 1024px)**: fixed right sidebar, `--app-social-width` (20rem) wide, from
  the top of the page down to the player bar (`--app-player-height`). `body` gets the
  same `padding-right`, so every page (and the library overlay, via `right`) shifts left
  rather than sitting under it. Collapse with the chevron in its header; reopen with the
  chat button in the player bar. Present on every signed-in page (landing, playlist,
  library overlay, profile) and next to the pending-approval card; not on `/dashboard`.
- **Below 1024px**: hidden except on `/social`, where it covers the page above the
  player bar with a back arrow in its header (the collapse chevron is hidden).
- Header: back (phones) | underline tabs **Chat** (unread badge) and **People** (online
  count) | collapse (desktop).
- **Chat**: a scrolling list (`.chat-scroll`) of messages — avatar, bold name, faint time,
  then the text in `fg-2`, `white-space: pre-wrap`; consecutive messages from one author
  within 5 minutes drop the avatar/name. Newest 50 first; scrolling to the top loads the
  next older page (keyset cursor) and keeps the scroll position. Text is always escaped;
  http(s) URLs become links (`target=_blank`, `rel="noopener noreferrer nofollow"`).
  Composer at the bottom: `.input-group` with the input and a primary send icon button.
  Admins (admin cookie) get a small danger trash button per message (on hover; always on
  touch screens), with a confirm.
- **People**: two flush list groups under small uppercase headings, "Online — n" and
  "Offline — n". Row: round avatar (photo, emoji or initials) with a presence dot
  (success = online, grey = offline), name (+ subtle "you" / warning "pending" badges),
  and one muted line: the song playing (accent; muted with a pause icon when paused)
  "Title — Artist · context", or "Last seen 5m ago" when offline. Offline rows are
  dimmed. Anyone else online who is playing something (from any playlist or the
  library) gets a headphones icon button "Listen along with <name>" (`.person-listen`,
  `.active` + `aria-pressed` while you listen along with them or with whomever they
  listen along with; pressing it again stops). A private playlist's name is never
  shown to anyone but its owner: others see only the song.
- **Unread**: messages from others that arrive while the chat is not on screen (panel
  collapsed or hidden, People tab, or the browser tab in the background) count up on
  every `[data-social-unread]` badge (player-bar chat button, Chat tab, pending card) and
  reset when the chat is shown.

All pages must work from 320px wide with no horizontal page scroll; check 320 and 375.

## Accessibility rules

- Every icon-only button has `aria-label` (and `title` for a tooltip). Decorative SVGs get `aria-hidden="true"`.
- Focus is always visible: Bootstrap's focus ring (accent, 3px) plus a global `:focus-visible`
  outline in `theme.css`. Never remove outlines.
- Clickable non-buttons need `tabindex="0"`, a role and a keyboard handler — prefer a real `<button>`.
- Touch targets: player controls grow to 2.5rem on coarse pointers; don't go below `.btn-sm` (2rem)
  for primary touch actions.

## How to add something

**A new view in the SPA**: add a `<div id="…-view" class="view">` to `index.html` with an
`app-navbar`, a `main.app-main.container` (add `.app-narrow` for
forms), register it in `ui.js`'s `showView` and in `router.js`. Build the content from cards,
list groups and utilities. Only if something is genuinely not expressible that way, add a
small, named section to `app.css` inside `@layer custom`, using tokens only.

**A new standalone page**: copy the `<html data-bs-theme="dark">` and `<head>` of `admin.html` (Bootstrap, theme.css),
start the body with an `app-navbar`, and use only Bootstrap + `theme.css` classes. If a rule is
needed by more than one page, put it in `theme.css` (`@layer custom`).

**A new component or JS-rendered markup**: write the Bootstrap classes into the template next
to a semantic hook class the JS uses (e.g. `class="list-group-item libpage-item"`). Keep
selectors in JS on ids, `data-*` attributes and hook classes, never on Bootstrap classes, so
restyling never breaks behaviour.

**A new colour**: you probably don't need one. If you do, add a token to
`theme.css`, give it a role name (`--app-…`), and add it to the palette table above.

Before finishing: check 320px and desktop, keyboard focus, and the console.

## Android

The Android app (`android/`, Jetpack Compose) follows this guide too: same dark-only palette,
no light theme, one accent. Tokens live in `android/app/src/main/java/com/erkantaylan/listenalong/ui/theme/Theme.kt`
(`Palette`), mapped onto a Material 3 `darkColorScheme` so stock M3 components come out right.
Use `Palette.*`, never literal colours.

| CSS token | `Palette` | Material 3 role |
| --- | --- | --- |
| `--app-page-bg` `#232528` | `page` | `background`, `surfaceContainerLowest`, `surfaceDim` |
| `--bs-bg-body` `#2c2f33` | `surface` | `surface`, `surfaceContainer(Low)` |
| `--bs-bg-1` … `--bs-bg-4` | `bg1` … `bg4` | `surfaceVariant`/`surfaceContainerHigh` (bg1), `surfaceContainerHighest`/`surfaceBright` (bg2) |
| `--bs-fg-body` / `-2` / `-3` / `-4` | `fg` / `fg2` / `fg3` / `fg4` | `onSurface`/`onBackground` (fg), `onSurfaceVariant` (fg3) |
| `--bs-border-color` `#3f4348` | `border` | `outline` |
| `--bs-primary-bg` `#557799` | `accent` | `primary` (`onPrimary` = `#fff`) |
| `--bs-primary-fg` `#9db8d6` | `accentFg` | `onPrimaryContainer`, `tertiary` |
| `--bs-primary-bg-subtle` `#34404d` | `accentSubtle` | `primaryContainer` |
| `--bs-secondary-bg` / `-bg-subtle` / `-fg` | `secondary` / `secondarySubtle` / `secondaryFg` | `secondary` / `secondaryContainer` |
| `--bs-danger-bg` / `--bs-success-bg` | `dangerSolid` / `successSolid` (+ text tints `danger`, `success`) | `errorContainer` / `error` |

Components (`ui/Components.kt`) stand in for the Bootstrap ones: `AppTopBar` (navbar: back, small
title, muted subtitle, icon actions), `ListGroupItem` (list group row; `current` = `.is-playing`
accent tint + 3dp left edge), `PrimaryButton` / `SecondaryButton` / `DangerButton` / `QuietButton`,
`IconAction` (`.btn-text.btn-icon`, `active` = accent tint), `SubtleBadge` (e.g. "Private" with a
lock), `TextInput` (`.form-control`), `Alert`, `EmptyState` (`.app-empty`), `Thumb` (`.app-thumb`).
Type: the system font at 16sp body, 14sp/12sp secondary text in `fg3`, small semibold titles.
Radii 8dp (buttons, inputs) and 12dp (cards, list groups). Icons are Material paths (`ui/Icons.kt`),
tinted `fg3` by default. The player is one persistent mini bar above the tabs (cover, title,
"artist · context", previous / solid accent play pill / next, thin progress line) plus a
full-screen player; never add a second one.
