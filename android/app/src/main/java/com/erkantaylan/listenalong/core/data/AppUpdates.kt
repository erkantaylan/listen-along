package com.erkantaylan.listenalong.core.data

import com.erkantaylan.listenalong.core.domain.UpdateRules
import com.erkantaylan.listenalong.core.network.ApiProvider
import com.erkantaylan.listenalong.core.storage.TextStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl

/** A newer release to offer: its version and where to get it (the APK on GitHub, as the web's /app page links it). */
data class UpdateNotice(val version: String, val downloadUrl: String)

/** What "Check for updates" found. */
sealed interface UpdateCheck {
    data class Available(val notice: UpdateNotice) : UpdateCheck
    data object UpToDate : UpdateCheck
    data object Failed : UpdateCheck
}

/**
 * "Is there a newer app?" from the server's `GET /api/app/latest` (the
 * GitHub releases the web's /app page offers; any signed-in account may
 * ask). Never forced: the notice is a dismissible banner, "Later" hides that
 * version for [UpdateRules.SNOOZE_MS], a newer one shows at once. Asked when
 * the app opens and at most every [UpdateRules.RECHECK_MS] while it stays
 * open; a failed check is silent. Debug and "-dev" builds never ask unless
 * [allowInDevBuild] (a debug-only intent extra, for trying it on the stub).
 */
class AppUpdates(
    private val api: ApiProvider,
    private val store: TextStore,
    private val installedVersion: String,
    private val devBuild: Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Serializable
    private data class Saved(val dismissedVersion: String? = null, val dismissedAt: Long = 0)

    private val json = Json { ignoreUnknownKeys = true }

    @Volatile var allowInDevBuild: Boolean = false

    private val _notice = MutableStateFlow<UpdateNotice?>(null)
    /** The banner's content, or null. */
    val notice: StateFlow<UpdateNotice?> = _notice.asStateFlow()

    @Volatile private var lastCheckAt: Long? = null

    val installed: String get() = installedVersion

    private fun saved(): Saved = store.read()?.let { runCatching { json.decodeFromString<Saved>(it) }.getOrNull() } ?: Saved()

    /** On app open / resume: quiet, throttled, nothing when signed out, offline or a dev build. */
    suspend fun checkOnOpen(signedIn: Boolean, online: Boolean) {
        if (!signedIn || !online || (devBuild && !allowInDevBuild)) return
        val last = lastCheckAt
        if (last != null && now() - last < UpdateRules.RECHECK_MS) return
        lastCheckAt = now()
        val found = fetch() ?: return
        val s = saved()
        val dismissal = s.dismissedVersion?.let { UpdateRules.Dismissal(it, s.dismissedAt) }
        _notice.value = found.takeIf { UpdateRules.shouldShow(it.version, installedVersion, dismissal, now()) }
    }

    /** Settings' "Check for updates": asks now, shows the banner when there is something newer. */
    suspend fun checkNow(): UpdateCheck {
        lastCheckAt = now()
        val client = api() ?: return UpdateCheck.Failed
        val latest = try {
            client.appLatest()
        } catch (c: CancellationException) {
            throw c
        } catch (_: Exception) {
            return UpdateCheck.Failed
        }
        val notice = latest.notice(client.baseUrl)
        return if (notice != null && UpdateRules.isNewer(notice.version, installedVersion)) {
            _notice.value = notice
            UpdateCheck.Available(notice)
        } else if (!latest.available && latest.reason == "unavailable") UpdateCheck.Failed
        else UpdateCheck.UpToDate
    }

    /** "Later": hide this version for a while. */
    fun later() {
        val n = _notice.value ?: return
        store.write(json.encodeToString(Saved(n.version, now())))
        _notice.value = null
    }

    private suspend fun fetch(): UpdateNotice? {
        val client = api() ?: return null
        return try {
            client.appLatest().notice(client.baseUrl)
        } catch (c: CancellationException) {
            throw c
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The notice for an answer from [server]. The link is the first of the
     * APK, the release page and the releases list that is one of this
     * repository's GitHub release URLs ([UpdateRules.isReleaseUrl]); anything
     * else from the answer is never opened: the server's own `/app` page is.
     */
    private fun com.erkantaylan.listenalong.core.model.AppLatest.notice(server: HttpUrl): UpdateNotice? {
        if (!available) return null
        val v = version ?: return null
        val url = listOf(apk?.url, releaseUrl, releasesUrl).firstOrNull(UpdateRules::isReleaseUrl)
            ?: server.resolve("app")?.toString() ?: return null
        return UpdateNotice(v, url)
    }
}
