package com.erkantaylan.listenalong

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import com.erkantaylan.listenalong.app.AppContainer
import com.erkantaylan.listenalong.app.AppInfo
import com.erkantaylan.listenalong.app.AppUi
import com.erkantaylan.listenalong.app.AppViewModel
import com.erkantaylan.listenalong.app.AppViewModels
import com.erkantaylan.listenalong.app.MusicAccessState
import com.erkantaylan.listenalong.app.PlatformActions
import com.erkantaylan.listenalong.core.designsystem.ListenAlongTheme
import com.erkantaylan.listenalong.core.designsystem.Palette
import com.erkantaylan.listenalong.core.model.CoverArt
import com.erkantaylan.listenalong.core.network.ServerUrl
import com.erkantaylan.listenalong.core.player.ExternalPlayer
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.core.storage.MediaStoreAudio
import com.erkantaylan.listenalong.core.ui.AppEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The one activity: the intents (the sign-in redirect, the notification's
 * "open the player", the debug server override), the system prompts
 * (permissions, delete consent, the browser) and [AppUi]. Everything else
 * lives in the ViewModels and the [AppContainer].
 */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
class MainActivity : ComponentActivity(), PlatformActions {

    private val container: AppContainer get() = (application as ListenAlongApp).container
    private val appVm: AppViewModel by viewModels { AppViewModels.app(container) }

    /** Set by the media notification (tap opens the full player). */
    private var openPlayerRequest by mutableStateOf(false)

    private var musicAccess by mutableStateOf(false)
    private var musicPromptDismissed by mutableStateOf(false)
    private var askedPermissions = false
    private var deleteConsentFor: LocalSong? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.WRITE_EXTERNAL_STORAGE] == false) {
            toast("Without storage access, songs cannot be saved on this Android version")
        }
    }

    private val musicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        musicAccess = granted
        if (granted) {
            appVm.musicAccessGranted()
        } else {
            container.musicAccessPrefs.edit { putBoolean(PREF_DECLINED, true) }
            dismissMusicPrompt()
            toast("Without music access, songs from an earlier install are not recognised, and downloading one again saves a second copy")
        }
    }

    private val deleteConsent = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val song = deleteConsentFor
        deleteConsentFor = null
        if (song != null && result.resultCode == RESULT_OK) {
            container.index.remove(song.songId)
            toast("Deleted")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A recreated activity (rotation) gets the same intent again: the
        // override and a sign-in redirect apply once, on the first create.
        if (savedInstanceState == null) {
            applyDebugOverride(intent)
            handleSignInRedirect(intent)
        }
        openPlayerRequest = intent?.getBooleanExtra(AppEntry.EXTRA_OPEN_PLAYER, false) == true
        musicAccess = container.sink.canSeeAllFiles
        musicPromptDismissed = container.musicAccessPrefs.getBoolean(PREF_PROMPT_DISMISSED, false)

        setContent {
            ListenAlongTheme {
                // Insets handled once, here: every screen draws inside the
                // safe area and the tab bar sits above the system navigation.
                // Test tags double as resource ids, so uiautomator (and adb
                // scripts) can find every tab, row and button.
                Box(
                    Modifier.fillMaxSize().background(Palette.page).safeDrawingPadding()
                        .semantics { testTagsAsResourceId = true }
                ) {
                    AppUi(
                        container = container,
                        appVm = appVm,
                        platform = this@MainActivity,
                        music = MusicAccessState(musicAccess, musicPromptDismissed, ::requestMusicAccess, ::dismissMusicPrompt),
                        openPlayerRequest = openPlayerRequest,
                        onOpenPlayerHandled = { openPlayerRequest = false },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        applyDebugOverride(intent)
        handleSignInRedirect(intent)
        if (intent.getBooleanExtra(AppEntry.EXTRA_OPEN_PLAYER, false)) openPlayerRequest = true
    }

    override fun onStart() {
        super.onStart()
        container.player.connect()
    }

    override fun onResume() {
        super.onResume()
        // Back from the browser without a redirect (closed, or Back): stop
        // waiting. A redirect arrives in onNewIntent, before this.
        container.auth.browserClosed()
        // The permission can change in system settings while we were away.
        val nowAllowed = container.sink.canSeeAllFiles
        val justAllowed = nowAllowed && !musicAccess
        musicAccess = nowAllowed
        appVm.onResume(musicAccessJustGranted = justAllowed)
    }

    /**
     * Debug builds only: `adb shell am start ... --es server http://localhost:8091 --es session devtoken`
     * points this process at another server (and, optionally, a session the
     * stub accepts) without saving it (dev.sh --stub does this), so testing
     * never overwrites the phone's real settings or sign-in.
     */
    private fun applyDebugOverride(intent: Intent?) {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val server = intent?.getStringExtra(EXTRA_DEBUG_SERVER) ?: return
        if (!debuggable) return
        val url = ServerUrl.normalize(server) ?: return
        container.settings.overrideForSession(url, intent.getStringExtra(EXTRA_DEBUG_SESSION))
        // The stub serves its own thumbnails, so the dev loop never asks YouTube.
        intent.getStringExtra(EXTRA_DEBUG_THUMBS)?.let { CoverArt.base = it }
        // Debug builds never look for updates; this asks them to (the stub answers /api/app/latest).
        if (intent.getBooleanExtra(EXTRA_DEBUG_UPDATES, false)) container.appUpdates.allowInDevBuild = true
    }

    /** The sign-in redirect (custom scheme or App Link) from feature/auth/AuthRedirectActivity. */
    private fun handleSignInRedirect(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (container.auth.handleRedirect(data)) {
            // Used up: never replayed by a later recreate.
            setIntent(Intent(intent).setData(null))
        }
    }

    // --- PlatformActions ----------------------------------------------------

    /** The central login's page in a Custom Tab (the browser's cookies: one tap when already signed in there). */
    override fun signIn() {
        val url = container.auth.begin()
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, url.toString().toUri())
        } catch (e: ActivityNotFoundException) {
            container.auth.cancel()
            toast("No browser to sign in with")
        }
    }

    override fun openUrl(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
            .onFailure { toast("No browser to open $url") }
    }

    override fun openSource() {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, AppInfo.SOURCE_URL.toUri())) }
            .onFailure { toast("No browser to open ${AppInfo.SOURCE_URL}") }
    }

    override fun openExternal(song: LocalSong) {
        if (song.reclaimed && !container.sink.canSeeAllFiles) {
            toast("Needs music access: see Settings")
            return
        }
        lifecycleScope.launch {
            val present = withContext(Dispatchers.IO) {
                runCatching { container.sink.exists(song.uri) }.getOrDefault(true)
            }
            if (!present) {
                container.index.remove(song.songId)
                toast("That file was deleted outside the app; download it again from Library")
                return@launch
            }
            val result = ExternalPlayer.open(this@MainActivity, song)
            if (result is ExternalPlayer.Result.NoHandler) toast("No app installed that plays ${result.mimeType}")
        }
    }

    override fun deleteWithConsent(song: LocalSong) {
        val request = container.sink.deleteConsent(song.uri)
        if (request == null) {
            toast("This app cannot delete that file; use a file manager")
        } else {
            deleteConsentFor = song
            deleteConsent.launch(IntentSenderRequest.Builder(request).build())
        }
    }

    /**
     * Asked the first time a download or playback starts, not at launch:
     * notifications (download progress, the player's controls), and storage
     * on Android 9 and older, which has no MediaStore RELATIVE_PATH.
     */
    override fun askPermissions(forDownload: Boolean) {
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
            if (forDownload && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (wanted.isNotEmpty() && !askedPermissions) {
            askedPermissions = true
            permissionLauncher.launch(wanted.toTypedArray())
        }
    }

    override fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    // --- Music access -------------------------------------------------------

    private fun dismissMusicPrompt() {
        musicPromptDismissed = true
        container.musicAccessPrefs.edit { putBoolean(PREF_PROMPT_DISMISSED, true) }
    }

    private fun requestMusicAccess() {
        val declined = container.musicAccessPrefs.getBoolean(PREF_DECLINED, false)
        if (declined && !shouldShowRequestPermissionRationale(MediaStoreAudio.READ_PERMISSION)) {
            // The system no longer shows its dialog: only its settings page can change this.
            toast("Turn on Music and audio under Permissions")
            runCatching {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            }
        } else {
            musicPermission.launch(MediaStoreAudio.READ_PERMISSION)
        }
    }

    companion object {
        const val EXTRA_DEBUG_SERVER = "server"
        const val EXTRA_DEBUG_SESSION = "session"
        const val EXTRA_DEBUG_THUMBS = "thumbs"
        const val EXTRA_DEBUG_UPDATES = "updates"
        private const val PREF_PROMPT_DISMISSED = "prompt_dismissed"
        private const val PREF_DECLINED = "declined"
    }
}
