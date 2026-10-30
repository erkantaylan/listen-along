package com.erkantaylan.listenalong.storage

import android.content.Context
import androidx.core.content.edit

/**
 * One string value, persisted somewhere. The download index and queue are a
 * few hundred small records serialised to JSON, so this is all the storage
 * they need — and tests swap in [MemoryTextStore].
 */
interface TextStore {
    fun read(): String?
    fun write(value: String)
}

class PrefsTextStore(context: Context, file: String, private val key: String) : TextStore {
    private val prefs = context.getSharedPreferences(file, Context.MODE_PRIVATE)
    override fun read(): String? = prefs.getString(key, null)
    // commit, not apply: the worker can be killed right after a song lands,
    // and a lost write would mean downloading it again.
    override fun write(value: String) = prefs.edit(commit = true) { putString(key, value) }
}

class MemoryTextStore(private var value: String? = null) : TextStore {
    override fun read(): String? = value
    override fun write(value: String) {
        this.value = value
    }
}

/**
 * A value in its own file, for things too big for SharedPreferences (a
 * playlist's cached song list). Written to a temporary file and renamed, so a
 * crash mid-write leaves the previous version rather than half a JSON document.
 */
class FileTextStore(private val file: java.io.File) : TextStore {
    override fun read(): String? = runCatching { if (file.isFile) file.readText() else null }.getOrNull()

    override fun write(value: String) {
        file.parentFile?.mkdirs()
        val tmp = java.io.File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(value)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    fun delete() {
        file.delete()
    }
}
