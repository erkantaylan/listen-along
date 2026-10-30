package com.erkantaylan.listenalong.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The playlist endpoints, against the shapes backend/src/index.js answers with. */
class PlaylistApiTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun client() = LibraryClient(ServerUrl.normalize(server.url("/").toString())!!, "la_secret")

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    @Test
    fun `playlists parses the list with ownership flags`() = runTest {
        server.enqueue(json("""
            {"playlists":[
              {"id":"p1","name":"Mine","visibility":"private","ownerId":"u1","ownerName":"Erkan","isOwner":true,
               "canManage":true,"pinned":false,"userCount":2,"songCount":12,"createdAt":1761800000000},
              {"id":"p2","name":null,"visibility":"public","ownerId":null,"ownerName":null,"isOwner":false,
               "canManage":false,"pinned":true,"userCount":0,"songCount":0,"createdAt":1761800000001,"future":"x"}
            ],"lobbies":[]}
        """.trimIndent()))

        val list = client().playlists()

        assertEquals(2, list.size)
        val mine = list[0]
        assertTrue(mine.isPrivate)
        assertTrue(mine.isOwner && mine.canManage)
        assertEquals("by you", mine.ownerLine)
        assertEquals(12, mine.songCount)
        val shared = list[1]
        assertFalse(shared.isPrivate)
        assertEquals("Untitled playlist", shared.displayName)
        assertEquals("shared", shared.ownerLine)

        val request = server.takeRequest()
        assertEquals("/api/playlists", request.url.encodedPath)
        assertEquals("Bearer la_secret", request.headers["Authorization"])
    }

    @Test
    fun `playlist songs parse entries and strip the artist from queue titles`() = runTest {
        server.enqueue(json("""
            {"playlist":{"id":"p1","name":"Road","visibility":"public","isOwner":false,"ownerId":"u2","ownerName":"Ayşe"},
             "songs":[
              {"position":1,"entry_id":"e1","library_id":"11111111-1111-4111-8111-111111111111","youtube_id":"abcdefghijk",
               "title":"One More Time - Daft Punk","artist":"Daft Punk","duration_sec":320,"url":"library:1111",
               "thumbnail":null,"added_by":"Erkan","added_at":1761800000000,"available":true},
              {"position":2,"entry_id":"e2","library_id":null,"youtube_id":"zzzzzzzzzzz","title":"Old YouTube entry",
               "artist":null,"duration_sec":null,"url":"https://youtu.be/zzzzzzzzzzz","available":false}
             ]}
        """.trimIndent()))

        val result = client().playlistSongs("p1")

        assertEquals("by Ayşe", result.playlist!!.ownerLine)
        val first = result.songs[0]
        assertEquals("One More Time", first.cleanTitle)
        val song = first.toSong()!!
        assertEquals("11111111-1111-4111-8111-111111111111", song.id)
        assertEquals("Daft Punk", song.artist)
        assertEquals(320, song.durationSec)
        assertFalse(result.songs[1].playable)
        assertNull(result.songs[1].toSong())
        assertEquals("/api/playlists/p1/songs", server.takeRequest().url.encodedPath)
    }

    @Test
    fun `create, update, add and move send the bodies the server expects`() = runTest {
        server.enqueue(json("""{"id":"new","name":"Fresh","visibility":"private","isOwner":true,"canManage":true,"link":"/playlist/new"}""", 201))
        server.enqueue(json("""{"id":"new","name":"Renamed","visibility":"private","isOwner":true,"canManage":true}"""))
        server.enqueue(json("""{"id":"new","name":"Renamed","visibility":"public","isOwner":true,"canManage":true}"""))
        server.enqueue(json("""{"playlist_id":"new","summary":{"total":2,"added":1,"already_in_playlist":1,"not_in_library":0,"invalid":0},"results":[],"song_count":5}"""))
        server.enqueue(json("""{"playlist_id":"new","songs":[{"position":1,"entry_id":"e2","title":"B"},{"position":2,"entry_id":"e1","title":"A"}]}"""))
        val c = client()

        val created = c.createPlaylist("  Fresh ", Visibility.PRIVATE)
        assertEquals("new", created.id)
        val renamed = c.updatePlaylist("new", name = "Renamed")
        assertEquals("Renamed", renamed.name)
        assertFalse(c.updatePlaylist("new", visibility = Visibility.PUBLIC).isPrivate)
        val added = c.addToPlaylist("new", listOf("id-a", "id-b"))
        assertEquals(1, added.summary.added)
        assertEquals(1, added.summary.alreadyInPlaylist)
        assertEquals(5, added.songCount)
        val order = c.moveInPlaylist("new", "e1", 2)
        assertEquals(listOf("e2", "e1"), order.map { it.entryId })

        fun body(r: mockwebserver3.RecordedRequest) = Json.parseToJsonElement(r.body!!.utf8()).jsonObject

        server.takeRequest().let {
            assertEquals("POST", it.method)
            assertEquals("/api/playlists", it.url.encodedPath)
            assertEquals("Fresh", body(it)["name"]!!.jsonPrimitive.content)
            assertEquals("private", body(it)["visibility"]!!.jsonPrimitive.content)
        }
        server.takeRequest().let {
            assertEquals("PATCH", it.method)
            assertEquals("/api/playlists/new", it.url.encodedPath)
            assertEquals(setOf("name"), body(it).keys)
        }
        server.takeRequest().let {
            assertEquals(setOf("visibility"), body(it).keys)
            assertEquals("public", body(it)["visibility"]!!.jsonPrimitive.content)
        }
        server.takeRequest().let {
            assertEquals("/api/playlists/new/songs", it.url.encodedPath)
            assertEquals(listOf("id-a", "id-b"), body(it)["songs"]!!.jsonArray.map { e -> e.jsonPrimitive.content })
        }
        server.takeRequest().let {
            assertEquals("POST", it.method)
            assertEquals("/api/playlists/new/songs/e1/move", it.url.encodedPath)
            assertEquals(2, body(it)["position"]!!.jsonPrimitive.int)
        }
    }

    @Test
    fun `delete and remove use DELETE on the right paths`() = runTest {
        server.enqueue(json("""{"success":true,"id":"p1"}"""))
        server.enqueue(json("""{"playlist_id":"p1","removed":[],"song_count":0}"""))
        client().deletePlaylist("p1")
        client().removeFromPlaylist("p1", "entry 1")
        server.takeRequest().let {
            assertEquals("DELETE", it.method)
            assertEquals("/api/playlists/p1", it.url.encodedPath)
        }
        server.takeRequest().let {
            assertEquals("DELETE", it.method)
            assertEquals("/api/playlists/p1/songs/entry%201", it.url.encodedPath)
        }
    }

    @Test
    fun `server errors carry the status and the server's message`() = runTest {
        server.enqueue(json("""{"error":"Only the owner can delete this playlist","code":"FORBIDDEN"}""", 403))
        server.enqueue(json("""{"error":"A playlist with that name already exists","code":"CONFLICT"}""", 409))
        try {
            client().deletePlaylist("p1")
            fail("expected a 403")
        } catch (e: ApiException) {
            assertEquals(403, e.code)
            assertEquals("Only the owner can delete this playlist", e.message)
        }
        try {
            client().createPlaylist("Dup", Visibility.PUBLIC)
            fail("expected a 409")
        } catch (e: ApiException) {
            assertEquals(409, e.code)
            assertEquals("A playlist with that name already exists", e.message)
        }
    }

    @Test
    fun `fileUrl points at the library file endpoint under a path prefix`() {
        val c = LibraryClient(ServerUrl.normalize("https://example.com/music")!!, null)
        assertEquals("https://example.com/music/api/library/abc/file", c.fileUrl("abc").toString())
    }
}
