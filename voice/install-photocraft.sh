#!/bin/sh
# Installs PhotoCraft (github.com/storytold/photocraft, MIT OR Apache-2.0) for photo edits:
# the browser editor (official web build) and the command-line tool that runs the same
# engine for one-step changes (rotate, brighter, black and white, and so on).
# Output: second-brain/vendor/photocraft/  (not in git).
set -eu
VER="0.9.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/second-brain/vendor/photocraft"
CACHE="${HOME}/Library/Caches/photocraft-build"
mkdir -p "$CACHE"
WEB_ZIP="$CACHE/photocraft-web-${VER}.zip"
CLI_ZIP="$CACHE/photocraft-cli-${VER}-macos-universal.zip"
BASE="https://github.com/storytold/photocraft/releases/download/v${VER}"
# Download to a .part file first, so a broken download is not kept as the real one.
fetch() {
  if [ ! -s "$1" ]; then
    curl -fL --retry 3 -o "$1.part" "$2"
    mv "$1.part" "$1"
  fi
}
fetch "$WEB_ZIP" "$BASE/photocraft-web-${VER}.zip"
fetch "$CLI_ZIP" "$BASE/photocraft-cli-${VER}-macos-universal.zip"
rm -rf "$OUT"
mkdir -p "$OUT/web" "$OUT/bin"
rm -rf "$CACHE/unpack-web"
unzip -q -o "$WEB_ZIP" -d "$CACHE/unpack-web"
cp -R "$CACHE/unpack-web/photocraft-web-${VER}/." "$OUT/web/"
rm -rf "$CACHE/unpack-web"
unzip -q -o -j "$CLI_ZIP" "photocraft-cli-${VER}-macos-universal/photocraft-cli" -d "$OUT/bin"
chmod +x "$OUT/bin/photocraft-cli"
# macOS will not run a downloaded tool until this mark is removed.
xattr -d com.apple.quarantine "$OUT/bin/photocraft-cli" 2>/dev/null || true
cp "$ROOT/voice/photocraft-bridge.js" "$OUT/web/photocraft-bridge.js"
python3 - "$OUT/web/index.html" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
tag = '<script src="./photocraft-bridge.js"></script>\n'
if "photocraft-bridge.js" not in text:
    needle = "<script type=\"module\">"
    if needle not in text:
        raise SystemExit("PhotoCraft's page has no module script to attach to")
    text = text.replace(needle, tag + needle, 1)
    path.write_text(text)
PY
echo "Installed PhotoCraft ${VER} in $OUT"
