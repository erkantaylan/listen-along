#!/usr/bin/env python3
"""A stand-in for the listen-along library API, for working on the app
without the real server (which needs PostgreSQL).

Serves every .m4a / .mp3 under --music as a library song:

  GET /api/library?q=&limit=&offset=&sort=   search, paging, sort
  GET /api/library/<id>/file                 the bytes, with Range support
  GET /api/me                                needs --token; 401 otherwise

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


class Handler(BaseHTTPRequestHandler):
    songs = []
    token = None
    throttle_kbps = 0

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
            return self.send_json(200, {"name": "stub-user"})

        if parts == ["api", "library"]:
            qs = parse_qs(url.query)
            q = qs.get("q", [""])[0].lower().split()
            limit = max(1, min(int(qs.get("limit", ["100"])[0]), 1000))
            offset = max(0, int(qs.get("offset", ["0"])[0]))
            sort = qs.get("sort", ["recent"])[0]
            hits = [s for s in self.songs
                    if all(w in f"{s['title']} {s['artist']}".lower() for w in q)]
            key = {
                "title": lambda s: (s["title"].lower(), s["artist"].lower()),
                "artist": lambda s: (s["artist"].lower(), s["title"].lower()),
            }.get(sort)
            hits = sorted(hits, key=key) if key else sorted(hits, key=lambda s: -s["_mtime"])
            page = [{k: v for k, v in s.items() if not k.startswith("_")}
                    for s in hits[offset:offset + limit]]
            return self.send_json(200, {"songs": page, "total": len(hits)})

        if len(parts) == 4 and parts[:2] == ["api", "library"] and parts[3] == "file":
            song = next((s for s in self.songs if s["id"] == parts[2]), None)
            if not song:
                return self.send_json(404, {"error": "Song not found"})
            return self.send_file(song)

        self.send_json(404, {"error": "Not found"})

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
    Handler.token = args.token
    Handler.throttle_kbps = args.throttle
    print(f"stub: {len(Handler.songs)} songs from {music} on http://{args.bind}:{args.port}", flush=True)
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
