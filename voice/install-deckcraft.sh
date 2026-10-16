#!/bin/sh
# Installs the DeckCraft CLI (github.com/storytold/deckcraft), which second-brain/deckcraft.js
# uses to build PowerPoint files. Downloads the signed macOS release, checks its SHA-256,
# and puts deckcraft-cli in ~/.local/bin. Needs the gh CLI.
set -eu
VERSION="${1:-v0.7.0}"
NAME="deckcraft-cli-${VERSION#v}-macos-universal"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gh release download "$VERSION" -R storytold/deckcraft -p "$NAME.zip" -p SHA256SUMS.txt -D "$WORK"
(cd "$WORK" && grep " $NAME.zip\$" SHA256SUMS.txt | shasum -a 256 -c -)
unzip -q "$WORK/$NAME.zip" -d "$WORK"
mkdir -p "$HOME/.local/bin"
install -m 755 "$WORK/$NAME/deckcraft-cli" "$HOME/.local/bin/deckcraft-cli"
"$HOME/.local/bin/deckcraft-cli" --version
