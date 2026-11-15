package com.erkantaylan.listenalong.core.data

import com.erkantaylan.listenalong.core.network.ApiException
import com.erkantaylan.listenalong.core.network.ApiProvider
import kotlinx.coroutines.CancellationException

/** One line of the connection check, good or bad. */
data class CheckLine(val ok: Boolean, val text: String)

/** The signed-in account as the server sees it, and "Test connection". */
class AccountRepository(private val api: ApiProvider) {

    /** `/api/me` and one library page: who the server thinks you are, and whether the library answers. */
    suspend fun testConnection(): List<CheckLine> {
        val client = api() ?: return listOf(CheckLine(false, "No server set"))
        val result = mutableListOf<CheckLine>()
        try {
            val me = client.me()
            val status = me.user?.status
            result += CheckLine(
                status != "pending",
                "Signed in as ${me.name.ifBlank { "your account" }}" + if (status == "pending") " (waiting for approval)" else "",
            )
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            result += CheckLine(
                false,
                if (t is ApiException && t.sessionEnded) "The session has ended: sign in again"
                else "Account check failed: ${describe(t)}",
            )
        }
        try {
            val page = client.list(limit = 1)
            result += CheckLine(true, "Library reachable · ${page.total} songs")
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            result += CheckLine(false, "Library: ${describe(t)}")
        }
        return result
    }

    private fun describe(t: Throwable): String = when (t) {
        is ApiException -> "${t.code} ${t.message}"
        else -> t.message ?: t::class.simpleName ?: "failed"
    }
}
