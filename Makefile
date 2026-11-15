.PHONY: build run dev test test-restart clean help up down reset

# Detect OS for cross-platform support
ifeq ($(OS),Windows_NT)
    RM = rmdir /s /q
    MKDIR = mkdir
else
    RM = rm -rf
    MKDIR = mkdir -p
endif

help:
	@echo "Available targets:"
	@echo "  build  - Build Docker image"
	@echo "  run    - Run with Docker Compose"
	@echo "  dev    - Run locally for development"
	@echo "  test          - Run unit tests"
	@echo "  test-restart  - Run restart persistence tests (requires docker compose up)"
	@echo "  clean  - Remove build artifacts and containers"
	@echo "  up     - Local dev environment with Aspire (Postgres, server, frontend watch, seed; README)"
	@echo "  down   - Stop it (keeps the database volume)"
	@echo "  reset  - Stop it and delete the dev database volume and .dev-data/"

build:
	docker-compose build

run:
	docker-compose up

dev:
	npm install && npm --prefix backend install && npm run dev

test:
	npm test

test-restart:
	./scripts/test-restart.sh

clean:
	docker-compose down --rmi local -v 2>/dev/null || true
	$(RM) backend/node_modules node_modules frontend/dist 2>/dev/null || true

# Local development through the Aspire AppHost (aspire/apphost.mts, README
# "Local development"). Options: LISTEN_PORT, LISTEN_WORKER=1, LISTEN_AUTH=oidc.
up:
	sh scripts/aspire-dev.sh up

down:
	sh scripts/aspire-dev.sh down

reset:
	sh scripts/aspire-dev.sh reset
