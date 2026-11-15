# Central login (OIDC)

listen-along signs people in through the owner's central login (authentik,
OpenID Connect). It is the **only** sign-in: the old Google / GitHub login and
account linking were removed once the central login was live. In production
(`NODE_ENV=production`) the server refuses to start without it. Local
development and the tests use a fake IdP or the dev sign-in instead (see
[Local development and tests](#local-development-and-tests)).

## How it works

- The login page shows one **Sign in** button. `/auth/google`, `/auth/github`,
  their callbacks and the old `/link` routes answer 404, and
  `GET /api/auth/providers` answers `{ central: true, dev: false }`.
  `DELETE /api/profile/providers/:provider` is gone (404).
- Sign-in is the authorization code flow with PKCE (S256), `state` and `nonce`
  (openid-client v6). The id_token's issuer, audience (exactly `listen-along`;
  an extra audience or another `azp` is refused), signature (against the IdP's
  JWKS; `alg: none` and HS256 are refused), expiry and nonce are checked. Any
  mismatch lands on the login page with a generic "Sign-in did not work".
- The browser gets an opaque session cookie (HttpOnly, SameSite=Lax, 30 days):
  `__Host-la_session` in production (Secure, Path=/, no Domain), `la_session`
  on plain http (local dev). The short-lived sign-in flow cookie is named the
  same way (`__Host-la_oidc_flow` / `la_oidc_flow`). The session lives on the
  server (`user_sessions`): only the SHA-256 of the cookie's id is stored, and
  the refresh token and id_token are encrypted (AES-256-GCM, key derived from
  `SESSION_SECRET` with HKDF). Sockets authenticate from the same session.
- Every 5 minutes of use (and on a timer for open sockets) the session is
  re-checked with the refresh token (3 s timeout):
  - `invalid_grant` (the account was disabled centrally, the token revoked or
    expired), or an answer whose id_token does not validate or names another
    user: the session ends and its sockets are disconnected;
  - any other OAuth error (`invalid_client`...: a misconfiguration): the
    session is kept and the log says `CONFIGURATION PROBLEM`;
  - no answer (network, 5xx, 429): the session is kept, that session is not
    re-checked again for 5 minutes and nobody's for 30 seconds, so an outage
    does not slow requests down; after **24 hours** without a successful check
    the session ends anyway.
- Sign out ends the local session, then sends the browser to the IdP's
  end-session page (`id_token_hint`, back to `/`), which ends the central
  session too.
- The old Google / GitHub `listen_auth` cookies are no logins. An old cookie
  sent along with a sign-in (or a logout) plays no part in finding the account;
  it is simply deleted.
- With `DATABASE_URL` set but the database unreachable, sign-in answers "cannot
  be reached right now" and no session is created (in-memory accounts and
  sessions exist only when no database is configured at all, for development).
- The Android app signs in through the same flow and gets the same kind of
  server-side session (see [The Android app](#the-android-app)).
- Unchanged: CLI `la_` tokens, the
  `/dashboard` admin password (`la_admin` cookie), and listen-along's own
  account status (approved / pending / denied / rejected). The central `roles`
  claim is stored with the session but gates nothing yet.

## The Android app

The app signs in with the same client (`listen-along`, public, PKCE) and ends
up with a server-side session like a browser's, carried as a Bearer token
instead of a cookie (`backend/src/mobileAuth.js`). The server, not the app,
talks to the IdP's token endpoint; the app never holds an IdP token.

1. The app makes `state`, `nonce` and a PKCE verifier (32 random bytes each)
   and keeps them encrypted until the redirect comes back. It picks the
   redirect (below) and opens a Custom Tab on
   `GET <server>/auth/mobile/start?state&nonce&code_challenge&code_challenge_method=S256&redirect_uri=<redirect>`.
2. The server checks `redirect_uri` against a fixed allowlist of exactly two
   values and redirects to the IdP's authorize endpoint with it, the server's
   scopes and a nonce derived from the app's (below). The IdP sends the
   browser back to that URI with `code` and `state`; Android hands it to the
   app (`auth/AuthRedirectActivity`). The app checks that it came back on the
   redirect it asked for and with its own `state` (anything else is refused).
3. `POST <server>/auth/mobile/exchange` `{ code, state, code_verifier, nonce, iss?, redirect_uri? }`.
   The server exchanges the code at the token endpoint (public client, the
   same redirect URI, the app's verifier), validates the id_token exactly as
   the web callback does (signature against the JWKS, issuer, audience
   exactly `listen-along`, no foreign `azp`, expiry, and the **nonce derived
   from the app's nonce and the redirect** (a consistency check, below)), links the account with the rules above, logs the same
   `central-login: link ...` line with `client=app`, and creates a row in
   `user_sessions` (refresh token and id_token encrypted, 30 days, re-checked
   with the refresh token like any session). Answer:
   `{ token: "lam_...", token_type: "Bearer", expires_at, mode: "central", user: { id, name, status } }`.
4. The app stores the token encrypted (EncryptedSharedPreferences) and sends
   `Authorization: Bearer lam_...` on every API call.

### The redirect

An https App Link, with the custom scheme kept only for the transition. The
two redirects (`backend/src/mobileAuth.js`, `readMobileConfig`; the app picks
one in `auth/AuthFlow.redirectFor`):

| `redirect_uri` | Who gets the code | Used by |
|---|---|---|
| `<BASE_URL>/auth/mobile/callback` (production: `https://music.etaylan.com/auth/mobile/callback`) | only the app signed with the key listed in `<BASE_URL>/.well-known/assetlinks.json` (an Android App Link, `autoVerify`) | release builds after 0.4.0, when the configured server is `https://music.etaylan.com` |
| `com.etaylan.listen:/oauth2redirect` | **any** installed app that registers the scheme | app 0.4.0 and older (they send no `redirect_uri`: missing = this one), debug builds, release builds pointed at any other server |

Why: a malicious app can register the custom scheme, start its own sign-in
(with its own PKCE verifier, so PKCE does not help) and, if the IdP signs the
victim in silently from an existing browser session, receive a code for the
victim's account. An https App Link is handed only to the app whose signing
certificate the site lists. **The risk is closed only when the custom scheme
is removed from the IdP client's registered redirect URIs** (then the IdP
issues no code to it at all); until then any app can still run that attack
against the IdP directly, whatever this server does (below). Anything other than the two values (another
host, the web callback, a trailing slash, the value twice) is refused at
start (a 400 page) and at the exchange (`invalid_request`), before the code is
spent. The https one is built from `BASE_URL`, never from the Host header.

**The derived nonce: a consistency check, not a binding.** The IdP is not
given the app's nonce but `HMAC-SHA256(key, redirect + "\n" + nonce)`, the key
derived from `SESSION_SECRET` with HKDF (purpose `listen-along/mobile-nonce/v1`,
as `secretBox.js` derives its keys), and the exchange expects exactly that in
the id_token. What it gives: start and exchange must name the same redirect,
and the nonce must have come out of `/auth/mobile/start` (an authorize request
with a nonce of the caller's own fails). What it does **not** give: it is no
secret (it is in `/start`'s `Location` header, for anyone who asks) and no
proof of the redirect the IdP actually sent the code to. authentik (2026.8,
`check_redirect_uri`) only verifies that the token request's `redirect_uri`
is one of the registered ones, not that it is the one the code was issued
for (RFC 6749 4.1.3), and the id_token says nothing about the redirect. So
while the scheme is registered at the IdP, an app holding it can ask `/start`
for the https redirect, copy the derived nonce into its own authorize request
on the scheme (its own PKCE), catch the victim's code and exchange it naming
the https redirect; the server accepts it, with `MOBILE_CUSTOM_SCHEME=off`
too (`mobile-auth.test.js`, "THE LIMIT"). There is no server-only fix; the
removal at the IdP is the fix. A sign-in started before a server version that
changes the derivation and finished after it fails once (tap Sign in again).

**`/.well-known/assetlinks.json`** (public, `application/json`, cached 5
minutes): one statement, `delegate_permission/common.handle_all_urls` for
`com.erkantaylan.listenalong` with the release certificate's SHA-256
(`DD:B6:D8:FE:…:C3:F5`, from the signed APK of the `android-v0.3.0` release:
`apksigner verify --print-certs`). `ANDROID_APP_PACKAGE` /
`ANDROID_APP_CERT_SHA256` replace them (below). Debug builds (`.debug`, a
per-machine debug key) are not listed and keep the custom scheme; list one
only deliberately, through the variable.

**`GET /auth/mobile/callback`** is never requested when Android has verified
the link: it opens the app directly. When it has not (verification pending
or failed, the app not installed, a desktop browser), the browser loads it: a
static page (English and Turkish, no sign-in, no-store, `Referrer-Policy:
no-referrer`, its query hidden in the access log) whose button opens
`intent://<host>/auth/mobile/callback?<the same query>#Intent;scheme=https;package=com.erkantaylan.listenalong;S.browser_fallback_url=<BASE_URL>/app;end`.
The query is read by the page's script from `location.search`; the server
never echoes the code, exchanges it or sends it anywhere (it is useless
without the app's verifier). An `intent:` link with the package works from a
Custom Tab whether or not the domain is verified, and only this package can
take it; a plain link to the same https URL would stay in the browser (same
host). Without the app, Chrome opens `/app`.

**Android 8–11 (a known limit; minSdk stays 26).** Android 12+ sends an https
link whose domain is not verified for an app only to the browser. Before 12,
an app with an unverified intent filter for `music.etaylan.com` can be offered
in a chooser next to ours for the link, so a user could pick it and hand it
the code. On those versions the App Link protects only while verification
succeeded for our app (then Android opens it without asking).

**Removing the custom scheme: the step that closes the risk.** Once the App
Link version of the app is installed everywhere that matters, do both
together:

1. remove `com.etaylan.listen:/oauth2redirect` from listen-along's
   `static_redirects` in the central-login catalog (`idp/catalog.py`),
   re-render (`python3 idp/catalog.py`), commit, redeploy the IdP (the worker
   logs `central-login: blueprint applied`). **This is the fix:** the IdP then
   refuses to send a code to the scheme at all;
2. set `MOBILE_CUSTOM_SCHEME=off` here and redeploy: the server-side companion.
   An old app (no `redirect_uri`, or the scheme) then gets an "Update the app"
   page at start and `invalid_request` ("install the latest version") at the
   exchange instead of an IdP error. On its own it closes nothing.

Consequence: debug builds, and release builds pointed at any server other than
`https://music.etaylan.com`, use the custom scheme, so after the removal **a
debug build can no longer sign in against the production IdP**. Develop
against a server with `INSECURE_DEV_LOGIN` (or the stub, or a fake / your own
IdP that registers the scheme); self-hosted servers need their own IdP client
with the scheme registered.

**Going live, in order:**

1. The central-login catalog registers `<LISTEN_ALONG_URL>/auth/mobile/callback`
   (the scheme stays), redeployed. The https callback **must be registered at
   the IdP before any app that uses it ships**, or that app's sign-in fails at
   the IdP.
2. This server is deployed (serves `assetlinks.json`, accepts both redirects).
3. The new app release.
4. Later, once it is installed everywhere: the scheme removed at the IdP and
   `MOBILE_CUSTOM_SCHEME=off` here, together (above).

Errors from the exchange are `{ error, code }`: `invalid_request` (400),
`signin_failed` (400: wrong, reused or expired code, a verifier that does not
fit, any id_token check, the nonce included), `account_disabled` and
`registrations_closed` (403), `link_conflict` (409), `signin_unavailable`
(503: the IdP or the database cannot be reached), 429 from `AUTH_RATE_LIMIT`
(per client address, its own budget). A code is refused the second time
before the IdP is asked (in memory, 10 minutes: one instance, as already
required), unless the attempt ended 503 `signin_unavailable` (undecided: the
app may retry with the same code). The access log hides the query of
`/auth/mobile/start` and `/auth/mobile/callback` (as the web callback's). With `DATABASE_URL` set but no database, the exchange answers 503
before the code is spent.

**The session**: `lam_` + 32 random bytes; the server stores only the SHA-256
of the whole string (so a cookie id is never a valid Bearer, nor the reverse).
`userAuth.js` resolves it for HTTP requests only (sockets stay cookie-only;
the app has none). When a `lam_` Bearer is sent it is the only identity
looked at. It reaches what a signed-in browser reaches at the same account
levels (`policyFor` unchanged: approved for the API, pending for the member
routes); the CLI-only routes (upload, check, `la` self-update, request
dismiss) answer 403 `TOKEN_REQUIRED`, and admin stays the `la_admin` cookie.
An unknown, expired, signed-out, re-check-ended or banned session answers
**401 `SESSION_ENDED`**; that, and nothing else (not a bare 401 or a 401
`AUTH_REQUIRED` from some other route), sends the app back to Sign in.
A 503 (database or IdP down) never does. `GET /api/me` with the session
answers `{ name, user: { id, name, status }, session: { kind: "app" } }`
(pending accounts too).

**Sign out**: `POST /auth/mobile/logout` with the Bearer deletes the session
(and with it the refresh token). The IdP's browser session in the phone's
browser is left alone, on purpose, so signing in again is a tap; signing out
of the central login itself happens on the web or at the IdP. Signing in again
while holding a session (sent along as the Bearer to the exchange) ends the
old one.

**Development**: against a server with `INSECURE_DEV_LOGIN=1`,
`/auth/mobile/start` shows a "Continue as Dev User" page (or `?user=<users.id>`)
whose link goes straight back to the app with a signed one-time code; the
exchange checks the PKCE verifier and the nonce against it and answers
`mode: "dev"` with a stateless signed token (30 days). The redirect allowlist
and the derived-nonce check apply there too (the https one only when `BASE_URL` is set). Release builds of the
app refuse a `dev` session; production servers refuse to start with the dev
sign-in. The app's stub server (`android/tools/stub_server.py`) does the same.
Against a fake IdP (`node src/fakeOidcIssuer.js`) the real flow works too; the
phone must reach both the server and the fake IdP (e.g. `adb reverse` for both
ports, `BASE_URL`/issuer on `localhost`).

Tests: `backend/src/mobile-auth.test.js` (fake IdP, with and without Postgres).

## Environment

| Variable | Value |
|---|---|
| `OIDC_ISSUER` | `https://<id host>/application/o/listen-along/` (required in production, with the next one) |
| `OIDC_CLIENT_ID` | `listen-along` |
| `OIDC_CLIENT_SECRET` | empty: listen-along is a public client (PKCE). Only if the IdP is ever switched to a confidential client |
| `OIDC_SCOPES` | default `openid email profile entitlements offline_access`. Add `upstream` once the IdP has the mapping below |
| `OIDC_PROVIDER_MAP` | optional, `slug=provider,...`: upstream source slugs to listen-along provider names. `google` and `github` map to themselves; any other slug is ignored unless mapped |
| `OIDC_RECHECK_SECONDS` | default `300` |
| `OIDC_MAX_UNVERIFIED_SECONDS` | default `86400` (24 h) |
| `REGISTRATIONS_DEFAULT` | `open` (default) or `closed`: whether a central identity that matches no account gets a new one, **until an admin saves the switch in `/dashboard`**; from then on the saved value wins and this is ignored. Anything else stops the boot |
| `BASE_URL` | the public address, e.g. `https://music.example.com`. The redirect URI is `<BASE_URL>/auth/oidc/callback` and the post-logout redirect `<BASE_URL>/`; never taken from the request. Falls back to `FRONTEND_URL`; one of the two is required |
| `SESSION_SECRET` | required. Changing it signs everyone out |
| `AUTH_RATE_LIMIT` | optional, sign-in round trips per client address per minute (default 30) |
| `MOBILE_CUSTOM_SCHEME` | `on` (default) or `off`: whether this server still accepts the custom-scheme redirect `com.etaylan.listen:/oauth2redirect` (app 0.4.0 and older). Set it **off together with removing the scheme from the IdP client**, which is what actually closes the risk; `off` alone only turns old apps away politely ([The redirect](#the-redirect)). `off` without `BASE_URL` stops the boot |
| `ANDROID_APP_PACKAGE` | optional, default `com.erkantaylan.listenalong`: the package in `assetlinks.json` and the fallback page's intent |
| `ANDROID_APP_CERT_SHA256` | optional, comma-separated SHA-256 signing-certificate fingerprints (hex, colons optional) for that package; `package=FINGERPRINT` names another package. Replaces the built-in release fingerprint (so after a key rotation list the new one, and the old one while old installs remain). A malformed value stops the boot |

Both compose files carry these with empty defaults. The server refuses to
start with `NODE_ENV=production` when `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`SESSION_SECRET` or both `BASE_URL` and `FRONTEND_URL` are missing, or `INSECURE_DEV_LOGIN` is set; and
anywhere when only one of `OIDC_ISSUER` / `OIDC_CLIENT_ID` is set, when no
sign-in at all is configured, when an `http://` issuer or
`BASE_URL` is used in production, when `REGISTRATIONS_DEFAULT` is neither
`open` nor `closed`, or when the IdP answers discovery with metadata that
cannot work (another issuer, not JSON, no token endpoint, no S256). An IdP that
does not answer at boot (or answers 404 / 5xx, as Traefik does while the IdP
restarts) does not stop the server: sign-in shows "cannot be reached right
now" and retries discovery on the next attempt. One consequence: a mistyped
issuer *path* is not caught at boot; it shows up as that message and a
`[oidc] ... failed` line in the log on every sign-in attempt.

The app must run as one instance (as it already must): the re-check's
single-flight lock is in memory.

## The claim contract

From the validated **id_token** (authentik's `include_claims_in_id_token`,
already on for every app in the catalog; there is no userinfo call):

| Claim | Use |
|---|---|
| `sub` | the user's central id (`sub_mode: user_uuid`), stored as `users.oidc_sub` |
| `email`, `email_verified` | linking by email only when `email_verified` is the boolean `true`; a new account stores the address only then |
| `name`, else `preferred_username` | the display name (see below) |
| `roles` | stored with the session, not used yet |
| `upstream_identities` | optional (scope `upstream`; the owner adds it on the IdP): an array of `{ "provider": "<source slug: google, github, ...>", "id": "<the upstream account id as a string: Google sub, GitHub numeric id>" }`, one per upstream account connected to the central user. Absent = empty. At most 20 are read. When `OIDC_SCOPES` asks for `upstream` and a token has no such claim at all, the log warns once (`central-login: WARNING the id_token has no upstream_identities ...`) and every sign-in line says `upstream=MISSING(#n)` |

## Which account a sign-in lands on

At the callback, after the token is validated, in this order:

1. **a.** the user whose `oidc_sub` is this `sub`;
2. **b.** `upstream_identities`: an exact match on `user_providers(provider, provider_id)` or the
   legacy `users.provider` / `users.provider_id`. If any matching user is **already linked to
   another `sub`**, the sign-in is refused ("could not be linked, contact the administrator") and
   the log warns with both ids: it is either a takeover attempt or a second central account for
   the same person, and it must not quietly become a new account. Otherwise one user is linked;
   several unlinked users: the **earliest created** is linked, and a warning names the others for
   the owner to merge by hand; rows are never merged automatically;
3. **c.** email: only with `email_verified === true`, and only if exactly **one** unlinked user has
   that address **from Google** (a `google` row in `user_providers`, or `users.email` of a user
   whose legacy provider is `google`; case-insensitive). The old Google / GitHub login stored
   GitHub addresses whether GitHub had verified them or not, so those never count. None or
   several: no link by email. This rule trusts the IdP to set `email_verified` only for addresses
   a source (or the owner) has verified, which is what the catalog's `email` mapping does;
4. **e.** otherwise a new `approved` account, unless registrations are closed (then the person sees
   "Registrations are closed" and nothing is created).

There is no rule that uses the old `listen_auth` cookie: every legacy account is a Google or GitHub
account, so rule b finds it once the `upstream` claim is there.

In every case a found or linked account that is **denied or rejected** is refused ("Your account
has been disabled"); the link is kept, so the ban sticks to that central identity. Everything runs
in one transaction under a per-`sub` lock, a link only stamps a row whose `oidc_sub` is still NULL,
and `users.oidc_sub` is unique: two callbacks at once cannot create two accounts or link one `sub`
to two users (the loser of a race for one legacy account is refused, not given a new one).

Every sign-in logs one line, never tokens or email addresses:

```
central-login: link rule=b user=<users.id> linked sub=1a2b3c4d… upstream=2
central-login: link rule=a user=<users.id> signed-in sub=1a2b3c4d… upstream=2
central-login: link rule=e user=<users.id> created sub=1a2b3c4d… upstream=MISSING(#3)
central-login: refused rule=e reason=registrations_closed user=- sub=1a2b3c4d… upstream=0
```

**Name**: a display name the person chose on their profile is kept. If they never chose one (or it
is still the provider's name, unchanged), it follows the central name. The avatar is kept (the IdP
sends none).

## Banning and the registrations switch

- **Ban**: `/dashboard` → Users → **Reject** (status `rejected`; `denied` from
  `POST /api/auth/users/:id/status` works the same). At once: every session of that account is
  deleted, its sockets are disconnected, its CLI tokens stop (a token needs an approved owner), and
  signing in again is refused with "Your account has been disabled"; no new account is made for
  them. **Approve** undoes it; they sign in again.
- **Registrations**: `/dashboard` → Users → **Allow new accounts** (`GET|PUT /api/admin/settings
  { registrations_open }`, admin cookie only). Off: a central identity that matches no account
  (rules a-c) is turned away; existing accounts, linked or not yet linked, are unaffected. Until it
  is saved once, its value is `REGISTRATIONS_DEFAULT` and the dashboard says so; saving stores it in
  `app_settings`, and the stored value wins from then on (env ignored). No restart needed.
  Without a database it is kept in memory. It does nothing under the dev sign-in.

## Local development and tests

There is no password login. Two ways to sign in without the owner's IdP:

- **A fake IdP** (the real protocol, end to end): from `backend/`,
  `node src/fakeOidcIssuer.js` starts a local OpenID provider (port 9400; `--sub`, `--email`,
  `--name`, `--port` to change the one user it signs in) and prints the variables to start the app
  with (`NODE_ENV=development OIDC_ISSUER=http://127.0.0.1:9400/application/o/listen-along/
  OIDC_CLIENT_ID=listen-along BASE_URL=http://localhost:3000 SESSION_SECRET=dev`). Plain http
  issuers are accepted only outside production. `central-login.test.js` runs the real server
  against the same fake provider (discovery, JWKS, authorize, token with PKCE and refresh rotation,
  end-session, signed with jose).
- **The dev sign-in** (`INSECURE_DEV_LOGIN=1`, `backend/src/devLogin.js`): no IdP at all. The
  server refuses to start with it unless `NODE_ENV` is exactly `development` or `test`, and when
  `OIDC_ISSUER` / `OIDC_CLIENT_ID` are set too; neither compose file passes it through. The login
  page's button then goes to `/auth/dev/login?user=<users.id>&next=<path>` (without `?user`: a
  "Dev User" account, made once; without a database: the id `dev`), which sets a signed
  `la_dev_login` cookie (HMAC with `SESSION_SECRET` under its own label, 30 days). The tests sign
  it directly: `testServer.js` `cookieFor`, and `startServer()` turns the dev sign-in on unless the
  test configures central login.
- A central session without the IdP (the central-login counterpart of `cookieFor`): with the server
  on Postgres and `OIDC_*` set, insert a row with
  `node -e "require('./src/testServer').centralSessionCookie(process.env.DATABASE_URL, '<users.id>').then(console.log)"`
  (from `backend/`) and send the printed `la_session=...` as the cookie (local http only; in
  production the name is `__Host-la_session`). It has no refresh token, so it is not re-checked and
  lasts until `OIDC_MAX_UNVERIFIED_SECONDS`.

## Go-live checklist

**Central side (owner)**

1. Add a scope mapping `upstream` that returns
   `{"upstream_identities": [{"provider": <source slug>, "id": <upstream id as a string>}, ...]}`
   for every source connection of the user (Google: the Google `sub`; GitHub: the numeric user id),
   and attach it to the listen-along provider.
2. Register listen-along in production: set `LISTEN_ALONG_URL` in the IdP's variables so the
   catalog registers the strict redirect `${LISTEN_ALONG_URL}/auth/oidc/callback` and the logout
   redirect `${LISTEN_ALONG_URL}/`; check it is a **public** client with
   `authorization_code` + `refresh_token`.
3. Check the provider has a **signing key** (an RSA certificate, e.g. "authentik Self-signed
   Certificate"). Without one authentik signs id_tokens with HS256, which listen-along refuses, so
   every sign-in fails (closed, but nobody gets in).
4. Confirm the Google and GitHub sources are live, and that your own central account has both
   connected (Settings → Connected services), so `upstream_identities` lists them.

**App side (Dokploy)**

5. **Before the first deploy in central mode**, set `REGISTRATIONS_DEFAULT=closed`. With
   registrations closed an identity that matches no existing account is refused, not created, so
   nothing irreversible happens if the `upstream` claim is missing or wrong.
6. Set (or check) `OIDC_ISSUER=https://<id host>/application/o/listen-along/`,
   `OIDC_CLIENT_ID=listen-along`, `OIDC_SCOPES=openid email profile entitlements offline_access upstream`,
   `BASE_URL` (https, the public address) and `SESSION_SECRET`. Deploy. The log says
   `[oidc] central login on: issuer ...`.
7. Sign in once yourself. The log must show
   `central-login: link rule=b user=<your users.id> linked ... upstream=<n>` (or `rule=a ...
   signed-in` on a later sign-in), and you must land in your existing account (your playlists are
   there; `/dashboard` → Users shows "central login" on it). If the line says
   `upstream=MISSING` or `refused rule=e reason=registrations_closed`, fix the IdP mapping (step 1)
   before going on; nothing was created meanwhile.
8. Only then turn **Allow new accounts** on in `/dashboard` → Users. This is saved in the
   database and overrides `REGISTRATIONS_DEFAULT` from then on (you can leave the variable set).
9. Watch the log for `merge by hand`, `link_conflict` and unexpected `created` lines as friends
   sign in.

**Rollback**: there is no environment switch back to Google / GitHub any more: that code is gone,
and production refuses to start without `OIDC_*`. To undo a bad release, redeploy the previous
commit. The data needed by rules b and c (`users.provider` / `provider_id` / `email` and
`user_providers`) is kept untouched, so people who have not signed in through the central login
yet are still found on their first sign-in.
