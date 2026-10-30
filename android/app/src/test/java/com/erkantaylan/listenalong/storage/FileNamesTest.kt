package com.erkantaylan.listenalong.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileNamesTest {

    @Test
    fun `artist dash title with the extension`() {
        assertEquals("Daft Punk - One More Time.m4a",
                     FileNames.displayName("Daft Punk", "One More Time", AudioFormat.M4A))
        assertEquals("Daft Punk - One More Time.mp3",
                     FileNames.displayName("Daft Punk", "One More Time", AudioFormat.MP3))
    }

    @Test
    fun `characters illegal on common filesystems are replaced`() {
        assertEquals("AC DC - What Why - Live", FileNames.sanitize("AC/DC - What? Why\\ - Live"))
        val name = FileNames.baseName("A:B*C", "x<y>z|\"q\"")
        assertEquals("A B C - x y z q", name)
        for (bad in listOf('/', '\\', ':', '*', '?', '"', '<', '>', '|')) {
            assertFalse("contains $bad", FileNames.baseName("a${bad}b", "t${bad}u").contains(bad))
        }
    }

    @Test
    fun `control characters and runs of whitespace collapse to one space`() {
        assertEquals("a b c", FileNames.sanitize("a\tb\n\u0000 \u0007  c"))
    }

    @Test
    fun `leading and trailing dots and spaces are stripped`() {
        assertEquals("hidden", FileNames.sanitize("  ...hidden.. "))
        assertEquals("Artist - Title", FileNames.baseName(" .Artist. ", "Title..."))
    }

    @Test
    fun `non-latin text is kept as is`() {
        assertEquals("Barış Manço - Dağlar Dağlar", FileNames.baseName("Barış Manço", "Dağlar Dağlar"))
        assertEquals("坂本龍一 - 戦場のメリークリスマス", FileNames.baseName("坂本龍一", "戦場のメリークリスマス"))
    }

    @Test
    fun `unknown or missing artist gives just the title`() {
        assertEquals("Some Song", FileNames.baseName("Unknown", "Some Song"))
        assertEquals("Some Song", FileNames.baseName("", "Some Song"))
        assertEquals("Some Song", FileNames.baseName(null, "Some Song"))
        assertEquals("Only Artist", FileNames.baseName("Only Artist", "  "))
    }

    @Test
    fun `nothing usable falls back to Untitled`() {
        assertEquals("Untitled", FileNames.baseName("", ""))
        assertEquals("Untitled", FileNames.baseName("???", "..."))
        assertEquals("Untitled.m4a", FileNames.displayName(null, null, AudioFormat.M4A))
    }

    @Test
    fun `long names are cut to the byte budget without splitting a character`() {
        val long = FileNames.baseName("Ö".repeat(150), "ş".repeat(150))
        val bytes = long.toByteArray(Charsets.UTF_8).size
        assertTrue("was $bytes bytes", bytes <= FileNames.MAX_BASE_BYTES)
        assertFalse(long.contains('�'))
        assertTrue(long.startsWith("ÖÖÖ"))

        // Emoji are surrogate pairs; never cut one in half.
        val emoji = FileNames.truncateUtf8("ab" + "🎵".repeat(10), 9)
        assertEquals("ab🎵", emoji)
    }

    @Test
    fun `a name cut at the budget does not end in a space or a dot`() {
        val name = FileNames.baseName("A".repeat(FileNames.MAX_BASE_BYTES - 2), "Title")
        assertFalse(name.endsWith(" "))
        assertFalse(name.endsWith(" -"))
        assertTrue(name.startsWith("AAAA"))
        assertTrue(name.toByteArray().size <= FileNames.MAX_BASE_BYTES)
    }

    @Test
    fun `format comes from the content type`() {
        assertEquals(AudioFormat.M4A, AudioFormat.fromContentType("audio/mp4"))
        assertEquals(AudioFormat.M4A, AudioFormat.fromContentType("audio/x-m4a"))
        assertEquals(AudioFormat.M4A, AudioFormat.fromContentType("AUDIO/MP4; charset=binary"))
        assertEquals(AudioFormat.MP3, AudioFormat.fromContentType("audio/mpeg"))
        assertEquals(AudioFormat.MP3, AudioFormat.fromContentType("audio/mpeg; foo=bar"))
        assertEquals(AudioFormat.MP3, AudioFormat.fromContentType("audio/mp3"))
        // Anything unexpected is treated as the server's default container.
        assertEquals(AudioFormat.M4A, AudioFormat.fromContentType("application/octet-stream"))
        assertEquals(AudioFormat.M4A, AudioFormat.fromContentType(null))
        assertEquals("audio/mp4", AudioFormat.M4A.mimeType)
        assertEquals("audio/mpeg", AudioFormat.MP3.mimeType)
    }

    @Test
    fun `legacy webm and ogg songs keep their container`() {
        // The real server serves migrated .webm / .ogg / .opus cache files as
        // audio/webm and audio/ogg. Saving them as .m4a breaks players.
        assertEquals(AudioFormat.WEBM, AudioFormat.fromContentType("audio/webm"))
        assertEquals(AudioFormat.OGG, AudioFormat.fromContentType("audio/ogg"))
        assertEquals(AudioFormat.OGG, AudioFormat.fromContentType("audio/ogg; codecs=opus"))
        assertEquals("Dean Martin - Let It Snow.mka",
                     FileNames.displayName("Dean Martin", "Let It Snow", AudioFormat.WEBM))
        assertEquals("Dean Martin - Let It Snow.ogg",
                     FileNames.displayName("Dean Martin", "Let It Snow", AudioFormat.OGG))
        // MediaStore rejects audio/webm; WebM is Matroska.
        assertEquals("audio/x-matroska", AudioFormat.WEBM.mimeType)
        assertEquals("audio/ogg", AudioFormat.OGG.mimeType)
    }
}
