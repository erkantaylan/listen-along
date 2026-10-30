# Listen Along for Android

The listen-along music library on your phone: browse and search it, play it
(streamed, or from downloaded files with no connection), manage playlists,
and keep songs as **plain, unencrypted, tagged audio files** that VLC or any
other player can open too.

Kotlin + Jetpack Compose + Media3, no cross-platform runtime. The look follows
the web app (`DESIGN.md`, "Android" section): dark only, soft greys, one muted
slate-blue accent.

## Getting started

The app talks to **https://music.etaylan.com** out of the box (change it in
Settings). The library and playlists need an **API token**: on first launch
the app opens Settings and walks you through it — open your profile on the
web (**Open my profile**), create a token under "CLI tokens", copy it, tap
**Paste**, then **Save and test**. The token is sent as
`Authorization: Bearer …` and stored encrypted.

## What it does

- **Library**: every song on the server. Search, sort (recent, title,
  artist), scroll to load more. Tap a song to play the list from there; **Play**
  / **Shuffle** play the whole result. The download button saves a song (tap
  the ring again to cancel; a green check means it is on the phone). ⋮ → *Add
  to playlist*, *Download*, *Open in another app*. The header's download
  button fetches the whole current result after a confirm (count, rough size).
  **All songs / Broken** switches to the songs someone marked as broken
  (`?reported=1`), each with its reasons, who and when.
- **Song menu**: ⋮ on a row opens it as a dropdown, a **long-press** on the
  row (Library, a playlist, On device; the cover or title in the full player)
  as a bottom sheet with the same items.
- **Mark as broken** (as on the web): from the song menu, with an optional
  reason (chips *Wrong song*, *Bad audio*, *Cut off*, *Too quiet / too loud*,
  or free text up to 200 characters). Your own report offers *Edit broken
  report…* and *Unmark broken*. A reported song shows a small muted warning
  icon after its title everywhere (TalkBack: "Needs replacement — marked as
  broken by n people"); tapping it lists the reasons, reporters and times.
  Replacing the audio on the server clears the reports.
- **Playlists**: every public playlist plus your private ones ("Private"
  badge), yours first. Open one to see its songs; tap a song to play the
  playlist from it at once, or Play / Shuffle; rows have no reorder or delete
  controls. **Download playlist** queues every song not yet on the phone.
  **Edit** in the top bar (shown when you may change the list: the server's
  `canEdit` — a public playlist is anyone's, a private one its owner's)
  switches to edit mode: a drag handle per row (drag it, or long-press-drag
  the row; the list scrolls at the edges), a remove button with an **Undo**
  snackbar, and tapping does not play; **Done** or Back leaves. A finished
  drag sends one move; a removal is sent when the snackbar times out (or on
  Done / the next removal / leaving the playlist). TalkBack gets *Move up* /
  *Move down* actions on each row. ⋮ on a playlist: *Rename*, and for its
  owner *Make private/public* and *Delete* (who may do what comes from the
  server's `canManage`; its error is shown if it refuses). ⋮ on a song:
  *Add to another playlist*, *Remove from playlist* (with Undo), and the
  report entries. **+** makes a new playlist
  (name, Public/Private). Entries that are not in the library (old
  YouTube-only queue entries) are listed but cannot be played.
- **On device**: the downloaded songs (play, shuffle, add to playlist, open in
  another app, delete) and the download queue while it runs.
- **Settings**: server address, API token (Paste button), **Save and test**
  (`/api/me` and `/api/library`), and storage stats.

## Player

`player/PlaybackService` is a Media3 `MediaSessionService` around one
ExoPlayer; the UI only talks to it through a `MediaController`
(`player/PlayerConnection`, one per process in `AppGraph`).

- Plays in the background with the media notification, lock-screen and
  headset/Bluetooth controls that Media3 builds from the session; tapping the
  notification opens the full player.
- Audio focus is handled by ExoPlayer (calls and other players pause it);
  unplugging headphones pauses (`setHandleAudioBecomingNoisy`).
- Each queued song is resolved once (`player/PlayQueue`): a downloaded song
  plays from its MediaStore file, anything else streams from
  `/api/library/:id/file` through an OkHttp client whose interceptor adds the
  Bearer token, only for the configured server. Range requests make seeking
  in a stream cheap.
- A song that fails (deleted file, 404, connection lost) is skipped and a
  toast says why.
- UI: a mini player above the tabs (cover from the file's embedded art,
  title, "artist · from", previous / play / next, progress line) and a full
  player (seek bar, shuffle, repeat off/all/one).

## Offline

- Downloaded songs play with no connection; the player's queue then leaves out
  songs that are not on the phone (and says how many it skipped).
- **Library** falls back to the downloaded songs (searched and sorted
  locally) with an "Offline" notice, and reloads when the connection returns.
- **Playlists** keeps the last list and the last song list of every playlist
  you opened (`playlists/PlaylistCache`, JSON files under the app's files
  dir, per server). Offline, or when the server answers 5xx, those are shown
  read-only with "Offline — saved copy from …"; editing actions are disabled.
  A 4xx is not hidden behind the cache: a rejected token is shown, and a
  playlist that answers 404 is forgotten.
- **Broken songs**: the list of reported songs (`reports/ReportStore`) is
  saved per server, so the warning icons and the Broken filter (over the
  downloaded songs) still work offline. Marking, editing and unmarking need
  the server: offline those menu entries are **disabled** ("Needs a
  connection"), not queued. The list is refreshed at start, on resume, when
  the connection returns and with every library load.

### Where the files go

`Music/ListenAlong/<Artist> - <Title>.m4a` is saved through MediaStore, so
the files are public and every app sees them. The server's bytes are stored
**unchanged**, so its tags and cover art come along. The extension comes
from the response `Content-Type`: legacy songs migrated from the old cache
can be `.mp3` (`audio/mpeg`), `.ogg` (`audio/ogg`) or WebM (`audio/webm`),
which is saved as `.mka` because MediaStore refuses `audio/webm`. Names are
sanitised for FAT/exFAT and capped at 200 UTF-8 bytes. The server's
placeholder artist `Unknown` is dropped.

A small JSON index in SharedPreferences maps each song id to its MediaStore
URI. That is how the app knows what is downloaded and avoids duplicates.

### Downloads

A single WorkManager worker drains a persisted queue, **two songs at a time**,
as a `dataSync` foreground service, with one progress notification
(**Cancel all**) and a summary when it finishes. Downloads keep going with the
app closed; after a process death WorkManager restarts the worker and the
unfinished songs are fetched again. A network error or a 5xx is retried twice;
a 4xx fails at once and the row offers a retry. Song and playlist downloads
use the same queue.

## Build and install

You need a JDK 17 or newer (21 works) and the Android SDK (compileSdk 37).

```bash
cd android
./dev.sh                            # build, install, launch on the connected phone
./gradlew :app:testDebugUnitTest    # unit tests (JVM, no device needed)
./gradlew :app:assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

`dev.sh` finds a JDK (JAVA_HOME if it is ≥ 17, else 17, else 21+ under
`/usr/lib/jvm`) and the SDK (`ANDROID_HOME`, else `~/Android/Sdk`) by itself;
call `./gradlew` with `JAVA_HOME` and `ANDROID_HOME` set yourself. The debug
build installs as `com.erkantaylan.listenalong.debug`. minSdk 26, targetSdk 36.

## Dev loop

```bash
./dev.sh                 # build, install, launch on the connected device
./dev.sh --stub          # ...against tools/stub_server.py, for this run only
./dev.sh --logs          # ...then tail logcat
ANDROID_SERIAL=emulator-5554 ./dev.sh --stub   # pick the device explicitly
./shot.sh out.png        # screenshot, refused unless the app is focused
```

`tools/stub_server.py` (Python standard library only) stands in for the real
server, which needs PostgreSQL. It serves every `.m4a`/`.mp3` in a folder
through the same API — search, paging, sort, `Range`, `/api/me` — plus
in-memory playlists seeded with one private playlist of yours and one public
playlist of someone else's (with a YouTube-only entry), with the server's
owner rules (`canEdit` too) and error answers, and broken-song reports
(`?reported=1`, `POST`/`DELETE /api/library/:id/report`, seeded with one
report by someone else). `--samples` makes five short test songs with
ffmpeg; `--throttle KBPS` slows transfers down.

`./dev.sh --stub` starts it, tunnels it to the phone's `localhost:8091` with
`adb reverse`, and launches the app with `--es server http://localhost:8091
--es token devtoken`. Debug builds take those intent extras as an
**in-memory** override for that process (Settings shows a notice): the server
and token saved on the phone are never touched. Restart the app normally to
go back to them.

Cleartext HTTP is allowed only for `localhost`, `127.0.0.1` and `10.0.2.2`
(see `res/xml/network_security_config.xml`). A real server must use HTTPS,
because the token travels with every request.

Compose test tags are exposed as resource ids (`tab:playlists`,
`song:<id>`, `playlist:<id>`, `mini-player`, `player:toggle`, …), so
`uiautomator dump` can find and tap them from scripts.

## Layout

```
app/src/main/java/com/erkantaylan/listenalong/
├── api/         LibraryClient (OkHttp): library, /api/me, playlists; models
├── settings/    server URL (default music.etaylan.com) + encrypted token
├── playlists/   PlaylistRepository + PlaylistCache (offline copies),
│                PlaylistEdits (edit mode: drag reorder, remove + Undo)
├── reports/     ReportStore (broken-song reports, saved per server), ReportReasons
├── player/      PlaybackService (Media3), PlayerConnection, PlayQueue
├── net/         connectivity hint
├── storage/     MediaStore sink, filenames, the song-id → URI index
├── download/    queue, state, the drain loop, WorkManager worker + notification
├── open/        hand-off to an external player
└── ui/          Library, Playlists, On device, Settings, player bars, theme
```

`Downloads` and `PlaylistRepository` hold the logic and depend on interfaces
(`AudioSink`, `TextStore`, a client provider), so downloads, playlist
caching/fallback, the API parsing and queue building all run in JVM unit
tests against MockWebServer.

## Known limits

- The download index lives in app storage. After a reinstall or a data
  clear, the app no longer knows about files it saved earlier. Downloading
  those songs again produces `Name (1).m4a`.
- The play queue is not restored after the app process is killed.
- There is no live socket: reports made elsewhere show up on the next
  refresh (resume, pull-to-refresh, reconnect), not instantly.
- Edit mode assumes nobody else edits the same playlist at the same time;
  if a move or removal fails, the playlist is reloaded from the server.
- Cover art comes from the audio file's embedded picture (shown once the
  player has read it); list rows use the placeholder.
- Android 8–9 writes the file directly and needs the storage permission. That
  path has not been run on a device.
- A failed or cancelled download starts over from zero (no `Range` resume).
