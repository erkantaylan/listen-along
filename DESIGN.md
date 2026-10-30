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
colours (one documented exception: the white quiet zone behind the QR code).

`theme.css` defines a small set of **semantic tokens** (`--app-*`) and maps Bootstrap 6's
variables (`--bs-*`) onto them, so stock components come out right without per-component CSS.
In new CSS prefer the `--app-*` name for the role you mean; `--bs-bg-1…4` / `--bs-fg-*` are fine
for hover fills and text steps.

### Tokens

Contrast is the WCAG 2.x ratio. AA needs **4.5:1** for text and **3:1** for UI parts that convey
state or identify a control (input borders, focus ring, the playing edge, icons). Borders marked
"decorative" separate things that are already distinguishable by fill or position and are not
held to 3:1.

| Role | Token | Hex | Contrast |
| --- | --- | --- | --- |
| **Elevation** (each step lighter) | | | |
| Page (behind everything) | `--app-page-bg` | `#1d1f22` | — |
| Surface: cards, navbars, list groups, chat panel | `--app-surface` = `--bs-bg-body` | `#2a2d31` | 1.19 vs page |
| Raised: card headers, player bar | `--app-raised` | `#33373c` | 1.15 vs surface |
| Overlay: menus, popovers, modals, toasts | `--app-overlay` | `#3b4046` | 1.32 vs surface |
| Input well (inputs, selects, checkboxes) | `--app-field-bg` | `#222528` | — |
| Secondary (tonal) button fill / hover | `--app-btn-tonal` / `-hover` | `#41464d` / `#4b5158` | text 7.89 |
| Hover / pressed row fill | `--bs-bg-1` / `--bs-bg-2` | `#32363b` / `#3a3e44` | — |
| Backdrop | `--app-backdrop` | `rgb(10 11 12 / .6)` | — |
| **Text** | | | |
| Primary text | `--app-text` = `--bs-fg-body` | `#e8eaed` | 11.48 surface, 13.70 page, 8.68 overlay |
| Secondary text, icon buttons | `--app-text-secondary` = `--bs-fg-2` | `#c3c8ce` | 8.22 surface |
| Muted: meta lines, hints, times | `--app-text-muted` = `--bs-fg-3` | `#a4abb3` | 5.96 surface, 5.17 raised, 4.51 overlay |
| Faint: placeholders, drag handles, disabled | `--app-text-faint` = `--bs-fg-4` | `#8f969e` | 4.63 surface, 5.53 page |
| **Borders** | | | |
| Subtle: dividers inside a component (decorative) | `--app-border-subtle` | `#3d4147` | 1.35 surface |
| Default: outline of cards, list groups, panels, navbar/player edges (decorative) | `--app-border` = `--bs-border-color` | `#50565d` | 1.86 surface, 2.23 page |
| Strong: inputs, secondary/outline buttons, pagination, overlays | `--app-border-strong` | `#737a83` | **3.19** surface, 3.55 field, 3.81 page |
| Strong, hovered | `--app-border-hover` | `#8c939c` | — |
| **Accent** (cornflower blue) | | | |
| Fill: primary buttons, playing edge, checked controls, seek fill | `--app-accent` = `--bs-primary-bg` | `#7cacee` | 5.92 surface, 7.07 page |
| Fill hovered / pressed | `--app-accent-hover` / `-pressed` | `#97bdf2` / `#6a9de3` | — |
| Text/icons on the accent fill | `--app-on-accent` = `--bs-primary-contrast` | `#0e1b2c` | 7.42 (8.98 hover, 6.23 pressed) |
| Accent text: links, playing title, toggled icons | `--app-accent-text` = `--bs-primary-fg` | `#8fbaf2` | 6.90 surface, 5.75 on tint |
| Accent text, strong (playing title) | `--app-accent-text-strong` | `#b9d3f7` | — |
| Tint: selected / playing row, toggled icon buttons | `--app-accent-subtle` | `#2b3a4f` | — |
| Accent border (toggled buttons, chosen presets) | `--app-accent-border` | `#5d84b8` | — |
| Focus ring (2px, 2px gap) | `--app-focus` | `#9cc2f5` | **7.54** surface, 9.01 page, 5.70 overlay |
| **Status** | | | |
| Danger text/icon / outline border | `--app-danger` / `--app-danger-border` | `#f2938d` / `#c06560` | 6.15 surface (4.65 overlay) / 3.47 |
| Danger fill (white text) / tint | `--app-danger-solid` / `-subtle` | `#c9443e` / `#4a2b2b` | white 4.79 / text 5.58 |
| Success text / fill (white text) / tint | `--app-success` / `-solid` / `-subtle` | `#6cc893` / `#2b7f50` / `#24402f` | 6.80 / 4.94 / 5.58 |
| Warning text / fill (dark text) / tint | `--app-warning` / `-solid` / `-subtle` | `#f0c060` / `#e5b23c` / `#47391c` | 8.18 / 8.88 / 6.64 |
| Info text / fill / tint | `--app-info` / `-solid` / `-subtle` | `#6ec6dc` / `#2b7f93` / `#1f3d45` | 7.10 / — / 5.95 |

**Why this accent.** The old slate blue (`#557799`) had so little chroma that next to the grey
UI it read as "another grey", and with white text it only just passed (4.6:1). The new accent is
a lighter, more saturated cornflower blue used *as a fill with dark text* (the Material 3 dark
pattern): the one primary button per view is now the brightest thing on screen and impossible to
confuse with a grey button, while staying a soft, cool tone that suits the grey theme. It is
still the **only** brand colour.

### Elevation and border rules

- The page is the darkest layer; things that sit *on* it are lighter, and things that float are
  lighter again: **page < surface < raised < overlay**. Never put a darker box on a lighter one,
  except input wells (`--app-field-bg`), which are deliberately sunken.
- Every card, list group, navbar edge, side panel and the player bar has a `--app-border`
  outline. Rows inside a list are divided by the same colour.
- Anything you type into or click as a secondary control gets `--app-border-strong` (3:1):
  inputs, selects, checkboxes, `.btn`, `.btn-outline.theme-secondary`, pagination.
- Overlays (`.menu`, the context menu/popover, `.app-modal-card`, toasts) use `--app-overlay`
  with a `--app-border-strong` edge and `--bs-box-shadow-lg`. Shadows only on floating things
  (and the soft one above the player bar).
- **Row states** must be distinguishable from each other: hover = grey `--bs-bg-1`, pressed =
  `--bs-bg-2`, selected / playing = `--app-accent-subtle` tint **plus** a 3px `--app-accent`
  left edge and accent title, keyboard focus = the 2px focus ring inside the row.
- Focus: every focusable thing shows a 2px `--app-focus` ring with a 2px gap
  (inset `-2px` in list rows and menu items, so it is not clipped). Never remove it.

### Button hierarchy

Four tiers, distinguishable at a glance. One primary per view; most actions are secondary or
tertiary.

| Tier | Markup | Looks like | Use for |
| --- | --- | --- | --- |
| **Primary** | `.btn-solid.theme-primary` | accent fill, dark semibold text; lightens on hover | The main action of a view or dialog: New playlist (landing), Create playlist (its dialog), Save (display name), Download, Replace, Mark as broken (in its dialog), Done (playlist edit mode), the chat send button, the player's **Play/Pause** pill (a size up, 2.75rem, 1.5rem icon). |
| **Secondary, tonal** | `.btn` | grey fill `--app-btn-tonal` + strong border | Neutral actions next to a primary or on their own: Cancel, Edit, Create token, Disconnect, Refresh, Play (admin), Retry/Cancel on jobs, preset reasons. |
| **Secondary, outline** | `.btn-outline.theme-secondary` | border only, transparent | Navigation-ish or less important neutral actions: Music library & requests, login providers, Dismiss all, library pager, round library play buttons. |
| **Tertiary / ghost** | `.btn-text.theme-secondary` (+ `.btn-icon`) | no fill, no border; `--app-text-secondary` icon; grey fill + bright icon on hover | Icon buttons: player controls (repeat, shuffle, prev, next, mute, chat), navbar back / pin / share / lock, ⋮ song menus, drag handles, collapse chevrons, small text links like "Dismiss". Toggled on = `.active`: accent tint + accent icon + accent border. |
| **Danger** | `.btn-outline.theme-danger` (text) / `.btn-text.theme-danger.btn-icon` (icon) / `.btn-solid.theme-danger` (rare: a confirm step) | red text and border / red icon; red tint on hover | Anything that deletes or revokes: Delete playlist (trash), Clear queue, remove from queue (minus), Revoke token, Sign out, Delete (dashboard), delete chat message, Reject. |
| **Success** | `.btn-subtle.theme-success` | green tint, green text | Approve (dashboard). Don't use green for ordinary confirm buttons — that's primary. |

**Disabled** buttons of every tier turn flat grey (`--bs-bg-1` fill, `--app-text-faint` label,
subtle border, 70% opacity; text buttons 55%) so they never read as clickable — e.g. the
library's "Add" when no playlist is open, the player controls when nothing is playing.

**Badges**: `.badge.badge-subtle.theme-*` = tinted fill + a matching hairline border. Neutral
(counts, "Private", "you") = `theme-secondary` (grey); "Broken", "pending", waiting jobs =
`theme-warning`; downloading / unread counts = `theme-primary`; done / approved / online =
`theme-success`; failed / rejected = `theme-danger`.

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
| Playing / current row | `.is-playing` (shared) or `.queue-item.playing` (playlist): accent tint + 3px accent left edge + accent title. |
| Buttons | See "Button hierarchy" above: primary `.btn-solid.theme-primary` (one per view), secondary `.btn` / `.btn-outline.theme-secondary`, tertiary `.btn-text.theme-secondary(.btn-icon)`, danger `.btn-outline.theme-danger` / `.btn-text.theme-danger.btn-icon`. |
| Icon-only action | `.btn-text.theme-secondary.btn-icon` with `aria-label` + `title`; toggled state = `.active` (accent tint + accent border). |
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
- **Landing** (`/`, the view after login): navbar (brand, profile), narrow column. A
  header row: `h1.h4` "Playlists" + muted tagline ("Your playlists and everyone's public
  ones.") on the left; on the right the outline secondary **"Music library & requests"**
  (folds to its icon below 480px) next to the view's one primary button **"New playlist"**
  (plus icon). Then the "Your playlists" card (every
  playlist you own, public and private) and the "Public playlists" card (other people's
  public ones and ownerless shared ones; hidden when there are none). Both are flush list
  groups, pinned first, then newest. Each row (click / Enter / Space opens `/playlist/<id>`):
  name, a subtle "Private" badge with a lock icon on private ones (the current **state**;
  public ones show no badge — never an icon of the action that would happen), then a muted line
  "by you / by <owner> / shared", song and listener counts, age. On the right: a ghost
  **quick play** icon button when the playlist has songs (shown on row hover / focus, always
  on touch; opens the playlist and starts it from the first song in the app-wide player, or
  resumes it if it is already the one playing), and a ⋮ menu (`playlist-actions.js` items in
  `context-menu.js`; also right-click / long-press on the row): Play, Copy link for everyone,
  plus — owner only — Rename (dialog), Make private / Make public (with a one-line hint) and a
  danger Delete that opens a confirm dialog (grey Cancel focused first, `.btn-solid.theme-danger`
  Delete). No playlists of your own: the "Your
  playlists" card shows an empty state ("No playlists yet", a muted hint, a grey "New
  playlist" button). Below the cards: the "Have a link?" hint. Footer (version, language, GitHub). On load, a "Back
  to your last playlist?" prompt names the last playlist you opened (looked up first; not
  shown if it is gone or no longer visible to you).
  **New playlist dialog** (`new-playlist.js`, an `.app-modal`, see "Modal dialogs"): Playlist
  name (required, 50 chars, live `n/50` counter), Visibility as two `.radio` choices with a
  one-line hint each (Public default), a danger alert for other errors, footer grey Cancel +
  primary "Create playlist" ("Creating…" while busy). Empty name or a server refusal about
  the name ("A playlist with that name already exists") shows in red under the field. On
  success it closes and the new playlist opens.
- **Playlist** (`/playlist/<id>`; internally the "lobby" view): full-height column —
  navbar (back, name, a muted line with the "Private" badge (lock + text, same as the
  landing rows; nothing for public), owner and listener count; pin, share, and the owner's
  ⋮ menu: Copy link, Rename, Make private / public, Delete), scrolling body (56rem)
  with the queue (no tabs: who is listening and what they play is the global people
  panel, your name/avatar is on the profile page). There is no per-playlist chat; there
  is one global chat (see "Chat and people panel"). Playback is the app-wide player bar, like
  every other page. The back button only navigates; it never leaves the playlist or stops
  audio. Users who may edit the playlist (public: every signed-in user; private: its owner —
  the server sends `canEdit` with `lobby:joined`) get a grey "Edit" text button in the navbar
  (solid primary "Done" while editing) and the add-song bar; the others see neither. Queue rows
  follow "Song rows: normal and edit mode" below; there is no per-song YouTube button (the
  player keeps the source link). The "Clear queue" button (danger icon button) shows only in edit mode.
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

### Modal dialogs

Every dialog (share, replace audio, mark as broken, new playlist) is the same plain markup —
no `<dialog>`, no Bootstrap JS:

```html
<div id="…-dialog" class="app-modal" role="dialog" aria-modal="true" aria-labelledby="…-title">
  <form class="card app-modal-card" novalidate>
    <div class="card-header d-flex flex-row align-items-center justify-content-between gap-2">
      <h2 id="…-title" class="h6 mb-0">Title</h2> <!-- + ghost × close button (aria-label) -->
    </div>
    <div class="card-body vstack gap-5">fields, .alert.theme-danger[hidden] for errors</div>
    <div class="card-footer d-flex justify-content-end gap-2">
      <button class="btn" type="button">Cancel</button>
      <button class="btn-solid theme-primary" type="submit">Do it</button>
    </div>
  </form>
</div>
```

Behaviour: built and appended to `body` when opened, removed when closed. Focus goes to the
first field (or the primary button); Tab / Shift+Tab stay inside (`trapFocus(dialog, event)`
from `ui.js` in the keydown handler); Escape, ×, Cancel and a backdrop click close it, and
focus returns to the button that opened it. Enter submits (it is a `<form>`). Field errors go
in red (`--app-danger`) under the field with `aria-invalid`; other errors in the alert. While
busy the primary button is disabled and says "…ing…".

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

- `openContextMenu({ x, y } | { anchor, alignLeft? }, items, { label, trigger, returnFocus, focusFirst, kind, sheet, className })`
  opens one fixed `.menu.app-ctx-menu` (z-index `--bs-z-popover`, above the player bar and the
  library overlay) at the pointer, or under an element right-aligned; it flips and clamps to stay
  inside the viewport (8px margin). Items: `{ label, description?, icon?, theme?, disabled?, onSelect }`,
  `{ header }`, `{ divider: true }`, `{ text, muted? }`. `kind: 'popover'` renders the same box as
  `role="dialog"` for details (a song's reports, a person's card); Tab cycles inside it.
  A popover item can be `{ html, onAction }` (trusted markup the caller escaped; its
  `[data-ctx-action]` buttons call `onAction` and close). `sheet: true` makes it a bottom
  sheet below 576px; `updateContextMenu(items)` re-renders the open box (live data) keeping
  focus; `returnFocus` may be a function (rows that re-render).
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
  "Offline — n". Row (Discord-like, no buttons in it): round avatar (photo, emoji or
  initials) with a presence dot (success = online, grey = offline), name (+ subtle "you" /
  warning "pending" badges), and one activity line: an animated three-bar equaliser
  (`.person-eq`, still under reduced motion) + "Title — Artist" in accent while playing,
  muted pause icon + "Paused · Title" when paused, nothing when idle, "Last seen 5m ago"
  when offline. Offline rows are dimmed.
- **Person card**: the whole row is a `role="button"` (`aria-haspopup="dialog"`); click or
  Enter / Space opens a `context-menu.js` popover (`kind: 'popover'`, `{ html }` item)
  anchored under the row — a **bottom sheet** below 576px (`sheet: true`, page dimmed).
  It shows a big avatar + presence ("Online" in green / "Last seen …"), the current song
  (cover thumbnail or a music placeholder, "Listening to" with the equaliser or "Paused",
  title, artist, "from <playlist / Music Library>" only when the viewer may see it),
  "N listening along" when they have followers (a count from `people:listeners`, no
  names), and one full-width action: primary **Listen along**, or tonal **Stop listening
  along** while you follow them (or whomever they follow). Disabled with a muted hint for
  yourself, offline / idle people and unapproved accounts. Escape closes and focus returns
  to the row; Tab stays inside; it re-renders live while open. A private playlist's name
  or id is never sent to anyone but its owner, so the card shows only the song.
- **Unread**: messages from others that arrive while the chat is not on screen (panel
  collapsed or hidden, People tab, or the browser tab in the background) count up on
  every `[data-social-unread]` badge (player-bar chat button, Chat tab, pending card) and
  reset when the chat is shown.

All pages must work from 320px wide with no horizontal page scroll; check 320 and 375.

## Accessibility rules

- Every icon-only button has `aria-label` (and `title` for a tooltip). Decorative SVGs get `aria-hidden="true"`.
- Focus is always visible: a global 2px `--app-focus` ring with a 2px gap on every focusable
  element (`theme.css`). Never remove outlines.
- Contrast: text >= 4.5:1, state-carrying UI (input borders, focus ring, playing edge, icons)
  >= 3:1 — see the token table. New colours must be added there with their ratios.
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

### Android mapping

The values below are the source of truth for `Palette` (they match `theme.css` exactly).
Hex is `0xFFRRGGBB` in Compose.

| CSS token | Hex | `Palette` | Material 3 role |
| --- | --- | --- | --- |
| `--app-page-bg` | `#1d1f22` | `page` | `background`, `surfaceContainerLowest`, `surfaceDim` |
| `--app-surface` | `#2a2d31` | `surface` | `surface`, `surfaceContainerLow`, `surfaceContainer` |
| `--app-raised` | `#33373c` | `raised` | `surfaceContainerHigh` (mini player, top-app-bar when scrolled, card headers) |
| `--app-overlay` | `#3b4046` | `overlay` | `surfaceContainerHighest`, `surfaceBright` (menus, sheets, dialogs, snackbars) |
| `--app-field-bg` | `#222528` | `field` | text field container |
| `--app-btn-tonal` / `-hover` | `#41464d` / `#4b5158` | `tonal` / `tonalHover` | `secondaryContainer` (tonal / secondary button fill) |
| `--bs-bg-1` / `--bs-bg-2` | `#32363b` / `#3a3e44` | `hover` / `pressed` | row hover / pressed (ripple base) |
| `--bs-bg-3` / `--bs-bg-4` | `#444950` / `#52575e` | `bg3` / `bg4` | neutral badge fill / its border |
| `--app-text` | `#e8eaed` | `fg` | `onSurface`, `onBackground`, `onSecondaryContainer` |
| `--app-text-secondary` | `#c3c8ce` | `fg2` | icon tint for `IconAction` |
| `--app-text-muted` | `#a4abb3` | `fg3` | `onSurfaceVariant` |
| `--app-text-faint` | `#8f969e` | `fg4` | placeholders, drag handles, disabled content |
| `--app-border-subtle` | `#3d4147` | `borderSubtle` | `outlineVariant` (dividers) |
| `--app-border` | `#50565d` | `border` | card / list outlines |
| `--app-border-strong` | `#737a83` | `borderStrong` | `outline` (text fields, outlined buttons) |
| `--app-accent` | `#7cacee` | `accent` | `primary` |
| `--app-accent-hover` / `-pressed` | `#97bdf2` / `#6a9de3` | `accentHover` / `accentPressed` | — |
| `--app-on-accent` | `#0e1b2c` | `onAccent` | `onPrimary` (**dark**, no longer white) |
| `--app-accent-text` | `#8fbaf2` | `accentFg` | `onPrimaryContainer`, `tertiary`, links |
| `--app-accent-text-strong` | `#b9d3f7` | `accentFgStrong` | playing title |
| `--app-accent-subtle` | `#2b3a4f` | `accentSubtle` | `primaryContainer` (playing row, toggled icons) |
| `--app-accent-border` | `#5d84b8` | `accentBorder` | toggled icon / chosen chip border |
| `--app-focus` | `#9cc2f5` | `focus` | focus indication |
| `--app-danger` / `-solid` / `-subtle` / `-border` | `#f2938d` / `#c9443e` / `#4a2b2b` / `#c06560` | `danger` / `dangerSolid` / `dangerSubtle` / `dangerBorder` | `error` (`#f2938d`), `onError` `#ffffff` on `dangerSolid`, `errorContainer` (`#4a2b2b`), `onErrorContainer` (`#f2938d`) |
| `--app-success` / `-solid` / `-subtle` / `-border` | `#6cc893` / `#2b7f50` / `#24402f` / `#4f9a6f` | `success` / `successSolid` / `successSubtle` / `successBorder` | — |
| `--app-warning` / `-solid` / `-subtle` / `-border` | `#f0c060` / `#e5b23c` / `#47391c` / `#a8873a` | `warning` / `warningSolid` / `warningSubtle` / `warningBorder` | dark text (`#0e1b2c`) on `warningSolid` |
| `--app-info` / `-solid` / `-subtle` / `-border` | `#6ec6dc` / `#2b7f93` / `#1f3d45` / `#4b98ab` | `info` / `infoSolid` / `infoSubtle` / `infoBorder` | — |

Buttons on Android follow the same hierarchy: `PrimaryButton` = filled `accent` with `onAccent`
text, semibold; `SecondaryButton` = `tonal` fill + 1dp `borderStrong` outline (or an
`OutlinedButton` with `borderStrong` for the outline variant); `QuietButton` / `IconAction` =
no container, `fg2` content, `pressed` fill on press; `DangerButton` = `danger` text + 1dp
`dangerBorder` outline (icon-only: `danger` tint). Disabled: `hover` fill, `fg4` content, 70%
alpha. Cards and list groups get a 1dp `border` outline; text fields a 1dp `borderStrong`
outline on `field`, `accent` 2dp when focused. Menus, sheets and dialogs use `overlay` with a
1dp `borderStrong` edge. Playing row = `accentSubtle` + 3dp `accent` left edge + `accentFgStrong`
title; hover/pressed rows use `hover` / `pressed`.

Components (`ui/Components.kt`) stand in for the Bootstrap ones: `AppTopBar` (navbar: back, small
title, muted subtitle, icon actions), `ListGroupItem` (list group row; each row draws its slice of
the group's 1dp `border` outline; pressed = `pressed` fill, `current` = `.is-playing` accent tint +
3dp left edge, `lifted` = the row being dragged), `PrimaryButton` / `SecondaryButton` (`outlined`
variant) / `DangerButton` (`solid` only as a destructive dialog's confirm) / `QuietButton`, all with
`compact` for top bars and dialogs, `IconAction` (`.btn-text.btn-icon`, `active` = accent tint +
accent border), `SubtleBadge` (`tone`: NEUTRAL "Private" / counts, ACCENT, WARNING "Broken" count,
SUCCESS "On device", DANGER), `TextInput` (`.form-control`), `Alert` (tinted fill + matching border),
`EmptyState` (`.app-empty`), `Thumb` (`.app-thumb`), and for overlays `AppDropdownMenu`,
`Modifier.dialogEdge()`, `DialogConfirm` (primary, or solid danger) / `DialogDismiss` (secondary).
Dialog actions are real buttons (Cancel secondary + one primary), not M3's text buttons.
There is no hover on touch: pressed uses `accentPressed` (primary, play pill), `tonalHover` +
`borderHover` (secondary), `dangerSubtle` (danger), `pressed` (icon buttons, rows); the focus ring is left to the platform (Compose draws no ring by default).
Type: the system font at 16sp body, 14sp/12sp secondary text in `fg3`, small semibold titles.
Radii 8dp (buttons, inputs) and 12dp (cards, list groups). Icons are Material paths (`ui/Icons.kt`),
tinted `fg3` by default. The player is one persistent mini bar above the tabs (cover, title,
"artist · context", previous / solid accent play pill / next, thin progress line) plus a
full-screen player; never add a second one.

Song menus: ⋮ on a row opens a `DropdownMenu`; a long-press on the row (or on the full player's
cover/title) opens the same items in a `ModalBottomSheet` (`SongActionsSheet`), headed by the song's
title and artist. A song marked as broken shows `ReportIcon` (warning glyph in
`Palette.warning`, a real button with a TalkBack label) right after its title. Playlist edit mode
swaps the top bar's "Edit" for "Done" and gives rows a drag handle and a danger-tinted remove
button; removals confirm with an Undo `Snackbar` (`overlay`, accent action) rather than a dialog.
