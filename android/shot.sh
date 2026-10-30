#!/usr/bin/env bash
# Screenshot the device ONLY when Listen Along is the focused app, so a
# capture can never pick up whatever else happens to be on screen.
#
#   ./shot.sh [output.png]          (ANDROID_SERIAL picks the device)
set -euo pipefail

APP_ID=com.erkantaylan.listenalong.debug
OUT="${1:-/tmp/listenalong-shot.png}"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

focus="$(adb shell dumpsys window | grep -m1 'mCurrentFocus' || true)"
if ! grep -q "$APP_ID" <<<"$focus"; then
  echo "Refusing to capture: $APP_ID is not the focused window." >&2
  echo "Focused: ${focus#*mCurrentFocus=}" >&2
  exit 1
fi

adb exec-out screencap -p > "$OUT"
echo "$OUT ($(stat -c%s "$OUT") bytes)"
