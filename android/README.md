# Listen Along for Android

Keeps songs from the listen-along music library on your phone as **plain,
unencrypted, tagged audio files** that VLC or any other player can play. It
has no player of its own. It downloads songs and hands them off.

Kotlin + Jetpack Compose, with no cross-platform runtime. It uses the same
stack, versions and conventions as the kitaplik reader app: one catalog in
the cloud, download what you want, and an On device tab.

## What it does

- **Library**: every song on the server. Search by title or artist, sort by
  recent, title or artist, and scroll to load more pages. Each row shows the
  title, artist, duration, who uploaded it, and whether it is already on the
  device. Tap a row to download it. Tap a row that is downloading to cancel
  it, or a saved row to play it. **Download all** fetches the whole current
  search result: a dialog first shows how many songs that is and the rough
  size (about 1 MB per minute), and skips what you already have.
- **On device**: the saved songs, plus the download queue while it runs.
  Tap a song to open it in your player (`ACTION_VIEW`, `audio/mp4` or
  `audio/mpeg`, content URI). Long-press to delete it. Pull down to forget
  songs whose files were deleted in another app. The app also does this every
  time it comes to the foreground.
- **Settings**: the server address, an optional API token (sent as
  `Authorization: Bearer …` and stored encrypted), a **Save and test** button
  that checks `/api/library` and `/api/me`, and the Night/Paper theme.

### Where the files go

`Music/ListenAlong/<Artist> - <Title>.m4a` is saved through MediaStore, so
the files are public and every app sees them. The server's bytes are stored
**unchanged**, so its tags and cover art come along. The extension comes
from the response `Content-Type`: legacy songs can be `.mp3`. Names are
sanitised for FAT/exFAT (`\ / : * ? " < > |`, control characters, and
leading/trailing dots are removed) and capped at 200 UTF-8 bytes. The
server's placeholder artist `Unknown` is dropped.

A small JSON index in SharedPreferences maps each song id to its MediaStore
URI. That is how the app knows what is downloaded and avoids duplicates.

### Downloads

A single WorkManager worker drains a persisted queue, **two songs at a time**,
as a `dataSync` foreground service. It shows one progress notification with a
**Cancel all** action and posts a summary when it finishes. Downloads keep
going with the app closed. If the process dies, WorkManager restarts the
worker and the unfinished songs are fetched again. The half-written files
left behind are swept up first. A transient failure (a network error or a
5xx) is retried twice. A 4xx (404, a bad token) fails at once, and the row
offers a retry.

## Build and install

You need JDK 17 and the Android SDK (compileSdk 37). Then:

```bash
cd android
./gradlew :app:assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # unit tests (JVM, no device needed)
./gradlew :app:installDebug         # install on the connected device
```

The debug build installs as `com.erkantaylan.listenalong.debug`, next to a
future release build. minSdk is 26 and targetSdk is 36, the same as kitaplik.
The first time the app opens, it goes to Settings so you can enter the
server address.

## Dev loop

```bash
./dev.sh                 # build, install, launch on the connected device
./dev.sh --stub          # ...plus a local stub library over an adb reverse tunnel
./dev.sh --logs          # ...then tail logcat
ANDROID_SERIAL=emulator-5554 ./dev.sh --stub   # pick the device explicitly
./shot.sh out.png        # screenshot, refused unless the app is focused
```

The real server needs PostgreSQL. `tools/stub_server.py` (Python standard
library only) stands in for it. It serves every `.m4a`/`.mp3` in a folder
through the same API: search, paging, sort, `Range`, and `/api/me` with a
token. `--samples` uses ffmpeg to make five short test songs, including an
mp3 and names with awkward characters. `--throttle KBPS` slows transfers
down so you can watch progress and test cancelling. With `./dev.sh --stub`,
set the server in the app to `localhost:8091` and the token to `devtoken`.

Cleartext HTTP is allowed only for `localhost`, `127.0.0.1` and `10.0.2.2`
(see `res/xml/network_security_config.xml`). A real server must use HTTPS,
because the token travels with every request.

## Layout

```
app/src/main/java/com/erkantaylan/listenalong/
├── api/         LibraryClient (OkHttp), models, base-URL normalising
├── settings/    server URL + encrypted token
├── storage/     MediaStore sink, filenames, the song-id → URI index
├── download/    queue, state, the drain loop, WorkManager worker + notification
├── open/        hand-off to an external player
└── ui/          Library, On device, Settings, tab bar, theme
```

`Downloads` is the one place that downloading logic lives. The UI enqueues
and cancels there, and the worker calls `drain()`. It depends on an
`AudioSink` interface rather than on MediaStore directly, so the whole
download path runs in JVM unit tests against MockWebServer.

## Known limits

- The download index lives in app storage. After a reinstall or a data
  clear, the app no longer knows about files it saved earlier, and on
  Android 10+ it cannot see them without a media permission it does not
  request. Downloading those songs again produces `Name (1).m4a`.
- Android 8–9 writes the file directly and needs the storage permission. That
  path has not been run on a device.
- A failed or cancelled transfer starts over from zero. There is no `Range`
  resume, because songs are a few MB each.
