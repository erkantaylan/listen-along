# Listen Along for Android

The listen-along music library on your phone: browse and search it, play it
(streamed, or from downloaded files with no connection), manage playlists,
and keep songs as **plain, unencrypted, tagged audio files** that VLC or any
other player can open too.

Kotlin + Jetpack Compose + Media3, no cross-platform runtime. The look follows
the web app (`DESIGN.md`, "Android" section): dark only, soft greys on a page < surface < raised < overlay scale with
visible borders, and one cornflower-blue accent (filled, dark text) for the
main action of each screen and the play button.

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
  *Move down* actions on each row. ⋮ on a playlist, for its owner only:
  *Rename*, *Make private/public* and *Delete* (who may do what comes from the
  server's `canManage`; its error is shown if it refuses). ⋮ on a song:
  *Add to another playlist*, *Remove from playlist* (with Undo), and the
  report entries. **+** makes a new playlist
  (name, Public/Private). Entries that are not in the library (old
  YouTube-only queue entries) are listed but cannot be played.
- **On device**: the downloaded songs (play, shuffle, add to playlist, open in
  another app, delete) and the download queue while it runs.
- **Settings**: server address, API token (Paste button), **Save and test**
  (`/api/me` and `/api/library`), storage stats, and the app version
  (`versionName`) with a link to the source on GitHub.

## Player

`player/PlaybackService` is a Media3 `MediaLibraryService` around one
ExoPlayer; the UI only talks to it through a `MediaController`
(`player/PlayerConnection`, one per process in `AppGraph`), Android Auto
through the same session (see [Android Auto](#android-auto)).

- Plays in the background with the media notification, lock-screen and
  headset/Bluetooth controls that Media3 builds from the session; tapping the
  notification opens the full player.
- Those controls are **previous / play / next**. The session does not offer
  seek back / seek forward (`CarLibrary.onConnectAsync` removes them): with
  them it also advertised rewind / fast-forward, and car screens showed
  "−15 s / +15 s" where previous and next belong.
- Audio focus is handled by ExoPlayer (calls and other players pause it);
  unplugging headphones pauses (`setHandleAudioBecomingNoisy`).
- Each queued song is resolved once (`player/PlayQueue`): a downloaded song
  plays from its MediaStore file, anything else streams from
  `/api/library/:id/file` through an OkHttp client whose interceptor adds the
  Bearer token, only for the configured server. Range requests make seeking
  in a stream cheap.
- A song that fails (deleted file, 404, connection lost) is skipped and a
  toast says why. A stream that fails because the server cannot be reached
  (no route, timeout, a dropped connection, a 5xx) also marks the server
  unreachable for a minute, and the player goes on with the next
  **downloaded** song (see Offline).
- UI: a mini player above the tabs (cover from the file's embedded art,
  title, "artist · from", previous / play / next, progress line) and a full
  player (seek bar, shuffle, repeat off/all/one).

## Offline

- "Offline" (`net/Connectivity`) means no **validated** network (Android
  has not reached the internet through it: a car hotspot with no uplink, a
  captive portal, mobile data with no signal all count), or a stream failed
  in the last minute because the server could not be reached. It ends early
  when the phone moves to another network or a stream starts.
- Downloaded songs play with no connection; the player's queue then leaves out
  songs that are not on the phone (and says how many it skipped).
- If the connection goes away **after** the queue was built (with streams in
  it), the player skips the streamed entries instead of stopping on them:
  on "next", at the end of a song, and when a stream runs out of buffer it
  goes to the nearest downloaded entry in play order (backwards after
  "previous"), and pauses if there is none. Offline, failed loads are not
  retried, so this happens at once rather than after a minute of retries.
  Once back online the same queue streams again.
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

`Music/ListenAlong/<Artist> - <Title>.<ext>` is saved through MediaStore, so
the files are public and every app sees them. The server's bytes are stored
**unchanged**, so its tags and cover art come along. The library is mixed and
the extension comes from the response `Content-Type`: AAC songs are `.m4a`
(`audio/mp4`), Opus songs `.ogg` (`audio/ogg`; the server's `.opus`, but
`audio/ogg` cannot tell Opus from a legacy Vorbis file and `.ogg` suits both
and every MediaStore version), legacy songs migrated from the old cache
`.mp3` (`audio/mpeg`), `.ogg` or WebM (`audio/webm`), which is saved as `.mka`
because MediaStore refuses `audio/webm`. The player is never told a type: it
sniffs the container, from a file or a stream alike. Names are
sanitised for FAT/exFAT and capped at 200 UTF-8 bytes. The server's
placeholder artist `Unknown` is dropped.

A small JSON index in SharedPreferences maps each song id to its MediaStore
URI. That is how the app knows what is downloaded and avoids duplicates.

The index does not survive a reinstall or a data clear, and uninstalling also
takes away the app's ownership of its files. So when the folder holds a file
the index does not know, the app compares it with the server's library
(`storage/FileMatcher`, at start, on resume and before downloads): the file
name rebuilt from the song's artist and title (any audio extension the app knows,
`.ogg` and a copied-in `.opus` included), and the duration within 3
seconds. Anything that fits more than one way stays unmatched.

Seeing files from an earlier install takes **music access**
(`READ_MEDIA_AUDIO`, `READ_EXTERNAL_STORAGE` before Android 13), which is
optional. A notice in Library and On device offers it while nothing is
downloaded; Settings can ask later. Without it, such songs are kept in the list
(an invisible file may still exist), stream when online and are left out
offline. Deleting one needs the system's consent prompt; declining keeps it.

### Downloads

A single WorkManager worker drains a persisted queue, **two songs at a time**,
as a `dataSync` foreground service, with one progress notification
(**Cancel all**) and a summary when it finishes. Downloads keep going with the
app closed; after a process death WorkManager restarts the worker and the
unfinished songs are fetched again. A network error or a 5xx is retried twice;
a 4xx fails at once and the row offers a retry. Song and playlist downloads
use the same queue.

## Android Auto

The app is an Android Auto media app: `PlaybackService` is a
`MediaLibraryService`, the manifest declares
`com.google.android.gms.car.application` (`res/xml/automotive_app_desc.xml`,
`<uses name="media"/>`) and the `android.media.browse.MediaBrowserService`
action. `player/CarLibrary` is the session callback, `player/CarTree` the
media ids (pure, tested). In the car:

- **Playlists** → a playlist → *Shuffle*, then its songs.
- **On device** → *Shuffle*, then the downloaded songs (artist, title).
- **Recently added** → *Shuffle*, then the 200 newest library songs.
- **Search** (voice or typed): the library search; offline, the downloads.

Tapping a song plays its whole list from that song, with the same queue
rules as the app (`PlayQueue.build`: downloaded songs from the file, the rest
streamed, offline only the downloaded ones). Downloaded songs carry the car's
download mark. The data comes from the same places as the app's screens —
`PlaylistRepository` (saved copies offline), the download index, the library
API with the Bearer token — and nothing waits on the network when offline:
playlists come from the saved copies (only those opened in the app before),
*Recently added* shows the downloads, and songs that are not on the phone
are left out of the lists. Browsing is allowed for this app, Android Auto /
Automotive and trusted system controllers only, since it shows playlist names.

### Using it with the sideloaded APK

Android Auto hides media apps that were not installed from Google Play until
you allow them, once, on the phone:

1. Open **Android Auto settings** on the phone (Settings → Connected devices →
   Connection preferences → Android Auto, or the Android Auto app).
2. Scroll to **Version** and tap it **10 times** until it says developer
   settings are enabled; confirm the dialog.
3. ⋮ (top right) → **Developer settings** → turn on **Unknown sources**.
4. Back in Android Auto settings → **Customise launcher**: tick
   **Listen Along** if it is not shown.
5. Disconnect and reconnect the phone (or restart Android Auto) so the car's
   launcher picks it up.

Playlists appear once the app has a server and token (Settings in the app);
for offline playlists, open them once in the app while online. To test without
a car, use the Desktop Head Unit (DHU) from the SDK's extras, with "Start head
unit server" in the same developer settings.

## Build and install

You need a JDK 17 or newer (21 works) and the Android SDK (compileSdk 37).

```bash
cd android
./dev.sh                            # build, install, launch on the connected phone
./gradlew :app:testDebugUnitTest    # unit tests (JVM, no device needed)
./gradlew :app:assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

Users get the app from the **`/app` page** of the web app (download, install
steps, connecting with a token), which offers the latest GitHub Release.

`dev.sh` finds a JDK (JAVA_HOME if it is ≥ 17, else 17, else 21+ under
`/usr/lib/jvm`) and the SDK (`ANDROID_HOME`, else `~/Android/Sdk`) by itself;
call `./gradlew` with `JAVA_HOME` and `ANDROID_HOME` set yourself. The debug
build installs as `com.erkantaylan.listenalong.debug`. minSdk 26, targetSdk 36.

## Releases

Push a tag `android-vX.Y.Z` (Y and Z under 100) and
`.github/workflows/android-release.yml` runs the unit tests, builds the signed
APK, checks its certificate and version, and publishes a GitHub Release with
`listen-along-X.Y.Z.apk`, a `.sha256` file and generated notes. The web app's
`/app` page picks it up within 10 minutes.

- **Version**: from the tag (`ANDROID_RELEASE_TAG`). versionName `X.Y.Z`,
  versionCode `X*10000 + Y*100 + Z`, so `android-v0.2.0` is 200. Without a tag
  a build is code 1, `0.2.0-dev`.
- **Signing key**: `~/keys/listen-along-release.jks`, with its password in
  `~/keys/listen-along-release.env`, on the maintainer's machine, and as the Actions
  secrets `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. Never in the repo.
  **If this key is lost, no update can ever install over existing installs**:
  everyone would have to uninstall first and lose the app's data. Keep a backup
  somewhere else. Certificate SHA-256 (public):
  `ddb6d8fe68097be1505d533755ee3c59d165e6e31852dbba9cc6a65f4561c3f5`.
- **Build one locally**: `set -a; . ~/keys/listen-along-release.env; set +a;
  ./gradlew :app:assembleRelease`. Without those variables the same command leaves
  an unsigned `app-release-unsigned.apk`.
- **R8**: release builds are minified and shrunk (`isMinifyEnabled`,
  `isShrinkResources`). `proguard-rules.pro` keeps the serializers. Run a
  release build against a real server after changing dependencies or
  API models; the unit tests run unminified.
- The release is `com.erkantaylan.listenalong`, the debug build
  `com.erkantaylan.listenalong.debug`, with different keys. They install side by side
  and share no token, settings or download index. Moving to the release
  means connecting it again; with music access, *Find songs already in the folder*
  picks up the files.

## Dev loop

```bash
./dev.sh                 # build, install, launch on the connected device
./dev.sh --stub          # ...against tools/stub_server.py, for this run only
./dev.sh --logs          # ...then tail logcat
ANDROID_SERIAL=emulator-5554 ./dev.sh --stub   # pick the device explicitly
./shot.sh out.png        # screenshot, refused unless the app is focused
```

`tools/stub_server.py` (Python standard library only) stands in for the real
server, which needs PostgreSQL. It serves every `.m4a`/`.opus`/`.ogg`/`.mp3`
in a folder through the same API — search, paging, sort, `Range`, `/api/me`
(with `upload_formats`) — plus
in-memory playlists seeded with one private playlist of yours and one public
playlist of someone else's (with a YouTube-only entry), with the server's
owner rules (`canEdit` too) and error answers, and broken-song reports
(`?reported=1`, `POST`/`DELETE /api/library/:id/report`, seeded with one
report by someone else). `--samples` makes six short test songs with
ffmpeg (m4a, one Ogg Opus, one mp3); `--throttle KBPS` slows transfers down.

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
├── player/      PlaybackService (Media3 MediaLibraryService), PlayerConnection,
│                PlayQueue, MediaItems, CarLibrary + CarTree (Android Auto)
├── net/         Connectivity (validated network + server reachability)
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

- Recognising songs after a reinstall needs **music access**. If it is denied,
  files from the earlier install stay invisible, and downloading one again
  produces `Name (1).m4a`. A file only comes back when its name and duration
  fit exactly one song: one whose title, artist or length changed on the
  server stays unrecognised, and so does a song with no duration.
- The play queue is not restored after the app process is killed, so the car's
  play button with nothing queued does nothing (no playback resumption yet).
- Android Auto: list rows have no cover art (only the playing song has, from
  the YouTube thumbnail or the file); a playlist that was never opened in the
  app is empty in the car while offline; no "Broken" marks or playlist
  editing in the car.
- There is no live socket: reports made elsewhere show up on the next
  refresh (resume, pull-to-refresh, reconnect), not instantly.
- Edit mode assumes nobody else edits the same playlist at the same time;
  if a move or removal fails, the playlist is reloaded from the server.
- Cover art comes from the audio file's embedded picture (shown once the
  player has read it); list rows use the placeholder.
- Android 8–9 writes the file directly and needs the storage permission. That
  path has not been run on a device.
- A failed or cancelled download starts over from zero (no `Range` resume).
