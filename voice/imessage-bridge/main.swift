// imessage-bridge: forwards iMessages you send to YOURSELF to the local second-brain server.
// It reads ~/Library/Messages/chat.db read-only (this binary alone gets Full Disk Access),
// accepts only the one-person self-chat for --handle, and POSTs {"text": ...} to
// <server>/imessage/incoming with an X-Bridge-Token header. The server answers and replies.
// Message text is never logged.
import Foundation
import SQLite3

func log(_ s: String) { FileHandle.standardError.write("\(ISO8601DateFormatter().string(from: Date())) \(s)\n".data(using: .utf8)!) }
func fail(_ s: String) -> Never { log("error: \(s)"); exit(1) }

// ---- Config ----
let home = FileManager.default.homeDirectoryForCurrentUser.path
let configDir = "\(home)/.config/hey-my-brain"
var opts: [String: String] = [:]
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let key = args.removeFirst()
    guard key.hasPrefix("--"), !args.isEmpty else { fail("usage: imessage-bridge --handle <phone|email> [--server URL] [--token-file PATH]") }
    opts[String(key.dropFirst(2))] = args.removeFirst()
}
let env = ProcessInfo.processInfo.environment
guard let handle = opts["handle"] ?? env["IMESSAGE_HANDLE"], !handle.isEmpty else { fail("--handle is required") }
let server = opts["server"] ?? env["BRAIN_SERVER"] ?? "http://127.0.0.1:3001"
let tokenFile = opts["token-file"] ?? "\(configDir)/imessage.token"
let stateFile = opts["state-file"] ?? "\(configDir)/imessage.state"   // hidden, for tests
let dbPath = opts["db"] ?? "\(home)/Library/Messages/chat.db"            // hidden, for tests

// Message text may contain patient info: only ever send it to this machine.
guard let endpoint = URL(string: server + "/imessage/incoming"),
      ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? "") else { fail("--server must be a loopback URL") }

// ---- Handle matching: emails case-insensitive, phone numbers by digits ----
func sameHandle(_ a: String, _ b: String) -> Bool {
    let ca = a.filter { $0 != " " && $0 != "-" }, cb = b.filter { $0 != " " && $0 != "-" }
    if ca.contains("@") || cb.contains("@") { return ca.lowercased() == cb.lowercased() }
    let da = ca.filter { $0.isASCII && $0.isNumber }, db = cb.filter { $0.isASCII && $0.isNumber }
    return !da.isEmpty && da == db
}

// ---- attributedBody (typedstream NSAttributedString) decoding ----
func decodeAttributedBody(_ data: Data) -> String? {
    if let s = (NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString)?.string { return s }
    // Fallback: the UTF-8 string follows "NSString" + 5 bytes, prefixed by a length (0x81 = 2-byte LE length).
    let bytes = [UInt8](data), marker = [UInt8]("NSString".utf8)
    guard let start = (0...max(0, bytes.count - marker.count)).first(where: { Array(bytes[$0..<min(bytes.count, $0 + marker.count)]) == marker })
    else { return nil }
    var i = start + marker.count + 5
    guard i < bytes.count else { return nil }
    var len = Int(bytes[i]); i += 1
    if len == 0x81 { guard i + 2 <= bytes.count else { return nil }; len = Int(bytes[i]) | Int(bytes[i + 1]) << 8; i += 2 }
    guard i + len <= bytes.count else { return nil }
    return String(bytes: bytes[i..<i + len], encoding: .utf8)
}

// ---- State (last ROWID seen) ----
try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
func saveState(_ id: Int64) {
    try? String(id).write(toFile: stateFile, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateFile)
}

// ---- Database ----
func withDB<T>(_ body: (OpaquePointer) -> T) -> T? {
    var db: OpaquePointer?
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
        log("error: cannot open chat.db read-only (Full Disk Access granted to this binary?)"); sqlite3_close(db); return nil
    }
    defer { sqlite3_close(db) }
    return body(db)
}
func maxRowID() -> Int64? {
    withDB { db -> Int64? in
        var st: OpaquePointer?
        defer { sqlite3_finalize(st) }
        guard sqlite3_prepare_v2(db, "SELECT IFNULL(MAX(ROWID), 0) FROM message", -1, &st, nil) == SQLITE_OK, sqlite3_step(st) == SQLITE_ROW else { return nil }
        return sqlite3_column_int64(st, 0)
    } ?? nil
}

// One row per (message, chat). Chats with exactly one participant also return that participant's id.
let newMessagesSQL = """
SELECT m.ROWID, m.text, m.attributedBody, c.chat_identifier,
       (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID),
       (SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID LIMIT 1)
FROM message m
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ? ORDER BY m.ROWID
"""
func columnText(_ st: OpaquePointer?, _ i: Int32) -> String? { sqlite3_column_text(st, i).map { String(cString: $0) } }

// ---- Forwarding ----
func post(_ text: String) {
    guard let token = try? String(contentsOfFile: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty
    else { log("error: token file missing or empty: \(tokenFile)"); return }
    if let mode = (try? FileManager.default.attributesOfItem(atPath: tokenFile))?[.posixPermissions] as? Int, mode & 0o077 != 0 {
        log("error: token file must be mode 0600; refusing to use it"); return
    }
    var req = URLRequest(url: endpoint, timeoutInterval: 300)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(token, forHTTPHeaderField: "X-Bridge-Token")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, resp, err in
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code != 200 { log("error: server returned \(code)\(err.map { " (\($0.localizedDescription))" } ?? "")") }
        done.signal()
    }.resume()
    done.wait()
}

// ---- Main loop ----
var lastID: Int64
if let s = try? String(contentsOfFile: stateFile, encoding: .utf8), let v = Int64(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
    lastID = v
} else {
    guard let m = maxRowID() else { fail("cannot read chat.db") }
    lastID = m; saveState(m)   // first start: never answer old history
}
log("imessage-bridge started (watching self-chat, last ROWID \(lastID))")
var recent: [String: Date] = [:]   // de-dup: self-messages can arrive as sent + received copies

while true {
    var texts: [String] = []   // collect first, post after closing chat.db (don't hold a read lock while the server thinks)
    withDB { db in
        var st: OpaquePointer?
        defer { sqlite3_finalize(st) }
        guard sqlite3_prepare_v2(db, newMessagesSQL, -1, &st, nil) == SQLITE_OK else { log("error: query failed: \(String(cString: sqlite3_errmsg(db)))"); return }
        sqlite3_bind_int64(st, 1, lastID)
        while sqlite3_step(st) == SQLITE_ROW {
            let id = sqlite3_column_int64(st, 0)
            if id > lastID { lastID = id; saveState(id) }   // advance first, so a bad row can't wedge the bridge
            guard let chatID = columnText(st, 3), sameHandle(chatID, handle),
                  sqlite3_column_int64(st, 4) == 1, let member = columnText(st, 5), sameHandle(member, handle) else { continue }
            var text = columnText(st, 1)
            if text == nil, let blob = sqlite3_column_blob(st, 2) {
                text = decodeAttributedBody(Data(bytes: blob, count: Int(sqlite3_column_bytes(st, 2))))
            }
            if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, !t.hasPrefix("🧠") { texts.append(t) }
        }
    }
    for t in texts {
        let now = Date()
        recent = recent.filter { now.timeIntervalSince($0.value) < 15 }
        if recent[t] != nil { continue }
        recent[t] = now
        log("received message (\(t.count) chars)")
        post(t)
    }
    sleep(3)
}
