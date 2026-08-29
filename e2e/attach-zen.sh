#!/usr/bin/env bash
# Relaunch Zen with the DevTools remote-debugger server on :6000 so the RDP harness
# (foxdriver) can attach to a fully-trusted (navigator.webdriver===false) real browser.
# The managed user.js is a nix-store symlink; we temporarily swap it for a writable copy
# that adds the three debugger prefs, then restore the symlink on exit.
set -euo pipefail
PROF="$HOME/.config/zen/default"
UJS="$PROF/user.js"
PORT=6000

if pgrep -f 'zen-bin-1.21' >/dev/null 2>&1; then
  echo "Zen is still running — quit it fully first (all windows), then re-run this."; exit 1
fi

# swap the store symlink for a writable copy + debugger prefs
if [ -L "$UJS" ]; then
  STORE_TARGET="$(readlink -f "$UJS")"
  echo "$STORE_TARGET" > /tmp/ytu-userjs-symlink-target
  rm "$UJS"
  cp "$STORE_TARGET" "$UJS"
  chmod u+w "$UJS"
fi
if ! grep -q 'devtools.debugger.remote-enabled' "$UJS"; then
  cat >> "$UJS" <<'EOF'

// --- ytu debug (temporary; remove + restore symlink after) ---
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.debugger.force-local", true);
EOF
fi

echo "Launching Zen with debugger server on :$PORT ..."
echo "After it opens: about:debugging -> Load Temporary Add-on -> ~/projects/yt-untrack/manifest.json, then open the video."
zen-beta -no-remote --start-debugger-server "$PORT" >/tmp/ytu-zen.log 2>&1 &
echo "launched pid $!  (log: /tmp/ytu-zen.log)"
