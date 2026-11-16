# Listen Along for Android

The listen-along music library on your phone: browse and search it, play it
(streamed, or from downloaded files with no connection), manage playlists,
and keep songs as **plain, unencrypted, tagged audio files** that VLC or any
other player can open too.

Kotlin + Jetpack Compose + Media3, no cross-platform runtime. The look is the
web app's phone layout (`DESIGN.md`, "Android" section): dark only, rounded
panels on the page colour with a gap between them (the page, the player bar,
the tabs), soft greys on a page < surface < raised < overlay scale, one
cornflower-blue accent (filled, dark text) for the main action of each screen
and the play button, segmented controls for exclusive views, playlists'
coloured covers of initials (the same colour as on the web) and the songs'
cover pictures.

## Getting started

The app talks to **https://music.etaylan.com** out of the box (change it in
Settings). The library and playlists need you to **sign in**: on first launch
the app opens Settings; tap **Sign in**. The central login's page
(id.etaylan.com) opens in a Custom Tab, the browser comes back to the app by
itself, and you are in (one tap when that browser is already signed in
there). The same account rules as the web apply (see [Signing in](#signing-in)).

## What it does

- **Library**: every song on the server. Search, sort (recent, title,
  artist), scroll to load more. Tap a song to play the list from there; **Play**
  / **Shuffle** play the whole result. The download button saves a song (tap
  the ring again to cancel; a small green circle with an arrow before the
  muted line means it is on the phone). ⋮ → *Add
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
  controls. Its **Download** switch (and ⋮ → *Download*) makes it a
  [downloaded playlist](#downloaded-playlists): every song is kept on the
  phone and followed as the playlist changes. The list has the web sidebar's
  filter (**All / Mine / Public / Private**) and a **Downloaded** chip.
  **Edit** in the top bar (shown when you may change the list: the server's
  `canEdit` — a public playlist is anyone's, a private one its owner's)
  switches to edit mode: a drag handle per row (drag it, or long-press-drag
  the row; the list scrolls at the edges), a remove button with an **Undo**
  snackbar, and tapping does not play; **Done** or Back leaves. A finished
  drag sends one move; a removal is sent when the snackbar times out (or on
  Done / the next removal / leaving the playlist). TalkBack gets *Move up* /
  *Move down* actions on each row. ⋮ on a playlist, for its owner:
  *Rename*, *Make private/public* and *Delete* (who may do what comes from the
  server's `canManage`; its error is shown if it refuses). ⋮ on a song:
  *Add to another playlist*, *Remove from playlist* (with Undo), and the
  report entries. **+** makes a new playlist
  (name, Public/Private). Entries that are not in the library (old
  YouTube-only queue entries) are listed but cannot be played.
- **On device**: the download queue while it runs, the **downloaded
  playlists** (each with its status), then the songs downloaded on their own
  (play, shuffle — Play and Shuffle take everything on the phone —, add to
  playlist, open in another app, delete).
- **Settings**: **Account** (Sign in, or who is signed in, **Test
  connection** (`/api/me` and `/api/library`) and **Sign out**), the server
  address, **Downloaded playlists** (its two settings), storage stats, and
  the app version (`versionName`, from the release tag) with **Check for
  updates** and a link to the source on GitHub.
- **Covers**: every song row, the player, the notification, the lock screen
  and the car show the song's cover: the public YouTube thumbnail the web
  shows (`core/model/CoverArt`), loaded by Coil through an HTTP client of its
  own that never carries the session; a downloaded song's cover is saved next
  to the app's data (`files/covers`, never in Music/ListenAlong), so it shows
  offline too, and goes with the download. Songs with no video keep the file's
  embedded picture or the placeholder.
- **Updates**: when the app opens (and at most every 12 hours while it stays
  open) it asks the server's `GET /api/app/latest` — the GitHub releases the
  web's `/app` page offers. A newer release shows a banner above the page,
  *Version X.Y.Z is available*, with **Download** (the APK in the browser) and
  **Later** (that version hidden for 3 days; a newer one shows at once).
  Never forced, nothing installed by the app; nothing shown when signed out,
  offline, when the check fails, or in a debug / `-dev` build (`--ez updates
  true` asks a debug build to). Versions compare as numbers, X.Y.Z =
  X*10000 + Y*100 + Z (the version code); pre-releases are not offered.

## Signing in

The app signs in through the owner's central login the way the web does
(server side: `backend/src/auth/mobileAuth.ts`, CENTRAL-LOGIN.md "The Android
app"). It never asks for a token and never holds the central login's tokens.

- **Sign in** makes a PKCE verifier, `state` and `nonce` (`core/auth/AuthFlow`;
  kept encrypted until the browser comes back, so it survives the app being
  killed meanwhile) and opens `<server>/auth/mobile/start?…&redirect_uri=…`
  in a Custom Tab. The server sends it on to the central login, which sends
  the browser back to that redirect with `code` and `state`; Android hands it
  to `feature/auth/AuthRedirectActivity`. Both redirects are handled alike; one with a
  `state` that is not the app's own is refused. (A server from before App
  Links ignores `redirect_uri` and answers on the scheme; that still works.)
- **Which redirect** (`AuthFlow.redirectFor`, the one place, unit tested):
  - **Release builds, server `https://music.etaylan.com`**: the https **App
    Link** `https://music.etaylan.com/auth/mobile/callback`. Declared with
    `autoVerify` in `src/release/AndroidManifest.xml`; Android verifies it
    against the server's `/.well-known/assetlinks.json` (the release key's
    SHA-256) and then gives the link to this app only, without a chooser.
    A custom scheme can be claimed by any installed app; this cannot.
    **Known limit, Android 8–11** (minSdk stays 26): there, an app with an
    unverified intent filter for the host can be offered in a chooser next to
    this one for the link; Android 12+ sends an unverified link only to the
    browser. The risk the link removes is closed only once the custom scheme
    is also removed from the IdP client (CENTRAL-LOGIN.md "The redirect").
  - **Everything else**: the custom scheme `com.etaylan.listen:/oauth2redirect`
    (registered at the central login; `build.gradle.kts` puts it in the
    manifest and `BuildConfig`; not the applicationId). Any other server
    (self-hosted, development) cannot be declared in the manifest, and debug
    builds (`.debug`, the debug key) are never verified for the production
    host. Once the scheme is removed from the production IdP client (with
    `MOBILE_CUSTOM_SCHEME=off` on the server), **debug builds can no longer
    sign in against production**: develop against a server with
    `INSECURE_DEV_LOGIN`, the stub, or an IdP of your own that registers the
    scheme.
  - **Not verified (yet)**: Android shows the https URL in the browser
    instead. The server's page there has an **Open the app** button: an
    `intent:` link to the same URL naming this package, which works whether
    or not the domain is verified and which no other app can take. So a
    release build always asks for the App Link on the production server; it
    does not look at `DomainVerificationManager` first and fall back to the
    custom scheme, because that fallback would hand the code to whoever holds
    the scheme (the very risk the App Link removes) and would stop working
    once the scheme is removed from the IdP. The cost is one extra tap on a
    phone where verification failed. Check it with
    `adb shell pm get-app-links com.erkantaylan.listenalong` (`verified`).
- The app sends the code, the verifier, the nonce and the redirect to
  `/auth/mobile/exchange`; the server exchanges the code, checks the
  id_token, finds the account by the same rules as the web, and answers with
  the app's own session token (`lam_…`). It is stored encrypted
  (EncryptedSharedPreferences, `core/data/SettingsStore`) for the server it
  was made on (another address drops it) and sent as `Authorization: Bearer`.
- **Signed out** happens only on a **401 with `code: SESSION_ENDED`** from
  the server (`core/network/SessionEndedInterceptor` on every API and streaming call:
  the session ended, expired after 30 days, was signed out, or the account was
  disabled centrally or rejected in `/dashboard`). Then the app shows **Sign
  in** again and says why. Offline, a timeout, a 5xx, a 403, a bare 401 or a
  401 `AUTH_REQUIRED` never sign you out: downloaded songs keep playing.
- **Sign out** (Settings → Account) forgets the session at once and tells
  the server when it can be reached. It does not sign you out of the central
  login in the browser, so signing in again is one tap.
- The state machine (`core/auth/AuthController`) and the protocol (`AuthFlow`,
  `core/network/SignInClient`, the interceptor) are unit tested.
- **Upgrading** from a version that used an API token: the saved token is
  deleted at the first start (it still works for the CLI until you revoke it
  on your profile page: CLI tokens); downloads, saved playlists and settings
  are kept; sign in once.
- A pending account can sign in; the library and playlists then say the
  account is waiting for approval, as on the web.

## Player

`core/player/PlaybackService` is a Media3 `MediaLibraryService` around one
ExoPlayer; the UI only talks to it through a `MediaController`
(`core/player/PlayerConnection`, one per process in `AppContainer`), Android Auto
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
- Each queued song is resolved once (`core/player/PlayQueue`): a downloaded song
  plays from its MediaStore file, anything else streams from
  `/api/library/:id/file` through an OkHttp client whose interceptor adds the
  session (Bearer), only for the configured server. Range requests make seeking
  in a stream cheap.
- A song that fails (deleted file, 404, connection lost) is skipped and a
  toast says why. A stream that fails because the server cannot be reached
  (no route, timeout, a dropped connection, a 5xx) also marks the server
  unreachable for a minute, and the player goes on with the next
  **downloaded** song (see Offline).
- UI: a mini player above the tabs, a rounded raised panel like the web's
  player bar (cover: the file's embedded art, else the saved or public
  thumbnail; title, "artist · from", previous / play / next, a thin seek line)
  and a full player (seek bar, shuffle, repeat off/all/one). The playing row in
  every list has the accent tint, the equaliser and a semibold accent title.

## Offline

- "Offline" (`core/network/Connectivity`) means no **validated** network (Android
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
  you opened (`core/data/PlaylistCache`, JSON files under the app's files
  dir, per server). Offline, or when the server answers 5xx, those are shown
  read-only with "Offline — saved copy from …"; editing actions are disabled.
  A 4xx is not hidden behind the cache: an ended session is shown, and a
  playlist that answers 404 is forgotten.
- **Broken songs**: the list of reported songs (`core/data/ReportRepository`) is
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
(`core/storage/FileMatcher`, at start, on resume and before downloads): the file
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
use the same queue; below 200 MB of free space nothing more is downloaded
("Not enough free space on the phone").

### Downloaded playlists

A playlist's **Download** switch (its page; ⋮ → *Download*) keeps every song
of it on the phone, and keeps following it: songs added later — by anyone,
on any client — are downloaded, songs removed are removed (see below). It is
Spotify's model, run by `core/data/PlaylistDownloads` over a pure plan
(`core/domain/PlaylistSyncPlanner`, unit tested).

- **When it syncs.** There is no socket, so at moments: when the app starts,
  when the playlists list or a downloaded playlist is loaded or pulled to
  refresh, when the connection returns, and **every 6 hours in the
  background** (`PlaylistSyncWorker`, WorkManager, scheduled only while a
  playlist is downloaded; battery not low; any network but roaming, or
  unmetered only when mobile data is off). Each run is idempotent and
  resumable: the queue, the index and the saved records let an interrupted or
  repeated run pick up where it stopped; a song that is on the phone, queued,
  or in two downloaded playlists is fetched once. All of it (enable, disable,
  sync) runs under one lock.
- **Saved per server and account.** The records (`playlists_v1` in the
  `downloads` prefs: `{version: 2, records: [{server, account, playlists,
  missing}]}`) are keyed by the server address AND the signed-in account's id
  (from the sign-in's answer, or `/api/me` once for a session made before
  the app kept it; nothing syncs while it is not known). The download index
  is one for the phone, so no record ever removes what it did not itself
  want. Another server's or account's records are not shown; when the app
  can no longer sync a record — the server address changed (even http →
  https), or another account signed in — the first sync or Download switch
  under the new server and account stops it: its playlists stop being
  synced (a message says so) and their files become **yours** (`manual`)
  before the record is forgotten, so nothing can remove them later. Until
  then nothing touches them either (no removal can come from another
  record). Signing out alone changes nothing: the
  same account signing in again carries on. A record store that cannot be
  read is copied to `playlists_unreadable`, every file playlist sync saved
  becomes yours, and it starts over (no removals). A sync whose server or
  account changes while it runs applies nothing.
- **Why a file is there.** The download index records it: `manual` = you
  asked (a song's download button, *Download all shown* / *Download
  playlist*, or kept when you turned a playlist's Download off), otherwise
  playlist sync saved it. Asking for a song playlist sync already saved or
  queued makes it yours, also when you ask while its download is running;
  yours is never turned back into the sync's. Downloads from before this
  version have no such field and count as yours.
- **Removed songs.** Settings → *Remove downloads of songs removed from a
  playlist* (**on** by default): when a complete answer from the server
  drops a song from a downloaded playlist, its file is removed too — only if
  that playlist wanted it before, no downloaded playlist (of any server or
  account) wants it now, playlist sync saved it, and it was not found in the
  folder from an earlier install. Removal is decided at that moment, from
  what the playlist itself wanted; nothing is ever removed for "not being in
  any playlist". Files you downloaded yourself, and every download from
  before playlist sync, are never removed. Off: removed songs stay (turning it
  on later does not remove them). A file that cannot be deleted (scoped
  storage) stays and is not tried again.
- **Only complete answers remove anything.** An answer in which any entry
  names no library song (the server's library lookup failing answers 200
  with `library_id: null` everywhere; an old YouTube-only entry), or that
  cannot be read (a 200 without `songs`), is never a reason to remove: its
  readable songs still download. A failed or offline fetch never removes
  anything either.
- **Guard.** A complete answer that is empty after having songs, or that
  loses more than half of them (and at least two) at once, deletes nothing:
  it is held with the time it was first seen (saved, so it survives a
  restart or a reboot; its new songs still download) and accepted only by a
  complete answer with the same list **at least 24 hours** later. A
  different list starts the wait again; a clock set back restarts it rather
  than confirming early. There is no per-run cap on removals (runs come
  seconds apart, so a cap would not slow anything down); the 24 hours and
  the rules above are the guard. Debug builds can move the sync's clock
  forward for one process (`--el clock_offset_ms <ms>`, see Dev loop).
- **Turning Download off** asks: *Keep songs* (they become yours) or
  *Remove* (the files it downloaded that no other downloaded playlist holds).
- **A playlist you can no longer see** (deleted, or made private: the server
  answers 404) is not synced any more; its files stay, and On device shows it
  as *No longer available* until you remove it there.
- **Network.** Settings → *Download over mobile data* (**on** by default).
  Off: playlist sync downloads on unmetered networks (Wi-Fi) only; on: also on
  mobile data, but never while roaming and never with Data Saver restricting
  the app. Your own downloads always run as before. While held, the playlist
  says *Waiting for Wi-Fi*; offline, *Paused while offline*.
- **Missing files.** A song whose file the server lacks (404) is skipped for a
  day, then tried once more; never looped. The playlist says *n not on the
  server*.
- **Status** (header, rows, On device): *Downloaded · n songs · size*,
  *Downloading n of m*, *Waiting for Wi-Fi*, *Paused while offline*,
  *Download stopped: … ·* **Retry**, *No longer available*; a small green
  circle with an arrow marks a downloaded playlist or song, a ring one that is
  downloading.

## Android Auto

The app is an Android Auto media app: `PlaybackService` is a
`MediaLibraryService`, the manifest declares
`com.google.android.gms.car.application` (`res/xml/automotive_app_desc.xml`,
`<uses name="media"/>`) and the `android.media.browse.MediaBrowserService`
action. `core/player/CarLibrary` is the session callback, `core/player/CarTree` the
media ids (pure, tested). In the car:

- **Playlists** → a playlist → *Shuffle*, then its songs. Downloaded
  playlists come first, with the car's download mark; offline they are there
  with every song.
- **On device** → *Shuffle*, then the downloaded songs (artist, title).
- **Recently added** → *Shuffle*, then the 200 newest library songs.
- **Search** (voice or typed): the library search; offline, the downloads.

Tapping a song plays its whole list from that song, with the same queue
rules as the app (`PlayQueue.build`: downloaded songs from the file, the rest
streamed, offline only the downloaded ones). Downloaded songs carry the car's
download mark. A row's cover is the saved cover (a `content://` URI of the
app's FileProvider, granted to the car's app) or the public thumbnail. The data comes from the same places as the app's screens —
`PlaylistRepository` (saved copies offline), the download index, the library
API with the session — and nothing waits on the network when offline:
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

Playlists appear once the app is signed in (Settings in the app);
for offline playlists, turn their Download on (or open them once in the app while online). To test without
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
steps, signing in), which offers the latest GitHub Release.

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
  The server publishes it in `/.well-known/assetlinks.json` for the sign-in
  App Link (`backend/src/auth/mobileAuth.ts` `RELEASE_CERT_SHA256`): a new key
  means setting `ANDROID_APP_CERT_SHA256` on the server (new and old while
  old installs remain), or the App Link stops verifying.
- **Build one locally**: `set -a; . ~/keys/listen-along-release.env; set +a;
  ./gradlew :app:assembleRelease`. Without those variables the same command leaves
  an unsigned `app-release-unsigned.apk`.
- **R8**: release builds are minified and shrunk (`isMinifyEnabled`,
  `isShrinkResources`). `proguard-rules.pro` keeps the serializers. Run a
  release build against a real server after changing dependencies or
  API models; the unit tests run unminified.
- The release is `com.erkantaylan.listenalong`, the debug build
  `com.erkantaylan.listenalong.debug`, with different keys. They install side by side
  and share no session, settings or download index. Both register the sign-in
  scheme, so with both installed Android asks which one gets a custom-scheme
  sign-in: pick the one you started from (a release build on music.etaylan.com
  uses the App Link, which only the release takes). Moving to the release means signing in again; with music access, *Find songs already in the folder*
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
in a folder through the same API — search, paging, sort, `Range`, `/api/me` —
the app's sign-in (`/auth/mobile/start` shows a "Continue as stub-user" link,
`/auth/mobile/exchange` checks the verifier, the nonce and the redirect (the
server's allowlist: the custom scheme, also when none is named, or
`http://localhost:<port>/auth/mobile/callback`; `--no-custom-scheme` refuses
the scheme like `MOBILE_CUSTOM_SCHEME=off`) and hands out a `lam_`
session, `/auth/mobile/logout`; an unknown session answers 401
`SESSION_ENDED`, and `POST /stub/end-sessions` ends them all, to try the
signed-out path), plus
in-memory playlists seeded with one private playlist of yours and one public
playlist of someone else's (with a YouTube-only entry), with the server's
owner rules (`canEdit` too) and error answers, and broken-song reports
(`?reported=1`, `POST`/`DELETE /api/library/:id/report`, seeded with one
report by someone else). `--samples` makes ten short test songs with
ffmpeg (m4a, Ogg Opus, one mp3; four are in no playlist, for adding);
`--throttle KBPS` slows transfers down. Every sample song but one has a
made-up `youtube_id`, and `/stub/thumbs/<id>/hqdefault.jpg` serves a generated
cover, so covers work with no network. `/api/app/latest` offers
`--app-version` (0.9.0). `--central-sessions` makes its sign-ins say `mode:
central`, so a minified release build (which refuses dev sessions) can be
tried against it. To watch playlist sync, change a playlist
"elsewhere" and pull to refresh in the app:

```bash
curl -X POST 'localhost:8091/stub/change?playlist=Stub%20mix&add=2&remove=1'  # someone adds 2, removes 1
curl -X POST 'localhost:8091/stub/missing?song=Cambodia'          # its file answers 404 FILE_MISSING
curl -X POST 'localhost:8091/stub/hide?playlist=Stub%20mix'       # it goes private to someone else (404)
curl -X POST 'localhost:8091/stub/degrade?playlist=Stub%20mix&mode=nulls'   # 200, every library_id null (mode=nosongs: no `songs`; mode=off)
```

The 24-hour rule for a big shrink: start the app again with the sync's clock
moved forward (debug builds only, this process only):
`adb -s emulator-5554 shell am start -n com.erkantaylan.listenalong.debug/com.erkantaylan.listenalong.MainActivity --es server http://localhost:8091 --es session devtoken --el clock_offset_ms 90000000`.

`./dev.sh --stub` starts it, tunnels it to the phone's `localhost:8091` with
`adb reverse`, and launches the app with `--es server http://localhost:8091
--es session devtoken --es thumbs http://localhost:8091/stub/thumbs/` (a
session the stub accepts from the start; covers from the stub instead of
YouTube). Debug
builds take those intent extras as an **in-memory** override for that process
(Settings shows a notice): the server and the sign-in saved on the phone are
never touched, and a sign-in made against the stub stays in memory too.
Restart the app normally to go back to them. Sign out and Sign in work against
the stub (its page, then back to the app).

Against a local server with the dev sign-in (`INSECURE_DEV_LOGIN=1`, see
CLAUDE.md), `adb reverse tcp:3000 tcp:3000` and launch with `--es server
http://localhost:3000`: Sign in shows "Continue as Dev User" (or another
account by `users.id`). That session says `mode: dev`, which only debug builds
accept; release builds refuse it, and production servers cannot run the dev
sign-in at all. With the fake IdP (`node src/testing/fakeOidcIssuer.ts`) instead, the
real protocol runs; reverse its port too.

Cleartext HTTP is allowed only for `localhost`, `127.0.0.1` and `10.0.2.2`
(see `res/xml/network_security_config.xml`). A real server must use HTTPS,
because the session token travels with every request.

Compose test tags are exposed as resource ids (`tab:playlists`,
`song:<id>`, `playlist:<id>`, `mini-player`, `player:toggle`, …), so
`uiautomator dump` can find and tap them from scripts.

## Architecture

One Gradle module (`:app`) on purpose: about 12k lines, one developer, and
the release workflow, R8 rules and signing in one place; separate Gradle
modules would add build files and slower configuration for a boundary the
package rules below already draw (they are the cut lines if it ever grows).
Packaged by feature, following Android's
recommended app architecture: a UI layer (Compose screens, one ViewModel
per screen exposing immutable state as `StateFlow`, events going up as
function calls), a data layer (repositories over the API, the saved copies
and the download store) and a thin domain layer for rules several screens
share.

```
app/src/main/java/com/erkantaylan/listenalong/
├── MainActivity, ListenAlongApp   the activity (intents, system prompts) and the Application
├── app/           AppContainer (manual DI), AppViewModels (the factories), AppUi (NavHost
│                  + shell), Routes (type-safe), AppViewModel (shell state, report dialogs)
├── feature/
│   ├── library/   LibraryScreen + LibraryViewModel
│   ├── playlists/ PlaylistsScreen/ViewModel (list), PlaylistScreen/ViewModel (one
│   │              playlist, edit mode: PlaylistEdits), AddToPlaylist, dialogs
│   ├── downloads/ OnDeviceScreen + OnDeviceViewModel
│   ├── player/    MiniPlayer, FullPlayer (read core/player's PlayerControls)
│   ├── settings/  SettingsScreen + SettingsViewModel
│   ├── reports/   the "Mark as broken" dialogs
│   └── auth/      AuthRedirectActivity (the sign-in redirect)
└── core/
    ├── model/     Song, Playlist, PlaylistEntry, … (the server's JSON), formatting
    ├── network/   ListenAlongApi + LibraryClient (every path and field name on the wire),
    │              SignInClient, SessionEndedInterceptor, Connectivity (NetworkMonitor)
    ├── auth/      AuthController (the sign-in state machine), AuthFlow (PKCE, redirect)
    ├── data/      repositories: Library, Playlist (+ PlaylistCache), Report, Account,
    │              PlaylistDownloads (playlist sync), AppUpdates;
    │              SettingsStore (server + encrypted session)
    ├── download/  Downloads (queue, drain, delete, reclaim), DownloadWorker, BulkPlan
    ├── storage/   MediaStore sink, FileNames, FileMatcher, DownloadIndex, TextStore
    ├── domain/    shared rules: the offline library, PlaylistSyncPlanner (pure), UpdateRules
    ├── player/    PlaybackService, PlayerConnection, PlayQueue, PlayLauncher, Android Auto
    ├── designsystem/ tokens (Palette, Dimens, TextSizes), components, icons, PlaylistCover
    └── ui/        composables that know the models (SongRow, song menu), AppActions
```

Rules:

- **Where state lives.** Screen state is in the screen's ViewModel
  (`StateFlow<…Ui>`); composables only draw it and call the ViewModel. Data
  that outlives a screen is in a repository, which is its single source of
  truth: the playlists list is `PlaylistRepository.observePlaylists()`, so a
  rename on a playlist's page shows on the list at once; the downloads are
  `Downloads.snapshots`. Only throwaway UI state (an open menu, a text field
  being typed) stays in the composable.
- **What may depend on what.** `feature/*` → `core/*`, never another
  feature; `app/` wires features together (navigation, the shell);
  `core/*` never imports `app/` or `feature/*`. The Android entry points in
  core (the player service, the download worker) get their dependencies from
  the Application through small interfaces (`PlayerHost`, `DownloadsHost`)
  and open the app through `core/ui/AppEntry`, so core does not know the
  activity.
- **New dependencies**: Navigation Compose (type-safe routes, a ViewModel per
  destination) and Coil 3 (covers: Compose image loading with memory and
  disk caches; its own OkHttp client, never the session's).
- **Dependency injection** is a hand-written `AppContainer`, one per process:
  a dozen objects with one lifetime do not need Hilt or Koin.
  `AppViewModels` is the one place that knows which pieces each ViewModel
  gets; a ViewModel never sees the container, so its tests pass fakes.
- **Navigation** is Navigation Compose with type-safe `@Serializable`
  routes (`app/Routes.kt`). Each destination gets its own ViewModel scoped to
  its back stack entry; a playlist's id travels in its route. The bottom tabs
  keep their own back stacks (a playlist stays open when you come back to
  Playlists); Back from any tab returns to the Library. The full player is an
  overlay, not a destination.
- **The network is one interface**: everything the app asks the server is a
  method of `core/network/ListenAlongApi`, and every path, query parameter and
  JSON field name is in `LibraryClient` and `core/model`, so renaming one on
  the wire is a change there.
- **Testing**: repositories and ViewModels take interfaces (`ListenAlongApi`,
  `NetworkMonitor`, `AudioSink`, `TextStore`, `ServerSettings`) and run in
  JVM unit tests with fakes (`src/test/.../testing/Fakes.kt`); the HTTP
  parsing runs against MockWebServer.

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
- A session lasts 30 days from sign-in (as on the web), then the app asks you
  to sign in again.
- There is no live socket: reports made elsewhere show up on the next
  refresh (resume, pull-to-refresh, reconnect), not instantly.
- Edit mode assumes nobody else edits the same playlist at the same time;
  if a move or removal fails, the playlist is reloaded from the server.
- Covers are YouTube's thumbnails (4:3 with black bars for 16:9 videos, as
  on the web); a song with no video has none in lists. A song downloaded
  before this version gets its saved cover the next time the phone is online
  (one library listing to learn the video ids).
- Android 8–9 writes the file directly and needs the storage permission. That
  path has not been run on a device.
- A failed or cancelled download starts over from zero (no `Range` resume).
