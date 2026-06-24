# YouTube Downloads via yt-dlp — Setup, Architecture & Troubleshooting

How this app reliably downloads audio from YouTube **from a datacenter/VPS IP**,
which YouTube actively blocks. If downloads stop working, start here.

## TL;DR

YouTube blocks logged-out requests from server IPs. Getting past it on a VPS
takes three things working together, all wired into the Docker image and compose:

1. **A PO token** — minted by the `bgutil-provider` sidecar, proves "origin" so
   YouTube stops returning *"Sign in to confirm you're not a bot"*.
2. **A JavaScript runtime + solver scripts** — Node 22 + `yt-dlp-ejs`, so yt-dlp
   can solve YouTube's signature / n-sig challenges (otherwise no playable
   formats are returned).
3. **The right player client** — `tv`, which hands out a clean audio-only opus
   format (251). `web_safari` clears the bot wall but only offers SABR audio
   (no direct URL); `ios`/`android` are blocked.

All three are on by default in production. If it breaks, it's almost always a
**stale yt-dlp** (rebuild with a bumped cache-bust) or YouTube changing again.

## The three walls (and why each fix exists)

| Symptom (yt-dlp stderr) | Wall | Fix |
|---|---|---|
| `Sign in to confirm you're not a bot` | Datacenter IP is blocked | bgutil **PO token** sidecar |
| `Signature solving failed` / `n challenge solving failed` | No JS runtime to decrypt format URLs | **Node 22 + yt-dlp-ejs** |
| `Requested format is not available` (after signatures solve) | `web_safari` audio is **SABR-only** | **`tv` player client** + `bestaudio/best` |
| `Sign in to confirm your age` | Genuinely age-restricted | **cookies.txt** (verified account) |

> Note: the bot-check message and the age message both contain "sign in".
> `parseError()` in `backend/src/ytdlp.js` deliberately separates them into the
> `BOT_CHECK` and `AGE_RESTRICTED` codes — do not re-merge them. A `BOT_CHECK`
> is an IP problem (PO token), an `AGE_RESTRICTED` is a cookie problem.

## Architecture

```
                 docker-compose.prod.yml
  ┌────────────────────────────────────────────────┐
  │  app (Node 22)                                  │
  │   ├─ yt-dlp  ← yt-dlp-ejs (signature solver)    │
  │   │            bgutil plugin (PO token client)  │
  │   │            Node runtime (--js-runtimes node)│
  │   └─ ffmpeg (transcode → mp3)                   │
  │         │ HTTP :4416                            │
  │         ▼                                       │
  │  bgutil-provider  (mints PO tokens)             │
  │                                                 │
  │  postgres                                       │
  └────────────────────────────────────────────────┘
```

Build/runtime pieces:

- **`docker/Dockerfile`** — base `node:22-alpine` (yt-dlp's Node runtime needs
  ≥22), installs `ffmpeg`, `yt-dlp`, `yt-dlp-ejs`, and the
  `bgutil-ytdlp-pot-provider` plugin. `ARG YTDLP_CACHE_BUST` forces a fresh
  yt-dlp on rebuild when bumped.
- **`docker-compose.prod.yml`** — adds the `bgutil-provider` service
  (`brainicism/bgutil-ytdlp-pot-provider:latest`, reached at
  `http://bgutil-provider:4416` over the internal network) and sets the env
  defaults below.
- **`backend/src/ytdlp.js`** and **`backend/src/downloader.js`** — build the
  yt-dlp args from the env vars (`getPotArgs`, `getJsRuntimeArgs`,
  `getCookiesArgs`, `PLAYER_CLIENT`) and download/transcode the audio.

## Environment variables

| Var | Prod default (compose) | Code default | Purpose |
|---|---|---|---|
| `YTDLP_PLAYER_CLIENT` | `tv` | `android_vr` | Which YouTube client yt-dlp impersonates. `tv` gives audio-only opus 251. Comma-separate for fallbacks (e.g. `tv,web_safari`). |
| `YTDLP_POT_BASE_URL` | `http://bgutil-provider:4416` | *(empty = off)* | bgutil PO-token provider URL. Empty disables it (local dev). |
| `YTDLP_JS_RUNTIME` | `node` | *(empty = yt-dlp default Deno)* | JS runtime for signature/n-sig solving. `node` because Deno has no clean musl/alpine build. |
| *(cookies file)* | `/data/cookies.txt` | same | Auto-used if present. Needed only for age-restricted content. |

Code defaults are intentionally safe for **local dev** (no sidecar, no POT);
production behaviour is set entirely through the compose env vars, so you can
retune the client/runtime/POT URL from Coolify **without a code change** — only a
restart.

## Verifying it works (run inside the app container)

```sh
# 1. Versions / runtimes present
yt-dlp --version
node --version                                   # must be >= 22
pip3 show bgutil-ytdlp-pot-provider | head -2    # plugin installed

# 2. Provider sidecar reachable
wget -qO- http://bgutil-provider:4416/ping ; echo    # -> {"server_uptime":...,"version":...}

# 3. Full extraction — the real test (uses the app's exact format + client)
yt-dlp --simulate -f bestaudio/best --js-runtimes node \
  --extractor-args "youtube:player_client=tv" \
  --extractor-args "youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416" \
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

Success = `[info] ... Downloading 1 format(s): 251` (or another id) and **no**
`Signature solving failed` / `not a bot` / `not available`.

To compare clients when picking one:

```sh
for c in tv tv_simply mweb ios android; do
  echo "=== $c ==="
  yt-dlp --simulate -f bestaudio/best --js-runtimes node \
    --extractor-args "youtube:player_client=$c" \
    --extractor-args "youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416" \
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>&1 \
    | grep -iE "Downloading 1 format|not available|not a bot|sign in"
done
```

## Troubleshooting

**`BOT_CHECK` / "not a bot" is back.**
- Is `bgutil-provider` running and reachable? (`wget .../ping`). If not, the app
  silently falls back to no-POT and gets blocked.
- Version skew between the pip plugin and the `:latest` provider image — pin both
  to the same version tag and rebuild.
- IP may be hard-blocked even with POT — add a `cookies.txt` (below) or, as a
  last resort, route yt-dlp through a residential proxy.

**`Signature solving failed` / `n challenge solving failed`.**
- `node --version` < 22, or `yt-dlp-ejs` not installed → rebuild the image.
- Confirm `--js-runtimes node` is being passed (`YTDLP_JS_RUNTIME=node`).

**`Requested format is not available`** (signatures solve fine).
- The client only offers SABR audio. Use `tv` (or `tv_simply`/`mweb`). `ios` and
  `android` do **not** work for this.

**Everything breaks at once after working for months.**
- Almost always a stale yt-dlp. Bump `YTDLP_CACHE_BUST` in `docker/Dockerfile`
  and redeploy to pull the latest yt-dlp. YouTube breaks yt-dlp regularly and
  fixes usually land within days.

## Age-restricted content (cookies)

Genuinely age-restricted videos (`AGE_RESTRICTED`, not the bot-check imposters)
need a logged-in session:

1. In a browser **logged into YouTube** (use a **throwaway account** — cookies
   used from a different IP get invalidated, and you don't want your real account
   flagged), export cookies with a "Get cookies.txt (Netscape format)" extension.
2. Mount that file at **`/data/cookies.txt`** — in Coolify, add a **Persistent
   Storage → File Mount** for the `app` service (don't drop it under
   `/data/songs`, the cache-cleanup job deletes unregistered files there).

yt-dlp picks it up automatically and it rides alongside the PO token on every
call.

## Reference

- yt-dlp known issues / FAQ: https://github.com/yt-dlp/yt-dlp/issues/3766
- PO Token guide: https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
- bgutil PO token provider: https://github.com/Brainicism/bgutil-ytdlp-pot-provider
- JS runtime / EJS solver: https://github.com/yt-dlp/yt-dlp/wiki/EJS
- SABR streaming: https://github.com/yt-dlp/yt-dlp/issues/12482
