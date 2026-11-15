package com.erkantaylan.listenalong.core.ui

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Short confirmations and errors for the user ("Added 2 songs to Road trip",
 * "Could not rename the playlist: …"). ViewModels [say] them; the activity
 * shows each one once (a toast). One per process, in the app container.
 */
class UserMessages {
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    fun say(text: String) {
        _messages.tryEmit(text)
    }
}
