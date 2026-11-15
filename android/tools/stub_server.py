#!/usr/bin/env python3
"""A stand-in for the listen-along library API, for working on the app
without the real server (which needs PostgreSQL).

Serves every .m4a / .opus / .ogg / .mp3 under --music as a library song
(a mixed library like the real one: AAC m4a and Ogg Opus, plus legacy mp3):

  GET /api/library?q=&limit=&offset=&sort=&reported=1
                                             search, paging, sort, broken only;
                                             every song carries reports +
                                             report_count
  POST/DELETE /api/library/<id>/report       mark as broken (reason <= 200) /
                                             withdraw your own report (seeded
                                             with one report by "Ayşe")
  GET /api/library/<id>/file                 the bytes, with Range support
  GET /stub/thumbs/<video>/hqdefault.jpg     a song's cover, as YouTube's
                                             thumbnail host would (no
                                             session; PNG bytes). Every
                                             sample song but "No Artist Here"
                                             has a made-up youtube_id; the
                                             app is pointed here with
                                             --es thumbs (dev.sh does)
  GET  /auth/mobile/start?state&nonce&code_challenge[&redirect_uri]
                                             the sign-in "page": a link back
                                             to the app (as the server's dev
                                             sign-in, no IdP). redirect_uri:
                                             the custom scheme (also when
                                             missing: an older app) or
                                             http://localhost:<port>/auth/mobile/callback;
                                             anything else is refused
                                             (--no-custom-scheme refuses the
                                             scheme, as MOBILE_CUSTOM_SCHEME=off)
  POST /auth/mobile/exchange                 code + verifier + nonce (+ the
                                             same redirect_uri) -> a `lam_`
                                             session token (mode dev)
  POST /auth/mobile/logout                   ends that session
  POST /stub/end-sessions                    ends every session (the app's
                                             next request gets 401
                                             SESSION_ENDED: test sign-out)
  POST /stub/change?playlist=<name or id>&add=N&remove=M
                                             someone else edits a playlist:
                                             adds the next N library songs
                                             it lacks, removes its last M
                                             (playlist sync: refresh and
                                             watch the downloads follow)
  POST /stub/missing?song=<title or id>      that song's file answers 404
                                             FILE_MISSING (as a lost file);
                                             &restore=1 brings it back
  POST /stub/hide?playlist=<name or id>      the playlist becomes someone
                                             else's private one (404 for us);
                                             &restore=1 makes it ours again
  GET /api/app/latest                        the newest Android release
                                             (--app-version, default 0.9.0)
  GET /api/me                                needs a session; 401
                                             SESSION_ENDED otherwise
  /api/playlists...                          list, songs, create, rename,
                                             visibility, delete, add, remove,
                                             move (in memory, seeded with two
                                             playlists; owner rules like the
                                             real server)

Metadata comes from the file name, "Artist - Title.ext". Ids are stable
UUIDs derived from the file path. Standard library only.

  python3 tools/stub_server.py --music ~/Music --port 8091 --token devtoken
                                    # devtoken: a session valid from the start
  python3 tools/stub_server.py --samples      # make a few test songs with ffmpeg
"""

import argparse
import base64
import hashlib
import html
import json
import secrets
import os
import re
import shutil
import subprocess
import sys
import struct
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

# As the server serves them (MIME_BY_EXT in backend/src/library.js).
MIME = {".m4a": "audio/mp4", ".opus": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg"}


def probe_duration(path):
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        return round(float(out), 1)
    except Exception:
        return None


def scan(music_dir):
    songs = []
    for root, _, files in os.walk(music_dir):
        for name in sorted(files):
            ext = os.path.splitext(name)[1].lower()
            if ext not in MIME:
                continue
            path = os.path.join(root, name)
            stem = os.path.splitext(name)[0]
            artist, _, title = stem.partition(" - ")
            if not title:
                artist, title = "Unknown", stem
            song_id = str(uuid.UUID(hashlib.md5(path.encode()).hexdigest()))
            # A made-up video id (11 characters, like YouTube's) for every song but
            # one, so the app's covers and its placeholder are both exercised.
            video = None if title == "No Artist Here" else "st" + hashlib.md5(song_id.encode()).hexdigest()[:9]
            songs.append({
                "id": song_id,
                "youtube_id": video,
                "thumbnail": thumb_path(video),
                "title": title,
                "artist": artist,
                "album": None,
                "duration_sec": probe_duration(path),
                "uploaded_by": "stub",
                "created_at": "2026-10-30T00:00:00.000Z",
                "source_url": None,
                "_path": path,
                "_mime": MIME[ext],
                "_mtime": os.path.getmtime(path),
            })
    return songs


def thumb_path(video):
    return f"/stub/thumbs/{video}/hqdefault.jpg" if video else None


def make_thumb(video):
    """A 480x360 PNG (any decoder sniffs it; the name says .jpg as YouTube's does):
    two colours from the video id in a diagonal split and a light disc."""
    h = hashlib.md5(video.encode()).digest()
    a, b = (h[0] % 160 + 40, h[1] % 160 + 40, h[2] % 160 + 40), (h[3] % 120 + 20, h[4] % 120 + 20, h[5] % 120 + 20)
    w, ht = 480, 360
    rows = []
    for y in range(ht):
        row = bytearray([0])
        for x in range(w):
            c = a if x + y < (w + ht) // 2 else b
            if (x - w / 2) ** 2 + (y - ht / 2) ** 2 < 70 ** 2:
                c = (235, 235, 235)
            row += bytes(c)
        rows.append(bytes(row))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, ht, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 6)) + chunk(b"IEND", b""))


THUMBS = {}


def make_samples(target):
    """A handful of short tagged files: m4a, an Ogg Opus, a legacy mp3, awkward names."""
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is needed to make samples")
    os.makedirs(target, exist_ok=True)
    samples = [
        ("Daft Punk", "One More Time", "m4a", 440),
        ("Barış Manço", "Dağlar Dağlar", "m4a", 523),
        ("AC/DC", "What? Why: Live", "m4a", 330),
        ("Legacy Artist", "An Old MP3", "mp3", 392),
        ("Unknown", "No Artist Here", "m4a", 294),
        ("Opus Artist", "A New Opus Song", "opus", 349),
        # Spare songs, not in any seeded playlist: /stub/change adds them (playlist sync).
        ("Kim Wilde", "Cambodia", "m4a", 370),
        ("Sezen Aksu", "Firuze", "opus", 415),
        ("Queen", "Bicycle Race", "m4a", 466),
        ("Tarkan", "Şımarık", "m4a", 311),
    ]
    for i, (artist, title, ext, freq) in enumerate(samples):
        safe = re.sub(r'[\\/:*?"<>|]', " ", f"{artist} - {title}")
        out = os.path.join(target, f"{safe}.{ext}")
        if os.path.exists(out):
            continue
        codec = {
            "m4a": ["-c:a", "aac", "-b:a", "128k"],
            "opus": ["-c:a", "libopus", "-b:a", "128k"],
            "mp3": ["-c:a", "libmp3lame", "-b:a", "128k"],
        }[ext]
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", f"sine=frequency={freq}:duration={20 + i * 10}",
             *codec, "-metadata", f"title={title}", "-metadata", f"artist={artist}", out],
            check=True,
        )
    print(f"samples in {target}")


ME = "stub-user"
RELEASES = "https://github.com/erkantaylan/listen-along/releases"

# The app's custom-scheme redirect (backend/src/mobileAuth.js MOBILE_REDIRECT_URI).
# The server's other allowed redirect is <BASE_URL>/auth/mobile/callback (an
# App Link); here http://localhost:<port>/auth/mobile/callback (Handler.redirects).
REDIRECT_URI = "com.etaylan.listen:/oauth2redirect"
SESSION_ENDED = {"error": "Your session has ended, sign in again", "code": "SESSION_ENDED"}
STATE_RE = re.compile(r"^[A-Za-z0-9._~-]{16,256}$")
VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def s256(verifier):
    return b64url(hashlib.sha256(verifier.encode()).digest())


def seed_playlists(songs):
    """Two playlists: one of ours (private), one of someone else's (public)."""
    def entry(song):
        return {"entry_id": str(uuid.uuid4()), "library_id": song["id"], "youtube_id": song.get("youtube_id"),
                "title": f"{song['title']} - {song['artist']}" if song["artist"] != "Unknown" else song["title"],
                "artist": song["artist"], "duration_sec": song["duration_sec"], "url": f"library:{song['id']}",
                "thumbnail": song.get("thumbnail"), "added_by": ME, "added_at": 1761800000000}
    mine = {"id": str(uuid.uuid4()), "name": "Stub mix", "visibility": "private", "ownerId": "u-me",
            "ownerName": ME, "entries": [entry(s) for s in songs[:3]]}
    theirs = {"id": str(uuid.uuid4()), "name": "Ayşe's road trip", "visibility": "public", "ownerId": "u-ayse",
              "ownerName": "Ayşe", "entries": [entry(s) for s in songs[2:5]]}
    theirs["entries"].append({"entry_id": str(uuid.uuid4()), "library_id": None, "youtube_id": "dQw4w9WgXcQ",
                              "title": "An old YouTube-only entry", "artist": None, "duration_sec": 212,
                              "url": "https://youtu.be/dQw4w9WgXcQ", "thumbnail": None, "added_by": "Ayşe"})
    return {p["id"]: p for p in (mine, theirs)}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def seed_reports(songs):
    """One open report by someone else, so the warning icon shows from the start."""
    if len(songs) < 2:
        return {}
    return {songs[1]["id"]: [{"id": "1", "reason": "Bad audio", "reported_by": "Ayşe", "_user": "u-ayse",
                              "created_at": "2026-10-30T09:00:00.000Z", "updated_at": "2026-10-30T09:00:00.000Z"}]}


class Handler(BaseHTTPRequestHandler):
    songs = []
    sessions = set()   # the `lam_` / --token values that are signed in
    used_codes = set()
    redirects = [REDIRECT_URI]  # the allowlist (main() adds the https-style callback)
    custom_scheme = True        # False: --no-custom-scheme
    app_version = "0.9.0"       # what /api/app/latest offers (--app-version; "" = no release)

    def chosen_redirect(self, raw):
        """As mobileAuth.js chosenRedirect: the allowlist, the scheme when missing, else None."""
        if raw is None:
            return REDIRECT_URI if self.custom_scheme else None
        if not isinstance(raw, str) or raw not in self.redirects:
            return None
        return raw if (raw != REDIRECT_URI or self.custom_scheme) else None
    throttle_kbps = 0
    playlists = {}
    reports = {}  # song id -> [report]
    next_report = 100

    def log_message(self, fmt, *args):
        sys.stderr.write("stub: " + fmt % args + "\n")

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def auth(self):
        """None when no token was sent, True/False for a live/ended session."""
        header = self.headers.get("Authorization")
        if not header:
            return None
        return header.startswith("Bearer ") and header[7:].strip() in self.sessions

    def send_html(self, code, title, body):
        data = (f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                f"<title>{html.escape(title)}</title><body style='font:16px system-ui;margin:2rem'>"
                f"<h1>{html.escape(title)}</h1>{body}").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # --- the app's sign-in (as the real server's dev sign-in) ----------------

    def mobile_start(self, qs):
        state, nonce = qs.get("state", [""])[0], qs.get("nonce", [""])[0]
        challenge = qs.get("code_challenge", [""])[0]
        if not STATE_RE.match(state) or not STATE_RE.match(nonce) or len(challenge) != 43:
            return self.send_html(400, "Sign-in link not valid", "<p>Go back to the app and try again.</p>")
        asked = qs.get("redirect_uri")
        if asked is not None and len(asked) != 1:
            return self.send_html(400, "Sign-in link not valid", "<p>Go back to the app and try again.</p>")
        redirect = self.chosen_redirect(None if asked is None else asked[0])
        if redirect is None:
            return self.send_html(400, "Sign-in link not valid", "<p>The app asked for a redirect this server does not allow.</p>")
        # The code names its redirect: start and exchange must agree, as the real
        # server checks through its derived nonce (a consistency check only).
        code = "dev." + b64url(json.dumps({"c": challenge, "n": nonce, "r": redirect, "t": time.time()}).encode())
        link = f"{redirect}?{urlencode({'code': code, 'state': state})}"
        self.send_html(200, "Stub sign-in", "<p>tools/stub_server.py: no IdP, anyone is " + html.escape(ME) + ".</p>"
                       f"<p><a id=continue href='{html.escape(link)}'>Continue as {html.escape(ME)}</a></p>")

    def mobile_exchange(self):
        b = self.read_body() or {}
        code, verifier, nonce, state = b.get("code"), b.get("code_verifier"), b.get("nonce"), b.get("state")
        if not all(isinstance(x, str) for x in (code, verifier, nonce, state)) \
                or not VERIFIER_RE.match(verifier) or not STATE_RE.match(nonce) or not STATE_RE.match(state):
            return self.send_json(400, {"error": "The sign-in request is not valid", "code": "invalid_request"})
        redirect = self.chosen_redirect(b.get("redirect_uri"))
        if redirect is None:
            return self.send_json(400, {"error": "The sign-in request is not valid", "code": "invalid_request"})
        try:
            data = json.loads(base64.urlsafe_b64decode(code[4:] + "=" * (-len(code[4:]) % 4)))
        except Exception:
            data = None
        if (not code.startswith("dev.") or not isinstance(data, dict) or code in self.used_codes
                or data.get("n") != nonce or data.get("c") != s256(verifier) or data.get("r", REDIRECT_URI) != redirect
                or time.time() - data.get("t", 0) > 600):
            return self.send_json(400, {"error": "Sign-in did not work, try again", "code": "signin_failed"})
        Handler.used_codes.add(code)
        token = "lam_" + secrets.token_urlsafe(32)
        Handler.sessions.add(token)
        return self.send_json(200, {"token": token, "token_type": "Bearer", "mode": "dev",
                                    "expires_at": int((time.time() + 30 * 86400) * 1000),
                                    "user": {"id": "u-me", "name": ME, "status": "approved"}})

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        if parts == ["auth", "mobile", "start"]:
            return self.mobile_start(parse_qs(url.query))
        if len(parts) == 4 and parts[:2] == ["stub", "thumbs"] and parts[3] == "hqdefault.jpg":
            # Like i.ytimg.com: public, no session. Never sees the app's Bearer (the app's
            # image client has none); log it if one ever arrives.
            if self.headers.get("Authorization"):
                print("stub: WARNING an image request carried an Authorization header", flush=True)
            video = parts[2]
            if not any(s.get("youtube_id") == video for s in self.songs):
                return self.send_json(404, {"error": "No such thumbnail"})
            data = THUMBS.get(video) or THUMBS.setdefault(video, make_thumb(video))
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
            return
        authed = self.auth()
        if authed is False:
            return self.send_json(401, SESSION_ENDED)

        if parts == ["api", "app", "latest"]:
            # As the server's (backend/src/features/app-release): any signed-in account, always 200.
            if not authed:
                return self.send_json(401, SESSION_ENDED)
            v = self.app_version
            if not v:
                return self.send_json(200, {"available": False, "reason": "none", "releasesUrl": RELEASES})
            tag = f"android-v{v}"
            return self.send_json(200, {
                "available": True, "version": v, "tag": tag, "publishedAt": now_iso(),
                "releaseUrl": f"{RELEASES}/tag/{tag}",
                "apk": {"name": f"listen-along-{v}.apk", "url": f"{RELEASES}/download/{tag}/listen-along-{v}.apk", "size": 12345678},
                "sha256": None, "releasesUrl": RELEASES, "stale": False,
            })

        if parts == ["api", "me"]:
            if not authed:
                return self.send_json(401, SESSION_ENDED)
            return self.send_json(200, {"name": ME, "user": {"id": "u-me", "name": ME, "status": "approved"},
                                        "session": {"kind": "app"}})

        if parts[:2] == ["api", "playlists"]:
            if not authed:
                return self.send_json(401, SESSION_ENDED)
            if len(parts) == 2:
                infos = [self.playlist_info(p) for p in self.playlists.values()
                         if p["visibility"] == "public" or p["ownerId"] == "u-me"]
                return self.send_json(200, {"playlists": infos, "lobbies": infos})
            p = self.visible_playlist(parts[2])
            if p is None:
                return self.send_json(404, {"error": "Playlist not found", "code": "NOT_FOUND"})
            if len(parts) == 4 and parts[3] == "songs":
                return self.send_json(200, {"playlist": self.playlist_info(p), "songs": self.entry_views(p)})
            return self.send_json(200, self.playlist_info(p))

        if parts == ["api", "library"]:
            qs = parse_qs(url.query)
            q = qs.get("q", [""])[0].lower().split()
            limit = max(1, min(int(qs.get("limit", ["100"])[0]), 1000))
            offset = max(0, int(qs.get("offset", ["0"])[0]))
            sort = qs.get("sort", ["recent"])[0]
            reported = qs.get("reported", [""])[0] in ("1", "true")
            hits = [s for s in self.songs
                    if all(w in f"{s['title']} {s['artist']}".lower() for w in q)
                    and (not reported or self.reports.get(s["id"]))]
            key = {
                "title": lambda s: (s["title"].lower(), s["artist"].lower()),
                "artist": lambda s: (s["artist"].lower(), s["title"].lower()),
            }.get(sort)
            hits = sorted(hits, key=key) if key else sorted(hits, key=lambda s: -s["_mtime"])
            page = [self.song_view(s) for s in hits[offset:offset + limit]]
            return self.send_json(200, {"songs": page, "total": len(hits)})

        if len(parts) == 4 and parts[:2] == ["api", "library"] and parts[3] == "file":
            song = next((s for s in self.songs if s["id"] == parts[2]), None)
            if not song:
                return self.send_json(404, {"error": "Song not found"})
            if song.get("_missing"):
                return self.send_json(404, {"error": "The file is missing", "code": "FILE_MISSING"})
            return self.send_file(song)

        self.send_json(404, {"error": "Not found"})

    # --- reports ("mark as broken") -----------------------------------------

    def report_views(self, song_id):
        return [{k: v for k, v in dict(r, mine=r["_user"] == "u-me").items() if not k.startswith("_")}
                for r in self.reports.get(song_id, [])]

    def song_view(self, s):
        view = {k: v for k, v in s.items() if not k.startswith("_")}
        view["reports"] = self.report_views(s["id"])
        view["report_count"] = len(view["reports"])
        return view

    def report_write(self, method, song_id):
        if self.auth() is not True:
            return self.send_json(401, SESSION_ENDED)
        song = next((x for x in self.songs if x["id"] == song_id), None)
        if song is None:
            return self.send_json(404, {"error": "Song not found", "code": "NOT_FOUND"})
        mine = [r for r in self.reports.get(song_id, []) if r["_user"] == "u-me"]
        if method == "DELETE":
            if not mine:
                return self.send_json(404, {"error": "You have not marked this song as broken", "code": "NOT_FOUND"})
            self.reports[song_id] = [r for r in self.reports[song_id] if r["_user"] != "u-me"]
            if not self.reports[song_id]:
                del self.reports[song_id]
            return self.send_json(200, {"ok": True})
        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad JSON"})
        reason = body.get("reason")
        if reason is not None and not isinstance(reason, str):
            return self.send_json(400, {"error": "reason must be a string", "code": "BAD_REQUEST"})
        reason = re.sub(r"\s+", " ", reason or "").strip() or None
        if reason and len(reason) > 200:
            return self.send_json(400, {"error": "reason is too long (max 200 characters)", "code": "BAD_REQUEST"})
        if mine:
            mine[0].update(reason=reason, updated_at=now_iso())
            report, code = mine[0], 200
        else:
            Handler.next_report += 1
            report = {"id": str(Handler.next_report), "reason": reason, "reported_by": ME, "_user": "u-me",
                      "created_at": now_iso(), "updated_at": now_iso()}
            self.reports.setdefault(song_id, []).append(report)
            code = 201
        view = {k: v for k, v in dict(report, mine=True).items() if not k.startswith("_")}
        return self.send_json(code, {"report": view, "song": self.song_view(song)})

    # --- playlists -----------------------------------------------------------

    def playlist_info(self, p):
        mine = p["ownerId"] == "u-me"
        return {"id": p["id"], "name": p["name"], "visibility": p["visibility"], "ownerId": p["ownerId"],
                "ownerName": p["ownerName"], "isOwner": mine, "canManage": mine,
                "canEdit": mine or p["visibility"] == "public", "pinned": False,
                "userCount": 0, "songCount": len(p["entries"]), "createdAt": 1761800000000}

    def entry_views(self, p):
        return [dict(e, position=i + 1, available=e["library_id"] is not None) for i, e in enumerate(p["entries"])]

    def visible_playlist(self, pid):
        p = self.playlists.get(pid)
        if p is None or (p["visibility"] == "private" and p["ownerId"] != "u-me"):
            return None
        return p

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return None

    def playlist_write(self, method):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) == 4 and parts[:2] == ["api", "library"] and parts[3] == "report" and method in ("POST", "DELETE"):
            return self.report_write(method, parts[2])
        if method == "POST" and parts == ["auth", "mobile", "exchange"]:
            return self.mobile_exchange()
        if method == "POST" and parts == ["auth", "mobile", "logout"]:
            header = self.headers.get("Authorization") or ""
            Handler.sessions.discard(header[7:].strip())
            return self.send_json(200, {"success": True})
        if method == "POST" and parts == ["stub", "end-sessions"]:
            Handler.sessions.clear()
            return self.send_json(200, {"success": True})
        if method == "POST" and len(parts) == 2 and parts[0] == "stub":
            return self.stub_control(parts[1], parse_qs(urlparse(self.path).query))
        authed = self.auth()
        if authed is False:
            return self.send_json(401, SESSION_ENDED)
        if parts[:2] != ["api", "playlists"]:
            return self.send_json(404, {"error": "Not found"})
        if not authed:
            return self.send_json(401, SESSION_ENDED)
        body = self.read_body()
        if body is None:
            return self.send_json(400, {"error": "Bad JSON"})

        if method == "POST" and len(parts) == 2:
            name = (body.get("name") or "").strip()
            visibility = body.get("visibility", "public")
            if visibility not in ("public", "private"):
                return self.send_json(400, {"error": "visibility must be 'public' or 'private'", "code": "BAD_REQUEST"})
            if len(name) > 50:
                return self.send_json(400, {"error": "Name must be 50 characters or less", "code": "BAD_REQUEST"})
            if name and any((q["name"] or "").lower() == name.lower() for q in self.playlists.values()):
                return self.send_json(409, {"error": "A playlist with that name already exists", "code": "CONFLICT"})
            p = {"id": str(uuid.uuid4()), "name": name or None, "visibility": visibility, "ownerId": "u-me",
                 "ownerName": ME, "entries": []}
            self.playlists[p["id"]] = p
            return self.send_json(201, dict(self.playlist_info(p), link=f"/playlist/{p['id']}"))

        p = self.visible_playlist(parts[2]) if len(parts) > 2 else None
        if p is None:
            return self.send_json(404, {"error": "Playlist not found", "code": "NOT_FOUND"})
        mine = p["ownerId"] == "u-me"

        if method == "PATCH" and len(parts) == 3:
            if "visibility" in body:
                if body["visibility"] not in ("public", "private"):
                    return self.send_json(400, {"error": "visibility must be 'public' or 'private'", "code": "BAD_REQUEST"})
                if not mine:
                    return self.send_json(403, {"error": "Only the owner can change visibility", "code": "FORBIDDEN"})
            if "name" in body:
                if not mine:
                    return self.send_json(403, {"error": "Only the owner can rename", "code": "FORBIDDEN"})
                name = (body["name"] or "").strip()
                if not name or len(name) > 50:
                    return self.send_json(400, {"error": "Name must be 1-50 characters", "code": "BAD_REQUEST"})
                if any(q is not p and (q["name"] or "").lower() == name.lower() for q in self.playlists.values()):
                    return self.send_json(409, {"error": "A playlist with that name already exists", "code": "CONFLICT"})
                p["name"] = name
            if "visibility" in body:
                p["visibility"] = body["visibility"]
            return self.send_json(200, self.playlist_info(p))

        if method == "DELETE" and len(parts) == 3:
            if not mine:
                return self.send_json(403, {"error": "Only the owner can delete this playlist", "code": "FORBIDDEN"})
            del self.playlists[p["id"]]
            return self.send_json(200, {"success": True, "id": p["id"]})

        if method == "POST" and len(parts) == 4 and parts[3] == "songs":
            refs = body.get("songs")
            if not isinstance(refs, list) or not refs:
                return self.send_json(400, {"error": "songs must be a non-empty array", "code": "BAD_REQUEST"})
            results, added = [], 0
            for ref in refs:
                song = next((x for x in self.songs if x["id"] == ref), None)
                if song is None:
                    results.append({"input": ref, "status": "not_in_library"})
                elif any(e["library_id"] == ref for e in p["entries"]):
                    results.append({"input": ref, "status": "already_in_playlist"})
                else:
                    e = seed_playlists([song])  # reuse the entry builder
                    entry = next(iter(e.values()))["entries"][0]
                    p["entries"].append(entry)
                    added += 1
                    results.append({"input": ref, "status": "added", "entry_id": entry["entry_id"]})
            count = lambda st: sum(1 for r in results if r["status"] == st)
            return self.send_json(200, {"playlist_id": p["id"], "results": results, "song_count": len(p["entries"]),
                                        "summary": {"total": len(results), "added": added,
                                                    "already_in_playlist": count("already_in_playlist"),
                                                    "not_in_library": count("not_in_library"), "invalid": 0}})

        if method == "DELETE" and len(parts) == 5 and parts[3] == "songs":
            before = len(p["entries"])
            p["entries"] = [e for e in p["entries"] if e["entry_id"] != parts[4] and e["library_id"] != parts[4]]
            if len(p["entries"]) == before:
                return self.send_json(404, {"error": "That song is not in this playlist", "code": "SONG_NOT_FOUND"})
            return self.send_json(200, {"playlist_id": p["id"], "removed": [], "song_count": len(p["entries"])})

        if method == "POST" and len(parts) == 6 and parts[3] == "songs" and parts[5] == "move":
            idx = next((i for i, e in enumerate(p["entries"]) if e["entry_id"] == parts[4]), None)
            if idx is None:
                return self.send_json(404, {"error": "That song is not in this playlist", "code": "SONG_NOT_FOUND"})
            pos = body.get("position")
            if not isinstance(pos, int) or not 1 <= pos <= len(p["entries"]):
                return self.send_json(400, {"error": f"position must be between 1 and {len(p['entries'])}", "code": "BAD_REQUEST"})
            p["entries"].insert(pos - 1, p["entries"].pop(idx))
            return self.send_json(200, {"playlist_id": p["id"], "songs": self.entry_views(p)})

        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        self.playlist_write("POST")

    def do_PATCH(self):
        self.playlist_write("PATCH")

    def do_DELETE(self):
        self.playlist_write("DELETE")

    def stub_control(self, what, qs):
        """Changes made "elsewhere", for trying the app's playlist sync (see the docstring)."""
        def find_playlist(key):
            return next((p for p in self.playlists.values() if key in (p["id"], p["name"])), None)
        restore = qs.get("restore", [""])[0] in ("1", "true")
        if what == "change":
            p = find_playlist(qs.get("playlist", [""])[0])
            if p is None:
                return self.send_json(404, {"error": "No such playlist"})
            add, remove = int(qs.get("add", ["0"])[0]), int(qs.get("remove", ["0"])[0])
            removable = [e for e in p["entries"] if e["library_id"]]
            for e in removable[len(removable) - remove:] if remove else []:
                p["entries"].remove(e)
            have = {e["library_id"] for e in p["entries"]}
            for song in [s for s in self.songs if s["id"] not in have][:add]:
                p["entries"].append({"entry_id": str(uuid.uuid4()), "library_id": song["id"], "youtube_id": song.get("youtube_id"),
                                     "title": song["title"], "artist": song["artist"], "duration_sec": song["duration_sec"],
                                     "url": f"library:{song['id']}", "thumbnail": song.get("thumbnail"), "added_by": "Ayşe",
                                     "added_at": int(time.time() * 1000)})
            print(f"stub: {p['name']} now has {len(p['entries'])} entries", flush=True)
            return self.send_json(200, {"playlist": self.playlist_info(p), "songs": self.entry_views(p)})
        if what == "missing":
            key = qs.get("song", [""])[0]
            song = next((x for x in self.songs if key in (x["id"], x["title"])), None)
            if song is None:
                return self.send_json(404, {"error": "No such song"})
            song["_missing"] = not restore
            return self.send_json(200, {"song": song["id"], "missing": song["_missing"]})
        if what == "hide":
            p = find_playlist(qs.get("playlist", [""])[0])
            if p is None:
                return self.send_json(404, {"error": "No such playlist"})
            p["visibility"], p["ownerId"] = ("private", "u-me") if restore else ("private", "u-someone")
            return self.send_json(200, {"hidden": not restore})
        return self.send_json(404, {"error": "Not found"})

    def send_file(self, song):
        size = os.path.getsize(song["_path"])
        start, end = 0, size - 1
        match = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if match and (match.group(1) or match.group(2)):
            if match.group(1):
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else size - 1
            else:
                start = size - int(match.group(2))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", song["_mime"])
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(song["_path"], "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
                if self.throttle_kbps:
                    time.sleep(len(chunk) / 1024 / self.throttle_kbps)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_music = os.path.join(here, "..", "build", "stub-music")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--music", default=default_music, help="folder of .m4a/.opus/.ogg/.mp3 files")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--token", help="a session token that is signed in from the start (dev.sh passes devtoken)")
    parser.add_argument("--throttle", type=int, default=0, metavar="KBPS",
                        help="slow file transfers down, to watch progress and test cancelling")
    parser.add_argument("--samples", action="store_true", help="create sample songs in --music first")
    parser.add_argument("--app-version", default="0.9.0",
                        help="the Android release /api/app/latest offers (empty: none), for the update notice")
    parser.add_argument("--no-custom-scheme", action="store_true",
                        help="refuse the custom-scheme redirect (as the server's MOBILE_CUSTOM_SCHEME=off)")
    args = parser.parse_args()

    music = os.path.abspath(args.music)
    if args.samples:
        make_samples(music)
    if not os.path.isdir(music):
        sys.exit(f"{music} does not exist (use --samples to create test songs)")

    Handler.songs = scan(music)
    Handler.playlists = seed_playlists(Handler.songs)
    Handler.reports = seed_reports(Handler.songs)
    Handler.sessions = {args.token} if args.token else set()
    Handler.throttle_kbps = args.throttle
    Handler.redirects = [f"http://localhost:{args.port}/auth/mobile/callback", REDIRECT_URI]
    Handler.custom_scheme = not args.no_custom_scheme
    Handler.app_version = args.app_version
    print(f"stub: {len(Handler.songs)} songs from {music} on http://{args.bind}:{args.port}", flush=True)
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
