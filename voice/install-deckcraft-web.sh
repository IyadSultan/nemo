#!/bin/sh
# Installs DeckCraft (github.com/storytold/deckcraft, MIT OR Apache-2.0) for second-brain/deckweb.js:
# builds its browser app (WebAssembly) at a pinned commit with voice/deckcraft-bridge.patch, which adds
# window.deckcraftBridge so the page can run DeckCraft commands and save the deck,
# and keeps the engine from asking for a process id (it panics in the browser).
# Output: second-brain/vendor/deckcraft/. Needs git, Homebrew rustup and trunk (brew install rustup trunk).
# The Rust toolchain and build cache live in ~/Library/Caches/deckcraft-build (your own Rust is untouched).
set -eu
COMMIT="1dc69720db64323370dda061226becb09ad79fd4"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/second-brain/vendor/deckcraft"
CACHE="$HOME/Library/Caches/deckcraft-build"
export RUSTUP_HOME="$CACHE/rustup" CARGO_HOME="$CACHE/cargo" CARGO_TARGET_DIR="$CACHE/target" RUSTUP_TOOLCHAIN=stable
export PATH="$(brew --prefix rustup)/bin:$PATH"
rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown
SRC="$CACHE/src"
if [ ! -d "$SRC/.git" ]; then git clone -q https://github.com/storytold/deckcraft.git "$SRC"; fi
git -C "$SRC" fetch -q origin "$COMMIT" 2>/dev/null || git -C "$SRC" fetch -q origin
git -C "$SRC" checkout -q -f "$COMMIT"
git -C "$SRC" clean -fdq apps/deckcraft-web crates/engine
git -C "$SRC" apply "$ROOT/voice/deckcraft-bridge.patch"
(cd "$SRC/apps/deckcraft-web" && trunk build --release)
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC/dist/web/." "$OUT/"
echo "Built $OUT"
