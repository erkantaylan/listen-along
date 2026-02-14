.PHONY: build run dev test test-restart clean help

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

build:
	docker-compose build

run:
	docker-compose up

dev:
	cd backend && npm install && npm run dev

test:
	cd backend && npm test

test-restart:
	./scripts/test-restart.sh

clean:
	docker-compose down --rmi local -v 2>/dev/null || true
	$(RM) backend/node_modules 2>/dev/null || true
