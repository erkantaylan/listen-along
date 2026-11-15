package com.erkantaylan.listenalong.testing

import com.erkantaylan.listenalong.core.data.ServerConfig
import com.erkantaylan.listenalong.core.model.AddSongsResult
import com.erkantaylan.listenalong.core.model.AddSongsSummary
import com.erkantaylan.listenalong.core.model.LibraryPage
import com.erkantaylan.listenalong.core.model.Me
import com.erkantaylan.listenalong.core.model.MeUser
import com.erkantaylan.listenalong.core.model.Playlist
import com.erkantaylan.listenalong.core.model.PlaylistEntry
import com.erkantaylan.listenalong.core.model.PlaylistSongs
import com.erkantaylan.listenalong.core.model.ReportResult
import com.erkantaylan.listenalong.core.model.Song
import com.erkantaylan.listenalong.core.model.SongReport
import com.erkantaylan.listenalong.core.model.SortOrder
import com.erkantaylan.listenalong.core.model.Visibility
import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.ListenAlongApi
import com.erkantaylan.listenalong.core.network.NetworkMonitor
import com.erkantaylan.listenalong.core.network.ServerUrl
import com.erkantaylan.listenalong.core.storage.AudioFormat
import com.erkantaylan.listenalong.core.storage.AudioSink
import com.erkantaylan.listenalong.core.storage.LocalSong
import com.erkantaylan.listenalong.core.storage.PendingAudio
import com.erkantaylan.listenalong.core.storage.SavedAudio
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.HttpUrl
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.atomic.AtomicInteger

/** viewModelScope runs on Dispatchers.Main: replace it for the test. */
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(val dispatcher: TestDispatcher = UnconfinedTestDispatcher()) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}

val TEST_SERVER: HttpUrl = ServerUrl.normalize("https://music.test")!!

fun signedIn(token: String = "lam_test") = ServerConfig(TEST_SERVER, token, "Tester")

class FakeNetwork(online: Boolean = true) : NetworkMonitor {
    override val online = MutableStateFlow(online)
}

fun song(id: String, title: String = "Song $id", artist: String = "Artist", duration: Double? = 180.0) =
    Song(id = id, title = title, artist = artist, durationRaw = duration)

fun entry(entryId: String, libraryId: String?, title: String = "T $entryId", artist: String = "A") =
    PlaylistEntry(entryId = entryId, libraryId = libraryId, title = title, artist = artist, durationRaw = 120.0)

fun local(id: String, title: String = "Song $id", artist: String = "Artist", manual: Boolean = true, reclaimed: Boolean = false) =
    LocalSong(id, "content://fake/$id", "$artist - $title.m4a", title, artist, 180, "audio/mp4", 1000, 1, reclaimed)

/**
 * The server, in memory. Everything is public so a test sets it up and looks
 * at what was asked; [fail] makes the next calls throw (an IOException is
 * "unreachable", an [ApiException] an answer).
 */
class FakeApi(override val baseUrl: HttpUrl = TEST_SERVER) : ListenAlongApi {
    val library = mutableListOf<Song>()
    val playlists = linkedMapOf<String, Playlist>()
    val entries = mutableMapOf<String, MutableList<PlaylistEntry>>()
    var fail: IOException? = null
    /** Per playlist id: the error its songs endpoint answers with. */
    val playlistErrors = mutableMapOf<String, IOException>()
    val calls = mutableListOf<String>()
    var me = Me("Tester", MeUser("u1", "Tester", "approved"))
    val reports = mutableMapOf<String, List<SongReport>>()
    /** The bytes each song's file returns; absent = 404. */
    val files = mutableMapOf<String, ByteArray>()
    private val ids = AtomicInteger()

    private fun check(call: String) {
        calls += call
        fail?.let { throw it }
    }

    fun addPlaylist(id: String, name: String, songIds: List<String?>, owner: Boolean = true) {
        playlists[id] = Playlist(id = id, name = name, isOwner = owner, canManage = owner, canEdit = true, songCount = songIds.size)
        entries[id] = songIds.mapIndexed { i, sid -> entry("$id-e$i", sid, title = sid?.let { "Song $it" } ?: "YouTube only") }.toMutableList()
    }

    override suspend fun list(query: String, limit: Int, offset: Int, sort: SortOrder, reported: Boolean): LibraryPage {
        check("list:$query:$offset:$reported")
        val hits = library.filter { query.isBlank() || it.title.contains(query, ignoreCase = true) }
            .filter { !reported || it.reports.isNotEmpty() }
        return LibraryPage(hits.drop(offset).take(limit), hits.size)
    }

    override suspend fun listAll(query: String, sort: SortOrder, pageSize: Int, reported: Boolean): List<Song> {
        check("listAll:$query:$reported")
        return library.filter { query.isBlank() || it.title.contains(query, ignoreCase = true) }
            .filter { !reported || it.reports.isNotEmpty() }
    }

    override suspend fun me(): Me {
        check("me")
        return me
    }

    override suspend fun report(songId: String, reason: String?): ReportResult {
        check("report:$songId")
        val r = SongReport("r-$songId", reason, "Tester", mine = true)
        reports[songId] = listOf(r)
        return ReportResult(r)
    }

    override suspend fun unmark(songId: String) {
        check("unmark:$songId")
        reports.remove(songId)
    }

    override suspend fun playlists(): List<Playlist> {
        check("playlists")
        return playlists.values.map { it.copy(songCount = entries[it.id]?.size ?: 0) }
    }

    override suspend fun playlistSongs(id: String): PlaylistSongs {
        check("songs:$id")
        playlistErrors[id]?.let { throw it }
        val p = playlists[id] ?: throw ApiException(404, "Playlist not found", "NOT_FOUND")
        val list = entries[id].orEmpty().mapIndexed { i, e -> e.copy(position = i + 1) }
        return PlaylistSongs(p.copy(songCount = list.size), list)
    }

    override suspend fun createPlaylist(name: String, visibility: Visibility): Playlist {
        check("create:$name")
        val id = "new-${ids.incrementAndGet()}"
        addPlaylist(id, name, emptyList())
        playlists[id] = playlists[id]!!.copy(visibility = visibility.param)
        return playlists[id]!!
    }

    override suspend fun updatePlaylist(id: String, name: String?, visibility: Visibility?): Playlist {
        check("update:$id")
        val p = playlists[id] ?: throw ApiException(404, "Playlist not found")
        val next = p.copy(name = name ?: p.name, visibility = visibility?.param ?: p.visibility)
        playlists[id] = next
        return next
    }

    override suspend fun deletePlaylist(id: String) {
        check("delete:$id")
        playlists.remove(id) ?: throw ApiException(404, "Playlist not found")
        entries.remove(id)
    }

    override suspend fun addToPlaylist(id: String, libraryIds: List<String>): AddSongsResult {
        check("add:$id:${libraryIds.joinToString(",")}")
        val list = entries.getOrPut(id) { mutableListOf() }
        var added = 0
        var already = 0
        libraryIds.forEach { sid ->
            if (list.any { it.libraryId == sid }) already++ else {
                list += entry("$id-e${ids.incrementAndGet()}", sid, title = "Song $sid"); added++
            }
        }
        return AddSongsResult(AddSongsSummary(libraryIds.size, added, already), list.size)
    }

    override suspend fun removeFromPlaylist(id: String, entryId: String) {
        check("remove:$id:$entryId")
        entries[id]?.removeAll { it.entryId == entryId }
    }

    override suspend fun moveInPlaylist(id: String, entryId: String, position: Int): List<PlaylistEntry> {
        check("move:$id:$entryId:$position")
        val list = entries[id] ?: throw ApiException(404, "Playlist not found")
        val e = list.first { it.entryId == entryId }
        list.remove(e)
        list.add(position - 1, e)
        return list.toList()
    }

    override fun fileUrl(songId: String): HttpUrl =
        baseUrl.newBuilder().addPathSegments("api/library/$songId/file").build()

    override fun <T> streamFile(songId: String, job: Job?, block: (String?, Long, InputStream) -> T): T {
        calls += "file:$songId"
        fail?.let { throw it }
        val bytes = files[songId] ?: throw ApiException(404, "Not on the server", "FILE_MISSING")
        return block("audio/mp4", bytes.size.toLong(), ByteArrayInputStream(bytes))
    }
}

/** Where downloads go in tests: in memory, with a flag to make deletes fail. */
class MemorySink : AudioSink {
    val saved = linkedMapOf<String, ByteArray>()
    val deleted = mutableListOf<String>()
    var free: Long? = null
    private val counter = AtomicInteger()

    override fun begin(displayName: String, format: AudioFormat): PendingAudio {
        val buffer = ByteArrayOutputStream()
        return object : PendingAudio {
            override val output = buffer
            override fun commit(): SavedAudio {
                val uri = "content://fake/saved-${counter.incrementAndGet()}"
                saved[uri] = buffer.toByteArray()
                return SavedAudio(uri, displayName)
            }
            override fun abort() {}
        }
    }

    override fun exists(uri: String): Boolean = uri in saved || (uri.startsWith("content://fake/") && uri !in deleted)

    override fun delete(uri: String): Boolean {
        deleted += uri
        saved.remove(uri)
        return true
    }
}
