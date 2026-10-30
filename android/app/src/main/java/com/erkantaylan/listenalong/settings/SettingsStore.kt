package com.erkantaylan.listenalong.settings

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.erkantaylan.listenalong.api.ServerUrl
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl

/** Where the library lives, and how to identify to it. */
data class ServerConfig(val baseUrl: HttpUrl, val token: String?) {
    val hasToken: Boolean get() = !token.isNullOrBlank()
}

/**
 * The server URL in plain preferences; the API token encrypted at rest under
 * a Keystore-backed key, the way kitaplik keeps its Drive credentials.
 */
class SettingsStore(context: Context) {

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
        // Keystore reset) must not take the app down; the token is re-entered.
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

    private val _config = MutableStateFlow(load())
    /** Never null: with nothing saved it is [DEFAULT_SERVER] without a token. */
    val config: StateFlow<ServerConfig> = _config.asStateFlow()

    /** True while a debug-only, in-memory server override is in force (see [overrideForSession]). */
    private val _overridden = MutableStateFlow(false)
    val overridden: StateFlow<Boolean> = _overridden.asStateFlow()

    fun save(baseUrl: HttpUrl, token: String?) {
        prefs.edit { putString(KEY_URL, baseUrl.toString()) }
        secrets.edit {
            val clean = token?.trim()
            if (clean.isNullOrEmpty()) remove(KEY_TOKEN) else putString(KEY_TOKEN, clean)
        }
        _overridden.value = false
        _config.value = load()
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

    private fun load(): ServerConfig {
        val url = prefs.getString(KEY_URL, null)?.let(ServerUrl::normalize) ?: DEFAULT_URL
        return ServerConfig(url, secrets.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() })
    }

    companion object {
        /** The production server; editable in Settings. */
        const val DEFAULT_SERVER = "https://music.etaylan.com"
        private const val KEY_URL = "server_url"
        private const val KEY_TOKEN = "api_token"
        val DEFAULT_URL: HttpUrl = ServerUrl.normalize(DEFAULT_SERVER)!!
        /** Where users create the API token the app needs. */
        fun profileUrl(base: HttpUrl): String = ServerUrl.display(base) + "/profile"
    }


}
