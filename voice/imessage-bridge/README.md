# imessage-bridge

Text your second brain from your phone: send an iMessage **to yourself**, and the brain replies in the same thread (replies start with 🧠).

This small binary is the only thing that gets Full Disk Access. It reads `~/Library/Messages/chat.db` read-only every 3 s, keeps only new messages in your one-person self-chat (no other senders, no group chats), and POSTs `{"text": ...}` to `http://127.0.0.1:3001/imessage/incoming` with an `X-Bridge-Token` header. The Node server writes the answer and sends the reply. The bridge never sends messages and never logs message text.

## Build

    ./build.sh

## Grant Full Disk Access (to this binary only)

System Settings → Privacy & Security → Full Disk Access → **+** → pick `voice/imessage-bridge/imessage-bridge` (press Cmd-Shift-G to type the path). Repeat after every rebuild, because the binary's signature changes.

## Install as a login service

    sed -e "s|__HOME__|$HOME|g" -e "s|__HANDLE__|+15551234567|g" \
      com.heymybrain.imessage-bridge.plist > ~/Library/LaunchAgents/com.heymybrain.imessage-bridge.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.heymybrain.imessage-bridge.plist

Use your handle as Messages shows it (for a phone number, the full international form with country code). Phone numbers are compared by digits and emails case-insensitively.

Logs: `~/Library/Logs/hey-my-brain-imessage.log`. To stop it: `launchctl bootout gui/$(id -u)/com.heymybrain.imessage-bridge`.

## Notes

- The Node server must be running, and it creates the token at `~/.config/hey-my-brain/imessage.token` (mode 0600). The bridge refuses a token file that other users can read.
- The first time the server sends a reply, macOS asks for permission to let it control **Messages** (Automation). Allow it.
- On first start the bridge skips all existing history. Its position is saved in `~/.config/hey-my-brain/imessage.state`.
- `--server` must be a loopback address, so message text never leaves this Mac.
- If the server is down when a message arrives, that message is dropped. Send it again.
