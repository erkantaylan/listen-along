package com.erkantaylan.listenalong.core.download

import android.content.Context
import android.content.ContextWrapper
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID
import kotlin.coroutines.CoroutineContext

/**
 * WorkManager stores each work request's worker class BY NAME and, after the
 * app is updated, creates it by reflection with (Context, WorkerParameters).
 * A name an earlier release stored that no longer resolves fails that work
 * (a download queued by 0.4.0, waiting for a network, never runs).
 */
class LegacyWorkerNamesTest {

    /** Every worker a released version could have stored (`git grep -n Worker android-v0.x.y -- android/app/src/main`). */
    private val released = listOf(
        // android-v0.2.0 .. android-v0.4.0: the only worker those versions had.
        "com.erkantaylan.listenalong.download.DownloadWorker",
    )

    /** The workers this version enqueues (stored by name for the next update). */
    private val current = listOf(
        "com.erkantaylan.listenalong.core.download.DownloadWorker",
        "com.erkantaylan.listenalong.core.download.PlaylistSyncWorker",
    )

    /** As WorkManager's default WorkerFactory does it: the class by name, its (Context, WorkerParameters) constructor. */
    private fun create(name: String): ListenableWorker {
        // WorkerParameters is WorkManager's to build: its public constructor, filled by type (the rest unused here).
        val ctor = WorkerParameters::class.java.constructors.maxBy { it.parameterCount }
        val params = ctor.newInstance(*ctor.parameterTypes.map { type ->
            when (type) {
                UUID::class.java -> UUID.randomUUID()
                Data::class.java -> Data.EMPTY
                Collection::class.java -> emptyList<String>()
                WorkerParameters.RuntimeExtras::class.java -> WorkerParameters.RuntimeExtras()
                Int::class.javaPrimitiveType -> 0
                CoroutineContext::class.java -> Dispatchers.Default
                else -> null
            }
        }.toTypedArray()) as WorkerParameters
        val context: Context = ContextWrapper(null)
        return Class.forName(name).asSubclass(ListenableWorker::class.java)
            .getDeclaredConstructor(Context::class.java, WorkerParameters::class.java)
            .newInstance(context, params)
    }

    @Test
    fun `every worker name a released version stored still creates the worker`() {
        (released + current).forEach { create(it) }
        assertTrue("0.4.0's download worker is today's", create(released[0]) is DownloadWorker)
    }

    @Test
    fun `the release build keeps every one of them under its name (R8 would strip an unused shim)`() {
        // Gradle runs unit tests in the module directory.
        val rules = File("proguard-rules.pro").readText()
        (released + current).forEach { name ->
            val keep = Regex("""-keep class ${Regex.escape(name)} \{\s*public <init>\(android\.content\.Context, androidx\.work\.WorkerParameters\);\s*\}""")
            assertTrue("proguard-rules.pro keeps $name", keep.containsMatchIn(rules))
        }
    }
}
