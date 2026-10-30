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
data class ServerConfig(val baseUrl: HttpUrl, val token: String?)

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
    val config: StateFlow<ServerConfig?> = _config.asStateFlow()

    private val _darkTheme = MutableStateFlow(prefs.getBoolean(KEY_DARK, true))
    val darkTheme: StateFlow<Boolean> = _darkTheme.asStateFlow()

    fun save(baseUrl: HttpUrl, token: String?) {
        prefs.edit { putString(KEY_URL, baseUrl.toString()) }
        secrets.edit {
            val clean = token?.trim()
            if (clean.isNullOrEmpty()) remove(KEY_TOKEN) else putString(KEY_TOKEN, clean)
        }
        _config.value = load()
    }

    fun setDarkTheme(dark: Boolean) {
        prefs.edit { putBoolean(KEY_DARK, dark) }
        _darkTheme.value = dark
    }

    private fun load(): ServerConfig? {
        val url = prefs.getString(KEY_URL, null)?.let(ServerUrl::normalize) ?: return null
        return ServerConfig(url, secrets.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() })
    }

    private companion object {
        const val KEY_URL = "server_url"
        const val KEY_TOKEN = "api_token"
        const val KEY_DARK = "dark_theme"
    }
}
