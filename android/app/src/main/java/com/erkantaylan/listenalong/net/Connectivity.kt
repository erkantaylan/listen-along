package com.erkantaylan.listenalong.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the server can be reached right now. Only a hint: the screens still
 * treat a failed request as the real answer, but this lets them say "offline"
 * up front, refresh when the connection comes back, and lets the player leave
 * songs that are not on the device out of the queue (or skip them).
 *
 * Two things make it false:
 * - no **validated** network. A network with the INTERNET capability alone is
 *   not enough: a car's Wi-Fi hotspot with no uplink, a captive portal, or
 *   mobile data with no signal all claim INTERNET, and streams on them only
 *   hang until they time out. Android sets VALIDATED once it has actually
 *   reached the internet.
 * - the player found the server unreachable ([reportServerUnreachable]: a
 *   stream failed with a network error or a 5xx). That holds for
 *   [Reachability.SERVER_DOWN_MS], or until the phone moves to another
 *   network, or a stream starts again.
 */
class Connectivity(context: Context) {

    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val reachability = Reachability(SystemClock::elapsedRealtime)
    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    init {
        reachability.network(currentlyValidated())
        publish()
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = update()
                override fun onLost(network: Network) = update()
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = update()
            })
        }
    }

    /** A stream failed in a way that means the server cannot be reached (not just this song). */
    fun reportServerUnreachable() {
        reachability.serverUnreachable()
        publish()
        // Look again once the cool-down is over, so `online` comes back by itself.
        handler.postDelayed(::publish, Reachability.SERVER_DOWN_MS + 100)
    }

    /** A stream started playing: the server answers. */
    fun reportServerReachable() {
        reachability.serverReachable()
        publish()
    }

    private fun update() {
        reachability.network(currentlyValidated())
        publish()
    }

    private fun publish() {
        _online.value = reachability.online
    }

    private fun currentlyValidated(): Boolean = runCatching {
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)
    }.getOrDefault(true)
}

/**
 * The decision behind [Connectivity.online], without Android, so it can be
 * tested: a validated network, and no recent sign that the server is down.
 */
class Reachability(private val now: () -> Long, private val serverDownMs: Long = SERVER_DOWN_MS) {

    private var network = true
    private var serverDownAt: Long? = null

    @Synchronized
    fun network(validated: Boolean) {
        // A network that (re)appears is worth trying the server on again.
        if (validated && !network) serverDownAt = null
        network = validated
    }

    @Synchronized
    fun serverUnreachable() {
        serverDownAt = now()
    }

    @Synchronized
    fun serverReachable() {
        serverDownAt = null
    }

    val online: Boolean
        @Synchronized get() {
            if (!network) return false
            val downAt = serverDownAt ?: return true
            if (now() - downAt < serverDownMs) return false
            serverDownAt = null
            return true
        }

    companion object {
        /** How long a failed stream keeps the player on downloaded songs only. */
        const val SERVER_DOWN_MS = 60_000L
    }
}
