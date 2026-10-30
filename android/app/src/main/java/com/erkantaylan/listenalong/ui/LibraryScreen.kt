package com.erkantaylan.listenalong.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import com.erkantaylan.listenalong.reports.ReportReasons
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.erkantaylan.listenalong.api.SortOrder
import com.erkantaylan.listenalong.download.DownloadState
import com.erkantaylan.listenalong.download.formatMb
import com.erkantaylan.listenalong.player.NowPlaying
import com.erkantaylan.listenalong.ui.theme.Palette

@OptIn(ExperimentalComposeUiApi::class, ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    viewModel: LibraryViewModel,
    nowPlaying: NowPlaying,
    actions: AppActions,
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
    LaunchedEffect(state.query, state.sort, state.brokenOnly) { listState.scrollToItem(0) }

    val label = if (state.offline) "On device" else "Library"
    val reports = LocalReports.current
    // In the Broken list, a song leaves as soon as its last report is withdrawn.
    val shown = remember(state.songs, state.brokenOnly, reports) {
        if (state.brokenOnly) state.songs.filter { reports[it.id].orEmpty().isNotEmpty() } else state.songs
    }

    Column(Modifier.fillMaxSize().background(Palette.page).semantics { testTagsAsResourceId = true }) {
        AppTopBar(
            title = "Library",
            subtitle = if (state.hasToken && state.total > 0) {
                {
                    val count = if (state.songs.size >= state.total) "${state.total} songs"
                                else "${state.songs.size} of ${state.total} songs"
                    Text(count, color = Palette.fg3, fontSize = 12.sp)
                }
            } else null,
        ) {
            if (state.hasToken) {
                SortMenu(state.sort, viewModel::onSortChange)
                IconAction(AppIcons.Download, "Download all shown", tag = "download-all",
                           enabled = !state.offline && state.total > 0) { viewModel.prepareBulk() }
            }
        }

        if (!state.hasToken) {
            TokenNeeded(actions)
            return@Column
        }

        TextInput(
            value = state.query,
            onValueChange = viewModel::onQueryChange,
            placeholder = "Search title or artist",
            tag = "search",
            leadingIcon = AppIcons.Search,
            imeAction = ImeAction.Search,
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp),
            trailing = if (state.query.isNotEmpty()) {
                { IconAction(AppIcons.Close, "Clear search", size = 36.dp, iconSize = 18.dp) { viewModel.clearQuery() } }
            } else null,
        )
        BrokenFilter(state.brokenOnly, LocalReports.current.size, viewModel::onBrokenOnlyChange)
        if (state.offline) {
            Alert(
                "Offline — showing the ${state.songs.size} songs on this device.",
                AlertKind.WARNING, icon = AppIcons.CloudOff,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
            )
        }

        when {
            state.loading -> Centre { CircularProgressIndicator(color = Palette.accentFg) }

            state.error != null && state.songs.isEmpty() -> EmptyState(
                title = "Cannot reach the library",
                body = state.error,
                icon = AppIcons.CloudOff,
            ) { SecondaryButton("Retry", viewModel::refresh, tag = "retry") }

            state.songs.isEmpty() -> EmptyState(
                title = when {
                    state.query.isNotBlank() -> "Nothing matches."
                    state.brokenOnly && state.offline -> "None of the songs on this device are marked as broken."
                    state.brokenOnly -> "No songs are marked as broken."
                    state.offline -> "No songs on this device yet."
                    else -> "The library is empty."
                },
                icon = when {
                    state.query.isNotBlank() -> AppIcons.Search
                    state.brokenOnly -> AppIcons.Warning
                    else -> AppIcons.MusicNote
                },
            )

            else -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    state = listState,
                    contentPadding = PaddingValues(bottom = 16.dp),
                ) {
                    item(key = "play-all") {
                        PlayAllBar(
                            playEnabled = shown.isNotEmpty(),
                            onPlay = { actions.play(shown, 0, label, false) },
                            onShuffle = { actions.play(shown, 0, label, true) },
                        )
                    }
                    itemsIndexed(shown, key = { _, song -> song.id }) { i, song ->
                        val download = downloads.stateOf(song.id)
                        SongRow(
                            index = i,
                            count = shown.size,
                            tag = "song:${song.id}",
                            title = song.title,
                            artist = song.artist,
                            durationSec = song.durationSec,
                            download = download,
                            current = nowPlaying.songId == song.id,
                            onClick = { actions.play(shown, i, label, false) },
                            onDownload = {
                                actions.beforeDownload()
                                viewModel.download(song)
                            },
                            onCancelDownload = { viewModel.cancel(song) },
                            reportSong = song,
                            detail = if (state.brokenOnly) reports[song.id]?.let { ReportReasons.lines(it).joinToString("\n") } else null,
                        ) { dismiss ->
                            MenuEntry("Add to playlist", AppIcons.PlaylistAdd, "menu-add-to-playlist",
                                      enabled = !state.offline) {
                                dismiss(); actions.addToPlaylist(listOf(song))
                            }
                            when (download) {
                                is DownloadState.Absent, is DownloadState.Failed ->
                                    MenuEntry("Download", AppIcons.Download, "menu-download", enabled = !state.offline) {
                                        dismiss(); actions.beforeDownload(); viewModel.download(song)
                                    }
                                is DownloadState.Queued, is DownloadState.InProgress ->
                                    MenuEntry("Cancel download", AppIcons.Close, "menu-cancel") {
                                        dismiss(); viewModel.cancel(song)
                                    }
                                is DownloadState.Done ->
                                    MenuEntry("Open in another app", AppIcons.OpenInNew, "menu-open") {
                                        dismiss(); actions.openExternal(download.local)
                                    }
                            }
                        }
                    }
                    item(key = "footer") {
                        when {
                            state.loadingMore -> Box(Modifier.fillMaxWidth().padding(16.dp),
                                                     contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(color = Palette.accentFg, strokeWidth = 2.dp)
                            }
                            state.error != null -> Text(
                                "${state.error} · tap to retry",
                                color = Palette.danger, fontSize = 13.sp, textAlign = TextAlign.Center,
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
                    showCancel = false,
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
                        actions.beforeDownload()
                        actions.queued(viewModel.confirmBulk())
                    },
                    onDismiss = viewModel::dismissBulk,
                )
            }
        }
    }
}

/** "All songs" / "Broken · n": the web library's Broken tab, as two toggle chips. */
@Composable
private fun BrokenFilter(brokenOnly: Boolean, count: Int, onChange: (Boolean) -> Unit) {
    androidx.compose.foundation.layout.Row(
        Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
    ) {
        FilterToggle("All songs", null, !brokenOnly, "filter:all") { onChange(false) }
        FilterToggle("Broken", AppIcons.Warning, brokenOnly, "filter:broken", count.takeIf { it > 0 }) { onChange(true) }
    }
}

@Composable
private fun FilterToggle(
    text: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector?,
    selected: Boolean,
    tag: String,
    /** A warning count badge after the label (the web's Broken tab). */
    count: Int? = null,
    onClick: () -> Unit,
) {
    androidx.compose.foundation.layout.Row(
        Modifier
            .clip(ButtonShape)
            .background(if (selected) Palette.accentSubtle else Palette.surface)
            .border(1.dp, if (selected) Palette.accentBorder else Palette.borderStrong, ButtonShape)
            .clickable(onClick = onClick)
            .semantics { this.selected = selected; role = androidx.compose.ui.semantics.Role.Tab }
            .heightIn(min = 34.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            androidx.compose.material3.Icon(icon, contentDescription = null,
                tint = if (selected) Palette.accentFg else Palette.warning, modifier = Modifier.size(16.dp))
            androidx.compose.foundation.layout.Spacer(Modifier.width(6.dp))
        }
        Text(text, color = if (selected) Palette.accentFg else Palette.fg2, fontSize = 14.sp)
        if (count != null) {
            androidx.compose.foundation.layout.Spacer(Modifier.width(6.dp))
            SubtleBadge("$count", tone = BadgeTone.WARNING)
        }
    }
}

/** `select.form-control` for the sort order, as an icon button with a menu. */
@Composable
private fun SortMenu(sort: SortOrder, onChange: (SortOrder) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconAction(AppIcons.Sort, "Sort: ${sort.label}", tag = "sort") { open = true }
        AppDropdownMenu(open, onDismissRequest = { open = false }) {
            SortOrder.entries.forEach { option ->
                MenuEntry(
                    option.label,
                    if (option == sort) AppIcons.DownloadDone else AppIcons.Sort,
                    "sort:${option.param}",
                ) {
                    open = false
                    onChange(option)
                }
            }
        }
    }
}

/**
 * First launch, or the token was removed: the library and playlists need an
 * API token, which is made on the web profile page.
 */
@Composable
fun TokenNeeded(actions: AppActions) {
    EmptyState(
        title = "Connect your account",
        body = "The music library needs an API token. Create one under \"CLI tokens\" on your profile at " +
            "${actions.serverName()}, then paste it in Settings.",
        icon = AppIcons.Lock,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PrimaryButton("Open my profile", actions.openProfile, icon = AppIcons.OpenInNew, tag = "open-profile")
            Box(Modifier.padding(top = 8.dp)) {
                SecondaryButton("Paste token in Settings", actions.openSettings, tag = "goto-settings")
            }
        }
    }
}
