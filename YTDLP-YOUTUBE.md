# YouTube, yt-dlp and where songs come from

## TL;DR

**The server no longer downloads audio from YouTube.** The production server's
IP kept getting blocked ("Sign in to confirm you're not a bot"), so downloading
moved to the **listen-along CLI** (`cli/`), which runs on a home machine (a
residential IP YouTube does not block), downloads songs as **m4a (AAC)** and
uploads them to the server's **music library**.

The server is now a library host:

```
  home machine                          server (docker-compose.prod.yml)
  ┌──────────────────────┐   HTTPS     ┌────────────────────────────────────┐
  │ listen-along CLI      │──────────▶ │ app (Node 22)                       │
  │  yt-dlp + ffmpeg      │  Bearer    │  POST /api/library/upload (m4a)     │
  │  GET /api/requests    │  token     │  ffprobe validation (AAC in MP4)    │
  │  POST .../upload      │            │  library_songs + files in SONGS_PATH│
  └──────────────────────┘            │  postgres                           │
                                       └────────────────────────────────────┘
```

## What the server still does with YouTube (metadata only)

yt-dlp is still installed in the image, but only for **metadata**, never audio:

| Use | How | Bot wall? |
|---|---|---|
| Resolve typed text to a video id | `yt-dlp --flat-playlist -J ytsearch1:<text>` | Search page only — usually fine |
| Expand a playlist link | `yt-dlp --flat-playlist -J <url>` | Playlist page only — usually fine |
| Title for a pasted video link | YouTube oEmbed (`/oembed?url=…`) over plain HTTPS | No |
| Spotify track link | `spotify-url-info` page scrape → title/artist | No |

All of these are best effort (`backend/src/ytdlp.js`, `backend/src/songResolver.js`).
If they fail, queueing still works: typed text falls back to a library text
search, and anything not found becomes a **song request**.

## Song lifecycle

1. A web user queues something. If it is in the library (matched by YouTube id,
   `library:<id>`, or a legacy cache URL) it is queued and played from
   `/api/stream` → the library file.
2. If it is **not** in the library, the server records a **song request**
   (`song_requests`: youtube_id/url/title/artist, requested_by, lobby, status)
   and tells the user. Requests are listed for everyone on the Library page.
3. The CLI polls `GET /api/requests`, downloads, and uploads with
   `POST /api/library/upload` (optionally `request_id`).
4. The upload fulfils every pending request with that `youtube_id` (plus the
   explicit `request_id`), and the song is **automatically added to the queue of
   each requesting lobby** (socket `request:fulfilled`, `queue:update`).
5. Requests the CLI cannot find are dismissed (`POST /api/requests/:id/dismiss`,
   also possible from `/admin`).

## Upload rules

- `.m4a` only (extension + content type `audio/mp4`/`audio/x-m4a`/`audio/m4a`/
  `audio/aac`/`application/octet-stream`), **and** ffprobe must report an MP4
  container with an AAC audio stream and no real video stream (embedded cover
  art is fine). The server never transcodes.
- Max 50 MB (413 if larger).
- Dedupe: same `youtube_id` → 409; identical bytes (sha256) → 409. The 409 body
  includes the existing `song`.
- Optional `source_url`: the original link (http(s), max 2048 chars, else 400).
  If omitted but `youtube_id` is given, it is set to
  `https://www.youtube.com/watch?v=<id>`. Song objects return it and the web
  library page shows it as a small source link. The CLI sends it for downloads
  and detects it (and the `youtube_id`) from earlier `--no-upload` files, which
  carry the watch URL in their `comment` tag.

## Tokens and admin

- Set `ADMIN_PASSWORD` to enable `/admin` (unset = admin disabled).
- On `/admin`, create a token per person (labelled with their display name).
  The plaintext is shown once; only its SHA-256 is stored. Revoke any time.
- The CLI sends `Authorization: Bearer <token>`; uploads record `uploaded_by`
  = the token's name.

## Legacy cache migration

On every boot the server registers the old yt-dlp cache (`SONGS_PATH/*.mp3`,
plus rows of the legacy `songs` table) into `library_songs` with
`uploaded_by = "server"`, title/duration from the old DB row (artist
"Unknown"), `youtube_id` parsed from the old URL and `source_url` = the old URL
(or the watch URL of the parsed id if the old URL is not a valid http(s) link)
so existing queue entries keep playing. A boot-time migration also backfills
`source_url` from `youtube_id` for any library row that has none. It is idempotent (skips known paths and
known hashes). Files keep their format (mp3); tags are not rewritten. New
uploads are stored in `SONGS_PATH/library/<id>.m4a`. Library songs are never
expired (the old 7-day cache cleanup is gone).

## Removed from the server

- `backend/src/downloader.js` (background yt-dlp → ffmpeg mp3 downloads, the
  download queue, 7-day cache cleanup, cache dashboard endpoints)
- Live yt-dlp → ffmpeg transcoded streaming in `/api/stream`
- `ytdlp.getMetadata` (player-API metadata, blocked on the server IP) and
  `/api/metadata`
- The `bgutil-provider` PO-token sidecar, the `bgutil-ytdlp-pot-provider` and
  `yt-dlp-ejs` pip packages, and the `YTDLP_PLAYER_CLIENT`,
  `YTDLP_POT_BASE_URL`, `YTDLP_JS_RUNTIME` env vars
- yt-dlp cookies support (`/data/cookies.txt` and the dashboard Cookies page)

## Background: why a server IP fails (useful for the CLI too)

| Symptom (yt-dlp stderr) | Cause | Fix |
|---|---|---|
| `Sign in to confirm you're not a bot` | Datacenter IP is blocked | Run yt-dlp from a home IP (the CLI); PO token as a last resort |
| `Signature solving failed` / `n challenge solving failed` | No JS runtime for YouTube's challenges | Install a JS runtime (Deno/Node ≥ 22) + `yt-dlp-ejs` |
| `Requested format is not available` | Client only offers SABR audio | Try another `player_client` (e.g. `tv`) |
| `Sign in to confirm your age` | Age-restricted | Cookies from a logged-in browser |

Stale yt-dlp is the most common cause of sudden breakage — update it first.

Reference: yt-dlp PO Token guide https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide,
EJS https://github.com/yt-dlp/yt-dlp/wiki/EJS.
