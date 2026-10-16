#!/bin/sh
# Installs WordCraft (github.com/storytold/wordcraft, MIT OR Apache-2.0) for second-brain/wordcraft.js:
# builds its browser app (WebAssembly) at a pinned commit with voice/wordcraft-bridge.patch, which adds
# window.wordcraftBridge so the page can read the selection and run WordCraft commands.
# Output: second-brain/vendor/wordcraft/. Needs git, Homebrew rustup and trunk (brew install rustup trunk).
# The Rust toolchain and build cache live in ~/Library/Caches/wordcraft-build (your own Rust is untouched).
set -eu
COMMIT="eae242176108d328c5dd81fbc10370c51ab90706"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/second-brain/vendor/wordcraft"
CACHE="$HOME/Library/Caches/wordcraft-build"
export RUSTUP_HOME="$CACHE/rustup" CARGO_HOME="$CACHE/cargo" CARGO_TARGET_DIR="$CACHE/target" RUSTUP_TOOLCHAIN=stable
export PATH="$(brew --prefix rustup)/bin:$PATH"
rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown
SRC="$CACHE/src"
if [ ! -d "$SRC/.git" ]; then git clone -q https://github.com/storytold/wordcraft.git "$SRC"; fi
git -C "$SRC" fetch -q origin "$COMMIT" 2>/dev/null || git -C "$SRC" fetch -q origin
git -C "$SRC" checkout -q -f "$COMMIT"
git -C "$SRC" clean -fdq apps/wordcraft-web
git -C "$SRC" apply "$ROOT/voice/wordcraft-bridge.patch"
(cd "$SRC/apps/wordcraft-web" && trunk build --release)
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SRC/dist/web/." "$OUT/"
echo "Built $OUT"
