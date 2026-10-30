#!/usr/bin/env python3
"""A stand-in for the listen-along library API, for working on the app
without the real server (which needs PostgreSQL).

Serves every .m4a / .mp3 under --music as a library song:

  GET /api/library?q=&limit=&offset=&sort=&reported=1
                                             search, paging, sort, broken only;
                                             every song carries reports +
                                             report_count
  POST/DELETE /api/library/<id>/report       mark as broken (reason <= 200) /
                                             withdraw your own report (seeded
                                             with one report by "Ayşe")
  GET /api/library/<id>/file                 the bytes, with Range support
  GET /api/me                                needs --token; 401 otherwise
  /api/playlists...                          list, songs, create, rename,
                                             visibility, delete, add, remove,
                                             move (in memory, seeded with two
                                             playlists; owner rules like the
                                             real server)

Metadata comes from the file name, "Artist - Title.ext". Ids are stable
UUIDs derived from the file path. Standard library only.

  python3 tools/stub_server.py --music ~/Music --port 8091 --token devtoken
  python3 tools/stub_server.py --samples      # make a few test songs with ffmpeg
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MIME = {".m4a": "audio/mp4", ".mp3": "audio/mpeg"}


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
            songs.append({
                "id": str(uuid.UUID(hashlib.md5(path.encode()).hexdigest())),
                "youtube_id": None,
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


def make_samples(target):
    """A handful of short tagged files, including an mp3 and awkward names."""
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is needed to make samples")
    os.makedirs(target, exist_ok=True)
    samples = [
        ("Daft Punk", "One More Time", "m4a", 440),
        ("Barış Manço", "Dağlar Dağlar", "m4a", 523),
        ("AC/DC", "What? Why: Live", "m4a", 330),
        ("Legacy Artist", "An Old MP3", "mp3", 392),
        ("Unknown", "No Artist Here", "m4a", 294),
    ]
    for i, (artist, title, ext, freq) in enumerate(samples):
        safe = re.sub(r'[\\/:*?"<>|]', " ", f"{artist} - {title}")
        out = os.path.join(target, f"{safe}.{ext}")
        if os.path.exists(out):
            continue
        codec = ["-c:a", "aac", "-b:a", "128k"] if ext == "m4a" else ["-c:a", "libmp3lame", "-b:a", "128k"]
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", f"sine=frequency={freq}:duration={20 + i * 10}",
             *codec, "-metadata", f"title={title}", "-metadata", f"artist={artist}", out],
            check=True,
        )
    print(f"samples in {target}")


ME = "stub-user"


def seed_playlists(songs):
    """Two playlists: one of ours (private), one of someone else's (public)."""
    def entry(song):
        return {"entry_id": str(uuid.uuid4()), "library_id": song["id"], "youtube_id": None,
                "title": f"{song['title']} - {song['artist']}" if song["artist"] != "Unknown" else song["title"],
                "artist": song["artist"], "duration_sec": song["duration_sec"], "url": f"library:{song['id']}",
                "thumbnail": None, "added_by": ME, "added_at": 1761800000000}
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
    token = None
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
        """None when no token was sent, True/False for a good/bad one."""
        header = self.headers.get("Authorization")
        if not header:
            return None
        return self.token is not None and header == f"Bearer {self.token}"

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        authed = self.auth()
        if authed is False:
            return self.send_json(401, {"error": "Invalid or revoked token"})

        if parts == ["api", "me"]:
            if not authed:
                return self.send_json(401, {"error": "Missing API token"})
            return self.send_json(200, {"name": ME, "user": {"id": "u-me", "name": ME},
                                        "token": {"label": "stub", "legacy": False}})

        if parts[:2] == ["api", "playlists"]:
            if not authed:
                return self.send_json(401, {"error": "Authentication required"})
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
            return self.send_json(401, {"error": "Authentication required"})
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
        authed = self.auth()
        if authed is False:
            return self.send_json(401, {"error": "Invalid or revoked token"})
        if parts[:2] != ["api", "playlists"]:
            return self.send_json(404, {"error": "Not found"})
        if not authed:
            return self.send_json(401, {"error": "Authentication required"})
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
    parser.add_argument("--music", default=default_music, help="folder of .m4a/.mp3 files")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--token", help="accept this API token (enables /api/me)")
    parser.add_argument("--throttle", type=int, default=0, metavar="KBPS",
                        help="slow file transfers down, to watch progress and test cancelling")
    parser.add_argument("--samples", action="store_true", help="create sample songs in --music first")
    args = parser.parse_args()

    music = os.path.abspath(args.music)
    if args.samples:
        make_samples(music)
    if not os.path.isdir(music):
        sys.exit(f"{music} does not exist (use --samples to create test songs)")

    Handler.songs = scan(music)
    Handler.playlists = seed_playlists(Handler.songs)
    Handler.reports = seed_reports(Handler.songs)
    Handler.token = args.token
    Handler.throttle_kbps = args.throttle
    print(f"stub: {len(Handler.songs)} songs from {music} on http://{args.bind}:{args.port}", flush=True)
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
