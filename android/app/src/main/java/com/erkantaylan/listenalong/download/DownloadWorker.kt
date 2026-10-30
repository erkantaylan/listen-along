package com.erkantaylan.listenalong.download

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.erkantaylan.listenalong.ListenAlongApp
import com.erkantaylan.listenalong.MainActivity
import com.erkantaylan.listenalong.R
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Runs the download queue in the background, as a foreground service with a
 * progress notification, so downloads carry on with the app closed.
 *
 * One worker drains the whole queue (two songs at a time) rather than one
 * worker per song: a "download all" of 400 songs is one notification, not 400.
 */
class DownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val downloads get() = (applicationContext as ListenAlongApp).graph.downloads

    override suspend fun doWork(): Result {
        if (downloads.queue.pending.value.isEmpty()) return Result.success()

        DownloadNotifications.ensureChannel(applicationContext)
        val stats = DrainStats()
        // Android 12+ refuses to start a foreground service from the
        // background in some cases; the downloads still run, just without the
        // service's protection.
        runCatching { setForeground(foregroundInfo(stats)) }

        coroutineScope {
            val ticker = launch {
                while (true) {
                    delay(1_000)
                    runCatching { setForeground(foregroundInfo(stats)) }
                }
            }
            try {
                downloads.drain(stats)
            } finally {
                ticker.cancel()
            }
        }

        DownloadNotifications.showSummary(applicationContext, stats.done.get(), stats.failed.get())
        return Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        DownloadNotifications.ensureChannel(applicationContext)
        return foregroundInfo(DrainStats())
    }

    private fun foregroundInfo(stats: DrainStats): ForegroundInfo {
        val notification = DownloadNotifications.progress(applicationContext, downloads.snapshot(), stats)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(DownloadNotifications.PROGRESS_ID, notification,
                           ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(DownloadNotifications.PROGRESS_ID, notification)
        }
    }
}

object DownloadScheduler {
    private const val WORK_NAME = "downloads"

    /**
     * Makes sure a worker will look at the queue. APPEND_OR_REPLACE rather
     * than KEEP: a worker that has just found the queue empty and is about to
     * finish would otherwise swallow this request, stranding what was just
     * queued. An appended worker that finds nothing to do exits at once.
     */
    fun kick(context: Context) {
        val request = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
}

/** The notification's "Cancel all" button. */
class CancelDownloadsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        (context.applicationContext as ListenAlongApp).graph.downloads.cancelAll()
    }
}

object DownloadNotifications {
    const val CHANNEL_ID = "downloads"
    const val PROGRESS_ID = 1
    private const val SUMMARY_ID = 2

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Songs being saved to the device"
            }
        )
    }

    fun progress(context: Context, snapshot: DownloadSnapshot, stats: DrainStats): Notification {
        val finished = stats.done.get() + stats.failed.get()
        val total = finished + snapshot.pending.size
        val running = snapshot.pending.filter { it.id in snapshot.progress }
        val position = (finished + 1).coerceAtMost(total.coerceAtLeast(1))

        // Count-based bar, with the songs in flight counted fractionally so it
        // moves during a long track rather than in jumps.
        val inFlight = running.sumOf { song ->
            val p = snapshot.progress[song.id]
            if (p != null && p.total > 0) p.bytesRead.toDouble() / p.total else 0.0
        }
        val max = 1000
        val value = if (total > 0) (((finished + inFlight) / total) * max).toInt() else 0

        val cancel = PendingIntent.getBroadcast(
            context, 0,
            Intent(context, CancelDownloadsReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(if (total > 0) "Downloading $position of $total" else "Preparing downloads")
            .setContentText(running.joinToString(" · ") { it.title.ifBlank { "Untitled" } })
            .setProgress(max, value, total == 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(openApp(context))
            .addAction(0, "Cancel all", cancel)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun showSummary(context: Context, done: Int, failed: Int) {
        if (done == 0 && failed == 0) return
        if (!canNotify(context)) return
        val text = buildString {
            append(if (done == 1) "1 song saved" else "$done songs saved")
            if (failed > 0) append(" · $failed failed")
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle("Downloads finished")
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(openApp(context))
            .build()
        try {
            NotificationManagerCompat.from(context).notify(SUMMARY_ID, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }

    private fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun openApp(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
