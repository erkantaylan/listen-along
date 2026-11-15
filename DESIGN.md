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
music-library overlay and the chat-and-people panel) and `changelog.html`, which uses
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
  the filled track is painted from `--bs-range-fill` (0..1). `ui.ts` keeps it in step
  on user input; after setting `.value` from code call `syncRangeFill(input)` from `ui.ts`.
- `.card-header` is `flex-direction: column`; add `flex-row` when you `d-flex` it.
- Adjacent `.card-body` siblings get a divider line between them; use one body if you don't want it.
- Modals are `.dialog` (native `<dialog>`), offcanvas is `.drawer`. **We do not load
  Bootstrap's JS**: our overlays are plain elements (see "Overlays" below).

To upgrade: `npm pack bootstrap@<version>`, copy `dist/css/bootstrap.min.css`, its map and
`LICENSE` into a new `frontend/vendor/bootstrap-<version>/`, update the `<link>` in the three
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
state or identify a control (input borders, focus ring, icons). Borders marked
"decorative" separate things that are already distinguishable by fill or position and are not
held to 3:1.

| Role | Token | Hex | Contrast |
| --- | --- | --- | --- |
| **Elevation** (each step lighter) | | | |
| Page (behind everything) | `--app-page-bg` | `#1d1f22` | — |
| Surface: cards, navbars, list groups, playlists sidebar, chat panel | `--app-surface` = `--bs-bg-body` | `#2a2d31` | 1.19 vs page |
| Raised: card headers, player bar | `--app-raised` | `#33373c` | 1.15 vs surface |
| Overlay: menus, popovers, modals, toasts | `--app-overlay` | `#3b4046` | 1.32 vs surface |
| Input well (inputs, selects, checkboxes) | `--app-field-bg` | `#222528` | — |
| Secondary (tonal) button fill / hover | `--app-btn-tonal` / `-hover` | `#41464d` / `#4b5158` | text 7.89 |
| Hover / pressed fill (rows, tiles, cards, places, tabs) | `--app-hover` = `--bs-bg-1` / `--app-pressed` = `--bs-bg-2` | `#32363b` / `#3a3e44` | — |
| Tonal button pressed; outline and ghost pressed | `--bs-bg-3` | `#444950` | text 7.53 |
| Danger button pressed | `--bs-danger-bg-muted` | `#5c3131` | text 6.50 |
| Backdrop | `--app-backdrop` | `rgb(10 11 12 / .6)` | — |
| **Text** | | | |
| Primary text | `--app-text` = `--bs-fg-body` | `#e8eaed` | 11.48 surface, 13.70 page, 8.68 overlay |
| Secondary text, icon buttons | `--app-text-secondary` = `--bs-fg-2` | `#c3c8ce` | 8.22 surface |
| Muted: meta lines, hints, times | `--app-text-muted` = `--bs-fg-3` | `#a4abb3` | 5.96 surface, 5.17 raised, 4.51 overlay |
| Faint: placeholders, drag handles, disabled; not for text on raised or overlay surfaces (use muted) | `--app-text-faint` = `--bs-fg-4` | `#8f969e` | 4.63 surface, 5.53 page, 4.01 raised, 3.50 overlay |
| **Borders** | | | |
| Subtle: dividers inside a component (decorative) | `--app-border-subtle` | `#3d4147` | 1.35 surface |
| Default: outline of cards, list groups, panels, navbar/player edges (decorative) | `--app-border` = `--bs-border-color` | `#50565d` | 1.86 surface, 2.23 page |
| Strong: inputs, secondary/outline buttons, pagination, overlays | `--app-border-strong` | `#737a83` | **3.19** surface, 3.55 field, 3.81 page, 2.41 overlay (its own edge is decorative) |
| Strong, hovered; radios (they sit on overlays in dialogs) | `--app-border-hover` | `#8c939c` | 4.46 surface, **3.37** overlay |
| **Accent** (cornflower blue) | | | |
| Fill: primary buttons, current rail avatar, checked controls, seek fill | `--app-accent` = `--bs-primary-bg` | `#7cacee` | 5.92 surface, 7.07 page |
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
| **Placeholder covers** (a playlist's initials; `.cover-1`…`.cover-6`, picked by `playlistCoverIndex(id)` in `playlist-filter.ts`) | | | |
| Cover colours 1–6 | `--app-cover-1` … `--app-cover-6` | `#49699a` `#795b9a` `#34716e` `#895e41` `#8a4d6b` `#4e713f` | `--app-text` on each >= 4.61 (4.62 / 4.61 / 4.67 / 4.66 / 5.19 / 4.64); decorative against the surface |
| Radio / library / Artists tiles | gradients of two cover colours (`.cover-radio`, `.cover-library`, `.cover-artists`) | — | icon only |
| **Shell** | | | |
| Gap between and around the shell's panels | `--app-gap` | 0.5rem (0.375rem below 768px) | — |
| Corner of a shell panel, tile shelf card, social card | `--app-panel-radius` | 0.75rem | — |

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
- The **shell's panels** (the sidebar's two panels, the page, the chat column's cards, the player bar, the
  rails) have **no outline**: they are surface (`--app-raised` for the player bar) on the page colour, told
  apart by the `--app-gap` between them, with `--app-panel-radius` corners. Everything inside a page keeps the
  rule below.
- Every card, list group and song table inside a page has a `--app-border`
  outline. Rows inside a list are divided by the same colour (not in the sidebar, the landing tiles or the chat
  column's lists, which are separate rounded rows).
- Anything you type into or click as a secondary control gets `--app-border-strong` (3:1):
  inputs, selects, checkboxes, `.btn`, `.btn-outline.theme-secondary`, pagination.
- Overlays (`.menu`, the context menu/popover, `.app-modal-card`, toasts) use `--app-overlay`
  with a `--app-border-strong` edge and `--bs-box-shadow-lg`. Shadows only on floating things
  (and the soft one above the player bar).
- **Row states** must be distinguishable from each other: hover = grey `--bs-bg-1`, pressed =
  `--bs-bg-2`, selected / playing = `--app-accent-subtle` tint and a semibold
  `--app-accent-text-strong` title (the tint alone is only 1.2:1 against the surface; the title's colour and
  weight carry the state too), keyboard focus = the 2px focus ring inside the row.
- **No accent edges, anywhere.** Never mark or decorate anything with a coloured or thicker bar on one side:
  not for selected, current, playing, pinned, hover or status, not on cards, rows, callouts, toasts, panels, tables
  or menus, and not by way of `border-left`, an inset `box-shadow`, a `::before` bar, an outline trick or a gradient.
  **Selection is a background tint**; status is a tinted fill. Allowed: uniform full outlines, the plain dividers
  between rows and panels, and the focus ring. Tabs are a segmented control (below), the current one a tint, never an underline.
- Focus: every focusable thing shows a 2px `--app-focus` ring with a 2px gap
  (inset `-2px` in list rows and menu items, so it is not clipped). Never remove it.

### Button hierarchy

Four tiers, distinguishable at a glance. One primary per view; most actions are secondary or
tertiary.

| Tier | Markup | Looks like | Use for |
| --- | --- | --- | --- |
| **Primary** | `.btn-solid.theme-primary` | accent fill, dark semibold text; lightens on hover | The main action of a view or dialog: New playlist (landing), Create playlist (its dialog), Save (display name), Download, Replace, Mark as broken (in its dialog), Done (playlist edit mode), the chat send button, the player's **Play/Pause** pill (a size up, 2.75rem, 1.5rem icon). |
| **Secondary, tonal** | `.btn` | grey fill `--app-btn-tonal` + strong border | Neutral actions next to a primary or on their own: Cancel, Edit, Create token, Refresh, Play (dashboard), Retry/Cancel on jobs, preset reasons. |
| **Secondary, outline** | `.btn-outline.theme-secondary` | border only, transparent | Navigation-ish or less important neutral actions: Library & Downloads, Dismiss all, library pager, round library play buttons. |
| **Tertiary / ghost** | `.btn-text.theme-secondary` (+ `.btn-icon`) | no fill, no border; `--app-text-secondary` icon; grey fill + bright icon on hover | Icon buttons: player controls (repeat, shuffle, prev, next, mute, chat), navbar back / pin / share / lock, ⋮ song menus, drag handles, collapse chevrons, small text links like "Dismiss". Toggled on = `.active`: accent tint + accent icon + accent border. |
| **Danger** | `.btn-outline.theme-danger` (text) / `.btn-text.theme-danger.btn-icon` (icon) / `.btn-solid.theme-danger` (rare: a confirm step) | red text and border / red icon; red tint on hover | Anything that deletes or revokes: Delete playlist (trash), Clear queue, remove from queue (minus), Revoke token, Sign out, Delete (dashboard), delete chat message, Reject. |
| **Success** | `.btn-subtle.theme-success` | green tint, green text | Approve (dashboard). Don't use green for ordinary confirm buttons — that's primary. |

**Pressed** buttons change from their hover colour: primary `--app-accent-pressed`, tonal, outline and ghost `--bs-bg-3` (player controls `--bs-bg-4`), danger `--bs-danger-bg-muted`. Bootstrap paints a pressed button only with `.active`, so `theme.css` also sets the `--bs-btn-hover-*` variables under `:active`; a new tier needs the same.

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
  (`.app-narrow` = 40rem for forms/settings; the playlist page and the library take the whole column, the library's
  search box (36rem), hints (48rem) and Download form (40rem) keeping a readable measure, left-aligned; the search page 56rem).
  Vertical rhythm between cards: `mb-4`/`mb-5` or `vstack gap-6`.
- Radii and shadows: Bootstrap defaults (buttons .5rem, cards .75rem). Shadows only on
  floating things (modals, drawer, toasts).

## Components and when to use them

| Need | Use |
| --- | --- |
| Top bar | `nav.navbar.app-navbar > .container` (brand `.app-brand` or back button + `h1.h6`, actions on the right). In the signed-in app it is the page panel's head: same surface, no rule under it, the title a size up (`--bs-font-size-lg`). Not to be confused with the shell's top bar above the page panel, which holds only the search field (see "App shell"). |
| Version, Android app, changelog, GitHub | One place only: the About card at the bottom of the profile page (`#profile-about`). Android app is an in-app link to `/app`; the others open a new tab so playback continues; `setupAppMeta()` in `ui.ts` fills the version from `/api/version` and leaves it hidden on failure. Never in a navbar. |
| Grouped content | `.card` with `.card-header` (h6) / `.card-body` / `.card-footer`. |
| Lists of items (songs, playlists, users, tokens) | `ul.list-group` with `li.list-group-item` (flex row: `.app-thumb`, text block `min-w-0 flex-grow-1`, actions). Clickable rows: `.list-group-item-action` + `tabindex="0"` + Enter/Space handler. Empty state: `li.list-group-item.app-empty`. |
| Song lists (playlist queue, library) | Normal vs edit mode, see "Song rows: normal and edit mode" below. |
| Playing / current row | `.is-playing` (shared) or `.queue-item.playing` (playlist): accent tint + accent semibold title, no edge. |
| Buttons | See "Button hierarchy" above: primary `.btn-solid.theme-primary` (one per view), secondary `.btn` / `.btn-outline.theme-secondary`, tertiary `.btn-text.theme-secondary(.btn-icon)`, danger `.btn-outline.theme-danger` / `.btn-text.theme-danger.btn-icon`. |
| Icon-only action | `.btn-text.theme-secondary.btn-icon` with `aria-label` + `title`; toggled state = `.active` (accent tint + accent border). |
| Inputs | `.form-control` (also on `<select>`), `.input-group` to attach buttons, `.form-label` or `aria-label`. |
| Tabs | Views that exclude each other (a real filter you could combine would be chips, not tabs): a segmented control, `.app-seg` (`theme.css`) holding plain `button`s, the current one `.active` (or `aria-pressed="true"` where it is a pressed button). One `--app-border-strong` outline with `--bs-radius-5` corners; the buttons touch, a 1px divider of the same colour between them; 32px tall (40px on touch), `fs-sm`, `--app-text-secondary`. Hover = `--app-hover`, pressed = `--app-pressed`, current = `--app-accent-subtle` tint + semibold `--app-accent-text-strong` text, no outline or bar of its own. Too wide for its column, it scrolls sideways inside its outline (hidden scrollbar), and the focus ring is inset (-2px) so that never clips it; in a page column under 30rem the buttons are tighter (`app.css`). `.app-seg-fill` = equal buttons across the whole width, `fs-xs`, a label may wrap to two lines and no button gets narrower than its longest word (the sidebar's filter). Never an underline, never separate pills. |
| Status / counts | `.badge.badge-subtle.theme-*`. The stats strip (`.playlist-stats`, Radio and the artist pages) is a row of neutral pills; the playlist page folds the same facts into its header's muted line. |
| Playlist cover | `.playlist-avatar.cover-N` (2.5rem rounded square of initials, `playlistInitials` + `playlistCoverIndex`): sidebar rows and rail, landing tiles and cards, the playlist page's head. Never an image. |
| Pagination | `ul.pagination.pagination-sm > li.page-item > button.page-link` (`.active`, `.disabled`). |
| Progress | `.progress > .progress-bar` (inline `width`). Seek/volume: `.form-range`. |
| Notices | `.alert.theme-warning|danger|success`. |
| Toasts | `showToast(message, type)` in `ui.ts` → `.toast.show` in `#toast-container` (fixed, bottom centre). Success and error are a tinted fill (`--app-success-subtle`, `--app-danger-subtle`). |
| Overlays | `.app-modal` (fixed backdrop, toggled with `hidden`) wrapping a `.card.app-modal-card`; give it `role="dialog" aria-modal="true" aria-labelledby`. Full-screen panels (music library) are fixed layers with their own navbar. The dashboard sidebar becomes a slide-in drawer below 1024px (`.open` class). |
| Cover art | `.app-thumb` (3rem square, grey placeholder with a music-note SVG). |
| Playlist navigation | The one `#app-sidebar` (see "Playlists sidebar"). Never add a second playlist nav. Its places (Home, Radio, Artists, Music library) are the app's main navigation; the landing tiles are shortcuts to the same. |
| Chat / people | The one `#social-panel` (see "Chat and people panel"). Never add a second chat or people list. |
| Radio | The one `#plnav-radio` row and `#radio-view` (see "Radio"). A future station is another rule in `stations.js`, not another page. |
| Artists | The landing shelf `#artists-section`, `#artists-view` (`/artists`) and `#artist-view` (`/artist/<key>`), see "Artists". Cards are `.artist-card` (`artists.js` `cardHtml`); never a second artist list. |
| Player | The one app-wide `#player-bar` (`section.sticky-player.player-bar` in `index.html`, outside the views): see "Player bar" below. Never add a second player or a per-page `<audio>`. |
| Context menu / small popover | `context-menu.ts` (see "Context menu" below). Never a second menu implementation. |
| Search | The one global field `#app-search`, in the shell's top bar, and the search page (see "Search" below). Never a second search field for the whole app (the sidebar's playlist filter, the library's, the playlist's and the artists' boxes filter their own lists). |
| Icons | Inline SVG (Material paths), `fill="currentColor"`, `aria-hidden="true"`. Inside buttons they are sized automatically (1.25rem, 1rem in `.btn-sm`); elsewhere add `.icon` or `.icon-sm`. |

## Page layouts

### App shell

The signed-in app (`body.has-plnav`) is a set of rounded panels floating on the page colour, Spotify-style:
the sidebar's two panels on the left, the page in the middle, the chat column's cards on the right, the player
bar across the bottom; on phones the sidebar is a drawer and a row of places is a panel above the page.
`--app-gap` (8px, 6px on phones) sits between them and around the window's edge; corners
are `--app-panel-radius`; no panel has an outline (see "Elevation and border rules").

- **The side columns are full height**, as Spotify's side panels are: the sidebar's two panels and the chat column (or
  its rail) always start a gap below the window's top and end a gap above the player bar, whatever the top bar does.
- **The top bar** (`form#app-search`, `body.has-topbar`, "Top bar" in `app.css`): from 768px a row at the top of the
  **page column** only, holding only the global search field, centred in the **page column** (not in the window any more:
  the side columns run past it to the top), 32rem at most. It spans exactly the page column (fixed, `left` =
  `--app-sidebar-width`, `right` = `--app-social-inset`, so it follows the rail, a dragged width and the chat opening or
  closing) with a gap inside on each side, as the page panel has, so the field's centre is the page panel's centre. It sits
  on the page colour, a gap from the window's top and a gap above the page panel, with no card, rule or shadow; the page
  panel and the library overlay start under it, at `--app-top` (a gap, plus the bar's 2.5rem and a gap when it is shown),
  and `--app-view-height` takes it off. It is fixed: it never scrolls and is never moved into a page. Nothing else goes in
  it (brand, GitHub, profile and the collapse toggle stay in the sidebar's top panel), so the field cannot collide with
  anything; at 768px with the rail it still has 84px either side, and in a page column narrower than the field it
  narrows with it. It is shown on the signed-in pages that have the
  search (Home, playlist, Radio, artists, an artist, search, profile, `/app`, and the library overlay); login, pending and
  `/dashboard` have no bar and no gap (`--app-top` stays one gap). The full-screen `/social` below 1010px covers it. Below
  768px it is only on the search page, a sticky row between the row of places and the page panel (`--app-topbar-room`).
  Layout is by position, not a grid: the DOM order is unchanged (the row of places, the field, the views, the sidebar,
  the chat column, the player bar), so in the tab order the field comes before the page.
- The columns are where "Columns and breakpoints" puts them: `--app-sidebar-width` and `--app-social-inset` are
  whole columns, each holding its panel and the gap at the window's edge; the page panel has a gap on both sides.
  So the page panel is 16px narrower than the page column in the table, and `@container page` rules see that.
- Every view is the page panel (`.view` gets the surface, the gap and the radius). Its `app-navbar` is the
  panel's head. With a mouse the panel scrolls inside, as the page column did; touch keeps document scrolling,
  with `body` padded by `--app-player-height`.
- The player bar floats a gap above the window's bottom (or the safe area). `--app-player-height` is the room it
  takes, both gaps included (`player-bar.ts` adds its `bottom` and its `margin-top`), so every column and overlay
  that stops at `--app-player-height` stops a gap above it. With no player bar (pending) they stop a gap above the
  window's edge.
- The music library overlay (`.library-page`) is a panel in exactly the page panel's place.
- Login, pending and `/dashboard` keep their full-page layouts; the chat column and the player bar float there too.

### Columns and breakpoints

Automatic widths, with nobody having touched the sidebar's toggle or dragged a column (L = sidebar, R = chat or its rail):

| Viewport | Chat open: L / page / R | Chat closed: L / page / R |
| --- | --- | --- |
| < 768px | drawer + the row of places / full width / only on `/social`, full-screen | same |
| 768–1009px | 72 / width − 72 / only on `/social`, full-screen, covering the sidebar too | same |
| 1010–1100px | 72 / width − 352 / 280 docked | 72 / width − 128 / 56 rail |
| 1101–1159px | **72** / width − 352 / 280 docked | 264 / width − 320 / 56 rail |
| 1160–1199px | 264 / width − 544 / 280 docked | 264 / width − 320 / 56 rail |
| 1200–1439px | 264 / width − 584 / 320 docked | 264 / width − 320 / 56 rail |
| >= 1440px | 304 / width − 624 / 320 docked | 304 / width − 360 / 56 rail |

- **The library collapses first, the chat stays docked.** Modelled on Spotify's layout (the main column has a
  floor and the right panel never overlays). `sidebarRail()` in `layout-rules.ts` is the one rule: automatically,
  the sidebar is a rail up to 1100px (`RAIL_MAX`, as the layout mockup has it), and above that whenever
  expanding it would leave the page column under 616px. So with the chat closed it is a rail at 768–1100px and
  expanded from 1101px; with the chat docked (from 1010px) a rail at 1010–1159px and expanded from 1160px:
  the docked range is the wider one, never the narrower. Opening or closing the chat between 1101 and 1159px
  changes the sidebar too.
- The user's toggle wins (`listen-sidebarMode` in localStorage: `rail`, `expanded`, absent = automatic) at every
  width from 768px. The floor holds by construction: an expanded sidebar with the chat docked leaves 466px at 1010px,
  the narrowest case, and 504px at 768px with no chat. The page column is never under 416px from 768px up.
- **Dragged widths** (`panel-widths.ts` applies, `resolveColumns()` in `layout-rules.ts` decides). The sidebar
  takes 200–420px, or 72 as the rail; the chat 280–420px. Only a width the user dragged or stepped is stored
  (`listen-sidebarWidth`, `listen-chatWidth`), never one a small window squeezed: the result of `resolveColumns()`
  is applied and the wish stays, so it returns when there is room. Without storage it all works for the session.
  - The page column's floor is 416px (`MAIN_FLOOR`). The chat gives way only once a chosen sidebar is down to 200.
  - Automatic sidebar: the rail up to 1100px whatever was dragged; above that it keeps the page at 616. A dragged
    one shrinks to that, down to 200, then becomes the rail; one never dragged is still 264 or the rail, so the
    table above stays exact. A chat dragged wide counts as its
    real width in that sum, so it can rail the library, live during the drag.
  - Dragging the sidebar below 200 snaps to the rail and sets `rail`, like the toggle; its width stays for the next
    expand. Dragging out of the rail, or past the automatic 616, sets `expanded`, so the floor becomes 416.
  - Double-click, double-tap or Enter resets: for the sidebar the width and the toggle's choice, as if never touched.
    Escape cancels a drag. A click or a drag that ends where it began stores nothing.
- The chat panel docks from 1010px (`DOCK_MIN`). Below that it never sits beside the page, whatever the user
  chose: the chat button opens the full-screen `/social` and closes it again, and a remembered open or closed
  choice applies again from 1010px. From 1010px the right rail is on screen whenever the column is not, so chat
  and people are never hidden behind one icon.
- Rules about what fits in the page column use `@container page (…)`: `#landing-view`, `#lobby-view`,
  `#profile-view`, `#search-view` and `.library-page` are size containers, so a rule such as `width < 576px` fires
  in a column of 504px at 768px. `@media (width …)` is for what follows the viewport (the two columns, the
  player bar's slim form).
- The 19rem step still takes 39px at 1440px with the chat open (855px at 1439px, 816px at 1440px), at a width where that
  does no harm; it used to fall on 1280px. The automatic steps: at 1101px with the chat closed the column drops
  from 972px to 781px, at 1160px with it docked from 807px to 616px.
- With a mouse (`pointer: fine`) the page column scrolls, not the document, so the chat panel and the player
  bar never move and no scrollbar sits beyond them. The column's own scrollbar takes 15px from it when
  the page overflows. Touch keeps document scrolling. Bootstrap's `scrollbar-gutter: stable` is overridden
  (`theme.css`).
- The narrowest page columns beside a sidebar: 616px automatically (1160 and 1200px with the chat docked),
  466px with the sidebar kept expanded at 1010px, 504px kept expanded at 768px. Check new page content there,
  not only on phones.
- The player bar always spans the full viewport, and its centre zone is centred on the viewport, not
  on the page column. Login and the standalone pages have neither column; pending has only the chat panel;
  `/dashboard` has its own section list and, for someone also signed in to the app, the chat panel.

- **Column drag handles** (`.panel-resizer`, `#plnav-resizer`, `#social-resizer`): only where a column sits beside the
  page, so from 768px for the sidebar and on the docked panel from 1010px; never on the phone drawer or the full-screen
  `/social`. `/dashboard` has its own section list and no sidebar handle, but its chat panel is the same panel with the
  same saved width. They fill the `--app-gap` between the two panels (12px with a coarse pointer), full column height.
  Nothing shows at rest; on hover, focus or drag a 1px `--app-border-hover` line appears in the middle of the gap with
  a short 4px grip at its middle, neutral, never an accent edge. Pointer events with capture, one update per animation frame through `--app-sidebar-width` and
  `--app-social-width`, so `@container page` rules respond during the drag. `role="separator"`,
  `aria-orientation="vertical"`, `aria-valuenow/min/max` in pixels (the max is what fits now); the arrows move the
  divider 16px, Home and End go to the smallest and largest, Enter resets.

- **Login / pending**: navbar + one centred card (`.app-center`, `.login-card` 26rem).
  A single primary **Sign in** (`#central-login-btn`, `.btn-solid.theme-primary.btn-lg.w-100`,
  `login.signIn`), the view's one main action, and nothing else to choose: it goes to the central
  login, or on a development server (`/api/auth/providers` says `dev`) to the dev sign-in, with a
  muted `fs-sm` line under it, `#login-dev-note` (`login.devNote`). There are no provider buttons
  (Google / GitHub sign-in is gone). Above the button, `#login-error` (`.alert`, full outline, never an edge)
  explains why a sign-in came back (`/login?error=<code>`, a fixed sentence per code, en + tr in
  `login.error.*`): `theme-danger` for "Your account has been disabled", "Sign-in did not
  work" and "could not be linked ... contact the administrator", `theme-warning` for "Registrations are closed" and "cannot be reached right now".
  The profile page has no "Connected accounts" card.
- **Dashboard → Users, Allow new accounts**: a `.card.card-body` above the counts holding one
  `.form-field` with a Bootstrap `.switch` (`role="switch"`), its label (`fw-medium`) and a
  muted `fs-sm` hint; a second muted line says when the value is the server's
  `REGISTRATIONS_DEFAULT` (not saved yet). Toggling saves at once and toasts; a failed save puts the switch back.
- **Landing** ("Home", `/`, the view after login; `lobby.js`). From 768px it has no top bar (the sidebar carries
  the brand and the profile); below 768px a navbar (☰, brand, profile; the brand folds to its icon below 400px)
  under the row of places (see "Playlists sidebar").
  A header row: `h1.h4` "Playlists" + muted tagline ("Your playlists and everyone's public ones.") on the left;
  on the right the outline secondary **"Library & Downloads"** (folds to its icon when the page column is
  below 34rem; the actions wrap under the title rather than squeeze it) next to the view's one primary button
  **"New playlist"** (plus icon). Then three sections, each a bold `fs-lg` heading over its content, no cards:
  - **Your playlists**: every playlist you own, public and private, your pins first, then newest, as **tiles**
    (`.landing-tile`, 3.5rem tall, `--app-raised`, hover `--app-btn-tonal`): the cover of initials flush left,
    the name (semibold, a pin icon when pinned) over a muted line with the "Private" badge (lock + text, the
    current **state**; nothing for public), songs and listeners. Three columns, two in a page column under 40rem,
    one under 30rem. After your playlists, three shortcut tiles with gradient covers: **Radio** (with a Play
    button), **Library & Downloads** (muted line "Songs, requests and downloads") and **Artists** (links to `/radio`, `/library`, `/artists`). No
    playlists of your own: an empty state ("No playlists yet", a muted hint, a grey "New playlist" button) before
    the shortcuts.
  - **Artists**: the shelf, see "Artists".
  - **Public playlists** (other people's public ones and ownerless shared ones; hidden when there are none): a
    shelf of **cards** (`.playlist-card`, 10.5rem columns, 8.75rem in a column under 400px, one row that scrolls
    sideways, snap to cards, ghost ‹ › for a mouse while the row overflows): a square cover of initials, the
    name, a muted "by <owner> / shared · songs · listeners".
  Tiles and cards are `.lobby-card` (`role="link"`, click / Enter / Space opens `/playlist/<id>`, a double-click
  plays). Each has a ghost **quick play** button (tile: at the end; card: round, on the cover's corner) when the
  playlist has songs, shown on hover / focus and always on touch: it opens the playlist and starts it from the
  first song in the app-wide player, or resumes it; on the playlist that is playing it is **Pause**. And a ⋮
  menu (`playlist-actions.ts` items in `context-menu.ts`; also right-click / long-press): Play, Copy link for
  everyone, plus — owner only — Rename (dialog), Make private / Make public (with a one-line hint) and a danger
  Delete that opens a confirm dialog (grey Cancel focused first, `.btn-solid.theme-danger` Delete). The playlist
  playing now is the accent tint with an accent title and the equaliser, never an edge.
  Below the sections: the "Have a link?" hint; no footer (the language setting is on the profile). On load, a "Back to your last playlist?"
  prompt names the last playlist you opened (looked up first; not shown if it is gone or no longer visible to you).
  **New playlist dialog** (`new-playlist.ts`, an `.app-modal`, see "Modal dialogs"): Playlist
  name (required, 50 chars, live `n/50` counter), Visibility as two `.radio` choices with a
  one-line hint each (Public default), a danger alert for other errors, footer grey Cancel +
  primary "Create playlist" ("Creating…" while busy). Empty name or a server refusal about
  the name ("A playlist with that name already exists") shows in red under the field. On
  success it closes and the new playlist opens.
- **Playlist** (`/playlist/<id>`; internally the "lobby" view): full-height column, and above the table only two rows (the
  shell's top bar with the search sits above the panel) —
  navbar (back, the playlist's cover of initials (hidden in a page column under 30rem), name, a muted `fs-xs` line with the "Private" badge (lock + text, same as the
  landing rows; nothing for public), then one truncated line of plain text (`#playlist-meta-text`): owner · the stats (see "Stats" under
  "Song rows") · listener count, e.g. "by you · 11 songs · 48 min · 11 artists · Top artist: X (3) · 2 listeners", the " · " drawn by CSS,
  the whole line in its `title` and the "about …" length keeping its own; your own pin (same as the
  sidebar's; aria-pressed, `.active`), share, and the owner's
  ⋮ menu: Copy link, Rename, Make private / public, Delete), scrolling body (full column)
  with the queue (no tabs: who is listening and what they play is the global people
  panel, your name/avatar is on the profile page). There is no per-playlist chat; there
  is one global chat (see "Chat and people panel"). Playback is the app-wide player bar, like
  every other page. The back button only navigates; it never leaves the playlist or stops
  audio. Users who may edit the playlist (public: every signed-in user; private: its owner —
  the server sends `canEdit` with `lobby:joined`) get a grey "Edit" text button in the navbar
  (solid primary "Done" while editing). Under the navbar **one toolbar** (`.queue-toolbar`): the "Filter songs…" box takes
  the width, then the sort select (at most 11rem) and the ghost download-playlist icon, and in edit mode the "Clear queue"
  danger icon button, all on one line (at 360px too). There is no add-song box, "Add songs" button or library button: songs
  are added from the global search, which adds to this playlist when it is started here (see "Search"), or from the library
  in the sidebar. An empty playlist says so for editors: "Search for songs above (Ctrl K) to add them here." ("Find songs with
  the search…" on touch and phones) with a grey **Find songs** button that starts the search (on phones the search page);
  people who cannot edit read "Nothing in this playlist yet". Queue rows
  follow "Song rows: normal and edit mode" below; a song's source link is in its menu.
  A playlist you cannot see (missing, deleted, someone else's private one) shows a
  "Playlist not found" toast and returns to the landing page.
- **Music library**: a panel over landing or a playlist, in the page panel's place (see "App shell"), as wide as the page panel
  on every tab like the other pages (lists full width; the search box, hints and the Download form keep a measure, left-aligned): navbar (back, title, "adding
  to" context), tabs (segmented control; tighter on phones, so all four fit at 360px) Songs/Requested/Download/Broken with count badges, search + sort toolbar, list group of
  songs (when the page column is below 576px the row's buttons go on their own line under the text; clicking / tapping the row, or Enter / Space on it, plays it — the song already playing is
  resumed, never restarted —; play button — plays in the app-wide player, shows pause on the song that is playing —, a grey
  icon button "Replace with…" (swap arrows), Add / "Added" button (a song already in the playlist says "Added" in the success
  tint and still adds again after the "Already in this playlist. Add again?" question; disabled only with no playlist open), ⋮ song menu), 20 per page: a compact
  "‹ Page n of m ›" pager above the list and the full numbered pagination + range below it
  (both follow `?page=`, both hidden when there is one page).
  "Replace with…" opens the song dialog, see "Replace with…" under "Context menu".
  Third tab **Download** (`jobs.ts`, `?tab=downloads`; badge = your waiting + running jobs):
  a card with the Download box — text input (YouTube video / playlist link, Spotify track
  link or a search) with a one-line muted hint, "Add it to" `select.form-control` (the
  library only, or a playlist you can see; defaults to the playlist the library was opened
  from), primary "Download" button and next to it a status line with a small dot (success =
  a downloader is online, grey = none: "No downloader online — jobs wait until someone runs
  `la worker`"), a danger alert for errors — then "Your downloads": a list group of your
  jobs (Download-box jobs and the jobs of songs you requested in a playlist), newest first.
  Row: thumb, title, one `fg-2` status line ("Waiting for a downloader", "Downloading on
  living-room-pc (Ayşe) · Uploading Artist - Title… 42%", "In the library: … · added to Road trip",
  "Failed: … (AGE_RESTRICTED)"), a muted origin line, a subtle status badge (warning
  waiting, primary downloading, success done, danger failed, secondary cancelled) and a
  grey Cancel (waiting) / Retry (failed, cancelled) button. Live over the socket
  (`jobs:update`, `workers:update`); a finished or failed Download-box job also toasts when
  the tab is not on screen. Song rows elsewhere in the library read "uploaded by
  <worker> (<owner>)" when a downloader uploaded them, plus "asked by <name>".
- **Profile**: navbar with back; avatar + display-name card (the only place to edit your
  name/avatar; the chat and people panel show them); a **Language** card (the only language control:
  label + `select#language-selector`, English / Türkçe in their own names, a muted "Saved in this browser";
  `setupLanguageSelector` in ui.ts, stored by i18n.ts; login and pending have none and follow the browser);
  connected-accounts card; Sign out; last, the
  About card (version, Changelog, GitHub). The pending-approval card has no route here (app.js stops at it).
  Approved accounts also get a "CLI tokens" card (`/profile#tokens` scrolls to it and focuses the label; it links to `/app`): label input + grey "Create token"
  button (the display-name Save stays the one primary), a success alert that shows a new
  token once (read-only input + Copy, a `pre` "how to use" snippet that scrolls sideways,
  Done), and a list group of active tokens (label, prefix, created, last used, danger
  Revoke). Then **Your activity** (`profile-activity.ts`, approved accounts, only ever
  your own; "Only you can see this" in the header): a one-line `fg-2` summary of counts,
  tabs (segmented control) with count badges, on one line that scrolls sideways inside its outline when the column is too narrow — Uploaded (also by your downloaders), Asked for (song
  requests + Download-box jobs, with status badge and "uploaded by <worker> (<owner>)"),
  Fulfilled (what your downloaders fulfilled, with "asked by"), Downloaders (yours: name, jobs done, online /
  busy / offline badge; never host, OS or IP) — and one list group below them.
- **Social** (`/social`): below 1010px the chat-and-people cards as a full-screen view on the page colour (over the
  playlists sidebar too); from 1010px the URL just opens the chat column beside the current page. See below.
- **Dashboard** (`dashboard.ts`, `dashboard-admin.ts`; `/admin` 301s here): navbar (hamburger below 1024px),
  15rem section list (sticky, a drawer below 1024px; `#section` in the URL), main area up to 64rem. Until the admin login
  it shows only a centred login card (`#adm-gate`, no player bar, no sections); Log out is under the section list. Sections, one at a time, each `h2.h5` + a
  muted hint + a list group: **Overview** (stat cards, below); **Playlists** (public ones; private ones are only
  counted, never listed); **Users**; **Downloaders** (every `la worker` ever connected: name · owner, host /
  platform / OS, IP and versions in muted lines (a subtle warning "outdated" badge after an la version older than
  the one the server ships, `cli_outdated`), online / busy / offline badge, Refresh — the only place
  machine details appear); **Download jobs** (status filter select, counts, rows with requester, playlist, worker,
  error code, status badge and Cancel / Retry); **Broken songs** (see "Context menu"); **CLI tokens** (list, Revoke);
  **Song requests** (status filter, Dismiss); **Library** (search, Play, Delete). Downloaders, jobs and broken songs refresh every 10s.
  The dashboard does not start the app-wide player (the bar stays empty there), so Play is a preview on one in-memory `Audio`; this is the
  only exception to "one player".
  **Stat cards**: `.dashboard-stats` is `repeat(auto-fit, minmax(min(100%, 14rem), 1fr))`; every card is a `.card` (surface, `--app-border`
  outline, no shadow). One fact per line and no line wraps: `.stat-label` (`fs-sm fg-3`), `.stat-value` (`fs-2xl`), then optional
  `.stat-meta` lines (`fs-xs`) for what used to be crammed into the value: "1,234 private", "1,234 files", the warning-coloured
  "12 unregistered (1.2 GB)". Longer facts get a `.stat-meta` line, not a wider value.
- **Radio** (`/radio`, `radio.js`, approved accounts): see "Radio" below.
- **Artists** (`/artists`, `/artist/<key>`, the landing shelf; approved accounts): see "Artists" below.
- **Android app** (`/app`, `app-page.ts`; `a[data-spa-link]` is its in-app link, so playback continues): navbar (☰, back, `h1.h6`), `.app-narrow` column, no art, three cards.
  **Download**: the view's primary "Download APK" (GitHub's asset URL, new tab), a line of version · size · date, the SHA-256 with a grey Copy, a ghost link to all releases and "Needs Android 8 or newer". While checking, or when GitHub cannot be reached, a muted line replaces the button and the releases link stays.
  **Install**: numbered steps (`.app-steps`), then short notes with a bold lead-in: Play Protect, Updates, Developer builds. **Connect your account**: numbered steps quoting the app's Settings labels exactly (the app is English only, so the Turkish text keeps them in English; keep them in step with `SettingsScreen.kt`), the Address step showing this site's origin, a grey link to `/profile#tokens` and a Revoking note.
  A pending account gets the page too, from a link on its pending card: a warning alert says tokens need approval, and the tokens link is hidden. No sidebar or player there. iOS has no section.
- **/changelog**: navbar + narrow column of cards; Bootstrap and
  utilities only.

### Playlists sidebar

One `nav#app-sidebar` in `index.html`, driven by `sidebar.js` (list in `playlist-store.ts`, search
in `playlist-filter.ts`, styles "Playlists sidebar" in `app.css`, hooks prefixed `plnav-` because
the dashboard already owns `.sidebar-*`). Shown by body classes, never `[hidden]`: `has-plnav`
(approved account), `plnav-open` (drawer open). Present on landing, playlist, library overlay,
profile and the desktop `/social`; not on login, pending or `/dashboard`.

Two rounded panels, a gap apart (see "App shell"):

- **Upper panel, the places.** Head: brand (link to Home), GitHub (`#plnav-github`, the project's source: a real `<a>`,
  new tab, `rel="noopener"`, name `appMeta.source`; an icon button like its neighbours, so it is on every page, the
  profile's About card keeps its own), profile, the collapse toggle (× in the drawer instead).
  Then the app's main navigation (`.plnav-nav`): **Home** (`#plnav-nav-home`, `/`), **Radio** (`#plnav-radio`, see
  "Radio"), **Artists** (`#plnav-nav-artists`, `/artists`) and **Library & Downloads** (`#plnav-nav-library`, key `landing.library`;
  opens the library overlay like the landing button, over the playlist on screen if any; app.js). Icon + semibold
  `fs-sm` label, 2.75rem tall. The place on screen is `aria-current="page"` (`syncPlaces` in sidebar.js: Home on the
  landing page, Artists on `/artists` and `/artist/<key>`, the library while its overlay is open; Radio marks
  itself in radio.js): the accent tint and accent text, never an edge. Home and Artists are `data-spa-link`s.
- **Lower panel, the playlists**: the title row, the filter, search and the list below; it fills the rest of the column
  and only the list scrolls.

- **From 768px**: fixed left column, `--app-sidebar-width` (16.5rem, 19rem from 1440px; 4.5rem as the rail),
  the whole column including the gap at the window's edge, from a gap below the window's top (the top bar with the search
  is in the page column only, see "App shell") down to a gap above the player bar. `body` gets the same `padding-left`, and the library overlay's `left` follows it, as the chat column does on
  the right.
- **Rail** (`body.plnav-rail`, 72px, see "Columns and breakpoints" for when): the same two panels, re-styled. Brand
  icon, GitHub, profile, the toggle (`#plnav-toggle`, chevron, "Expand / Collapse playlists", `aria-expanded`), the places as
  3rem icon buttons (the label stays their accessible name, visually hidden; `title` is the tooltip), then New
  playlist and one 2.5rem cover of initials per playlist, the same order with a divider between groups instead of
  headings. Tooltip = `title`, and `aria-label` has name, Private, owner and song count. Current = a solid accent
  avatar; pinned = tinted avatar with accent initials; otherwise its cover colour. Click and Enter navigate;
  right-click and long-press open the same menu. No search, filter, sort control or pin / ⋮
  buttons: a running search is cleared on collapsing. The rail follows the sort but lists everything, since nothing there would show or
  reset a filter; expanding brings the remembered filter back. A display utility on anything the rail hides would beat
  `@layer custom`, so those parts carry none. Rail rules live inside `@media (width >= 768px)`: phones always get the full drawer.
- **Below 768px** (unchanged by the toggle, which is hidden): a drawer (`min(20rem, 85vw)`) holding both panels on
  the page colour, that stops at the player bar, with a backdrop,
  opened from the ☰ (`[data-plnav-open]`) in every navbar. ☰ replaces the playlist page's back button
  there (Home is in the drawer and the row of places). Focus moves in and stays in; Escape, ×, the backdrop and any
  navigation close it; focus returns to the ☰.
- **Row of places, below 768px** (`nav#app-places`, "Main", in addition to the drawer, which keeps the places and
  the playlists): a 52px panel of its own above the page panel (the page's navbar with ☰, brand and profile stays
  the page panel's head), `--app-gap` around it; it holds the top safe area, and `--app-view-height` and the
  library overlay's `top` leave room for it. Home, Radio, Artists, Library & Downloads as real links
  (`#places-*`): Home, Radio and Artists are `data-spa-link`s, the library opens the overlay as the sidebar's does
  (app.js). 44px targets sharing the width, icon + `fs-sm` semibold label, icon only below 576px (the label stays
  the name, visually hidden; `title` is the tooltip). The place on screen is `aria-current="page"` (`syncPlaces`,
  Radio only on `/radio`, not while merely playing): the selection tint and accent text, never an edge; focus is
  the usual 2px ring, inset. Not shown from 768px.
- Lower panel head: "Playlists" (bold) + the sort control + a ghost New playlist
  icon button (not primary: the view's primary stays in the view), then the filter and the search box.
- **Filter** (`#plnav-chips`, `role="group"`): All (default), Mine, Public, Private, one at a time, `aria-pressed`: a full-width segmented
  control (`.app-seg.app-seg-fill`, see "Tabs" under "Components"), four equal buttons, `fs-xs`, 32px (40px on touch). A label may take two
  lines, and does in Turkish ("Herkese açık"), which makes the whole control 37px; a button never gets narrower than its longest word.
  Its side margins are 1rem, in step with the search box, shrinking to 0.5rem in a sidebar dragged towards 200px, so both languages fit
  every sidebar width and the drawer without scrolling or cut words. Pressed = the accent tint and semibold accent text. Tapping the
  pressed one, or All, resets. Mine is the server's `isOwner` and Public / Private its `visibility`, never a client guess.
- **Sort** (`#plnav-sort`): the current choice + icon, `context-menu.ts` with `menuitemradio` rows (208px wide, 40px rows): **Name (A–Z)**,
  `localeCompare('tr', { numeric: true })`, and **Date created**, newest first, the default. Only what the data supports: there is
  no "recently played", and `lobbies.last_activity` means someone joined or left, is not in the API, so no Recents.
  Filter and sort are in localStorage (`listen-sidebarFilter`, `listen-sidebarSort`), per browser.
- **Search**: `input[type=search]`, filters as you type by name and owner, every word must match.
  i/ı/I/İ are one letter and ş/ğ/ü/ö/ç match s/g/u/o/c (`foldText`). × or Escape clears (Escape in an
  empty box closes the drawer). It combines with the filter and the sort. No match: a muted line, a grey "Clear search",
  and "Show all" when a filter is on. A filter with nothing and no search has its own line ("You have no private
  playlists"), with New playlist (not for Public) and "Show all".
- **List**: small uppercase headings (`.people-heading`) over list groups of separate rounded rows (no dividers): **Pinned**, always on top,
  then by date **Your playlists** and **Public playlists**, by name one A–Z list (the groups would break the order; its heading
  "Playlists" shows only under Pinned). The sort applies inside every group, and the filter to Pinned too; empty groups vanish
  (`arrangePlaylists`). Names like `Family: Name` sort as families.
  Row: the playlist's 2.5rem cover of initials, then the name (`fs-sm`, medium) over a muted `fs-xs` line with a lock icon on private ones (icon only here,
  no badge; the word is there for screen readers) and "by you · 2 songs". Current row =
  `.is-current`, the usual accent tint + accent semibold title, with `aria-current="page"`. The playlist the player
  is playing from (`.is-playing`) has the equaliser at the start of its line, an accent semibold title and the
  playing row's tint, and "playing" in its label. Hover and press as other rows. The text block is the `role="link"`: `bindContextMenu` keeps the browser's menu
  on real links, which would lose right-click and long-press here.
- **Row actions**: pin toggle and ⋮ (`playlistMenuItems` + Pin / Unpin; right-click and long-press
  too). Shown on hover / focus-within, always on touch, and they keep their space so names do not
  jump. A pinned row always shows its pin, as a plain accent icon rather than the usual toggled box.
  `aria-pressed` + a label naming the playlist.
- **Double-click** (`row-double-click.ts`, mouse only): a sidebar row, a rail avatar, a landing row, Radio's row or an artist card plays, as Play does (`quickPlayLobby`,
  `playRadioFromTop`, `playArtistFromTop`): from the top, shuffle taking over after the first song; the one already playing is left alone, or resumed if paused; empty gives the usual toast. The first click opens without any delay
  and the second press is taken whole, whatever is under it by then. Row controls keep their clicks. No hint, no keyboard equivalent (Enter opens; Play is in ⋮ and on landing rows), no double tap. Rows are `user-select: none`.
- **Live**: refetches on socket `playlists:changed`, on `queue:update`, on reconnect and every 30s.
  It only touches the DOM when the markup changed, and focus follows the control when a row moves.

### Radio

Every song in the listener's own shuffled order, separate from the library, which stays as it is.

- **Sidebar row** (`#plnav-radio`, a real link): one of the places in the sidebar's upper panel, between Home and Artists, outside `#plnav-list`, so search, the filter, sort and scrolling
  never touch it. Rounded box, 3.5rem tall, full `--app-info-border` outline on `--app-info-subtle`, radio icon, "Radio" over a live
  "All 2,108 songs, shuffled". At rest the info tint, so it never reads as the selected row. While on `/radio` or while Radio is the player's source
  it is `.is-current`: the selection tint (`--app-accent-subtle`, `--app-accent-border`, accent title); `.is-playing` adds the equaliser. No covers, no edge.
- **Rail**: a 3rem box with the icon, among the places; tooltip and `aria-label` carry the count. **Drawer**: the same row; navigating closes the drawer.
- **Page**: navbar with ☰ / back, a radio cover (`.cover-radio`), `h1.h6` "Radio" over a muted "All songs, shuffled", ghost Reshuffle and the view's primary Play / Pause. No hero, no art. Under it the stats strip (`statsHtml`) with songs and total length only,
  then the playlist song table (`.queue-head`, `.queue-item`) with #, Title + artist, Duration, ⋮ at every column width from 480px, and the compact row under that. Windowed with `virtual-list.ts`, so ↑ / ↓, Page Up / Down and Home / End work as on playlists.
  No Added / Added by, edit mode, remove or reorder. The song menu works as on any song row.
- **Behaviour**: opening plays nothing. Play starts at the top, so what you see is what you hear; a row plays from there (the song already playing is resumed, never
  restarted). The order is made in the browser per opening and stays while the view is open and while Radio is the player's source, playing or paused, also across navigation (with the
  current row scrolled into view). Opened when it is not the source: a fresh shuffle. Picking a song or playlist elsewhere replaces it, like any context.
  At the end of the list a new shuffle starts that does not open with the song that just ended; Previous at its first song restarts that song.
  Player bar: "artist · Radio", which opens `/radio`; the shuffle button is disabled (the list is the shuffle).
- **Broken songs** (a default we can reverse): songs with an open report are not in Radio. Marked while it plays, the song on air finishes first.
- **Library changes** (`library:updated`): songs that left go away, new ones land at a random place after the current song, nothing else moves.

### Artists

Every artist of the library as a read-only "album" of their songs (`artists.js`, `artist-page.js`, rules in `artist-rules.ts`). An artist is
every song whose credit names them, as on Spotify: the server splits a credit into its artists (`backend/src/artistCredits.js`), so
"RAYE, 070 Shake" is on both pages while "Earth, Wind & Fire" and "Simon & Garfunkel" stay one artist, and spellings fold to one key
("Barış Manço", "barismanco" and "Barış Manço - Topic" are one). The name shown is the spelling most of their songs use, without channel
suffixes; a song row always shows the song's full credit. Songs with an open report are left out, as in Radio.

- **Card** (`.artist-card`, Spotify's artist tile): a round cover (the newest song's YouTube thumbnail, else the music-note placeholder), the name
  (`fs-sm`, medium, one line) and "12 songs" (`fs-xs` muted). The whole card is one link to `/artist/<key>` (a stretched `::after`, so
  middle-click and Ctrl-click open a tab); the focus ring is drawn on the card. A round tonal play button sits on the cover's corner, on hover /
  focus, always on touch; it opens the artist and plays from the top (the artist already on air resumes). Hover and press are the grey row fills;
  the artist the player plays from is `.is-current`: the selection tint and an accent semibold name, no edge. A double-click plays, as on playlist rows.
- **Landing shelf** (`#artists-section`, a section between "Your playlists" and "Public playlists", like the public playlists' shelf): "Artists" with **Show all** on the right and,
  for a mouse while the row overflows, ghost ‹ › buttons. One row that scrolls sideways (8.5rem columns, 7.25rem in a column under 400px,
  snap to cards): the 20 artists with the most songs, leaving out one-song artists unless nobody has more. Hidden while there are none.
- **/artists**: navbar with ☰ / back and `h1.h6` "Artists"; a search box (every word, Turkish-aware, as in the sidebar; Escape clears)
  with a muted count ("310 artists", "3 of 310"); then every artist A–Z (Turkish alphabet) in a grid of the same cards,
  `repeat(auto-fill, minmax(8.5rem, 1fr))`. No match: a muted line and a grey "Clear search".
- **/artist/<key>**: like Radio without the shuffle. Navbar with ☰ / back (to `/artists` when opened from there, else Home), a small round
  cover, `h1.h6` name over a muted "Artist", and the view's primary Play / Pause. Then the stats strip (songs, total length) and the
  same song table as Radio (#, Title + artist, Duration, ⋮), windowed with `virtual-list.ts`, in title order. No edit mode, remove,
  reorder or add. The song menu works as on any song row (it acts on the library song, never on this list).
- **Behaviour**: opening plays nothing; Play starts at the top, a row plays from there (the song already playing is resumed). The player
  context is `{ type: 'artist', key, name }`: the player bar reads "artist · name" (once, when they are the same) and opens the page; the
  player's own shuffle and repeat apply. Library changes update the list on screen and the one playing; a song that left while on air
  finishes first. Presence shows "from <artist>" to everyone.

### Search

One field for the whole signed-in app and one page, `/search?q=…` (`search.js`, rules in `search-rules.ts`, relevance on the server
in `backend/src/songSearch.js`).

- **The field** (`form#app-search[role=search]`, `#app-search-input`): the shell's **top bar** (see "App shell"), one element that never
  moves: at the top of the page column and centred in it (not in the window), above the page panel, from 768px (landing, playlist, Radio, artists, an artist, search, profile, `/app`, and
  the library overlay while it is open), shown or hidden by `search.js` (`body.has-topbar`). Not on login, pending or `/dashboard`. A `.form-control`
  pill, 2.5rem, max 32rem, with the search icon inside at the start and a `kbd` hint at the end ("Ctrl K", "⌘K" on a Mac; hidden
  while there is text and on touch). Placeholder "Search songs, artists, playlists, or paste a link"; "Find songs to add to <name>"
  while an editable playlist page is on screen or the search has that playlist as its target (`placeholderTarget`). **Ctrl+K / Cmd+K** focuses and selects it from anywhere, also from another input (not over a
  dialog, not on `/dashboard`); Escape clears it, a second Escape leaves it. Below 768px it is only on the search page, which the
  **Search** place opens: a fifth icon in the phone row of places (`#places-search`) and a Search row in the drawer's places
  (`#plnav-nav-search`, phones only).
- **Typing** opens `/search?q=` once (one history entry from the page you were on), then replaces the URL as you type (150ms;
  350ms for a link). IME-safe: nothing happens during a composition, Enter and Escape of a composition are the IME's. Back returns
  to the page you came from; the page's own back button too. The title is "<query> · Search · listen-along".
- **The page**: navbar with ☰ / back and `h1` "Search"; a line saying where a one-step add goes ("Adding to: <name>" as a
  primary subtle badge, with × when the search was started on that playlist's page, else a muted "the playlist you last played"; without one, a muted
  "Play a playlist to add to it here in one step"); then sections, each a bold `fs-lg` heading over a list group of rows
  (`.search-row`, 3.75rem, thumb, title over a muted meta line, buttons at the end):
  - **Songs — in the library**, as you type (`GET /api/library?sort=relevance&limit=50`): ten, then "Show n more" up to 50 and a note
    to narrow it. Relevance: the title, the artist, "artist title", a title or artist that starts with it, every word starting a
    word, a substring, then the rest (Turkish i/ı/İ and accents fold); ties A–Z. Row: cover, title, "artist · length", round play
    (pause on the song sounding), **Add** (one step to the target; "Add to…" opens the playlist chooser when there is none), ⋮.
    A muted line says a song played from here repeats.
  - **Artists** (up to six, from `/api/artists`, the name first, then most songs): round cover, name, "Artist · n songs"; opens
    the artist page. **Playlists** (up to six, from the viewer's own list, so nothing they may not see): cover of initials, name,
    "by … · n songs · Private"; opens the playlist.
  - **From YouTube**: never per keystroke (30 lookups a minute per client). A row "Search YouTube for “…”" with an `Enter` hint;
    Enter in the field or the row runs `POST /api/jobs/picks { query }` and scrolls to it. States: "Searching YouTube…", "YouTube
    found nothing for “…”", rate limited (warning alert + Try again), failed (danger alert + Try again). A result the library has
    is a library row with a success "In library" badge; any other has a 16:9 thumbnail, title, "channel · length", **Request**
    ("Request and add to <name>" with a target; without one it asks where: a playlist or **Library only**), an icon link to
    YouTube (new tab) and ⋮ (Request and add to ▸, Library only, Open on YouTube, Copy YouTube link). Requested = disabled
    "Requested"; progress is in Activity. While an add, a request or an import is on its way its button is `aria-busy` /
    `aria-disabled` (dimmed, still focusable) and a second press does nothing: the server does not dedupe jobs.
  - Nothing matches: a centred empty state, "Nothing in the library matches “…”." with a grey "Search YouTube for “…”" button.
  - Empty field: a short hint of what the page does.
- **A link** (exact, never fuzzy; `POST /api/jobs/picks { input }` classifies it): a video, a bare 11-character id (only with a
  digit, "-" or "_"; one YouTube cannot name is searched as words) or a Spotify **track** shows that one song ("From the link":
  a library row with "In library", or a YouTube row), then **Similar in the library** (title words of the video, a hint, never in
  the way). A Spotify track resolves as it does elsewhere (the library's exact title and artist, else the top YouTube hit) with a
  muted "Spotify track: Artist - Title". An unsupported link is a warning alert with the server's reason in the page's language
  ("Only Spotify track links are supported…"). A **YouTube playlist** is an import card (`.card`, a cover with a list icon, the
  playlist's name, "17 videos · 2 already in the library", "The first 100 of …" over 100) with one primary **Import…**.
- **Import…** opens the pick dialog's checklist (`importPlaylist` in `pick-dialog.ts`) with **Add to** at the top: a
  `select.form-control`, "New playlist named “<YouTube title>”" (the default; the usual create path, public) or one of the user's
  editable playlists, and a muted line under it ("Checking what is already in it…", "1 is already in it and is left unticked.").
  Rows say "In library, added now" or "Will be requested"; a row already in the chosen playlist (the same video or library song)
  starts unticked with a warning "Already in playlist" badge, re-decided when the destination changes (a tick changed by hand
  stays). The primary button says the outcome: "Add 12 now, request 30" / "Add 2 now" / "Request 15". The first 100 only. A
  summary toast repeats it with **Open**. It is one `POST /api/jobs { picks, playlist_id, allow_duplicates }` (a ticked row is
  wanted as it is; without a readable destination the flag is left out and duplicates are skipped). A taken name says so and
  suggests importing into that playlist. If the songs cannot be queued after a new playlist was made, the playlist is kept
  (a lost answer may still have queued downloads into it) and the toast says so, with **Open**. Select all / none count as the
  user's own ticks: a destination change re-decides only the automatic "Already in playlist" ones.
- **Keys**: ↓ from the field goes to the first row; ↑ / ↓ walk every row of every section (↑ from the first goes back to the field),
  Page Up / Down, Home / End; Enter plays a song, opens an artist or playlist, runs the YouTube search or opens a YouTube row's
  menu; **A** adds the focused row to the target (its tooltip says "(A)"); Shift+F10 / the menu key opens the song menu.
- **Rows**: a click selects (focus and the selection tint), a double-click plays (as in Spotify's search), the play button plays,
  a tap on touch plays. Selected (`:focus-within`) and playing (`.is-playing`, accent semibold title) are the
  `--app-accent-subtle` tint, hover `--app-hover`, pressed `--app-pressed`, the focus ring inset; never an edge. Right-click,
  long-press or ⋮: the usual song menu (Add to playlist ▸, Source ▸, broken, Replace with…; no Remove).
- **Playing from search**: the song is a context of its own, `{ type: 'search', query }`, with that one song; it repeats until
  something else is chosen, whatever the saved repeat mode (which is not touched); Next and Previous restart it; shuffle is
  disabled. The player bar reads "artist · Search “query”" and opens the search again. Presence sends no context (a search is
  nobody's business); listen-along followers just get the song.
- **The current playlist** (the one-step target) is, for one search, the playlist whose page was on screen when the search
  **started** (the field focused or clicked, Ctrl+K, the phone's Search place, an empty playlist's Find songs) if the viewer may
  edit it (`pageTarget` / `startTarget` in `search-rules.ts`): the "Adding to" chip with × to drop it, kept on the search page and
  back on that playlist (not its library), ended by any other page (`keepTarget`). Otherwise it is the playlist last **played**
  from (`listen-lastPlayedPlaylist` in this browser). Either only while it is in the viewer's list and editable, else there is none.
- Narrow page columns (< 576px): Add and Request become icon buttons, the "In library" badge and the YouTube link go (both stay in
  the menu), thumbs shrink. On touch every row button is 2.5rem.

### Modal dialogs

Every dialog (share, replace with, mark as broken, new playlist) is the same plain markup —
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
from `ui.ts` in the keydown handler); Escape, ×, Cancel and a backdrop click close it, and
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
  arrows or remove buttons. Buttons and links inside a row never trigger the row.
- **Playlist rows are a table** (`queue.js`, "Song table" in `app.css`), about 56px high: `#` (position; on hover or
  keyboard focus a play button, pause on the song sounding, whose number is an equaliser), Title with artist
  under it (+ 2.5rem thumb, status badges, per-row progress), Added by, Added (date, full time in its `title`),
  Duration, ⋮ at the far right (on hover / focus, always on touch; it keeps its place). The label row
  `#queue-head` shares the grid and sticks to the top of `.lobby-body`; it is `aria-hidden`, the cells carry their own
  visually hidden labels. Columns go by **page column** width, `@container page`, never the viewport:

  | Page column | Columns |
  | --- | --- |
  | >= 800px | #, Title, Added by, Added, Duration, ⋮ |
  | 650–799px | #, Title, Added by, Duration, ⋮ |
  | 480–649px | #, Title, Duration, ⋮ |
  | < 480px | compact: no head, no #; thumb, title, a line of artist / duration / added by, ⋮ |

  Data: `addedBy` (a display name, never an id) and `addedAt` were always on queue entries; `artistName` is additive
  (from the library song, not stored on the entry, null for requests) and only strips the artist off the combined title (`songParts`).
  `anonymous` (the placeholder of old rows) and missing values show blank.
- Right-click / long-press / ⋮ open the song menu as always (see "Context menu").
- **A song that failed to play** (`playback-failures.ts`; playlist, Radio and artist rows) is greyed with `.is-unplayable`: the title in
  `--app-text-muted` at normal weight, the cover at 45% and desaturated, and a `.badge.badge-subtle.theme-secondary` "could not play" on the
  meta line whose `title` says a click tries again. Nothing else changes: the row stays the play target with its hover fill and menu, no
  bar or border marks it, and the playing tint wins while the song is loaded. It is this page load's memory only: it clears when the song
  plays, when its audio is replaced, or on reload. The player skips greyed songs; three failures in a row stop playback with one danger
  toast ("… could not be played. Check your connection and try again.", or "… are not in the library yet." when that is all they were). A failure toast says "Could not play …" (+ "Skipping it." when another song came up); an automatic report gets an info toast
  with **Undo** (8s). There is no filter for unplayable songs: they stay in the list, greyed.

**Stats** (`playlist-stats.ts` + `queue.js`). On the playlist page they are part of the header's muted line
(`#playlist-stats` inside `#playlist-meta-text`, `statsTextHtml`): plain text between the owner and the listener count, " · "
between facts, one line, truncated with the whole line in its `title`. On Radio and the artist pages they are the **stats strip**
(`.playlist-stats`, `statsHtml`): one `fs-sm` line of neutral pills that wraps between facts and never inside one; muted words, the
numbers and names in `--app-text`. Always over the whole playlist, whatever the filter shows, and live.

| Fact | Shown when |
| --- | --- |
| "2,500 songs" | always, requests included |
| "6 h 12 min" (seconds below a minute, rounded minutes above) | always; "0 min" when empty; hidden when no song has a length; "about …" with a `title` saying how many are known when only some have one |
| "72 artists" | some song has a known artist (from the library; a request has none) |
| "Top artist: X (500)" | at least two artists, and X has at least two songs |
| "Most added by: X (33)" | at least two people added songs, and X at least two; the `anonymous` placeholder is nobody |

A tie goes to the first in playlist order. Only `addedBy` display names, never an id. Turkish takes no plural after a number
(`stats.songOne` and `stats.songMany` read the same there); numbers use the page language's grouping (2.500).

**Long lists** (`virtual-list.ts`, styles `.vlist`). The playlist page holds the whole queue, because `queue:update` delivers it and
the player, stats, Add to playlist and filter need it; only the **rows** are windowed, inside the existing `.lobby-body`
scroller. No "load more", no pager, and the sticky head and scrollbar act as if every row were there.

- Rows are exactly `--vl-row-height` (3.5rem = 56px) at every width, one fact per line and clipped, so never let a row grow.
- The DOM has the rows in view plus 12 either side, and the row holding focus, wherever it has scrolled to.
- Screen readers: `role="list"`, `aria-setsize` and `aria-posinset` on each row. `#` numbers survive a filter.
- Keyboard: on a row, ↑ / ↓ walk rows, Page keys a screenful, Home / End the ends, rendered or not. Enter / Space plays. Tab goes through a row's buttons.
- Someone else's edit keeps your place: the song at the top of the viewport stays put. Your own move or removal does not anchor, so the rows shift as they did under your hand.
- The player bar's song opens its playlist and brings the current song to the centre. Playback never scrolls the list by itself.
- Radio uses it too. For another long list call `createVirtualList` and set `--vl-row-height`. The library keeps its 20-per-page pager: it is server-paged, so it holds no long list.

**Edit mode** (playlist queue only; "Edit" → "Done" in the navbar, only for users who may edit;
leaving the page always ends it; `queue-edit.ts`):

- The handle takes the `#` cell, so nothing moves. Each row gets a drag handle on the left (`.queue-item-handle`, `.btn-text.theme-secondary.btn-icon.btn-sm`,
  `touch-action: none`) and a remove button on the right (`.queue-item-remove`, `.btn-text.theme-danger.btn-icon.btn-sm`,
  minus-circle). Handles and remove grow to 2.5rem on coarse pointers. The list always shows the real
  queue order (the sort select is disabled).
- Clicking a row does nothing. Drag the handle (pointer events: mouse, touch and pen alike) — the row
  lifts (`--bs-bg-2` + shadow) and the others slide out of its way; the list auto-scrolls near the
  edges, speeding up the longer you hold there (up to six times), and a drag can cross any number of rows that were not
  rendered when it began; Escape cancels. Keyboard: focus the handle and press ↑ / ↓ (Alt+↑ / ↓ anywhere on the row);
  a run of presses goes to the server as one move, 250ms after the last. Delete removes the focused row. Focus stays on the moved row.
- Moves and removals apply at once locally and go through `queue:reorder` / `queue:remove`, so every
  viewer updates live. A removal shows a toast with an **Undo** action (6s; `showToast(msg, type,
  { action, duration })` in `ui.ts`) that sends `queue:restore` — the server puts the song back where
  it was, within a minute. Prefer undo over confirm dialogs for reversible removals.

### Context menu

One reusable component, `frontend/src/shared/context-menu.ts` (styles: "Context menu" in `app.css`),
Bootstrap 6 `.menu` / `.menu-item` / `.menu-header` / `.menu-divider` markup, no Bootstrap JS.

- `openContextMenu({ x, y } | { anchor, alignLeft? }, items, { label, trigger, returnFocus, focusFirst, kind, sheet, className })`
  opens one fixed `.menu.app-ctx-menu` (z-index `--bs-z-popover`, above the player bar and the
  library overlay) at the pointer, or under an element right-aligned; it flips and clamps to stay
  inside the viewport (8px margin). Items: `{ label, description?, icon?, theme?, disabled?, onSelect }`,
  `{ header }`, `{ divider: true }`, `{ text, muted? }`; `checked` makes a radio choice (`menuitemradio`, `aria-checked`, a check mark). `kind: 'popover'` renders the same box as
  `role="dialog"` for details (a song's reports, a person's card); Tab cycles inside it.
  A popover item can be `{ html, onAction }` (trusted markup the caller escaped; its
  `[data-ctx-action]` buttons call `onAction` and close). `sheet: true` makes it a bottom
  sheet below 576px; `updateContextMenu(items)` re-renders the open box (live data) keeping
  focus; `returnFocus` may be a function (rows that re-render).
- **Submenu**: an item `{ label, icon, submenu: { label, backLabel?, searchLabel?, items(query), footer?, emptyText?, onOpen? } }`
  gets a chevron (`aria-haspopup="menu"`, `aria-expanded`) and opens a second box (`.app-ctx-sub`, 18rem) beside the menu: to the
  right, flipped left when it would cross the viewport edge, clamped vertically (`submenuPosition`, pure and tested in
  `context-menu-rules.ts`). Without a search box or footer it is **plain** (`.app-ctx-sub-plain`, as wide as its items, itself
  `role="menu"`; with a search box it is a `role="dialog"` holding the `role="menu"` list). Below 576px it replaces the menu as a
  bottom sheet with a back button (tap the parent: no hover needed), and sits above the on-screen keyboard. Mouse: on hover (150ms), and
  hovering a sibling closes it (250ms). Click, Enter or → open it and focus its first item (or the search box). In it, ↑/↓ cycle through the search box and items, Tab
  switches between the box and the first item, Enter in the box takes the first match; Escape clears the search, then closes just the
  submenu (focus back on its parent item), as ← does; a second Escape closes the menu.
  Touch does not focus the search box, so the keyboard does not cover the list. `refreshSubmenu()` re-renders it.
- `bindContextMenu(root, { rowSelector, triggerSelector, getItems, label })` wires a list
  (delegated, rows may re-render): right-click, a 500ms long-press on touch/pen (cancelled by
  >10px movement; swallows the click that follows), the keyboard context-menu key / Shift+F10
  on a focused row (anchored to the row), and a visible ⋮ trigger in each row
  (`.btn-text.theme-secondary.btn-icon.btn-sm`, `aria-haspopup="menu"`, `aria-expanded`).
  The browser's own menu is suppressed **only on rows**, and kept on links/inputs and with Shift held.
- ARIA and keys: `role="menu"` + `role="menuitem"` buttons; ↑/↓ (wrapping), Home/End, Enter/Space;
  Escape and Tab close and return focus to the trigger/row; outside click, any scroll, resize and
  window blur close it (the closing tap or click does not also press a song row, nor anything under a sheet; on touch, nothing under it at all). Opened from the keyboard, focus goes to the first item. Coarse pointers get
  2.75rem items.
- Song rows use it through `song-reports.ts` (`bindSongMenu`, `songMenuItems`): library rows,
  playlist queue rows and the player bar's current song (right-click / long-press on the song,
  plus `#player-menu-btn`, hidden in the slim phone bar where long-press is the way in). Add new
  song actions to `songMenuItems` — keep labels short ("Mark as broken", "Unmark broken").
- Song menu order: **Add to playlist ▸**, **Source ▸** (**Open in new tab**, `noopener`; **Copy YouTube link**, or "Copy link"
  for a non-YouTube http(s) source), divider, broken-song items, **Replace with…**, then on playlist rows only a divider and
  **Remove from playlist** (danger). Source exists only with a `youtube_id` or an http(s) source: no link, no item (never an
  empty submenu). Song rows and the player bar carry no source link of their own. A song not in the library: Add and Mark as
  broken are disabled, Source and Remove remain. The decisions are pure and tested in `song-menu-rules.ts` (`songSourceLink`,
  `sourceSubmenu`, `canRemoveFromPlaylist`).
- **Remove from playlist**: only on rows of the playlist on screen, and only when the viewer may edit it (`state.canEdit`;
  not the library, Radio, artist pages or the player bar). It is Edit mode's remove (`removeSong` in `queue.js`: gone at once,
  `queue:remove`, the 6s **Undo** toast sending `queue:restore`, which puts it back at the same position); no confirm. The
  server checks the right to edit again.
- **Add to playlist** (`add-to-playlist.ts`, a submenu): search with `matchesQuery` (Turkish-aware), groups Pinned /
  Your playlists / Public playlists from `playlist-store.ts`, only `canEdit` playlists, and a fixed **New playlist** at the bottom (the usual
  dialog, "Create and add"; it stays on the page). Rows say "by … · Private", and "Already added" for the playlist on screen and the
  one playing, whose queues the page holds; such a row is still choosable. Goes through `addSongToPlaylist` (`add-to-playlist.ts`), the
  one way the web adds a library song to a playlist (this menu, the library's Add, the search page): `POST /api/playlists/:id/songs`;
  when the server answers `already_in_playlist` (the same library song / YouTube video is in it; another video of the same song is
  not a duplicate) the **duplicate question** opens (`confirmDialog` in `playlist-actions.ts`: "Already in “X”", "Already in this
  playlist. Add again?", Cancel focused first, primary "Add again"), and only a yes sends it again with `allow_duplicates`. A toast
  names the playlist. Nothing here touches playback or navigates.

**Replace with…** (`replace-dialog.ts`, an `.app-modal`, any approved user, on every library song: playlist
rows, library rows, the Broken tab, the player bar; also the library row's swap button). One dialog, whatever is being
changed. Fields, top to bottom: a muted line naming the song, a warning alert with the song's report reasons (if any), the job
status, Title, Artist, Album, "YouTube or source link" with an icon link that opens the current one in a new tab (a real
`<a target="_blank">`, so playback goes on), and an optional audio file. **The primary button says what will happen:**

| What changed | Button | What happens |
| --- | --- | --- |
| A file is chosen (wins over the link, which is then its label) | Replace | Uploaded at once ("Uploading…"), the dialog closes. Refused while a downloader is running a job for the song; a job still waiting is dropped. |
| Another YouTube link, no file | Replace from link | A download job. The dialog stays, with the job's live status and percent. The song plays its old audio until the job is done and keeps the title, artist and album in the fields. |
| Only title, artist or album | Save | Saved at once, the dialog closes. The audio plays on. |
| Nothing | Save, disabled | |

As soon as a link is entered it is looked up (debounced; the server's metadata-only yt-dlp and oEmbed) and the line under the field
gives the video's title, channel and length. A warning alert appears when the length differs by more than 15 seconds and 10%: it
changes the song for everyone and there is no undo. A failed lookup is a muted note and does not stop anything. A red line under
the field, with the button disabled, says that the video belongs to another song (with its name) or that a replacement is
already running; the same video as now, in other words, is a muted "nothing to replace". Job status is a tinted alert: warning
while it waits ("Waiting for a downloader", with Stop waiting; the file field stays usable), primary while it runs (with a `.progress` bar), danger when it failed
(nothing changed), success when it is done. Only the requester sees the job; others see "Someone is already replacing this song".
Replace jobs also show on the Download tab, under "Asked for" on the profile, and in the dashboard's Download jobs.

**Pick the video** (`pick-dialog.ts`, rules in `pick-rules.ts`; an `.app-modal` with a 36rem card whose body scrolls).
It opens from the Download box before anything is queued, and only if there is
something to choose: a song the library already has is added without it, and an answer that arrives within 300ms
never flashes a dialog. The text stays in the input until the choice is made.

| Input | The dialog shows | Primary button |
| --- | --- | --- |
| Search text, Spotify track link | "Results for …" and up to five results, the first selected | Download ("Use the library song" when the selected one is in the library) |
| YouTube video link | That one video | Download |
| YouTube playlist link | Every video (the first 100) ticked, a count line with Select all / none, each row with **Swap** | Download n songs |
| Swap (of a playlist row) | The playlist's own video first, then five results for its title, the current pick selected | Use this one; Cancel becomes Back |

- A result is a `.list-group-item.pick-option` in a `role="listbox"`: 16:9 thumbnail (`.app-thumb.pick-thumb`), title,
  "channel · length", a success badge "In library", and a ghost icon link that opens it on YouTube in a new tab. The
  selected one is the accent tint plus a semibold accent title (`aria-selected`), never an edge.
- Keys: the listbox is one tab stop; ↑ / ↓, Home, End move the selection, Enter confirms from anywhere but a button,
  double-click confirms, Esc cancels (in Swap it goes back to the playlist). Focus is trapped and returns to the input.
- The playlist is a windowed list (`virtual-list.ts`, 4rem rows in `.pick-scroll`): a real checkbox and a Swap button
  per row, ↑ / ↓ move between rows, → opens Swap. An unticked row is dimmed; a swapped one gets a neutral "Swapped" badge.
  Alternatives are searched only when Swap is pressed, once per row.
- States: "Searching YouTube…"; "No videos found for …" with **Request it anyway**; and on a failed or rate-limited
  search a danger alert with **Try again** and **Take the first match without asking**. Both buttons do what happened
  before the dialog (a request or download by name). A held Enter never confirms, and the dialog closes by itself when
  the page changes or the playlist is left.

**Broken songs ("needs replacement").** A reported song shows a small muted-warning icon button
(`.song-broken-btn`, warning triangle, `aria-label` + `title` "Needs replacement — marked as broken
by n people") right after its title in library rows, queue rows and the player bar — never a text
badge on rows. Clicking it opens the details popover (count, each reason, reporter, time). The
"Mark as broken" dialog is an `.app-modal` card: preset reason buttons (Wrong song, Bad audio,
Cut off, …; `.active` when chosen), a free-text input (max 200, counter), Cancel + primary
"Mark as broken" / "Update". The library's fourth tab **Broken** (`?tab=broken`, warning count
badge) is the Songs list filtered to reported songs with every report listed under the row; `/dashboard`
has a **Broken songs** section (reasons, reporters, per-report Dismiss, Dismiss all). Short labels
("Broken") are fine on tabs, cards and badges there. A report the player filed by itself (`auto`) has no reason: wherever
a reason is shown it reads "Failed to play (reported automatically)" (`reports.autoReason`), with a secondary "Automatic"
badge on `/dashboard`. Same icon, same count, and its owner edits or unmarks it like their own. The server stores one only
after checking the song itself; when it does not, the player says nothing and the song just stays greyed. `/dashboard` → Broken
songs shows an outline **Dismiss automatic (n)** button next to Refresh while there are any.

### Player bar

One persistent bar, fixed to the bottom of every signed-in SPA page (landing, library
overlay, profile, dashboard, every playlist page), Spotify-style: a rounded `--app-raised` panel floating a
`--app-gap` clear of the window's left, right and bottom edges (the safe area, if larger), no outline, no shadow. Markup: `#player-bar` in
`index.html`; behaviour: `player.ts` (the only thing that touches `<audio id="audio-player">`),
`player-bar.ts` (visibility, padding, empty state, "from" line) and `playback.ts` (title,
art, times, buttons).

- Listen-along strip (`#listen-strip`, `role="status"`, hidden when idle): one line in
  `fs-xs` accent text with a headphones icon above the row. Follower: "Listening along
  with Ayşe" + a `.btn-text.theme-secondary.btn-xs` "Stop listening along" (after the
  leader goes offline: "Ayşe went offline · stops after this song"). The person being
  listened to: "Ayşe and 2 others are listening along", no button. While listening
  along the second line reads "artist · Listening along with Ayşe" and the open button
  is disabled — never a playlist name (it may be private).
- From 768px, full viewport width (1rem side padding), three zones in a `3fr 4fr 3fr` grid; the equal side
  columns keep the centre, and the Play button, on the viewport's centre. About 87px tall.
  - `.player-zone-left`: cover (3.5rem) + title / "artist · context" (one button that opens the context: the
    playlist page, or `/library`; both lines truncate), broken-song icon and ⋮ right after the text.
  - `.player-zone-center`: shuffle, prev, play (`.btn-solid.theme-primary` pill), next, repeat, so Play sits in
    the middle; under them the seek `.form-range` with the current time and duration on either side (fixed
    width, so the track stays centred).
    Repeat cycles off → all ("Replay list") → one and is kept in this browser (`listen-repeatMode`). With no stored
    choice it is **all** (`DEFAULT_REPEAT`, `initialRepeatMode` in `player-queue.ts`); a stored `off` stays off. Radio
    never replays its list (`contextRepeat`: it runs into its next round), and a listen-along follower never loops on
    its own (the leader's songs drive it). The button shows the mode from page load (`.active` + its label).
  - `.player-zone-right`, right-aligned: mute + volume, then chat at the very far right (`#social-toggle`,
    unread badge on its corner; toggles the chat panel from 1010px, opens `/social` below that; the only opener
    below 1010px, the rail is the labelled one above that). The slider is 4.75rem at 768px, growing with the
    viewport to 7.8125rem at 1280px.
  - Focus order follows that: song, ⋮, transport, seek, mute, volume, chat.
- Below 768px the zones dissolve (`display: contents`) into one row with the seek line wrapped under it, and the
  volume slider hides. The row reads song, ⋮, transport, mute, chat; the times are under the seek line. The seek
  input stays in the centre zone's markup, so there Tab reaches it before mute and chat.
- Below 576px it is the slim form: cover, title, play/pause, next, chat and a thin seek line (`.player-extra`
  and times hidden).
- On coarse pointers the seek input keeps a 2.5rem hit area around its 20px of layout; the buttons in the row
  stay above it, which leaves at least 34px under a button. Keep the zone's gap, and its bottom padding from
  768px, or that shrinks.
- Empty state (`.is-empty`): "Nothing playing", controls disabled (Play stays enabled on
  a playlist page whose queue has songs).
- It sits above the library overlay (`--bs-z-fixed` + 1). The room it takes — its height plus the gap under it
  and the gap above it — is `--app-player-height` on `body` (`.has-player-bar`), which ends the columns, pads the
  views and lifts toasts and prompts; new fixed bottom elements must use it too.
- Hidden only on the login / pending views.

### Chat and people panel

One `aside#social-panel` in `index.html`, driven by `social.ts` (pure helpers in
`chat-format.ts`; server in `backend/src/social.js`). It is shown by body classes,
never by `[hidden]`: `has-social` (signed in, socket up), `social-collapsed`
(desktop, remembered in localStorage), `social-route` (the `/social` URL).

Inside, **three stacked cards, all on screen at once** (no tabs), each a rounded surface panel a gap apart, with a
head of icon + bold title + count: **People** (neutral online count; the collapse chevron at its right, and the
back arrow at its left below 1010px), **Chat** (unread badge) and, for approved accounts, **Activity** ("2 in
progress" while downloads run; a pending account has no Activity card). People and Activity keep to a part of
the column (their lists scroll inside, at most 16rem); Chat takes the rest (at least 20rem); the column scrolls
when they do not fit. Each card is a labelled `section` (`aria-labelledby` its title, `tabindex="-1"` so the rail
can move focus there).

- **Desktop (>= 1010px)**: fixed right column, `--app-social-width` (17.5rem, 20rem from 1200px) wide including
  the gap at the window's edge, from a gap below the window's top (beside the top bar, which is in the page column only,
  see "App shell") down to a gap above the player bar,
  as is the rail. `body` gets the same `padding-right`, so every page (and the library overlay, via `right`) shifts left
  rather than sitting under it. Collapse with the chevron in the People card. Present on every
  signed-in page (landing, playlist, library overlay, profile), next to the pending-approval
  card, and on `/dashboard` when the browser is also signed in to the app (the admin login alone is
  not an account; a chat-only socket as for pending users, so Listen along says to open the app).
- **Rail (`#social-rail`, >= 1010px)**: whenever the column is not on screen (collapsed), a 3.5rem column at the
  right edge, a rounded surface panel like the others, mirroring the playlists sidebar. Stacked
  icon-and-word buttons, **Chat** (unread badge), **People** (neutral online count) and, for approved accounts,
  **Activity** (how many downloads are in progress), each opens the column, scrolls that card into view and
  moves focus to it. It takes page width like the column does
  (`--app-social-inset`). Collapsing returns focus to the rail button of the card last opened (Chat by default).
  Never hide the panel without leaving the rail: one small icon in the player bar is not enough of a way back.
- **Below 1010px** (tablets and small windows too): hidden except on `/social`, where the cards cover the page and
  the playlists sidebar above the player bar, on the page colour, with a back arrow in the People card's head (the
  collapse chevron is hidden).
- **Chat**: a scrolling list (`.chat-scroll`) of messages — avatar, bold name, faint time,
  then the text in `fg-2`, `white-space: pre-wrap`; consecutive messages from one author
  within 5 minutes drop the avatar/name. Newest 50 first; scrolling to the top loads the
  next older page (keyset cursor) and keeps the scroll position. Text is always escaped;
  http(s) URLs become links (`target=_blank`, `rel="noopener noreferrer nofollow"`).
  Composer at the bottom: `.input-group` with the input and a primary send icon button.
  Admins (admin cookie) get a small danger trash button per message (on hover; always on
  touch screens), with a confirm.
- **People**: two lists of rounded rows (no dividers) under small uppercase headings, "Online — n" and
  "Offline — n". Row (Discord-like, no buttons in it): round avatar (photo, emoji or
  initials) with a presence dot (success = online, grey = offline), name (+ subtle "you" /
  warning "pending" badges), and one activity line: an animated three-bar equaliser
  (`.person-eq`, still under reduced motion) + "Title — Artist" in accent while playing,
  muted pause icon + "Paused · Title" when paused, nothing when idle, "Last seen 5m ago"
  when offline. Offline rows are dimmed.
- **Person card**: the whole row is a `role="button"` (`aria-haspopup="dialog"`; the selection tint while its card
  is open); click or Enter / Space opens a `context-menu.ts` popover (`kind: 'popover'`, `{ html }` item)
  anchored under the row — a **bottom sheet** below 576px (`sheet: true`, page dimmed).
  It shows a big avatar + presence ("Online" in green / "Last seen …"), the current song
  (cover thumbnail or a music placeholder, "Listening to" with the equaliser or "Paused",
  title, artist, "from <playlist / Music Library / Radio>" only when the viewer may see it),
  "N listening along" when they have followers (a count from `people:listeners`, no
  names), and one full-width action: primary **Listen along**, or tonal **Stop listening
  along** while you follow them (or whomever they follow). Disabled with a muted hint for
  yourself, offline / idle people and unapproved accounts. Escape closes and focus returns
  to the row; Tab stays inside; it re-renders live while open. A private playlist's name
  or id is never sent to anyone but its owner, so the card shows only the song.
- **Activity** (`activity.ts`, rules in `activity-rules.ts`): a list of rounded rows (no dividers), one row per download job of
  anyone, newest first by when it was asked for, so a row never moves while its state changes. Row: a 2.25rem
  thumbnail (the video's, else the music placeholder); the title on one line with an ellipsis and the status
  badge at its right (the Download tab's badges: waiting, downloading, done, failed, cancelled); the status
  sentence in `fg-2`, built like "Your downloads" (`jobStatusText`), up to three lines, except that a failure's reason
  is a fixed sentence for its error code (`activity.fail.*`, "Download failed" for an unknown code) and progress is
  "Searching" / "Uploading 42%": the downloader's own text is never shown here; then a faint
  line "Asked by Ada · for <playlist> · 5m ago". The playlist is a link and is there only when the server
  sent it, which it does only to someone who can open that playlist. A waiting or running row has the accent
  tint (`--app-accent-subtle`) over its whole width, never an edge; finished rows have a quieter title.
  No buttons: it is for watching, and cancel / retry stay in Library → Download. A progress tick rewrites one
  text node; rows keep their elements, so thumbnails do not reload and nothing flickers. The newest 60 jobs
  plus everything still active; empty state "No downloads yet. …".
- **Unread**: messages from others that arrive while the chat is not on screen (column
  collapsed or hidden, or the browser tab in the background) count up on
  every `[data-social-unread]` badge (player-bar chat button, rail, Chat card, pending card) and
  reset when the chat is shown.

All pages must work from 320px wide with no horizontal page scroll; check 320 and 375, and 768, 1010 and
1200, with the sidebar expanded too (the narrowest page columns, see "Columns and breakpoints").

## Accessibility rules

- Every icon-only button has `aria-label` (and `title` for a tooltip). Decorative SVGs get `aria-hidden="true"`.
- Focus is always visible: a global 2px `--app-focus` ring with a 2px gap on every focusable
  element (`theme.css`). Never remove outlines.
- Contrast: text >= 4.5:1, state-carrying UI (input borders, focus ring, icons)
  >= 3:1 — see the token table. New colours must be added there with their ratios.
- Clickable non-buttons need `tabindex="0"`, a role and a keyboard handler — prefer a real `<button>`.
- Touch targets: on coarse pointers player controls, navbar icon buttons, ⋮ and library row buttons grow to
  2.5rem. The broken-song icon keeps its 1.5rem look with a 2.5rem invisible hit area, and the seek bar a 2.5rem
  hit area around its unchanged track (the player buttons above it stay on top). Don't go below `.btn-sm`
  (2rem) anywhere, on any pointer.

## How to add something

**A new view in the SPA**: add a `<div id="…-view" class="view">` to `index.html` with an
`app-navbar`, a `main.app-main.container` (add `.app-narrow` for
forms), register it in `ui.ts`'s `showView` and in `router.ts`. Build the content from cards,
list groups and utilities. Only if something is genuinely not expressible that way, add a
small, named section to `app.css` inside `@layer custom`, using tokens only.

**A new standalone page**: copy the `<html data-bs-theme="dark">` and `<head>` of `changelog.html` (Bootstrap, theme.css),
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
| `--app-hover` = `--bs-bg-1` / `--app-pressed` = `--bs-bg-2` | `#32363b` / `#3a3e44` | `hover` / `pressed` | row hover / pressed (ripple base) |
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
1dp `borderStrong` edge. Playing row = `accentSubtle` tint + `accentFgStrong` title, never an edge
bar (no one-sided accent edges anywhere; selection is a background tint); hover/pressed rows use `hover` / `pressed`.

Components (`ui/Components.kt`) stand in for the Bootstrap ones: `AppTopBar` (navbar: back, small
title, muted subtitle, icon actions), `ListGroupItem` (list group row; each row draws its slice of
the group's 1dp `border` outline; pressed = `pressed` fill, `current` = `.is-playing` accent tint, `lifted` = the row being dragged), `PrimaryButton` / `SecondaryButton` (`outlined`
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
