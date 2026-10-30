package com.erkantaylan.listenalong.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.erkantaylan.listenalong.api.Song
import com.erkantaylan.listenalong.api.SortOrder
import com.erkantaylan.listenalong.api.formatDuration
import com.erkantaylan.listenalong.download.DownloadState
import com.erkantaylan.listenalong.download.formatMb
import com.erkantaylan.listenalong.storage.LocalSong
import com.erkantaylan.listenalong.ui.theme.Palette

@OptIn(ExperimentalComposeUiApi::class, ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    viewModel: LibraryViewModel,
    onOpen: (LocalSong) -> Unit,
    onBeforeDownload: () -> Unit,
    onQueued: (Int) -> Unit,
    onGoToSettings: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val downloads by viewModel.downloads.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()

    // Back clears the search before it leaves the tab.
    BackHandler(enabled = state.query.isNotEmpty()) { viewModel.clearQuery() }

    // Fetch the next page when the last rows come into view.
    val nearEnd by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 10
        }
    }
    LaunchedEffect(nearEnd, state.songs.size, state.canLoadMore) {
        if (nearEnd && state.canLoadMore) viewModel.loadMore()
    }
    // A new search starts at the top.
    LaunchedEffect(state.query, state.sort) { listState.scrollToItem(0) }

    Column(
        Modifier.fillMaxSize().background(Palette.bg).semantics { testTagsAsResourceId = true }
    ) {
        ScreenHeader("LIBRARY") {
            if (state.configured && state.total > 0) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val count = if (state.songs.size >= state.total) "${state.total}"
                                else "${state.songs.size}/${state.total}"
                    Text(count, color = Palette.textDim, fontSize = 12.sp)
                    MetaSeparator()
                    HeaderAction("Download all", "download-all") { viewModel.prepareBulk() }
                }
            }
        }

        if (!state.configured) {
            Centre { NotConfigured(onGoToSettings) }
            return@Column
        }

        TextInput(
            value = state.query,
            onValueChange = viewModel::onQueryChange,
            placeholder = "Search title or artist",
            tag = "search",
            imeAction = ImeAction.Search,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
            ChipRow(SortOrder.entries, state.sort, { it.label }, viewModel::onSortChange)
        }

        when {
            state.loading -> Centre { CircularProgressIndicator(color = Palette.accent) }

            state.error != null && state.songs.isEmpty() -> Centre {
                ErrorPanel(state.error!!, onRetry = viewModel::refresh)
            }

            state.songs.isEmpty() -> Centre {
                Text(
                    if (state.query.isBlank()) "The library is empty." else "Nothing matches.",
                    color = Palette.textDim, fontSize = 13.sp,
                )
            }

            else -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = PaddingValues(bottom = 32.dp),
                ) {
                    items(state.songs, key = { it.id }) { song ->
                        val download = downloads.stateOf(song.id)
                        SongRow(song, download) {
                            when (download) {
                                is DownloadState.Absent, is DownloadState.Failed -> {
                                    onBeforeDownload()
                                    viewModel.download(song)
                                }
                                is DownloadState.Queued, is DownloadState.InProgress -> viewModel.cancel(song)
                                is DownloadState.Done -> onOpen(download.local)
                            }
                        }
                    }
                    item(key = "footer") {
                        when {
                            state.loadingMore -> Box(Modifier.fillMaxWidth().padding(16.dp),
                                                     contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(color = Palette.accent, strokeWidth = 2.dp)
                            }
                            state.error != null -> Text(
                                "${state.error} · tap to retry",
                                color = Palette.danger, fontSize = 12.sp, textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth().clickable { viewModel.refresh() }
                                    .padding(16.dp),
                            )
                        }
                    }
                }
            }
        }
    }

    when (val bulk = state.bulk) {
        null -> Unit
        BulkUi.Preparing -> ConfirmDialog(
            title = "Download all shown",
            text = "Counting songs…",
            confirmLabel = "Download",
            onConfirm = {},
            onDismiss = viewModel::dismissBulk,
        )
        is BulkUi.Error -> ConfirmDialog(
            title = "Download all shown",
            text = "Could not list the songs: ${bulk.message}",
            confirmLabel = "Retry",
            onConfirm = viewModel::prepareBulk,
            onDismiss = viewModel::dismissBulk,
        )
        is BulkUi.Ready -> {
            val plan = bulk.plan
            if (plan.count == 0) {
                ConfirmDialog(
                    title = "Nothing to download",
                    text = "All ${plan.alreadyHave} songs in this list are already on the device or queued.",
                    confirmLabel = "OK",
                    onConfirm = viewModel::dismissBulk,
                    onDismiss = viewModel::dismissBulk,
                )
            } else {
                val text = buildString {
                    append("Download ${plan.count} song${if (plan.count == 1) "" else "s"}")
                    if (state.query.isNotBlank()) append(" matching \"${state.query.trim()}\"")
                    append("?\n\nAbout ${formatMb(plan.estimatedMb)} (roughly 1 MB per minute of audio)")
                    if (plan.unknownDurations > 0) {
                        append("; ${plan.unknownDurations} with no duration counted as 4 minutes each")
                    }
                    append(".")
                    if (plan.alreadyHave > 0) append("\n\n${plan.alreadyHave} already on the device or queued are skipped.")
                }
                ConfirmDialog(
                    title = "Download all shown",
                    text = text,
                    confirmLabel = "Download ${plan.count}",
                    onConfirm = {
                        onBeforeDownload()
                        onQueued(viewModel.confirmBulk())
                    },
                    onDismiss = viewModel::dismissBulk,
                )
            }
        }
    }
}

@Composable
private fun SongRow(song: Song, download: DownloadState, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(bottom = 8.dp)
            .testTag("song:${song.id}")
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.panel)
            .border(1.dp, Palette.border, RoundedCornerShape(10.dp))
            .clickable(onClick = onTap)
            .padding(12.dp),
    ) {
        Text(song.title.ifBlank { "Untitled" }, color = Palette.text, fontSize = 15.sp, lineHeight = 21.sp)
        val byline = listOfNotNull(
            song.artist.takeIf { it.isNotBlank() },
            song.album?.takeIf { it.isNotBlank() },
        ).joinToString(" · ")
        if (byline.isNotEmpty()) {
            Text(byline, color = Palette.textDim, fontSize = 13.sp, maxLines = 1,
                 overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        }
        Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            val duration = formatDuration(song.durationSec)
            if (duration.isNotEmpty()) {
                Text(duration, color = Palette.textDim, fontSize = 11.sp)
            }
            song.uploadedBy?.takeIf { it.isNotBlank() }?.let {
                if (duration.isNotEmpty()) MetaSeparator()
                Text("by $it", color = Palette.textDim, fontSize = 11.sp, maxLines = 1)
            }
            StateLabel(download, leadingSeparator = duration.isNotEmpty() || !song.uploadedBy.isNullOrBlank())
        }
        if (download is DownloadState.InProgress) {
            val fraction = download.fraction
            val mod = Modifier.fillMaxWidth().padding(top = 8.dp)
            if (fraction != null) {
                LinearProgressIndicator(
                    progress = { fraction }, color = Palette.accent, trackColor = Palette.panel2,
                    drawStopIndicator = {}, gapSize = 0.dp, modifier = mod,
                )
            } else {
                LinearProgressIndicator(color = Palette.accent, trackColor = Palette.panel2, modifier = mod)
            }
        }
    }
}

@Composable
private fun StateLabel(state: DownloadState, leadingSeparator: Boolean) {
    val (text, color) = when (state) {
        is DownloadState.Absent -> return
        is DownloadState.Queued -> "queued · tap to cancel" to Palette.accent
        is DownloadState.InProgress -> {
            val pct = state.fraction?.let { "${(it * 100).toInt()}%" } ?: "starting"
            "$pct · tap to cancel" to Palette.accent
        }
        is DownloadState.Done -> "on device · tap to play" to Palette.ok
        is DownloadState.Failed -> "${state.message} · tap to retry" to Palette.danger
    }
    if (leadingSeparator) MetaSeparator()
    Text(text, color = color, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun NotConfigured(onGoToSettings: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally,
           verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("No server yet", color = Palette.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Text("Set the listen-along server's address in Settings.",
             color = Palette.textDim, fontSize = 13.sp, textAlign = TextAlign.Center)
        HeaderAction("Open Settings", "goto-settings", onClick = onGoToSettings)
    }
}

@Composable
private fun ErrorPanel(message: String, onRetry: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Cannot reach the library", color = Palette.danger, fontSize = 15.sp,
             fontWeight = FontWeight.SemiBold)
        Text(message, color = Palette.text, fontSize = 13.sp, textAlign = TextAlign.Center,
             modifier = Modifier.padding(top = 8.dp))
        Box(Modifier.padding(top = 14.dp)) { HeaderAction("Retry", "retry", onClick = onRetry) }
    }
}
