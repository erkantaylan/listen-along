# Changelog

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
