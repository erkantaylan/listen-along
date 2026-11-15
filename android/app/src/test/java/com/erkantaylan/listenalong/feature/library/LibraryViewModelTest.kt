package com.erkantaylan.listenalong.feature.library

import com.erkantaylan.listenalong.core.data.LibraryRepository
import com.erkantaylan.listenalong.core.data.ReportRepository
import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.download.DownloadQueue
import com.erkantaylan.listenalong.core.download.DownloadState
import com.erkantaylan.listenalong.core.download.Downloads
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.storage.DownloadIndex
import com.erkantaylan.listenalong.core.storage.MemoryTextStore
import com.erkantaylan.listenalong.testing.FakeApi
import com.erkantaylan.listenalong.testing.FakeNetwork
import com.erkantaylan.listenalong.testing.MainDispatcherRule
import com.erkantaylan.listenalong.testing.MemorySink
import com.erkantaylan.listenalong.testing.TEST_SERVER
import com.erkantaylan.listenalong.testing.local
import com.erkantaylan.listenalong.testing.signedIn
import com.erkantaylan.listenalong.testing.song
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.IOException

class LibraryViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    private val api = FakeApi().apply { library += listOf(song("1", "Alpha"), song("2", "Beta"), song("3", "Gamma")) }
    private val network = FakeNetwork()
    private val config = MutableStateFlow(signedIn())
    private val index = DownloadIndex(MemoryTextStore())
    private val reports = ReportRepository({ api }, MemoryTextStore())
    private val downloads = Downloads(DownloadQueue(MemoryTextStore()), index, MemorySink(), { api }, kick = {}, io = main.dispatcher)

    private fun viewModel() = LibraryViewModel(config, network, LibraryRepository({ api }, index.entries, reports), downloads, reports)

    @Test
    fun `signed in, it loads the first page`() {
        val vm = viewModel()
        val s = vm.state.value
        assertEquals(listOf("1", "2", "3"), s.songs.map { it.id })
        assertEquals(3, s.total)
        assertFalse(s.offline)
        assertFalse(s.loading)
    }

    @Test
    fun `signed out, it asks nothing`() {
        config.value = ServerConfig(TEST_SERVER, null)
        val vm = viewModel()
        assertFalse(vm.state.value.signedIn)
        assertTrue(vm.state.value.songs.isEmpty())
        assertTrue(api.calls.none { it.startsWith("list") })
    }

    @Test
    fun `unreachable server shows the downloaded songs, and back online the library`() {
        index.put(local("9", "On the phone"))
        api.fail = IOException("no route")
        val vm = viewModel()
        assertTrue(vm.state.value.offline)
        assertEquals(listOf("9"), vm.state.value.songs.map { it.id })

        api.fail = null
        network.online.value = false
        network.online.value = true
        assertFalse(vm.state.value.offline)
        assertEquals(3, vm.state.value.songs.size)
    }

    @Test
    fun `a 5xx falls back too, an ended session is an error`() {
        api.fail = ApiException(503, "down")
        assertTrue(viewModel().state.value.offline)

        api.fail = ApiException(401, "ended", "SESSION_ENDED")
        val vm = viewModel()
        assertFalse(vm.state.value.offline)
        assertEquals("Signed out: sign in again in Settings.", vm.state.value.error)
    }

    @Test
    fun `the Broken filter asks for reported songs only`() {
        val vm = viewModel()
        vm.onBrokenOnlyChange(true)
        assertTrue(api.calls.any { it == "list::0:true" })
        assertTrue(vm.state.value.brokenOnly)
    }

    @Test
    fun `download queues a song once, and the state follows`() {
        val vm = viewModel()
        val target = vm.state.value.songs.first()
        assertEquals(1, vm.download(target))
        assertEquals(0, vm.download(target))
        assertEquals(DownloadState.Queued, vm.downloadState.value.stateOf(target.id))
        vm.cancel(target)
        assertEquals(DownloadState.Absent, vm.downloadState.value.stateOf(target.id))
    }

    @Test
    fun `download all shown counts what is missing`() {
        index.put(local("2"))
        val vm = viewModel()
        vm.prepareBulk()
        val plan = (vm.state.value.bulk as BulkUi.Ready).plan
        assertEquals(listOf("1", "3"), plan.toDownload.map { it.id })
        assertEquals(1, plan.alreadyHave)
        assertEquals(2, vm.confirmBulk())
        assertNull(vm.state.value.bulk)
    }
}
