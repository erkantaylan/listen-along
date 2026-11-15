# Central login (OIDC)

listen-along can sign people in through the owner's central login (authentik,
OpenID Connect) instead of Google and GitHub. It is off until two environment
variables are set, and then it **replaces** Google and GitHub completely: no
mixed mode. Unset the variables and redeploy, and the app is back to Google /
GitHub exactly as before (the rollback).

The Google / GitHub setup for the old mode is in [OAUTH-SETUP.md](OAUTH-SETUP.md).

## What changes when it is on

- The login page shows one **Sign in** button. `/auth/google`, `/auth/github`,
  their callbacks and the `/link` routes answer 404, and
  `GET /api/auth/providers` answers `{ google: false, github: false, central: true }`.
  The profile page's "Connected accounts" card is gone, and
  `DELETE /api/profile/providers/:provider` answers 404.
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
- The old `listen_auth` cookies stop being logins. Everyone signs in once
  through the central login. An old cookie sent along with that sign-in plays
  no part in finding the account; it is simply deleted.
- With `DATABASE_URL` set but the database unreachable, sign-in answers "cannot
  be reached right now" and no session is created (in-memory accounts and
  sessions exist only when no database is configured at all, for development).
- Unchanged: CLI `la_` tokens, the Android app (Bearer tokens), the
  `/dashboard` admin password (`la_admin` cookie), and listen-along's own
  account status (approved / pending / denied / rejected). The central `roles`
  claim is stored with the session but gates nothing yet.

## Environment

| Variable | Value |
|---|---|
| `OIDC_ISSUER` | `https://<id host>/application/o/listen-along/` (turns it on, with the next one) |
| `OIDC_CLIENT_ID` | `listen-along` |
| `OIDC_CLIENT_SECRET` | empty: listen-along is a public client (PKCE). Only if the IdP is ever switched to a confidential client |
| `OIDC_SCOPES` | default `openid email profile entitlements offline_access`. Add `upstream` once the IdP has the mapping below |
| `OIDC_PROVIDER_MAP` | optional, `slug=provider,...`: upstream source slugs to listen-along provider names. `google` and `github` map to themselves; any other slug is ignored unless mapped |
| `OIDC_RECHECK_SECONDS` | default `300` |
| `OIDC_MAX_UNVERIFIED_SECONDS` | default `86400` (24 h) |
| `REGISTRATIONS_DEFAULT` | `open` (default) or `closed`: whether a central identity that matches no account gets a new one, **until an admin saves the switch in `/dashboard`**; from then on the saved value wins and this is ignored. Anything else stops the boot |
| `BASE_URL` | the public address, e.g. `https://music.example.com`. The redirect URI is `<BASE_URL>/auth/oidc/callback` and the post-logout redirect `<BASE_URL>/`; never taken from the request. Falls back to `FRONTEND_URL` |
| `SESSION_SECRET` | required in this mode. Changing it signs everyone out |
| `AUTH_RATE_LIMIT` | optional, sign-in round trips per client address per minute (default 30) |

Both compose files carry these with empty defaults. The server refuses to
start when only one of `OIDC_ISSUER` / `OIDC_CLIENT_ID` is set, when
`SESSION_SECRET` or `BASE_URL` is missing, when an `http://` issuer or
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
  `app_settings`, and the stored value wins from then on (env ignored). It can be changed while
  central login is still off, and applies from the first central sign-in. No restart needed.
  Without a database it is kept in memory. It does nothing while central login is off.

## Local development and tests

- Tests: `backend/src/central-login.test.js` runs the real server against a fake OpenID provider
  (`backend/src/fakeOidcIssuer.js`: discovery, JWKS, authorize, token with PKCE and refresh
  rotation, end-session, signed with jose).
- A session without the IdP (the central-login counterpart of `cookieFor`): with the server on
  Postgres and `OIDC_*` set, insert a row with
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

**Rollback**: unset `OIDC_ISSUER` and `OIDC_CLIENT_ID` and redeploy. Google / GitHub sign-in is back,
everyone signs in again with it, and the central-login data (`users.oidc_sub`, `user_sessions`)
stays unused. Accounts created by central login (provider `oidc`) are never turned into Google /
GitHub logins.
