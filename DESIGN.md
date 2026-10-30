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
| `frontend/app.css` | `index.html` only | Layout of the single-page app (views, lobby, player, library, dashboard). |

Pages: `index.html` (login, landing, lobby, profile, pending, dashboard views and
the music-library overlay), `admin.html`, `youtube-playlist.html`,
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
  (`.app-narrow` = 40rem for forms/settings; the lobby and library use 56rem).
  Vertical rhythm between cards: `mb-4`/`mb-5` or `vstack gap-6`.
- Radii and shadows: Bootstrap defaults (buttons .5rem, cards .75rem). Shadows only on
  floating things (modals, drawer, toasts).

## Components and when to use them

| Need | Use |
| --- | --- |
| Top bar | `nav.navbar.app-navbar > .container` (brand `.app-brand` or back button + `h1.h6`, actions on the right). |
| Grouped content | `.card` with `.card-header` (h6) / `.card-body` / `.card-footer`. |
| Lists of items (songs, lobbies, users, tokens) | `ul.list-group` with `li.list-group-item` (flex row: `.app-thumb`, text block `min-w-0 flex-grow-1`, actions). Clickable rows: `.list-group-item-action` + `tabindex="0"` + Enter/Space handler. Empty state: `li.list-group-item.app-empty`. |
| Playing / current row | `.is-playing` (shared) or `.queue-item.playing/.now-playing` (lobby): accent tint + 3px accent left edge. |
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
| Icons | Inline SVG (Material paths), `fill="currentColor"`, `aria-hidden="true"`. Inside buttons they are sized automatically (1.25rem, 1rem in `.btn-sm`); elsewhere add `.icon` or `.icon-sm`. |

## Page layouts

- **Login / pending**: navbar + one centred card (`.app-center`, `.login-card` 26rem).
- **Landing**: navbar (brand, profile), narrow column: "Start listening" card
  (mode tiles `.lobby-type-selector`, name input, primary Create button, library button),
  then "Active lobbies" card with a flush list group, footer (version, language, GitHub).
- **Lobby**: full-height column — navbar (back, name/rename, mode badge, listener count,
  pin/mode/share/theme), optional chat ticker, scrolling body (56rem) with underline tabs
  (Queue | Social), and a fixed player bar at the bottom (cover, title, controls, volume,
  seek bar, times). Below 768px the controls wrap to their own row; below 400px the volume
  slider is hidden (mute stays) and the per-song YouTube button is hidden (the player keeps
  the source link).
- **Music library**: fixed full-screen layer over landing or lobby: navbar (back, title, "adding
  to" context), tabs Songs/Requested with count badges, search + sort toolbar, list group of
  songs (preview play button, Add / disabled "Added" button), 20 per page: a compact
  "‹ Page n of m ›" pager above the list and the full numbered pagination + range below it
  (both follow `?page=`, both hidden when there is one page).
- **Profile**: navbar with back; avatar + display-name card; connected-accounts card; Sign out.
- **Dashboard**: navbar (hamburger below 1024px), 15rem sidebar list group, main area with
  stat cards grid, lobbies and users list groups.
- **/admin, /youtube-playlist, /changelog**: navbar + narrow column of cards; Bootstrap and
  utilities only.

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
