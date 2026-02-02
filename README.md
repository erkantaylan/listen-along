# listen-along

A web app where users create music lobbies, share links with friends, and listen to YouTube audio together in sync.

## Quick Start

### Using Docker (recommended)

```bash
make build
make run
```

Open http://localhost:3000

### Local Development

```bash
make dev
```

## Project Structure

```
├── backend/          # Node.js + Express + Socket.IO server
│   └── src/
├── frontend/         # Vanilla JS client (mobile-first)
├── docker/           # Docker configuration
├── docker-compose.yml
└── Makefile
```

## Requirements

- Docker and Docker Compose, OR
- Node.js 18+ (for local development)

## Make Targets

| Command      | Description                    |
|--------------|--------------------------------|
| `make build` | Build Docker image             |
| `make run`   | Run with Docker Compose        |
| `make dev`   | Run locally for development    |
| `make test`  | Run tests                      |
| `make clean` | Remove containers and node_modules |
