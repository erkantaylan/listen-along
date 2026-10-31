package com.erkantaylan.listenalong

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AppInfoTest {
    @Test
    fun `the label is the build's version in the web footer's form`() {
        assertEquals("v1.2.3", AppInfo.versionLabel("1.2.3"))
        assertEquals("v${BuildConfig.VERSION_NAME}", AppInfo.versionLabel(BuildConfig.VERSION_NAME))
        assertNotEquals("", BuildConfig.VERSION_NAME)
    }

    @Test
    fun `the source link is the web form of the repository`() {
        assertEquals("https://github.com/erkantaylan/listen-along", AppInfo.SOURCE_URL)
    }
}
