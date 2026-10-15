// swift make_icon.swift <out.png> <full|brain>
// full:  full-bleed square art; macOS 26 rounds it into the app icon shape.
// brain: the brain alone on transparent, for the Desktop shortcut.
import AppKit
let out = CommandLine.arguments[1]
let full = CommandLine.arguments[2] == "full"
let img = NSImage(size: NSSize(width: 1024, height: 1024))
img.lockFocus()
if full {
    NSGradient(starting: NSColor(calibratedRed: 1.0, green: 0.94, blue: 0.95, alpha: 1),
               ending: NSColor(calibratedRed: 0.98, green: 0.80, blue: 0.85, alpha: 1))!
        .draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024), angle: -90)
}
let brain = NSAttributedString(string: "🧠", attributes: [.font: NSFont.systemFont(ofSize: full ? 700 : 820)])
let b = brain.size()
brain.draw(at: NSPoint(x: (1024 - b.width) / 2, y: (1024 - b.height) / 2 + 20))
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
