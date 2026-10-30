#!/usr/bin/env bash
# One-command dev loop: build, install, launch (as kitaplik's dev.sh).
#
#   ./dev.sh              build, install and launch on the connected device
#   ./dev.sh --stub       ...and serve sample songs from tools/stub_server.py,
#                         tunnelled so the app reaches it at http://localhost:8091
#   ./dev.sh --logs       ...then tail the app's logcat
#
# Target a specific device or emulator with ANDROID_SERIAL=emulator-5554 ./dev.sh
# (required when more than one is attached).
set -euo pipefail

APP_ID=com.erkantaylan.listenalong.debug
STUB_PORT=8091
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# A JDK >= 17 for Gradle/AGP: JAVA_HOME if it is one, else the first of
# 17, 21 (and any newer) found under /usr/lib/jvm or on PATH.
java_major() {  # prints the major version of "$1/bin/java", or nothing
  [ -x "$1/bin/java" ] || return 0
  "$1/bin/java" -version 2>&1 | awk -F'"' '/version/ {split($2, v, "."); print (v[1] == "1" ? v[2] : v[1]); exit}'
}
pick_jdk() {
  local major
  if [ -n "${JAVA_HOME:-}" ]; then
    major="$(java_major "$JAVA_HOME")"
    if [ -n "$major" ] && [ "$major" -ge 17 ]; then echo "$JAVA_HOME"; return; fi
    echo "JAVA_HOME=$JAVA_HOME is not a JDK >= 17; looking for one" >&2
  fi
  local candidates=()
  for want in 17 21; do
    for dir in /usr/lib/jvm/*"$want"*; do [ -d "$dir" ] && candidates+=("$dir"); done
  done
  for dir in /usr/lib/jvm/*; do [ -d "$dir" ] && candidates+=("$dir"); done
  if command -v javac >/dev/null 2>&1; then
    candidates+=("$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")")
  fi
  for dir in "${candidates[@]}"; do
    [ -x "$dir/bin/javac" ] || continue
    major="$(java_major "$dir")"
    if [ -n "$major" ] && [ "$major" -ge 17 ]; then echo "$dir"; return; fi
  done
}
JAVA_HOME="$(pick_jdk)"
if [ -z "$JAVA_HOME" ]; then
  echo "No JDK 17 or newer found. Install openjdk-17-jdk (or 21) or set JAVA_HOME." >&2
  exit 1
fi
export JAVA_HOME

if [ -z "${ANDROID_HOME:-}" ]; then
  for dir in "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    if [ -n "$dir" ] && [ -d "$dir/platform-tools" ]; then ANDROID_HOME="$dir"; break; fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "No Android SDK found. Set ANDROID_HOME (expected ~/Android/Sdk)." >&2
  exit 1
fi
export ANDROID_HOME
echo "==> JDK: $JAVA_HOME ($(java_major "$JAVA_HOME")) · SDK: $ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

STUB=0
LOGS=0
for arg in "$@"; do
  case "$arg" in
    --stub) STUB=1 ;;
    --logs) LOGS=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- device -----------------------------------------------------------------
if [ -z "${ANDROID_SERIAL:-}" ]; then
  mapfile -t devices < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')
  if [ "${#devices[@]}" -eq 0 ] && [ -x "$PROJECT_DIR/../../env-setup/adb-wifi-connect.sh" ]; then
    echo "No device connected. Trying to reconnect over Wi-Fi..."
    bash "$PROJECT_DIR/../../env-setup/adb-wifi-connect.sh" || true
    mapfile -t devices < <(adb devices | awk 'NR>1 && $2=="device" {print $1}')
  fi
  case "${#devices[@]}" in
    0) echo "No device or emulator attached." >&2; exit 1 ;;
    1) export ANDROID_SERIAL="${devices[0]}" ;;
    *) echo "Several devices attached (${devices[*]}); set ANDROID_SERIAL." >&2; exit 1 ;;
  esac
fi
echo "==> Target: $ANDROID_SERIAL"

# --- stub library server ----------------------------------------------------
if [ "$STUB" = 1 ]; then
  if curl -sf -o /dev/null --max-time 2 "http://localhost:$STUB_PORT/api/library?limit=1"; then
    echo "==> Stub server already up on :$STUB_PORT"
  else
    echo "==> Starting stub server on :$STUB_PORT"
    nohup python3 "$PROJECT_DIR/tools/stub_server.py" --samples --port "$STUB_PORT" --token devtoken \
      >/tmp/listenalong-stub.log 2>&1 &
    for _ in $(seq 1 40); do
      curl -sf -o /dev/null --max-time 1 "http://localhost:$STUB_PORT/api/library?limit=1" && break
      sleep 0.25
    done
  fi
  adb reverse "tcp:$STUB_PORT" "tcp:$STUB_PORT" >/dev/null
  echo "==> Tunnel: device localhost:$STUB_PORT -> stub server (token: devtoken)"
fi

# --- build, install, launch -------------------------------------------------
"$PROJECT_DIR/gradlew" -p "$PROJECT_DIR" :app:installDebug

adb shell am force-stop "$APP_ID"
adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
echo "==> Launched $APP_ID"

if [ "$LOGS" = 1 ]; then
  PID="$(adb shell pidof "$APP_ID" | tr -d '\r')"
  echo "==> Tailing logcat for pid $PID (Ctrl-C to stop)"
  adb logcat --pid="$PID"
fi
