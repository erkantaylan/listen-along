package com.erkantaylan.listenalong.core.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.erkantaylan.listenalong.core.designsystem.DownloadMark
import com.erkantaylan.listenalong.core.designsystem.DownloadMarkIcon
import com.erkantaylan.listenalong.core.designsystem.Palette
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.Downloaded
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.Downloading
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.Failed
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.Off
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.Paused
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.Unavailable
import com.erkantaylan.listenalong.core.domain.PlaylistDownloadStatus.WaitingForWifi
import com.erkantaylan.listenalong.core.model.formatBytes

/** The mark a downloaded playlist carries next to its name (Spotify's green circle, a ring while downloading). */
fun markFor(status: PlaylistDownloadStatus): DownloadMark? = when (status) {
    Off -> null
    is Downloaded -> DownloadMark.Downloaded
    is Downloading -> DownloadMark.Progress(if (status.total > 0) status.done.toFloat() / status.total else null)
    is WaitingForWifi, is Paused, is Failed -> DownloadMark.Waiting
    is Unavailable -> if (status.done > 0) DownloadMark.Downloaded else null
}

private fun songs(n: Int) = if (n == 1) "1 song" else "$n songs"

/** The muted line under a downloaded playlist: what it is doing and how much it takes. */
fun statusText(status: PlaylistDownloadStatus): String = when (status) {
    Off -> ""
    is Downloaded -> buildString {
        append("Downloaded · ${songs(status.count)} · ${formatBytes(status.bytes)}")
        if (status.missingOnServer > 0) append(" · ${status.missingOnServer} not on the server")
    }
    is Downloading -> "Downloading ${status.done} of ${status.total}"
    is WaitingForWifi -> "Waiting for Wi-Fi · ${status.done} of ${status.total}"
    is Paused -> "Paused while offline · ${status.done} of ${status.total}"
    is Failed -> "Download stopped: ${status.message} · ${status.done} of ${status.total}"
    is Unavailable -> "No longer available · ${songs(status.done)} kept on this device"
}

/** [markFor] + [statusText] on one line (a playlist's header, On device). */
@Composable
fun PlaylistDownloadLine(status: PlaylistDownloadStatus, modifier: Modifier = Modifier, markSize: Dp = 14.dp) {
    if (status == Off) return
    Row(modifier.testTag("download-status"), verticalAlignment = Alignment.CenterVertically) {
        markFor(status)?.let {
            DownloadMarkIcon(it, size = markSize)
            Spacer(Modifier.width(5.dp))
        }
        Text(
            statusText(status),
            color = if (status is Failed) Palette.danger else Palette.fg3,
            fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}
