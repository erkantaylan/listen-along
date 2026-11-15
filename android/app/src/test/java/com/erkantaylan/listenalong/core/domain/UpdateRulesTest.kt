package com.erkantaylan.listenalong.core.domain

import com.erkantaylan.listenalong.core.domain.UpdateRules.Dismissal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {

    @Test
    fun `versions compare as numbers, like the version code`() {
        assertTrue(UpdateRules.isNewer("0.10.0", "0.9.0"))       // a string compare would say no
        assertTrue(UpdateRules.isNewer("1.0.0", "0.99.99"))
        assertTrue(UpdateRules.isNewer("0.4.1", "0.4.0"))
        assertFalse(UpdateRules.isNewer("0.4.0", "0.4.0"))       // equal
        assertFalse(UpdateRules.isNewer("0.3.9", "0.4.0"))       // older
        assertEquals(1002, UpdateRules.parse("0.10.2")!!.code)
        assertEquals(400, UpdateRules.parse("android-v0.4.0")!!.code)
    }

    @Test
    fun `malformed names are never offered`() {
        assertFalse(UpdateRules.isNewer("latest", "0.4.0"))
        assertFalse(UpdateRules.isNewer("1.0", "0.4.0"))
        assertFalse(UpdateRules.isNewer("", "0.4.0"))
        assertFalse(UpdateRules.isNewer(null, "0.4.0"))
        assertFalse(UpdateRules.isNewer("1.0.0", "garbage"))
        assertNull(UpdateRules.parse("1.2.3.4"))
    }

    @Test
    fun `pre-releases are not offered, and a dev build is older than its release`() {
        assertFalse(UpdateRules.isNewer("0.5.0-rc1", "0.4.0"))
        assertTrue(UpdateRules.isNewer("0.2.0", "0.2.0-dev"))
        assertTrue(UpdateRules.isDevBuild("0.2.0-dev", debug = false))
        assertTrue(UpdateRules.isDevBuild("0.4.0", debug = true))
        assertFalse(UpdateRules.isDevBuild("0.4.0", debug = false))
    }

    @Test
    fun `Later hides that version for three days, a newer one shows at once`() {
        val now = 10_000_000_000L
        val day = 24L * 60 * 60 * 1000
        assertTrue(UpdateRules.shouldShow("0.5.0", "0.4.0", null, now))
        assertFalse(UpdateRules.shouldShow("0.5.0", "0.4.0", Dismissal("0.5.0", now - day), now))       // dismissed recently
        assertTrue(UpdateRules.shouldShow("0.5.0", "0.4.0", Dismissal("0.5.0", now - 4 * day), now))    // a while ago
        assertTrue(UpdateRules.shouldShow("0.6.0", "0.4.0", Dismissal("0.5.0", now - day), now))        // an older version was dismissed
        assertFalse(UpdateRules.shouldShow("0.4.0", "0.4.0", null, now))
    }
}
