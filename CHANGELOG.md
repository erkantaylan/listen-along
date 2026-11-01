# Changelog

## Unreleased

- feat(android): signed release builds, published as GitHub Releases from a tag `android-vX.Y.Z` (`listen-along-X.Y.Z.apk` plus its SHA-256). versionName and versionCode come from the tag, and every release installs over the one before. The first one is `android-v0.2.0`
- feat(web): **Android app** page at `/app`: download the latest APK with its version, size and SHA-256, how to install it (unknown sources, Play Protect, updates), and how to connect it with a token. In English and Turkish, linked from the About card and the CLI tokens card, and open to accounts still waiting for approval. `/profile#tokens` goes straight to the tokens
- feat(api): `GET /api/app/latest` reads the release from GitHub, cached for 10 minutes; when GitHub is down the page still works and links to the releases page
- feat(web): double-click a playlist in the sidebar, the rail or on the landing page, or Radio, to play it from the top. A single click still only opens it. If it is already playing it keeps going; paused, it resumes. On phones use the Play button
- fix(web): ⋮ Play on the playlist already on screen starts it right away, instead of at its next change
- feat(web): playlist pages open with a line of stats: songs, total length ("about" when only some lengths are known), artists, top artist and who added the most. It updates live and counts the whole playlist, whatever the filter shows
- change(web): long playlists stay fast. Only the rows near the view are in the page (2,500 songs: about 1,360 elements instead of 65,800, first rows in 0.23s instead of 1.5s), with the same scrollbar and sticky header. Playing, next and previous, the song menu and the filter still cover every song
- feat(web): on a song row, ↑ / ↓, Page Up / Down and Home / End move through the whole playlist; clicking the song in the player bar shows it in its playlist
- change(web): edit mode drags cross any distance, the auto-scroll speeds up as you hold it, and holding an arrow key moves a song as one move. Live edits by someone else no longer move what you are looking at
- fix(web): the song filter finds titles with `&` and quotes, and says so when nothing matches
- change(server): a playlist reorder saves in one statement instead of one per song
- feat(web): **Radio**, at the top of the sidebar and at `/radio`: every song in your own shuffled order. Opening it plays nothing; Play starts at the top, a row plays from there. No repeats until the list runs out, then a new shuffle. The order stays while it plays, also when you browse elsewhere and come back. Songs marked broken stay out. People listening along hear it, and the people panel names Radio as the source
- feat(api): `GET /api/stations/:id` and `/api/stations/:id/songs` for approved web accounts (`all` is the only station); the now-playing context may be `{ type: 'radio' }`
- feat(web): every library song has **Replace with…** in its menu (playlist rows, library, Broken tab, player bar): one dialog for its title, artist, album, YouTube link and audio file, showing why it was reported. The button says what will happen: **Save** (details only, right away, the audio plays on), **Replace from link** (a downloader fetches the new video; the song plays its old audio until then and keeps its title), **Replace** (your file, right away). A new link shows the video's title and length first and warns when the length differs a lot; a video that belongs to another song, or the song's own, is refused
- feat(api): `PATCH /api/library/:id` changes title, artist, album (same access as replace, audited as kind `details` in `library_song_replacements`; a probable duplicate name is allowed, as on replace). `POST /api/jobs/replace`, `POST /api/jobs/replace/preview`, `GET /api/jobs/replace/:songId`. `library:updated` gains `{ details }`. Worker counts gain `can_replace`
- feat(workers): replace jobs. `la worker` 0.2.0 advertises the `replace` capability in its hello; older workers are never sent one, so with no capable worker the job waits. The song is replaced under its id (audit row, reports closed, old file deleted, players reload), the server keeps the requested details and video whatever the worker sends, and a duplicate file or a deleted song is a failed job with a clear error. One active job per song (409 `replace_job_active`)
- fix(api): `GET /api/library/:id/replacements` no longer returns account and token ids
- feat(web): the playlists sidebar and the chat panel can be resized by dragging their divider (or with the keyboard: arrows, Home, End, Enter), and the widths are saved in this browser. Sidebar 200-420px, and dragged below 200 it snaps to the 72px rail; chat 280-420px. A small window narrows them for the moment and never overwrites what you saved. Double-click resets
- feat(web): the playlists sidebar has filter chips (All, Mine, Public, Private) and a sort menu (Name A-Z in Turkish alphabet order, Date created). Pinned stays on top, search combines with both, and the choices are remembered in this browser. The rail keeps the sort and lists everything
- change(web, android): no more coloured edge bars. Selected, playing and current rows are a background tint with a stronger title; success and error toasts are a tinted fill; in the library rail the current playlist is a solid avatar and a pinned one a tinted avatar
- feat(web): the playlists sidebar collapses to a 72px rail of initials (pinned first, new playlist, tooltips, right-click menu) with a toggle that is remembered; automatically when the page column would drop under 616px
- change(web): the chat panel stays docked down to 1010px wide (it was 1200px), 280px wide below 1200px, by collapsing the library first; below that the chat button still opens it full-screen. The page column never goes under 416px from 768px up
- feat(web): playlist pages show a song table: #, title and artist, added by, added, duration, with a sticky header and ⋮ on hover. # turns into play on hover and focus. Added and Added by drop as the page column narrows; phones keep a compact row. The song list uses the full width on wide screens
- feat(api): socket queue entries carry an additive `artistName`; nothing else changes for the CLI and the app
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
