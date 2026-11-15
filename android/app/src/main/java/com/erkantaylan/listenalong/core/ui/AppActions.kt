package com.erkantaylan.listenalong.core.ui

import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.storage.LocalSong

/** What screens can ask of the app, so they need not know about the activity. */
class AppActions(
    /** Play [songs] from [index]; [context] is the "from" label. [shuffle] plays them shuffled. */
    val play: (songs: List<Song>, index: Int, context: String, shuffle: Boolean) -> Unit,
    val addToPlaylist: (List<Song>) -> Unit,
    /** Asks for the notification (and on old Androids storage) permission before the first download. */
    val beforeDownload: () -> Unit,
    val queued: (Int) -> Unit,
    val message: (String) -> Unit,
    val openSettings: () -> Unit,
    /** Opens the central login's sign-in page in a Custom Tab (auth/AuthController). */
    val signIn: () -> Unit,
    /** The source repository, the same link as the web footer. */
    val openSource: () -> Unit,
    val openExternal: (LocalSong) -> Unit,
    /** Deleting a file an earlier install created: asks the system for the user's consent. */
    val deleteWithConsent: (LocalSong) -> Unit,
    /** "music.etaylan.com", for hints. */
    val serverName: () -> String,
)
