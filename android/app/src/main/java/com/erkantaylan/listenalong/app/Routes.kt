package com.erkantaylan.listenalong.app

import kotlinx.serialization.Serializable

/*
 * Type-safe navigation routes (Navigation Compose). Each destination gets its
 * own ViewModel, scoped to its back stack entry; arguments travel in the
 * route (a playlist's id), never in a shared object.
 *
 *   LibraryRoute (start)
 *   PlaylistsGraph ── PlaylistsRoute ── PlaylistRoute(id)
 *   OnDeviceRoute
 *   SettingsRoute
 *
 * The full player is an overlay above all of them, not a destination: the
 * mini player and the notification open it over whatever is on screen.
 */

@Serializable
data object LibraryRoute

/** The Playlists tab's own back stack: the list, then a playlist (restored when you come back to the tab). */
@Serializable
data object PlaylistsGraph

@Serializable
data object PlaylistsRoute

@Serializable
data class PlaylistRoute(val id: String)

@Serializable
data object OnDeviceRoute

@Serializable
data object SettingsRoute
