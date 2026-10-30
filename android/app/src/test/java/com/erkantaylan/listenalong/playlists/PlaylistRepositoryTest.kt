package com.erkantaylan.listenalong.playlists

import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.ServerUrl
import com.erkantaylan.listenalong.storage.MemoryTextStore
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.IOException

class PlaylistRepositoryTest {

    private lateinit var server: MockWebServer
    private val listStore = MemoryTextStore()
    private val songStores = HashMap<String, MemoryTextStore>()
    private val cache = PlaylistCache(
        listStore = listStore,
        songsStore = { id -> songStores.getOrPut(id) { MemoryTextStore() } },
        forget = { id -> songStores.remove(id) },
    )
    private var clock = 1_000L
    private lateinit var client: LibraryClient
    private lateinit var repo: PlaylistRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = LibraryClient(ServerUrl.normalize(server.url("/").toString())!!, "tok")
        repo = PlaylistRepository({ client }, cache, now = { clock })
    }

    @After
    fun tearDown() {
        runCatching { server.close() }
    }

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private val twoPlaylists = """{"playlists":[
        {"id":"b","name":"Zeta","visibility":"public","isOwner":false,"ownerId":"x","ownerName":"X","songCount":1},
        {"id":"a","name":"Mine","visibility":"private","isOwner":true,"canManage":true,"ownerId":"me","songCount":2}]}"""

    private val songsOfA = """{"playlist":{"id":"a","name":"Mine","visibility":"private","isOwner":true,"canManage":true},
        "songs":[{"position":1,"entry_id":"e1","library_id":"L1","title":"One - Art","artist":"Art"},
                 {"position":2,"entry_id":"e2","library_id":"L2","title":"Two"}]}"""

    /** Makes the next requests fail the way a phone without a connection does. */
    private fun goOffline() = server.close()

    @Test
    fun `fresh list is sorted (yours first) and cached`() = runTest {
        server.enqueue(json(twoPlaylists))
        val loaded = repo.playlists()
        assertFalse(loaded.fromCache)
        assertEquals(listOf("a", "b"), loaded.value.map { it.id })
        assertEquals(listOf("a", "b"), repo.cachedPlaylists()!!.map { it.id })
    }

    @Test
    fun `offline the list and an opened playlist come from the cache`() = runTest {
        server.enqueue(json(twoPlaylists))
        server.enqueue(json(songsOfA))
        repo.playlists()
        repo.songs("a")
        clock = 5_000L

        goOffline()
        val list = repo.playlists()
        assertTrue(list.fromCache)
        assertEquals(1_000L, list.savedAt)
        assertNotNull(list.error)
        assertEquals(2, list.value.size)

        val songs = repo.songs("a")
        assertTrue(songs.fromCache)
        assertEquals(listOf("e1", "e2"), songs.value.songs.map { it.entryId })
        assertEquals("One", songs.value.songs[0].cleanTitle)
    }

    @Test
    fun `offline with nothing cached is an error`() = runTest {
        goOffline()
        try {
            repo.songs("never-opened")
            fail("expected an IOException")
        } catch (e: IOException) {
            // expected
        }
    }

    @Test
    fun `a 5xx falls back to the cache but a 401 does not`() = runTest {
        server.enqueue(json(twoPlaylists))
        repo.playlists()

        server.enqueue(json("""{"error":"Failed to list playlists"}""", 500))
        assertTrue(repo.playlists().fromCache)

        server.enqueue(json("""{"error":"Invalid or revoked token"}""", 401))
        try {
            repo.playlists()
            fail("a rejected token must be shown, not hidden behind the cache")
        } catch (e: ApiException) {
            assertEquals(401, e.code)
        }
    }

    @Test
    fun `a 404 forgets the cached playlist`() = runTest {
        server.enqueue(json(twoPlaylists))
        server.enqueue(json(songsOfA))
        repo.playlists()
        repo.songs("a")
        server.enqueue(json("""{"error":"Playlist not found","code":"NOT_FOUND"}""", 404))
        try {
            repo.songs("a")
            fail("expected a 404")
        } catch (e: ApiException) {
            assertEquals(404, e.code)
        }
        assertNull(repo.cachedSongs("a"))
        assertEquals(listOf("b"), repo.cachedPlaylists()!!.map { it.id })
    }

    @Test
    fun `move stores the new order for offline use`() = runTest {
        server.enqueue(json(songsOfA))
        repo.songs("a")
        server.enqueue(json("""{"playlist_id":"a","songs":[{"position":1,"entry_id":"e2","library_id":"L2","title":"Two"},
            {"position":2,"entry_id":"e1","library_id":"L1","title":"One - Art","artist":"Art"}]}"""))
        val moved = repo.move("a", "e1", 2)
        assertEquals(listOf("e2", "e1"), moved.value.songs.map { it.entryId })

        goOffline()
        val offline = repo.songs("a")
        assertTrue(offline.fromCache)
        assertEquals(listOf("e2", "e1"), offline.value.songs.map { it.entryId })
        assertEquals("Mine", offline.value.playlist!!.name) // playlist info kept from before
    }

    @Test
    fun `rename updates the cached list and the cached playlist`() = runTest {
        server.enqueue(json(twoPlaylists))
        server.enqueue(json(songsOfA))
        repo.playlists()
        repo.songs("a")
        server.enqueue(json("""{"id":"a","name":"Renamed","visibility":"private","isOwner":true,"canManage":true}"""))
        repo.rename("a", "Renamed")
        assertEquals("Renamed", repo.cachedPlaylists()!!.first { it.id == "a" }.name)
        assertEquals("Renamed", repo.cachedSongs("a")!!.playlist!!.name)
    }

    @Test
    fun `delete forgets the playlist`() = runTest {
        server.enqueue(json(twoPlaylists))
        server.enqueue(json(songsOfA))
        repo.playlists()
        repo.songs("a")
        server.enqueue(json("""{"success":true,"id":"a"}"""))
        repo.delete("a")
        assertNull(repo.cachedSongs("a"))
        assertEquals(listOf("b"), repo.cachedPlaylists()!!.map { it.id })
    }

    @Test
    fun `the cache belongs to one server`() = runTest {
        server.enqueue(json(twoPlaylists))
        repo.playlists()
        val other = LibraryClient(ServerUrl.normalize("http://localhost:9/")!!, "tok")
        val otherRepo = PlaylistRepository({ other }, cache)
        assertNull(otherRepo.cachedPlaylists())
    }

    @Test
    fun `cache ids are made safe for file names`() {
        assertEquals("a_b_c", PlaylistCache.safeId("a/b\\c"))
        assertEquals("0b9e6f0e-1111-4a5b", PlaylistCache.safeId("0b9e6f0e-1111-4a5b"))
    }
}
