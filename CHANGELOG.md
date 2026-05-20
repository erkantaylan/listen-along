# Changelog

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
