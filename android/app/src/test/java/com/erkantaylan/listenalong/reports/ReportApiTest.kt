package com.erkantaylan.listenalong.reports

import com.erkantaylan.listenalong.api.ApiException
import com.erkantaylan.listenalong.api.LibraryClient
import com.erkantaylan.listenalong.api.ServerUrl
import com.erkantaylan.listenalong.api.SongReport
import com.erkantaylan.listenalong.storage.MemoryTextStore
import kotlinx.coroutines.test.runTest
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
import java.time.Instant

/** "Mark as broken" against the shapes backend/src/libraryRoutes.js and songReports.js answer with. */
class ReportApiTest {

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

    private val reportedPage = """
        {"songs":[
          {"id":"s1","title":"One","artist":"A","report_count":2,"reports":[
            {"id":"7","reason":"bad audio","reported_by":"Alice","created_at":"2026-10-30T10:00:00.000Z",
             "updated_at":"2026-10-30T11:00:00.000Z","mine":true},
            {"id":"8","reason":null,"reported_by":"Bob","created_at":"2026-10-30T12:00:00.000Z",
             "updated_at":"2026-10-30T12:00:00.000Z","mine":false}]},
          {"id":"s2","title":"Two","artist":"B","report_count":1,"reports":[
            {"id":"9","reason":"cut off","reported_by":"Carol","created_at":"2026-10-29T10:00:00.000Z","mine":false}]}
        ],"total":2}
    """.trimIndent()

    @Test
    fun `songs carry their reports and count, old servers without them parse as none`() = runTest {
        server.enqueue(json(reportedPage))
        server.enqueue(json("""{"songs":[{"id":"x","title":"Legacy"}],"total":1}"""))

        val page = client().list(reported = true)
        assertEquals("reported=1 is sent", "1", server.takeRequest().url.queryParameter("reported"))
        val one = page.songs[0]
        assertEquals(2, one.reportCount)
        assertEquals(listOf("7", "8"), one.reports.map { it.id })
        assertTrue(one.reports[0].mine)
        assertEquals("Alice", one.reports[0].reportedBy)
        assertNull(one.reports[1].reason)

        val legacy = client().list().songs[0]
        assertNull("no reported param by default", server.takeRequest().url.queryParameter("reported"))
        assertTrue(legacy.reports.isEmpty())
        assertEquals(0, legacy.reportCount)
    }

    @Test
    fun `report posts the cleaned reason and parses report and song`() = runTest {
        server.enqueue(json("""
            {"report":{"id":"11","reason":"wrong song","reported_by":"Me","created_at":"2026-10-30T10:00:00.000Z","mine":true},
             "song":{"id":"s1","title":"One","report_count":1,"reports":[{"id":"11","reason":"wrong song","reported_by":"Me","mine":true}]}}
        """.trimIndent(), code = 201))

        val result = client().report("s1", "  wrong song ")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/library/s1/report", request.url.encodedPath)
        assertEquals("Bearer la_secret", request.headers["Authorization"])
        assertEquals("""{"reason":"wrong song"}""", request.body?.utf8())
        assertTrue(result.report.mine)
        assertEquals(1, result.song?.reportCount)
    }

    @Test
    fun `report with no reason sends an empty object`() = runTest {
        server.enqueue(json("""{"report":{"id":"1","mine":true},"song":null}""", code = 201))
        client().report("s1", "   ")
        assertEquals("{}", server.takeRequest().body?.utf8())
    }

    @Test
    fun `unmark deletes and a 404 is an ApiException`() = runTest {
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"error":"You have not marked this song as broken","code":"NOT_FOUND"}""", code = 404))

        client().unmark("s1")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/library/s1/report", request.url.encodedPath)

        try {
            client().unmark("s1")
            fail("expected 404")
        } catch (e: ApiException) {
            assertEquals(404, e.code)
            assertEquals("You have not marked this song as broken", e.message)
        }
    }

    // --- ReportStore ----------------------------------------------------------

    @Test
    fun `store refresh, absorb, mark and unmark keep the map in step`() = runTest {
        val saved = MemoryTextStore()
        val client = client()
        val store = ReportStore({ client }, saved)
        server.enqueue(json(reportedPage))

        store.refresh()
        assertEquals(setOf("s1", "s2"), store.reports.value.keys)

        // A library page says s2 has no reports any more, and s3 has one.
        store.absorb(listOf(
            com.erkantaylan.listenalong.api.Song(id = "s2"),
            com.erkantaylan.listenalong.api.Song(id = "s3", reports = listOf(SongReport(id = "20", reportedBy = "Dan"))),
        ))
        assertEquals(setOf("s1", "s3"), store.reports.value.keys)

        // Marking s3: the answer's song is the new truth.
        server.enqueue(json("""
            {"report":{"id":"21","reason":"cut off","mine":true},
             "song":{"id":"s3","reports":[{"id":"20","reported_by":"Dan"},{"id":"21","reason":"cut off","mine":true}],"report_count":2}}
        """.trimIndent(), code = 201))
        assertFalse("a new report, not an update", store.mark("s3", "cut off"))
        assertEquals(listOf("20", "21"), store.reportsFor("s3").map { it.id })

        // Unmarking s1 drops only my report; s3 keeps Dan's after mine goes.
        server.enqueue(json("""{"ok":true}"""))
        store.unmark("s1")
        assertEquals(listOf("8"), store.reportsFor("s1").map { it.id })
        server.enqueue(json("""{"error":"gone"}""", code = 404))
        store.unmark("s3")
        assertEquals(listOf("20"), store.reportsFor("s3").map { it.id })

        // Saved per server: a new store for the same server starts from it.
        val again = ReportStore({ client }, saved)
        assertEquals(store.reports.value, again.reports.value)
        // ... and another server's copy is not shown.
        val other = LibraryClient(ServerUrl.normalize("https://elsewhere.example")!!, "t")
        assertTrue(ReportStore({ other }, saved).reports.value.isEmpty())
    }

    @Test
    fun `mark reports an update when I already had a report`() = runTest {
        val client = client()
        val store = ReportStore({ client }, MemoryTextStore())
        server.enqueue(json(reportedPage))
        store.refresh()
        server.enqueue(json("""{"report":{"id":"7","reason":"wrong song","mine":true},"song":null}"""))
        assertTrue(store.mark("s1", "wrong song"))
        // No song in the answer: my report is replaced in place, Bob's stays.
        assertEquals(listOf("8", "7"), store.reportsFor("s1").map { it.id })
        assertEquals("wrong song", store.reportsFor("s1").first { it.mine }.reason)
    }

    @Test
    fun `a failed refresh keeps the old copy`() = runTest {
        val client = client()
        val store = ReportStore({ client }, MemoryTextStore())
        server.enqueue(json(reportedPage))
        store.refresh()
        server.enqueue(json("""{"error":"down"}""", code = 503))
        try {
            store.refresh()
            fail("expected 503")
        } catch (_: ApiException) {
        }
        assertEquals(setOf("s1", "s2"), store.reports.value.keys)
    }

    // --- ReportReasons --------------------------------------------------------

    @Test
    fun `reasons are cleaned like the server does`() {
        assertNull(ReportReasons.clean(null))
        assertNull(ReportReasons.clean("   "))
        assertEquals("bad audio", ReportReasons.clean("  bad \n\t  audio "))
        assertEquals(200, ReportReasons.clean("x".repeat(250))!!.length)
    }

    @Test
    fun `lines and relative times read like the web`() {
        val now = Instant.parse("2026-10-30T12:00:00Z")
        val reports = listOf(
            SongReport(id = "1", reason = "Wrong song", reportedBy = "Ayşe", updatedAt = "2026-10-30T10:00:00.000Z"),
            SongReport(id = "2", reason = null, reportedBy = "Me", createdAt = "2026-10-30T11:59:30.000Z", mine = true),
        )
        assertEquals(listOf("“Wrong song” — Ayşe, 2h ago", "No reason given — you, just now"), ReportReasons.lines(reports, now))
        assertEquals("5m ago", ReportReasons.relative("2026-10-30T11:55:00Z", now))
        assertEquals("3d ago", ReportReasons.relative("2026-10-27T12:00:00Z", now))
        assertEquals("", ReportReasons.relative("not a date", now))
        assertEquals("Needs replacement — marked as broken by 1 person", ReportReasons.summary(1))
        assertEquals("Needs replacement — marked as broken by 3 people", ReportReasons.summary(3))
    }
}
