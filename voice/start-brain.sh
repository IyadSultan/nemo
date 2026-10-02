#!/bin/bash
# Starts the second-brain app. macOS runs this when you log in.
# OneDrive can take a little while to appear after login, so we wait for the notes folder.

WIKI="/Users/USER/Library/CloudStorage/OneDrive-KingHusseinCancerCenter/2nd_brain/wiki"
NODE="/opt/homebrew/bin/node"
ROOT="/Users/USER/code/talk_to_your_brain"

for _ in $(seq 1 60); do
  if [ -d "$WIKI" ]; then
    break
  fi
  sleep 2
done

cd "$ROOT" || exit 1
exec "$NODE" second-brain/server.js
