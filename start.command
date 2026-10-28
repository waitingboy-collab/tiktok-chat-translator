#!/bin/bash
# Double-click this file on a Mac to start the translator.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Download the LTS version from https://nodejs.org , install it, then double-click start.command again."
  echo
  open "https://nodejs.org/en/download" 2>/dev/null
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo
  echo "  Installing — first run only, about a minute..."
  npm install --no-fund --no-audit || { echo "  npm install failed — check your internet connection."; read -n 1 -s -r; exit 1; }
fi

[ -f .env ] || cp .env.example .env

OPEN_BROWSER=1 node server.js
