package com.erkantaylan.listenalong.app

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.erkantaylan.listenalong.feature.downloads.OnDeviceViewModel
import com.erkantaylan.listenalong.feature.library.LibraryViewModel
import com.erkantaylan.listenalong.feature.playlists.AddToPlaylistViewModel
import com.erkantaylan.listenalong.feature.playlists.PlaylistViewModel
import com.erkantaylan.listenalong.feature.playlists.PlaylistsViewModel
import com.erkantaylan.listenalong.feature.settings.SettingsViewModel

/**
 * The ViewModel factories: the one place that knows which pieces of the
 * [AppContainer] each screen's ViewModel gets. A ViewModel never sees the
 * container, so its tests pass fakes for exactly these.
 */
object AppViewModels {

    fun app(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
        initializer { AppViewModel(c.settings.config, c.connectivity, c.reports, c.downloads, c.messages, syncCovers = { c.coverSync.sync() }) }
    }

    fun library(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
        initializer { LibraryViewModel(c.settings.config, c.connectivity, c.library, c.downloads, c.reports) }
    }

    fun playlists(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
        initializer {
            PlaylistsViewModel(c.settings.config, c.connectivity, c.playlists, c.messages, c.playlistStatuses, onRefreshed = { c.requestSync() })
        }
    }

    fun playlist(c: AppContainer, id: String): ViewModelProvider.Factory = viewModelFactory {
        initializer { PlaylistViewModel(id, c.connectivity, c.playlists, c.downloads, c.messages, c.playlistDownloads, c.playlistStatuses) }
    }

    fun addToPlaylist(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
        initializer { AddToPlaylistViewModel(c.playlists, c.messages) }
    }

    fun onDevice(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
        initializer { OnDeviceViewModel(c.downloads, c.messages, c.playlistDownloads, c.playlistStatuses, c.playlists) }
    }

    fun settings(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
        initializer { SettingsViewModel(c.settings, c.auth, c.account, c.downloads, c.messages, c.settings) }
    }
}
