#!/bin/bash
# Builds "Second Brain.app" (the window app) into /Applications.
# It owns the ".secondbrain" file type, so a Desktop file with a brain-only icon opens it.
# (macOS 26 forces app icons into a tile, and refuses custom links in .webloc files.)
# Usage: rust/window/bundle.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Second Brain.app"
# Cursor sometimes points Cargo at a temporary folder. The app must be built
# into this project's target directory, which is the file copied below.
unset CARGO_TARGET_DIR
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cargo build --release --manifest-path "$HERE/Cargo.toml"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/target/release/second-brain" "$APP/Contents/MacOS/second-brain"

swift "$HERE/make_icon.swift" "$WORK/icon.png" full
mkdir "$WORK/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Second Brain</string>
  <key>CFBundleDisplayName</key><string>Second Brain</string>
  <key>CFBundleIdentifier</key><string>com.iyad.second-brain</string>
  <key>CFBundleExecutable</key><string>second-brain</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Second Brain shortcut</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Owner</string>
    <key>LSItemContentTypes</key><array><string>com.iyad.second-brain.shortcut</string></array>
  </dict></array>
  <key>UTExportedTypeDeclarations</key>
  <array><dict>
    <key>UTTypeIdentifier</key><string>com.iyad.second-brain.shortcut</string>
    <key>UTTypeDescription</key><string>Second Brain shortcut</string>
    <key>UTTypeConformsTo</key><array><string>public.data</string></array>
    <key>UTTypeTagSpecification</key><dict>
      <key>public.filename-extension</key><array><string>secondbrain</string></array>
    </dict>
  </dict></array>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>Second Brain</string>
    <key>CFBundleURLSchemes</key><array><string>secondbrain</string></array>
  </dict></array>
  <key>NSMicrophoneUsageDescription</key><string>The second brain listens when you talk to it.</string>
  <key>NSCameraUsageDescription</key><string>The second brain takes photos for meeting notes when you ask.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>The second brain turns your speech into text.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
touch "$APP"
echo "Built $APP"
