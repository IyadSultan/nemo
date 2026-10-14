#!/bin/sh
# Build the calendar helper. Info.plist is embedded so macOS can ask for Calendar access.
# After a rebuild, macOS may ask again. Click Allow.
set -e
cd "$(dirname "$0")"
/usr/bin/swiftc -O main.swift -o calendar-attendees \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
echo "built $(pwd)/calendar-attendees"
