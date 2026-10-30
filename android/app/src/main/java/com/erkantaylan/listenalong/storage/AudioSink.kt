package com.erkantaylan.listenalong.storage

import java.io.OutputStream

/**
 * Where downloaded bytes go. The real one is [MediaStoreAudio]; tests use an
 * in-memory one, so the whole download path runs on the JVM.
 */
interface AudioSink {
    /** Opens a new, not-yet-visible file named [displayName]. */
    fun begin(displayName: String, format: AudioFormat): PendingAudio

    /** Whether the file behind [uri] still exists. Does I/O. */
    fun exists(uri: String): Boolean

    /** Deletes a saved file. Returns false when it could not be removed. */
    fun delete(uri: String): Boolean

    /**
     * Removes half-written files left behind when the process died
     * mid-download. Only called when nothing is being written. Returns how many.
     */
    fun cleanupAbandoned(): Int = 0
}

interface PendingAudio {
    val output: OutputStream

    /** Makes the file visible to other apps and reports where it ended up. */
    fun commit(): SavedAudio

    /** Throws the partial file away. Safe to call more than once. */
    fun abort()
}

data class SavedAudio(val uri: String, val displayName: String)
