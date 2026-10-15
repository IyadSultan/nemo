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

# Rust front (rust/src/bin/brain.rs) on 3001 answers what is already in Rust
# and passes the rest to Node on 3002. To go back to Node alone:
#   touch "$ROOT/.node-only" && launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain
FRONT="$ROOT/rust/target/release/brain"
if [ ! -x "$FRONT" ] || [ -f "$ROOT/.node-only" ]; then
  exec "$NODE" second-brain/server.js
fi

BRAIN_PORT=3002 "$NODE" second-brain/server.js &
NODE_PID=$!
BRAIN_PORT=3001 NODE_URL=http://127.0.0.1:3002 "$FRONT" &
FRONT_PID=$!
trap 'kill $NODE_PID $FRONT_PID 2>/dev/null' EXIT

# If either stops, stop both; launchd (KeepAlive) then starts them again.
while kill -0 $NODE_PID 2>/dev/null && kill -0 $FRONT_PID 2>/dev/null; do
  sleep 2
done
exit 1
