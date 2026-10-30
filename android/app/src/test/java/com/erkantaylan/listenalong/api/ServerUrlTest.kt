package com.erkantaylan.listenalong.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {

    private fun norm(input: String) = ServerUrl.normalize(input)?.toString()

    @Test
    fun `adds https when no scheme is given`() {
        assertEquals("https://listen.example.com/", norm("listen.example.com"))
    }

    @Test
    fun `keeps an explicit scheme and port`() {
        assertEquals("http://10.0.2.2:3000/", norm("http://10.0.2.2:3000"))
    }

    @Test
    fun `trims whitespace and extra slashes, drops query and fragment`() {
        assertEquals("https://x.com/", norm("  https://x.com///?a=1#frag  "))
    }

    @Test
    fun `keeps a path prefix with a trailing slash`() {
        assertEquals("https://x.com/listen/", norm("https://x.com/listen"))
        assertEquals("https://x.com/a/b/", norm("https://x.com/a//b/"))
    }

    @Test
    fun `rejects nonsense`() {
        assertNull(norm(""))
        assertNull(norm("   "))
        assertNull(norm("ftp://x.com"))
        assertNull(norm("https://"))
    }

    @Test
    fun `display drops the trailing slash`() {
        assertEquals("https://x.com/listen", ServerUrl.display(ServerUrl.normalize("x.com/listen/")!!))
    }

    @Test
    fun `formatDuration`() {
        assertEquals("", formatDuration(null))
        assertEquals("0:07", formatDuration(7))
        assertEquals("3:33", formatDuration(213))
        assertEquals("1:02:45", formatDuration(3765))
    }
}
