#!/bin/bash
# Builds "Live Chat Translator.app" (Node.js included — nothing to install) and a ZIP of it.
# Runs on macOS or Linux. Needs Node.js + npm only on the machine that builds it.
#   bash mac/build-mac-app.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-22.23.4}"
OUT="$ROOT/dist"
APP="$OUT/Live Chat Translator.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "• Building $APP (Node $NODE_VERSION)"
rm -rf "$APP" "$OUT/Live-Chat-Translator-mac.zip"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/node"

cp "$ROOT/mac/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp "$ROOT/mac/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/mac/launcher.sh" "$APP/Contents/MacOS/LiveChatTranslator"
chmod 755 "$APP/Contents/MacOS/LiveChatTranslator"

# The translator itself
cp -R "$ROOT/server.js" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$APP/Contents/Resources/app/"
(cd "$APP/Contents/Resources/app" && npm ci --omit=dev --no-fund --no-audit --ignore-scripts --silent)

# Official, signed Node.js binaries for Apple Silicon and Intel Macs (from npm)
(cd "$TMP" && npm pack "node-bin-darwin-arm64@$NODE_VERSION" "node-darwin-x64@$NODE_VERSION" --silent >/dev/null)
tar -xzf "$TMP/node-bin-darwin-arm64-$NODE_VERSION.tgz" -C "$TMP" package/bin/node && mv "$TMP/package/bin/node" "$APP/Contents/Resources/node/node-arm64"
tar -xzf "$TMP/node-darwin-x64-$NODE_VERSION.tgz" -C "$TMP" package/bin/node && mv "$TMP/package/bin/node" "$APP/Contents/Resources/node/node-x64"
chmod 755 "$APP/Contents/Resources/node/"*

# ZIP that keeps the executable permissions
cd "$OUT"
if command -v ditto >/dev/null; then
  ditto -c -k --keepParent "Live Chat Translator.app" "Live-Chat-Translator-mac.zip"
else
  zip -qry "Live-Chat-Translator-mac.zip" "Live Chat Translator.app"
fi
echo "• Done: $OUT/Live-Chat-Translator-mac.zip ($(du -h "Live-Chat-Translator-mac.zip" | cut -f1))"
