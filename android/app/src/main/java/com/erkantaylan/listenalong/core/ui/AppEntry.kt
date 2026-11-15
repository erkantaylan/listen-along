package com.erkantaylan.listenalong.core.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * Opening the app from a notification (the player's, the downloads'):
 * services and workers in core name the activity here instead of importing it.
 */
object AppEntry {
    /** The launcher activity; its name is part of the installed app (home-screen shortcuts), never move it. */
    private const val MAIN_ACTIVITY = "com.erkantaylan.listenalong.MainActivity"

    /** Set by the media notification: tapping it opens the full player. */
    const val EXTRA_OPEN_PLAYER = "open_player"

    fun intent(context: Context): Intent =
        Intent().setComponent(ComponentName(context, MAIN_ACTIVITY)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
}
