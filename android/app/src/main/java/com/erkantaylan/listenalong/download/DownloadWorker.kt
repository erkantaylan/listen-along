package com.erkantaylan.listenalong.download

import android.content.Context
import androidx.work.WorkerParameters

/**
 * The download worker's name before the app moved to its feature/core
 * packages. WorkManager stores a work request's class name, so a download
 * queued by an older version (still waiting for a network when the app is
 * updated) is created by this name: it is the same worker.
 */
class DownloadWorker(context: Context, params: WorkerParameters) :
    com.erkantaylan.listenalong.core.download.DownloadWorker(context, params)
