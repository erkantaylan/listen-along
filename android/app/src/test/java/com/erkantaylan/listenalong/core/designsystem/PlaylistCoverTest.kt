package com.erkantaylan.listenalong.core.designsystem

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The web's fixtures (frontend/src/features/playlists/playlist-filter.test.ts),
 * with the colour each id gets there (computed with the web's own function),
 * so a playlist's cover is the same colour on both.
 */
class PlaylistCoverTest {

    @Test
    fun `the same colour as the web for the same id`() {
        val web = mapOf(
            "abc" to 1, "Z9-x" to 1, "" to 1, "çğü" to 3, "7f3c" to 2, "🎸x" to 3,
            "f0e36fec-7633-4535-b53b-def54a57db37" to 2, "38a81e7a-22d3-41f3-8734-c717e4aa2ad8" to 6,
        )
        web.forEach { (id, n) -> assertEquals(id, n, PlaylistCover.index(id)) }
        assertEquals(1, PlaylistCover.index(null))
    }

    @Test
    fun `ids spread over the six colours exactly as on the web`() {
        val web = "234561234534561234564561234561561234561261234561231234561234"
        val ours = (0 until 60).joinToString("") { PlaylistCover.index("pl-$it").toString() }
        assertEquals(web, ours)
        assertTrue((0 until 60).map { PlaylistCover.index("pl-$it") }.toSet().size == PlaylistCover.COLOURS)
    }

    @Test
    fun `initials take two whole letters with Turkish capitals`() {
        assertEquals("İŞ", PlaylistCover.initials("istanbul şarkıları"))
        assertEquals("IÇ", PlaylistCover.initials("ılık çay ve üç kişi"))
        assertEquals("Y", PlaylistCover.initials("  Yol  "))
        assertEquals("🎸R", PlaylistCover.initials("🎸 rock"))
        assertEquals("?", PlaylistCover.initials(""))
        assertEquals("?", PlaylistCover.initials(null))
        assertEquals("RT", PlaylistCover.initials("Road trip"))
        assertEquals("DM", PlaylistCover.initials("dev mix"))
    }
}
