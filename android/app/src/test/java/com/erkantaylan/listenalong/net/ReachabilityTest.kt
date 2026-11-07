package com.erkantaylan.listenalong.net

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReachabilityTest {

    private var clock = 0L
    private val r = Reachability(now = { clock }, serverDownMs = 60_000)

    @Test
    fun `a validated network is online`() {
        r.network(true)
        assertTrue(r.online)
    }

    @Test
    fun `no validated network is offline`() {
        r.network(false)
        assertFalse(r.online)
    }

    @Test
    fun `an unreachable server keeps it offline for the cool-down`() {
        r.network(true)
        r.serverUnreachable()
        assertFalse(r.online)
        clock = 59_999
        assertFalse(r.online)
        clock = 60_000
        assertTrue(r.online)
    }

    @Test
    fun `a stream that starts again ends the cool-down`() {
        r.network(true)
        r.serverUnreachable()
        r.serverReachable()
        assertTrue(r.online)
    }

    @Test
    fun `a network that comes back is worth trying again`() {
        r.network(true)
        r.serverUnreachable()
        r.network(false)
        r.network(true)
        assertTrue(r.online)
    }

    @Test
    fun `the same network changing capabilities does not end the cool-down`() {
        r.network(true)
        r.serverUnreachable()
        r.network(true) // signal strength and the like: still the same validated network
        assertFalse(r.online)
    }
}
