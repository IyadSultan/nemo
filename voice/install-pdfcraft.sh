#!/bin/sh
# Installs PDFCraft's tools (github.com/PDFCraftTool/pdfcraft, AGPL-3.0) for second-brain/pdftools.js:
# bundles its pdf-lib processors (voice/pdfcraft-entry.ts) into second-brain/vendor/pdfcraft-tools.mjs.
# Fetches only src/lib/pdf, src/lib/utils and src/types at a pinned commit. Also installs pdf2docx
# (PDF to Word) in voice/pdf2docx-venv. Needs git, npx and python3.
set -eu
COMMIT="a99a52d60f5a9c30ba0f5c0d8d8fc1b69ecb6793"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/second-brain/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$VENDOR"

git clone -q --filter=blob:none --no-checkout https://github.com/PDFCraftTool/pdfcraft.git "$WORK/src"
git -C "$WORK/src" sparse-checkout set --no-cone /src/lib/pdf /src/lib/utils /src/types
git -C "$WORK/src" checkout -q "$COMMIT"
npx --yes esbuild@0.24.0 "$ROOT/voice/pdfcraft-entry.ts" --bundle --platform=node --format=esm \
  --alias:@="$WORK/src/src" --external:pdf-lib --external:@pdf-lib/fontkit --external:pdfjs-dist \
  --external:./word-to-pdf --external:./excel-to-pdf --external:./pptx-to-pdf \
  --log-level=warning --outfile="$VENDOR/pdfcraft-tools.mjs"
echo "Built $VENDOR/pdfcraft-tools.mjs"


# PDF to Word (pdf2docx, the converter PDFCraft runs in the browser) in its own Python environment.
python3 -m venv "$ROOT/voice/pdf2docx-venv"
"$ROOT/voice/pdf2docx-venv/bin/pip" install -q pdf2docx
echo "Installed pdf2docx in $ROOT/voice/pdf2docx-venv"
