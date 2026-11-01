# Changelog

## Unreleased

- change(web): the player bar uses the full window from 768px, in three zones: cover and song at the far left, transport over the seek bar in the middle (times beside it, Play in the exact centre, repeat moved to the right of next), and the chat button to the right of the volume at the far right. It is about 14px shorter; phones keep their slim form
- fix(web): a collapsed chat and people panel has a visible way back: a labelled rail at the right edge with **Chat** and **People**, from 1024px. Since the panel started docking at 1200px, windows of 1024-1199px had only the small chat icon in the player bar
- feat(web): whoever is also signed in to the app gets the chat and people panel on `/dashboard`
- change(admin): the `/admin` page moved into `/dashboard` (Downloaders, Download jobs, Broken songs, CLI tokens, Song requests, Library); `/dashboard` has its own login form and `/admin` redirects to it
- fix(web): dashboard overview cards no longer wrap: wider cards, and private counts, file counts and unregistered files sit on their own small lines
- feat(web): song menu (right-click, long-press, ⋮) has **Add to playlist**: a submenu on desktop and a bottom sheet on phones, with Turkish-aware search, pinned first, and New playlist that creates and adds without leaving the page
- change(web): the source link moved from library rows and the player bar into the song menu (**Open on YouTube**, **Copy link**), so rows are shorter on phones
- change(web): version, changelog and GitHub live in one place, the About card at the bottom of the profile page; they left every navbar and the line above the player, which gives the playlist queue that height back
- fix(web): clicking away from a song menu with a mouse no longer plays the row under the pointer
- fix(web): a song uploaded while the page is open can be used from the song menu without a reload
- feat(android): downloads survive a reinstall or data clear: files in Music/ListenAlong are recognised by name and duration instead of being downloaded again as `Name (1).m4a` (optional music access permission; deleting such a file asks for consent)
- feat(cli): `la upload` / `la download` show upload percent on a terminal; files are streamed from disk with a byte count
- fix(cli): uploads no longer hold the whole file in memory (a 600 MB file: 669 MB of memory before, 77 MB now)
- change(cli): an upload to a server URL that redirects fails with a clear message (code `REDIRECTED`); use the final address
- feat(workers): `la worker` reports upload percent, shown live on the Download tab to whoever asked for the song
- fix(web): the chat panel docks beside the page only from 1200px; below that the chat button opens it full-screen, so it no longer squeezes the page
- fix(web): library rows keep their title readable in a narrow column: the buttons go under the text (320px, and tablets beside the sidebar)
- fix(web): the landing title no longer collapses under its buttons; the header wraps and the library button folds to its icon by the room in the page column
- fix(web): profile activity tabs stay on one line with shorter labels (Fulfilled, Downloaders) and scroll sideways on phones
- fix(web): the page column no longer narrows at 1280px; the wider playlists sidebar starts at 1440px
- fix(web): no empty strip beside the chat and player with classic scrollbars; with a mouse the page column scrolls instead of the document
- fix(web): pressed buttons look pressed instead of keeping the hover colour
- fix(web): radio borders and faint text in dialogs and the person card now meet WCAG contrast
- fix(web): library tabs stay on one line and scroll sideways on narrow phones, as the profile tabs do
- fix(web): on touch, the tap that closes a song menu no longer also plays the row under it
- fix(web): larger touch targets on phones: song menu, broken-song icon, navbar buttons and the seek bar

## v2.31.0 (2026-10-31)

### Music library and CLI
- feat(library): the server no longer downloads audio; songs are uploaded as m4a by the `la` CLI with per-user tokens, and anything not in the library becomes a song request
- feat(library): duplicate detection (YouTube id, file hash, normalized metadata) and replacing a song's audio under the same id
- feat(library): mark songs as broken (needs replacement) from the song context menu
- feat(cli): `la playlist`, `--playlist` on download/upload, `la pull`, and `la worker`
- feat(workers): downloaders on users' machines take download jobs from the server; web Download box, live job status, admin view

### Playlists and social
- change(playlists): lobbies are now playlists, with an owner and public or private visibility enforced on the server
- change(playlists): renaming is owner-only; ownerless playlists can be renamed by an admin only
- feat(playlists): click a row to play, Edit mode for reorder and remove
- feat(playlists): left sidebar listing your playlists with search (Turkish-aware) and per-user pins synced across devices; a drawer on phones
- feat(social): one global chat and a people panel with presence and now playing; per-playlist chat removed
- feat(social): listen along follows a user instead of a playlist
- remove: Jam (synchronized) lobbies and the listening-mode toggle

### Accounts and security
- change(auth): login and account status enforced on every route and socket; a restart never changes a status
- change(tokens): CLI tokens belong to user accounts, created and revoked on the profile page
- change(admin): dashboard and admin share one login (`ADMIN_USER` / `ADMIN_PASSWORD`)
- fix(security): escape quotes in `escapeHtml`, fix unescaped HTML sinks
- fix(rate-limit): key on the real visitor behind Cloudflare + Traefik

### Web and Android
- feat(ui): redesign on stock Bootstrap 6 with a dark grey theme, elevation scale and clearer buttons; every view has a URL; app-wide player bar that keeps playing across pages
- feat(ui): landing page leads with your playlists; playlist menus; public `/youtube-playlist` page
- feat(ui): web version and GitHub link visible on all main pages (navbar on landing, profile and library; a slim line above the player bar on playlists)
- feat(ui): profile activity is paged, 10 per page on every tab, and reaches past the old limit of 100
- feat(android): new Android app with library, playlists, Media3 background playback, offline mode, downloads and broken-song reports
- feat(android): About card in Settings with the app version and a GitHub button

### Server
- feat(health): `/health` no longer spawns yt-dlp; reports event-loop and threadpool delay
- feat(version): `/api/version` reports the deployed commit
- fix(stability): crash guards, pool error handler, child-process watchdogs
- chore(deps): dependency security bumps

## v2.30.1 (2026-05-21)

- feat(player): mobile touch ergonomics for the sticky player — 44px+ tap targets, grabbable progress/volume sliders, volume/repeat/shuffle stay reachable on small phones, sub-360px layout, larger track/artist text (CSS only; desktop unchanged)

## v2.30.0 (2026-05-21)

### Lobbies
- feat(lobbies): lobbies now have a persistent creator (`host_id` set from the authenticated user); anonymous lobbies remain ownerless
- feat(lobbies): public by default, with a creator-only toggle to make a lobby private; private lobbies are hidden from non-owners in listings
- feat(lobbies): creator-only delete with a confirmation dialog (naming the lobby)
- change(lobbies): removed time-based auto-expiry — idle lobbies are no longer deleted after 24h; deletion is now explicit only

### Playlists removed
- revert(playlists): remove the personal-playlist feature entirely (shipped in v2.29.0 by mistake)
- remove: playlist tables, API endpoints, solo player, and playlist-URL import (Spotify/YouTube); idempotent migration drops `playlists`/`playlist_songs`
- internal: replace yt-dlp `--no-playlist` flag with URL `list` param stripping so single-video downloads are unaffected

## v2.29.0 (2026-05-20)

- feat(playlists): playlists are now public by default; creators can make them private
- feat(playlists): home page defaults to "All public" filter; users can switch to "Mine"
- feat(playlists): delete button is creator-only and prompts for confirmation
- feat(playlists): privacy toggle (creator-only) with lock indicator for private playlists
- fix(playlists): playlist endpoints now derive user from authenticated session, not request body (security fix)
- refactor(playlists): rename `playlists.user_id` column to `created_by`; add `is_public` column with idempotent migration

## v2.25.0 (2026-03-16)

- feat: add Google and GitHub OAuth login
- feat: add login page with provider buttons
- feat: add user management and manual approval on dashboard
- fix: sync currentIndex in all queue:update emissions
- fix: track shuffle history for correct previous song navigation

## v2.24.0 (2026-03-10)

- fix: replace insecure Math.random() with crypto APIs and fix tainted format strings
- fix: sanitize path traversal and open redirect vulnerabilities
- feat: add follow-a-friend in independent lobby
- feat: add unused song visibility and filtering to dashboard
- feat: add song mention support in Social chat
- feat: add clear queue button
- feat: add YouTube source link on songs
- fix: set currentIndex when first song added via queue:add
