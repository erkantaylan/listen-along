package com.erkantaylan.listenalong.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.erkantaylan.listenalong.core.data.AccountRepository
import com.erkantaylan.listenalong.core.data.CheckLine
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.data.ServerSettings
import com.erkantaylan.listenalong.core.data.DownloadPrefs
import com.erkantaylan.listenalong.core.data.AppUpdates
import com.erkantaylan.listenalong.core.data.UpdateCheck
import com.erkantaylan.listenalong.core.domain.SyncSettings
import com.erkantaylan.listenalong.core.download.DownloadSnapshot
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.network.ServerUrl
import com.erkantaylan.listenalong.core.ui.UserMessages
import com.erkantaylan.listenalong.core.auth.AuthController
import com.erkantaylan.listenalong.core.auth.SignInUi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

sealed interface UpdateCheckUi {
    data object Idle : UpdateCheckUi
    data object Checking : UpdateCheckUi
    data class Done(val result: UpdateCheck) : UpdateCheckUi
}

data class ConnectionUi(val checking: Boolean = false, val lines: List<CheckLine> = emptyList())

/**
 * Settings: the account (sign in / out, test connection), the server
 * address, what is on the device, and about. Sign-in itself is
 * [AuthController]; opening the browser is the activity's job.
 */
class SettingsViewModel(
    private val settings: ServerSettings,
    private val auth: AuthController,
    private val account: AccountRepository,
    private val downloads: Downloads,
    private val messages: UserMessages,
    private val downloadPrefs: DownloadPrefs,
    private val updates: AppUpdates? = null,
) : ViewModel() {

    private val _updateCheck = MutableStateFlow<UpdateCheckUi>(UpdateCheckUi.Idle)
    /** "Check for updates": checking, up to date, a newer version, or could not check. */
    val updateCheck: StateFlow<UpdateCheckUi> = _updateCheck.asStateFlow()

    fun checkForUpdates() {
        val u = updates ?: return
        _updateCheck.value = UpdateCheckUi.Checking
        viewModelScope.launch { _updateCheck.value = UpdateCheckUi.Done(u.checkNow()) }
    }

    /** Playlist sync's settings ("Download over mobile data", "Remove downloads of songs removed from a playlist"). */
    val sync: StateFlow<SyncSettings> = downloadPrefs.sync

    fun setAllowMetered(allow: Boolean) = downloadPrefs.setAllowMetered(allow)

    fun setRemoveUnlisted(remove: Boolean) = downloadPrefs.setRemoveUnlisted(remove)

    val config: StateFlow<ServerConfig> = settings.config
    val overridden: StateFlow<Boolean> = settings.overridden
    val signIn: StateFlow<SignInUi> = auth.ui
    val storage: StateFlow<DownloadSnapshot> =
        downloads.snapshots.stateIn(viewModelScope, SharingStarted.Eagerly, downloads.snapshot())

    private val _connection = MutableStateFlow(ConnectionUi())
    val connection: StateFlow<ConnectionUi> = _connection.asStateFlow()

    private val _serverNote = MutableStateFlow<CheckLine?>(null)
    /** The answer to the last "Save" of the address. */
    val serverNote: StateFlow<CheckLine?> = _serverNote.asStateFlow()

    init {
        // A check made for another session means nothing now.
        settings.config.distinctUntilChangedBy { it.signedIn }.drop(1)
            .onEach { _connection.value = ConnectionUi() }
            .launchIn(viewModelScope)
    }

    /** Saves the typed address. Returns what to show in the field (normalised), or null when unusable. */
    fun saveServer(typed: String): String? {
        val normalized = ServerUrl.normalize(typed)
        if (normalized == null) {
            _serverNote.value = CheckLine(false, "That is not a usable address.")
            return null
        }
        val wasSignedIn = settings.config.value.signedIn
        val changed = settings.saveServer(normalized)
        _serverNote.value = CheckLine(true, if (changed && wasSignedIn) "Saved. Sign in again on this server." else "Saved.")
        return ServerUrl.display(normalized)
    }

    fun testConnection() {
        _connection.value = ConnectionUi(checking = true)
        viewModelScope.launch {
            _connection.value = ConnectionUi(checking = false, lines = account.testConnection())
        }
    }

    fun signOut() = auth.signOut()

    fun cancelSignIn() = auth.cancel()

    fun findInFolder() {
        viewModelScope.launch {
            val found = downloads.reclaim(force = true)
            messages.say(if (found == 0) "No new songs found in the folder" else "$found songs found in the folder")
        }
    }

    fun forgetDeleted() {
        viewModelScope.launch {
            val gone = downloads.reconcile()
            messages.say(if (gone == 0) "Everything is still there" else "$gone forgotten")
        }
    }
}
