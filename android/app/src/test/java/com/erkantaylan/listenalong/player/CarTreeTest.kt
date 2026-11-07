package com.erkantaylan.listenalong.player

import com.erkantaylan.listenalong.api.Song
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CarTreeTest {

    private fun roundTrip(node: CarNode) = assertEquals(node, CarNode.parse(node.id))

    @Test
    fun `every node survives its media id`() {
        roundTrip(CarNode.Root)
        roundTrip(CarNode.Playlists)
        roundTrip(CarNode.Songs(CarList.Device))
        roundTrip(CarNode.Songs(CarList.Library))
        roundTrip(CarNode.Songs(CarList.Playlist("6f1c2a9e-0d7b-4c1e-9a55-3b1f0c2d4e5f")))
        roundTrip(CarNode.Shuffle(CarList.Playlist("p1")))
        roundTrip(CarNode.Shuffle(CarList.Device))
        roundTrip(CarNode.Track(CarList.Playlist("p1"), 12, "song-1"))
        roundTrip(CarNode.Track(CarList.Device, 0, "a"))
    }

    @Test
    fun `search queries with slashes, colons and spaces survive`() {
        roundTrip(CarNode.Track(CarList.Search("AC/DC: back in black"), 3, "s/1"))
        roundTrip(CarNode.Songs(CarList.Search("çok güzel şarkı")))
    }

    @Test
    fun `unknown or broken ids are refused`() {
        assertNull(CarNode.parse(""))
        assertNull(CarNode.parse("nope"))
        assertNull(CarNode.parse("list/elsewhere"))
        assertNull(CarNode.parse("track/device/x/song"))
        assertNull(CarNode.parse("track/device/-1/song"))
        assertNull(CarNode.parse("track/device/1"))
        assertNull(CarNode.parse("root/extra"))
    }

    @Test
    fun `a tapped song starts where it was, or where it moved to`() {
        val songs = listOf("a", "b", "c", "b").map { Song(id = it) }
        assertEquals(3, CarNode.startIndex(songs, 3, "b")) // the second "b" itself
        assertEquals(1, CarNode.startIndex(songs, 0, "b")) // moved: the first "b"
        assertEquals(0, CarNode.startIndex(songs, 9, "gone")) // removed: the top
    }
}
