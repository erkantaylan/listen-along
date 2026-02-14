#!/usr/bin/env bash
#
# Restart persistence test scenarios for GH#41
# Tests that lobby state survives docker compose restarts.
#
# Usage: ./scripts/test-restart.sh
# Requires: docker compose, curl, node
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log() { echo -e "${YELLOW}[test]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); }

wait_for_server() {
  local max_wait=30
  local waited=0
  while ! curl -sf "${BASE_URL}/health" > /dev/null 2>&1; do
    if [ $waited -ge $max_wait ]; then
      echo "Server failed to start within ${max_wait}s"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

restart_app() {
  log "Restarting app container..."
  docker compose -f "$COMPOSE_FILE" restart app
  wait_for_server
  log "App restarted and healthy"
}

# Helper: create a lobby via the API and return the ID
create_lobby() {
  curl -sf "${BASE_URL}/api/lobbies" -X POST -H 'Content-Type: application/json' | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(d); process.stdout.write(j.id);
    });"
}

# Helper: use a node script to interact via socket.io
# This approach avoids needing a separate test client dependency
run_socket_test() {
  local script="$1"
  node -e "$script"
}

# ─────────────────────────────────────────────────────────────────
# Scenario 1: Independent lobby + queue survives restart
# ─────────────────────────────────────────────────────────────────
scenario_1() {
  log "Scenario 1: Independent lobby + 3 songs → restart → verify"

  local result
  result=$(node -e "
    const io = require('socket.io-client');
    const socket = io('${BASE_URL}');

    socket.on('connect', () => {
      socket.emit('lobby:create', {
        username: 'TestUser',
        emoji: '🎵',
        listeningMode: 'independent',
        name: 'restart-test-1'
      });
    });

    socket.on('lobby:created', (data) => {
      const lobbyId = data.lobbyId;

      // Add 3 songs
      socket.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=test1', title: 'Song A', duration: 180, addedBy: 'Tester' });
      socket.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=test2', title: 'Song B', duration: 200, addedBy: 'Tester' });
      socket.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=test3', title: 'Song C', duration: 220, addedBy: 'Tester' });

      // Wait for DB writes, then output lobby ID
      setTimeout(() => {
        console.log(JSON.stringify({ lobbyId, listeningMode: data.listeningMode }));
        socket.disconnect();
      }, 1000);
    });

    socket.on('connect_error', (err) => {
      console.error('Connection failed:', err.message);
      process.exit(1);
    });

    setTimeout(() => { console.error('Timeout'); process.exit(1); }, 10000);
  " 2>&1) || { fail "Scenario 1: Failed to create lobby"; return; }

  local lobby_id
  lobby_id=$(echo "$result" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.lobbyId);})")
  local mode
  mode=$(echo "$result" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.listeningMode);})")

  if [ "$mode" != "independent" ]; then
    fail "Scenario 1: Expected independent mode, got: $mode"
    return
  fi

  # Restart
  restart_app

  # Reconnect and verify
  local verify
  verify=$(node -e "
    const io = require('socket.io-client');
    const socket = io('${BASE_URL}');

    socket.on('connect', () => {
      socket.emit('lobby:join', {
        lobbyId: '${lobby_id}',
        username: 'TestUser2',
        emoji: '🎶'
      });
    });

    socket.on('lobby:joined', (data) => {
      // Wait for queue:update event
    });

    socket.on('queue:update', (data) => {
      console.log(JSON.stringify({
        songCount: data.songs.length,
        songs: data.songs.map(s => s.title),
        lobbyId: data.lobbyId
      }));
      socket.disconnect();
    });

    socket.on('connect_error', (err) => {
      console.error('Connection failed:', err.message);
      process.exit(1);
    });

    setTimeout(() => { console.error('Timeout'); process.exit(1); }, 10000);
  " 2>&1) || { fail "Scenario 1: Failed to verify after restart"; return; }

  local song_count
  song_count=$(echo "$verify" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.songCount));})")

  if [ "$song_count" = "3" ]; then
    pass "Scenario 1: Independent lobby + 3 songs restored after restart"
  else
    fail "Scenario 1: Expected 3 songs, got: $song_count"
  fi
}

# ─────────────────────────────────────────────────────────────────
# Scenario 3: Queue order preserved after reorder + restart
# ─────────────────────────────────────────────────────────────────
scenario_3() {
  log "Scenario 3: Add songs → reorder → restart → verify order"

  local result
  result=$(node -e "
    const io = require('socket.io-client');
    const socket = io('${BASE_URL}');
    let lobbyId;
    let songs = [];

    socket.on('connect', () => {
      socket.emit('lobby:create', {
        username: 'OrderTest',
        emoji: '🔀',
        listeningMode: 'synchronized',
        name: 'restart-test-3'
      });
    });

    socket.on('lobby:created', (data) => {
      lobbyId = data.lobbyId;
      socket.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=o1', title: 'First', duration: 100, addedBy: 'Tester' });
      socket.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=o2', title: 'Second', duration: 110, addedBy: 'Tester' });
      socket.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=o3', title: 'Third', duration: 120, addedBy: 'Tester' });
    });

    let updateCount = 0;
    socket.on('queue:update', (data) => {
      updateCount++;
      songs = data.songs;

      if (updateCount === 3 && songs.length === 3) {
        // Reorder: move Third to position 0
        socket.emit('queue:reorder', { lobbyId, songId: songs[2].id, newIndex: 0 });
      }

      if (updateCount === 4) {
        // Give time for DB write
        setTimeout(() => {
          console.log(JSON.stringify({ lobbyId, order: songs.map(s => s.title) }));
          socket.disconnect();
        }, 1000);
      }
    });

    setTimeout(() => { console.error('Timeout'); process.exit(1); }, 15000);
  " 2>&1) || { fail "Scenario 3: Failed to set up lobby"; return; }

  local lobby_id
  lobby_id=$(echo "$result" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.lobbyId);})")

  restart_app

  local verify
  verify=$(node -e "
    const io = require('socket.io-client');
    const socket = io('${BASE_URL}');

    socket.on('connect', () => {
      socket.emit('lobby:join', { lobbyId: '${lobby_id}', username: 'Verifier', emoji: '✅' });
    });

    socket.on('queue:update', (data) => {
      console.log(JSON.stringify({ order: data.songs.map(s => s.title) }));
      socket.disconnect();
    });

    setTimeout(() => { console.error('Timeout'); process.exit(1); }, 10000);
  " 2>&1) || { fail "Scenario 3: Failed to verify"; return; }

  local order
  order=$(echo "$verify" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.order.join(','));})")

  if [ "$order" = "Third,First,Second" ]; then
    pass "Scenario 3: Queue order preserved after reorder + restart"
  else
    fail "Scenario 3: Expected 'Third,First,Second', got: '$order'"
  fi
}

# ─────────────────────────────────────────────────────────────────
# Scenario 4: Playlist survives restart
# ─────────────────────────────────────────────────────────────────
scenario_4() {
  log "Scenario 4: Create playlist → add songs → restart → verify"

  # Create playlist via API
  local playlist
  playlist=$(curl -sf "${BASE_URL}/api/playlists" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"userId":"test-user-restart","name":"Restart Mix"}') || { fail "Scenario 4: Failed to create playlist"; return; }

  local playlist_id
  playlist_id=$(echo "$playlist" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.id);})")

  # Add songs
  curl -sf "${BASE_URL}/api/playlists/${playlist_id}/songs" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://youtube.com/watch?v=pl1","title":"Playlist Song 1","duration":200}' > /dev/null

  curl -sf "${BASE_URL}/api/playlists/${playlist_id}/songs" -X POST \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://youtube.com/watch?v=pl2","title":"Playlist Song 2","duration":180}' > /dev/null

  restart_app

  # Verify playlist still exists
  local verify
  verify=$(curl -sf "${BASE_URL}/api/playlists/${playlist_id}") || { fail "Scenario 4: Playlist not found after restart"; return; }

  local song_count
  song_count=$(echo "$verify" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.songs.length));})")

  if [ "$song_count" = "2" ]; then
    pass "Scenario 4: Playlist with 2 songs intact after restart"
  else
    fail "Scenario 4: Expected 2 songs, got: $song_count"
  fi
}

# ─────────────────────────────────────────────────────────────────
# Scenario 5: Two users → restart → both reconnect to same state
# ─────────────────────────────────────────────────────────────────
scenario_5() {
  log "Scenario 5: Two users in lobby → restart → both reconnect"

  local result
  result=$(node -e "
    const io = require('socket.io-client');
    const s1 = io('${BASE_URL}');
    let lobbyId;

    s1.on('connect', () => {
      s1.emit('lobby:create', {
        username: 'User1',
        emoji: '👤',
        listeningMode: 'synchronized',
        name: 'restart-test-5'
      });
    });

    s1.on('lobby:created', (data) => {
      lobbyId = data.lobbyId;
      s1.emit('queue:add', { lobbyId, url: 'https://youtube.com/watch?v=mu1', title: 'Shared Song', duration: 300, addedBy: 'User1' });

      // Second user joins
      const s2 = io('${BASE_URL}');
      s2.on('connect', () => {
        s2.emit('lobby:join', { lobbyId, username: 'User2', emoji: '👥' });
      });
      s2.on('lobby:joined', () => {
        setTimeout(() => {
          console.log(JSON.stringify({ lobbyId }));
          s1.disconnect();
          s2.disconnect();
        }, 1000);
      });
    });

    setTimeout(() => { console.error('Timeout'); process.exit(1); }, 10000);
  " 2>&1) || { fail "Scenario 5: Failed to set up"; return; }

  local lobby_id
  lobby_id=$(echo "$result" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.lobbyId);})")

  restart_app

  # Both users reconnect
  local verify
  verify=$(node -e "
    const io = require('socket.io-client');
    let results = [];

    function connectUser(name, emoji) {
      return new Promise((resolve, reject) => {
        const s = io('${BASE_URL}');
        s.on('connect', () => {
          s.emit('lobby:join', { lobbyId: '${lobby_id}', username: name, emoji });
        });
        s.on('queue:update', (data) => {
          resolve({ user: name, songCount: data.songs.length, songs: data.songs.map(s => s.title) });
          s.disconnect();
        });
        setTimeout(() => reject(new Error('Timeout for ' + name)), 10000);
      });
    }

    Promise.all([
      connectUser('User1', '👤'),
      connectUser('User2', '👥')
    ]).then(results => {
      console.log(JSON.stringify(results));
    }).catch(err => {
      console.error(err.message);
      process.exit(1);
    });
  " 2>&1) || { fail "Scenario 5: Failed to verify"; return; }

  local both_see_song
  both_see_song=$(echo "$verify" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      const r=JSON.parse(d);
      const ok = r.every(u => u.songCount === 1 && u.songs[0] === 'Shared Song');
      process.stdout.write(String(ok));
    });" )

  if [ "$both_see_song" = "true" ]; then
    pass "Scenario 5: Both users see correct state after restart"
  else
    fail "Scenario 5: Users don't see consistent state"
  fi
}

# ─────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────

log "Starting restart persistence tests"
log "Base URL: ${BASE_URL}"

# Check if socket.io-client is available
if ! node -e "require('socket.io-client')" 2>/dev/null; then
  log "Installing socket.io-client for test client..."
  npm install --no-save socket.io-client 2>/dev/null
fi

# Verify server is running
if ! wait_for_server; then
  echo "Server is not running. Start it with: docker compose up -d"
  echo "Then run: $0"
  exit 1
fi

scenario_1
scenario_3
scenario_4
scenario_5

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit $FAIL
