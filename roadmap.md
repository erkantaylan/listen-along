# 🎵 listen-along

A web app where users create music lobbies, share links with friends, and listen to YouTube audio together in sync.

## Overview

Create a lobby, share the link, and enjoy music with friends – everyone hears the same song at the same time. No ads, no accounts, just music.

## Features

- **Lobby System** – Create a lobby, get a shareable link, friends join instantly
- **Shared Queue** – Anyone in the lobby can add songs (YouTube URL or search)
- **Synced Playback** – All users hear the same audio at the same timestamp
- **Real-time Updates** – Queue changes, user joins/leaves reflected instantly
- **No Ads** – Audio streamed directly via yt-dlp

## Architecture
```
┌─────────────┐     WebSocket      ┌─────────────────┐
│   Browser   │ ◄────────────────► │   Backend API   │
│  (Client)   │                    │                 │
└─────────────┘                    └────────┬────────┘
                                            │
                                            ▼
                                   ┌─────────────────┐
                                   │  yt-dlp + ffmpeg │
                                   │  (Audio Stream)  │
                                   └─────────────────┘
```

## How Sync Works

1. Server is the **single source of truth** for current track & timestamp
2. Server streams audio to all connected clients
3. Clients periodically sync their position with server
4. Small buffer handles network latency differences

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js (Express + Socket.IO) / Python (FastAPI + WebSockets) |
| Frontend | Vanilla JS / React |
| Audio | yt-dlp (stream mode) + ffmpeg |
| Database | SQLite / In-memory |

## User Flow

1. User creates lobby → gets unique link (e.g., `/lobby/abc123`)
2. Share link with friends
3. Friends open link → join lobby via WebSocket
4. Anyone adds song (YouTube URL or search term)
5. Server uses yt-dlp to stream audio
6. All clients receive synced audio stream
7. When track ends → next song in queue plays
