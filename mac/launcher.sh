#!/bin/bash
# Live Chat Translator — Mac app launcher.
# Starts the bundled Node.js server and opens the translator in its own window.
# The server quits by itself about 30 seconds after the window is closed.

RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
PORT=3030
URL="http://localhost:$PORT"
LOG="$HOME/Library/Logs/LiveChatTranslator.log"
mkdir -p "$HOME/Library/Logs"

if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  NODE="$RES/node/node-arm64"
else
  NODE="$RES/node/node-x64"
fi

open_window() {
  # Prefer an app-style window (no tabs/address bar) in Chrome, Edge or Brave; otherwise the default browser.
  for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
    for dir in "/Applications" "$HOME/Applications"; do
      if [ -d "$dir/$app.app" ]; then
        open -na "$dir/$app.app" --args --app="$URL" --window-size=1000,820 && return
      fi
    done
  done
  open "$URL"
}

running() { curl -fsS --max-time 1 "$URL/health" >/dev/null 2>&1; }

# Already running (e.g. opened twice) — just show the window.
if running; then open_window; exit 0; fi

if [ ! -x "$NODE" ]; then chmod +x "$NODE" 2>/dev/null; fi

cd "$RES/app" || exit 1
echo "---- $(date) start ($(uname -m))" >>"$LOG"
APP_MODE=1 PORT=$PORT HOST=127.0.0.1 "$NODE" server.js >>"$LOG" 2>&1 &
SERVER=$!

for _ in $(seq 1 75); do
  running && break
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 0.2
done

if ! running; then
  osascript -e 'display alert "Live Chat Translator could not start" message "Details are in ~/Library/Logs/LiveChatTranslator.log" as critical' >/dev/null 2>&1
  kill "$SERVER" 2>/dev/null
  exit 1
fi

open_window
wait "$SERVER"
