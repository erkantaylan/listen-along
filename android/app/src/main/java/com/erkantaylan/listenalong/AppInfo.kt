package com.erkantaylan.listenalong

/** What Settings shows about the app itself, in the web footer's form. */
object AppInfo {
    const val SOURCE_URL = "https://github.com/erkantaylan/listen-along"

    fun versionLabel(versionName: String): String = "v$versionName"
}
