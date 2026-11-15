package com.erkantaylan.listenalong.core.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.erkantaylan.listenalong.core.network.ServerUrl
import com.erkantaylan.listenalong.core.storage.TextStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import okhttp3.HttpUrl

/**
 * Where the library lives, and the session with it: [token] is the app's
 * own session token from the central login (`lam_...`, backend/src/mobileAuth.js),
 * sent as `Authorization: Bearer`. [userName] is who signed in, for display.
 */
data class ServerConfig(val baseUrl: HttpUrl, val token: String?, val userName: String? = null) {
    val signedIn: Boolean get() = !token.isNullOrBlank()
}

/** Where the session lives (SettingsStore; a fake in tests). */
interface SessionHolder {
    /** The server in force and its session, if any. */
    val current: ServerConfig
    fun signIn(token: String, userName: String?)
    /** Forgets [token] if it is still the session in force; true when it was. */
    fun endSession(token: String): Boolean
}

/** The server address and whether a debug override is in force (Settings reads and saves it). */
interface ServerSettings {
    val config: StateFlow<ServerConfig>
    val overridden: StateFlow<Boolean>
    /** A new server address. Returns false when it is the same one (the session is kept). */
    fun saveServer(baseUrl: HttpUrl): Boolean
}

/**
 * The server URL in plain preferences; the session token encrypted at rest
 * under a Keystore-backed key (as kitaplik keeps its Drive credentials). A
 * session belongs to the server it was made on: another address drops it.
 */
class SettingsStore(context: Context) : SessionHolder, ServerSettings {

    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    private val secrets: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            context,
            "secrets",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        // A keyset that cannot be opened (restored from another device, a
        // Keystore reset) must not take the app down; the user signs in again.
        Log.w("SettingsStore", "Encrypted prefs unavailable, starting over", e)
        context.deleteSharedPreferences("secrets")
        EncryptedSharedPreferences.create(
            context,
            "secrets",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    init {
        // Builds before the central login kept a pasted CLI token (`la_...`)
        // here. It is dropped, not used: the app signs in instead. Nothing
        // else depends on it (downloads, playlists saved for offline stay).
        if (runCatching { secrets.contains(LEGACY_TOKEN) }.getOrDefault(false)) {
            runCatching { secrets.edit(commit = true) { remove(LEGACY_TOKEN) } }
            Log.i("SettingsStore", "Dropped the old API token: sign in instead")
        }
    }

    private val _config = MutableStateFlow(load())
    /** Never null: with nothing saved it is [DEFAULT_SERVER], signed out. */
    override val config: StateFlow<ServerConfig> = _config.asStateFlow()

    /** True while a debug-only, in-memory server override is in force (see [overrideForSession]). */
    private val _overridden = MutableStateFlow(false)
    override val overridden: StateFlow<Boolean> = _overridden.asStateFlow()

    override val current: ServerConfig get() = _config.value

    /** The sign-in under way (state, nonce, PKCE verifier), encrypted like the session. */
    val pendingSignIn: TextStore = object : TextStore {
        override fun read(): String? = runCatching { secrets.getString(KEY_PENDING, null) }.getOrNull()
        override fun write(value: String) {
            secrets.edit(commit = true) { if (value.isEmpty()) remove(KEY_PENDING) else putString(KEY_PENDING, value) }
        }
    }

    /** A new server address. Returns false when it is the same one (the session is kept). */
    override fun saveServer(baseUrl: HttpUrl): Boolean {
        val changed = baseUrl != _config.value.baseUrl || _overridden.value
        prefs.edit { putString(KEY_URL, baseUrl.toString()) }
        _overridden.value = false
        _config.value = load()
        return changed
    }

    override fun signIn(token: String, userName: String?) {
        val clean = token.trim()
        if (_overridden.value) {
            // The debug override is this process only: so is a session made against it.
            _config.update { it.copy(token = clean, userName = userName) }
            return
        }
        secrets.edit(commit = true) {
            putString(KEY_SESSION, clean)
            putString(KEY_SESSION_SERVER, _config.value.baseUrl.toString())
            if (userName != null) putString(KEY_SESSION_USER, userName) else remove(KEY_SESSION_USER)
        }
        _config.value = load()
    }

    @Synchronized
    override fun endSession(token: String): Boolean {
        val config = _config.value
        if (config.token == null || config.token != token.trim()) return false
        if (!_overridden.value) clearSession()
        _config.value = config.copy(token = null, userName = null)
        return true
    }

    /**
     * Debug builds only (MainActivity checks): point this process at another
     * server, e.g. the stub, WITHOUT touching what is saved. Used by
     * `dev.sh --stub` so testing never overwrites the phone's real settings.
     */
    fun overrideForSession(baseUrl: HttpUrl, token: String?) {
        _overridden.value = true
        _config.value = ServerConfig(baseUrl, token?.trim()?.takeIf { it.isNotEmpty() })
    }

    private fun clearSession() {
        secrets.edit(commit = true) {
            remove(KEY_SESSION)
            remove(KEY_SESSION_SERVER)
            remove(KEY_SESSION_USER)
        }
    }

    private fun load(): ServerConfig {
        val url = prefs.getString(KEY_URL, null)?.let(ServerUrl::normalize) ?: DEFAULT_URL
        val token = secrets.getString(KEY_SESSION, null)?.takeIf { it.isNotBlank() }
        val forServer = secrets.getString(KEY_SESSION_SERVER, null)
        if (token != null && forServer != url.toString()) {
            // Made on another server: worthless here.
            clearSession()
            return ServerConfig(url, null)
        }
        return ServerConfig(url, token, if (token != null) secrets.getString(KEY_SESSION_USER, null) else null)
    }

    companion object {
        /** The production server; editable in Settings. */
        const val DEFAULT_SERVER = "https://music.etaylan.com"
        private const val KEY_URL = "server_url"
        private const val KEY_SESSION = "session_token"
        private const val KEY_SESSION_SERVER = "session_server"
        private const val KEY_SESSION_USER = "session_user"
        private const val KEY_PENDING = "pending_sign_in"
        /** The CLI token older builds stored; removed at start. */
        private const val LEGACY_TOKEN = "api_token"
        val DEFAULT_URL: HttpUrl = ServerUrl.normalize(DEFAULT_SERVER)!!
    }
}
