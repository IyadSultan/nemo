#!/bin/sh
# Build the iMessage bridge. Re-grant Full Disk Access after every rebuild (the binary's signature changes).
set -e
cd "$(dirname "$0")"
/usr/bin/swiftc -O main.swift -o imessage-bridge
echo "built $(pwd)/imessage-bridge"
