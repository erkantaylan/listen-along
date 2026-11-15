package com.erkantaylan.listenalong.feature

import com.erkantaylan.listenalong.app.AppViewModel
import com.erkantaylan.listenalong.core.auth.AuthController
import com.erkantaylan.listenalong.core.auth.SignInApi
import com.erkantaylan.listenalong.core.data.AccountRepository
import com.erkantaylan.listenalong.core.data.ReportRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.data.ServerSettings
import com.erkantaylan.listenalong.core.data.SessionHolder
import com.erkantaylan.listenalong.core.download.DownloadQueue
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.model.MeUser
import com.erkantaylan.listenalong.core.model.Me
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.SessionGrant
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import com.erkantaylan.listenalong.core.ui.UserMessages
import com.erkantaylan.listenalong.feature.downloads.OnDeviceViewModel
import com.erkantaylan.listenalong.feature.settings.SettingsViewModel
import com.erkantaylan.listenalong.testing.FakeApi
import com.erkantaylan.listenalong.testing.FakeNetwork
import com.erkantaylan.listenalong.testing.MainDispatcherRule
import com.erkantaylan.listenalong.testing.MemorySink
import com.erkantaylan.listenalong.testing.TEST_SERVER
import com.erkantaylan.listenalong.testing.local
import com.erkantaylan.listenalong.testing.signedIn
import com.erkantaylan.listenalong.testing.song
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The smaller screens' ViewModels: On device, Settings, and the app shell's report dialogs. */
class ScreensViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val api = FakeApi()
    private val sink = MemorySink()
    private val index = DownloadIndex(MemoryTextStore())
    private val downloads = Downloads(DownloadQueue(MemoryTextStore()), index, sink, { api }, kick = {}, io = main.dispatcher)
    private val messages = UserMessages()
    private val said = mutableListOf<String>()

    private fun collect() = CoroutineScope(main.dispatcher).launch { messages.messages.collect { said += it } }

    private val repo = com.erkantaylan.listenalong.core.data.PlaylistRepository(
        { api }, com.erkantaylan.listenalong.core.data.PlaylistCache(MemoryTextStore(), { MemoryTextStore() }),
    )
    private val playlistDownloads = com.erkantaylan.listenalong.core.data.PlaylistDownloads(
        MemoryTextStore(), { api }, repo, downloads, com.erkantaylan.listenalong.testing.FakePrefs(),
        { com.erkantaylan.listenalong.core.domain.NetworkInfo() },
    )
    private fun onDeviceVm() = OnDeviceViewModel(downloads, messages, playlistDownloads, MutableStateFlow(emptyMap()), repo)

    @Test
    fun `On device filters by title or artist, artist first`() {
        index.put(local("a", "Zed", "Abba"))
        index.put(local("b", "Alpha", "Queen"))
        val vm = onDeviceVm()
        assertEquals(listOf("a", "b"), vm.state.value.songs.map { it.songId })
        vm.onQueryChange("queen")
        assertEquals(listOf("b"), vm.state.value.songs.map { it.songId })
        assertEquals(2000L, vm.state.value.totalBytes)
    }

    @Test
    fun `On device deletes a file and forgets it`() {
        val job = collect()
        index.put(local("a"))
        val vm = onDeviceVm()
        var consent = false
        vm.delete(index["a"]!!) { consent = true }
        assertFalse(consent)
        assertTrue(vm.state.value.songs.isEmpty())
        assertEquals(listOf("Deleted"), said)
        job.cancel()
    }

    private class FakeSettings(initial: ServerConfig) : ServerSettings, SessionHolder {
        override val config = MutableStateFlow(initial)
        override val overridden: StateFlow<Boolean> = MutableStateFlow(false)
        override val current: ServerConfig get() = config.value
        override fun saveServer(baseUrl: HttpUrl): Boolean {
            val changed = baseUrl != config.value.baseUrl
            config.value = ServerConfig(baseUrl, if (changed) null else config.value.token)
            return changed
        }
        override fun signIn(token: String, userName: String?, userId: String?) { config.value = config.value.copy(token = token, userName = userName, userId = userId) }
        override fun endSession(token: String): Boolean { config.value = config.value.copy(token = null); return true }
    }

    private fun settingsVm(settings: FakeSettings): SettingsViewModel {
        val auth = AuthController(
            sessions = settings,
            pendingStore = MemoryTextStore(),
            apiFor = { object : SignInApi {
                override suspend fun exchange(code: String, state: String, verifier: String, nonce: String, iss: String?, previousToken: String?, redirectUri: String): SessionGrant = error("unused")
                override suspend fun logout(token: String) {}
            } },
            allowDevSignIn = false,
            scope = CoroutineScope(main.dispatcher),
        )
        return SettingsViewModel(settings, auth, AccountRepository { api }, downloads, messages, com.erkantaylan.listenalong.testing.FakePrefs())
    }

    @Test
    fun `Settings refuses an unusable address and saves a good one`() {
        val settings = FakeSettings(signedIn())
        val vm = settingsVm(settings)
        assertNull(vm.saveServer("   "))
        assertFalse(vm.serverNote.value!!.ok)
        assertEquals("https://other.example", vm.saveServer("other.example"))
        assertEquals("Saved. Sign in again on this server.", vm.serverNote.value!!.text)
        assertFalse(settings.config.value.signedIn)
    }

    @Test
    fun `Test connection names the account and the library`() {
        api.library += song("1")
        api.me = Me("Ayşe", MeUser("u1", "Ayşe", "pending"))
        val vm = settingsVm(FakeSettings(signedIn()))
        vm.testConnection()
        val lines = vm.connection.value.lines
        assertEquals("Signed in as Ayşe (waiting for approval)", lines[0].text)
        assertFalse(lines[0].ok)
        assertEquals("Library reachable · 1 songs", lines[1].text)
        assertTrue(lines[1].ok)
    }

    @Test
    fun `Sign out ends the session`() {
        val settings = FakeSettings(signedIn())
        settingsVm(settings).signOut()
        assertFalse(settings.config.value.signedIn)
    }

    private fun appVm(config: MutableStateFlow<ServerConfig> = MutableStateFlow(signedIn())) =
        AppViewModel(config, FakeNetwork(), ReportRepository({ api }, MemoryTextStore()), downloads, messages)

    @Test
    fun `marking a song as broken closes the dialog and says so`() {
        val job = collect()
        val vm = appVm()
        vm.markBroken(song("1", "Dağlar"))
        vm.submitReport("Bad audio")
        assertNull(vm.reportDialog.value)
        assertEquals(1, vm.reportMap.value["1"]?.size)
        assertTrue(said.contains("Marked “Dağlar” as broken"))
        job.cancel()
    }

    @Test
    fun `a refused report keeps the dialog open with the reason`() {
        val vm = appVm()
        vm.markBroken(song("1"))
        api.fail = ApiException(403, "Not approved")
        vm.submitReport(null)
        val d = vm.reportDialog.value!!
        assertFalse(d.busy)
        assertEquals("Could not mark it: Not approved", d.error)
    }

    @Test
    fun `the downloads badge counts the queue`() {
        val vm = appVm(MutableStateFlow(ServerConfig(TEST_SERVER, null)))
        downloads.enqueue(listOf(song("1"), song("2")))
        assertEquals(2, vm.pendingDownloads.value)
    }
}
