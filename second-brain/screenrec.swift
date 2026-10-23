// Records the whole screen, the sound other apps play (a Zoom call), and the
// microphone, into one video file. The Second Brain window starts this program,
// so macOS allows the recording (the same permission as Snapshot). Press Stop
// and Second Brain sends a stop signal. A pipe input also stops it when the
// pipe closes.
//
// Built by screen.js: clang screenbounce.m, then swiftc with AppKit.

import AppKit
import AVFoundation
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit
import Speech

// Implemented in screenbounce.m. See that file for why it exists.
@_silgen_name("skipRecordingMenuDot")
func skipRecordingMenuDot()

/// One recording. Kept alive until the process exits.
final class Recorder: NSObject, SCStreamDelegate, SCRecordingOutputDelegate, SCStreamOutput {
    private var stream: SCStream?
    private var output: SCRecordingOutput?
    private let stopLock = NSLock()
    private var stopping = false
    private var failed = false
    // macOS closes the file a moment after stopCapture returns. Quitting before that leaves a video no player can open.
    private var finished = false
    // Live words while it records: the app sound and the microphone are added together
    // at 16 kHz mono, and every tenth of a second the settled part goes to Apple's
    // on-device listener, which prints each result as one JSON line for Second Brain.
    var lang = "en"
    private var mix = [Int16]()
    private var mixBase = 0
    private var sent = 0
    private var liveStart = -1.0
    private let liveQueue = DispatchQueue(label: "screenrec.live")
    private var captioner: Captioner?
    private var feeder: DispatchSourceTimer?

    /// Run one step on the main thread. ScreenCaptureKit draws a menu-bar dot,
    /// and that crashes if AppKit was never started on the main thread.
    private func onMain(_ work: @escaping @MainActor () async throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            DispatchQueue.main.async {
                Task { @MainActor in
                    do {
                        try await work()
                        done.resume()
                    } catch {
                        done.resume(throwing: error)
                    }
                }
            }
        }
    }

    /// Start writing to `url`. Tries the microphone, and if macOS blocks only
    /// the microphone, records the screen and Zoom sound without it.
    func start(url: URL) async throws {
        try await onMain {
            _ = NSApplication.shared
            // No Dock icon. The Screen button in Second Brain is the control.
            // The menu-bar recording dot is turned off in screenbounce.m because
            // it crashes on this version of macOS.
            NSApp.setActivationPolicy(.accessory)
            skipRecordingMenuDot()
        }
        do {
            try await onMain { try await self.begin(url: url, withMic: true) }
        } catch {
            let code = (error as NSError).code
            // -3820 is SCStreamErrorFailedToStartMicrophoneCapture.
            if code == -3820 {
                fputs("Microphone was not allowed. Recording the screen and the sound from other apps only.\n", stderr)
                try await onMain { try await self.begin(url: url, withMic: false) }
            } else {
                throw error
            }
        }
    }

    private func begin(url: URL, withMic: Bool) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw RecorderError.message("No screen was found to record.")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let scale = max(1, Double(filter.pointPixelScale))
        let (width, height) = fit(Int((Double(display.width) * scale).rounded()), Int((Double(display.height) * scale).rounded()))

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.showsCursor = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        // Skip this app's own beeps. Zoom is a different app, so its sound stays.
        config.excludesCurrentProcessAudio = true
        config.captureMicrophone = withMic

        let file = SCRecordingOutputConfiguration()
        file.outputURL = url
        file.outputFileType = .mp4
        file.videoCodecType = .h264

        let recording = SCRecordingOutput(configuration: file, delegate: self)
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addRecordingOutput(recording)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: liveQueue)
        if withMic { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: liveQueue) }
        try await stream.startCapture()
        self.stream = stream
        self.output = recording
        startCaptions()
    }

    /// Open the listener in the background; the first language needs a download once.
    private func startCaptions() {
        let feeder = DispatchSource.makeTimerSource(queue: liveQueue)
        feeder.schedule(deadline: .now(), repeating: .milliseconds(100))
        feeder.setEventHandler { [weak self] in self?.pump() }
        feeder.resume()
        self.feeder = feeder
        Task {
            do {
                let captioner = try await Captioner(lang: lang)
                liveQueue.async { self.captioner = captioner }
            } catch {
                Captioner.note("The live words are off: \(error.localizedDescription)")
            }
        }
    }

    /// Send the settled sound to the listener. Runs on liveQueue.
    private func pump() {
        guard let captioner else {
            // Still opening: keep the last minute only.
            if mix.count > 16000 * 120 {
                let drop = mix.count - 16000 * 60
                mix.removeFirst(drop)
                mixBase += drop
            }
            return
        }
        let settled = mix.count - 3200
        guard settled > sent else { return }
        captioner.feed(mix[sent..<settled])
        sent = settled
        if sent > 160000 {
            mix.removeFirst(sent)
            mixBase += sent
            sent = 0
        }
    }

    /// Fit the picture inside 1920 on the long side, with even numbers (the
    /// video format requires that). A full retina frame would make an hour-long
    /// Zoom file enormous.
    private func fit(_ width: Int, _ height: Int) -> (Int, Int) {
        let longSide = max(width, height, 2)
        let scale = longSide > 1920 ? 1920.0 / Double(longSide) : 1
        var outW = Int((Double(max(width, 2)) * scale).rounded(.down))
        var outH = Int((Double(max(height, 2)) * scale).rounded(.down))
        if outW % 2 != 0 { outW -= 1 }
        if outH % 2 != 0 { outH -= 1 }
        return (max(outW, 2), max(outH, 2))
    }

    /// True the first time Stop is asked. Later calls do nothing.
    private func beginStop() -> Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        if stopping || failed { return false }
        stopping = true
        return true
    }

    func stop() async {
        if !beginStop() { return }
        feeder?.cancel()
        do {
            try await stream?.stopCapture()
        } catch {
            fputs("Could not stop cleanly: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
        // The last words.
        let captioner = liveQueue.sync { () -> Captioner? in
            guard let captioner = self.captioner else { return nil }
            captioner.feed(mix[sent...])
            sent = mix.count
            return captioner
        }
        await captioner?.finish()
        for _ in 0..<300 where !fileClosed() {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        print("saved")
        fflush(stdout)
        exit(0)
    }

    /// The sound of one buffer as mono samples between -1 and 1, at the buffer's own rate.
    private func monoSamples(_ buffer: CMSampleBuffer) -> [Float] {
        guard let description = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return [] }
        let frames = CMSampleBufferGetNumSamples(buffer)
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        guard frames > 0, isFloat || asbd.mBitsPerChannel == 16 else { return [] }
        var mono = [Float](repeating: 0, count: frames)
        try? buffer.withAudioBufferList { list, _ in
            for (index, chunk) in list.enumerated() {
                guard let data = chunk.mData else { continue }
                let perFrame = planar ? 1 : channels
                let count = min(frames, Int(chunk.mDataByteSize) / (isFloat ? 4 : 2) / perFrame)
                if planar && index >= channels { break }
                for i in 0..<count {
                    var sum: Float = 0
                    for c in 0..<perFrame {
                        let at = i * perFrame + c
                        sum += isFloat ? data.assumingMemoryBound(to: Float.self)[at] : Float(data.assumingMemoryBound(to: Int16.self)[at]) / 32768
                    }
                    mono[i] += sum / Float(channels)
                }
            }
        }
        return mono
    }

    /// Each sound buffer lands in the mix at its own time, so the microphone adds onto the app sound.
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio || type == .microphone, CMSampleBufferDataIsReady(buffer) else { return }
        let mono = monoSamples(buffer)
        guard !mono.isEmpty, let description = CMSampleBufferGetFormatDescription(buffer),
              let rate = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee.mSampleRate, rate >= 16000 else { return }
        let step = max(1, Int((rate / 16000).rounded()))
        var fresh = [Int16]()
        fresh.reserveCapacity(mono.count / step)
        var i = 0
        while i + step <= mono.count {
            var sum: Float = 0
            for j in 0..<step { sum += mono[i + j] }
            fresh.append(Int16(max(-1, min(1, sum / Float(step))) * 32767))
            i += step
        }
        let at = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
        if liveStart < 0 { liveStart = at }
        var offset = Int(((at - liveStart) * 16000).rounded()) - mixBase
        // A time far past the end, or before what was already sent, means the clocks disagree: add it at the end.
        if offset < sent || offset > mix.count + 32000 { offset = mix.count }
        if offset + fresh.count > mix.count { mix.append(contentsOf: repeatElement(0, count: offset + fresh.count - mix.count)) }
        for k in 0..<fresh.count { mix[offset + k] = Int16(clamping: Int32(mix[offset + k]) + Int32(fresh[k])) }
    }

    private func fileClosed() -> Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return finished || failed
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        print("recording")
        fflush(stdout)
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        stopLock.lock()
        finished = true
        stopLock.unlock()
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        stopLock.lock()
        failed = true
        stopLock.unlock()
        fputs("\(plain(error))\n", stderr)
        exit(1)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stopLock.lock()
        let already = stopping || failed
        failed = true
        stopLock.unlock()
        if already { return }
        fputs("\(plain(error))\n", stderr)
        exit(1)
    }
}

/// Apple's on-device listener for one language. Every result, finished or still
/// changing, prints as one JSON line: {"text", "final", "from", "to"}.
private final class Captioner {
    private static let printLock = NSLock()
    private let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private let format: AVAudioFormat
    private let converter: AVAudioConverter?
    private let analyzer: SpeechAnalyzer
    private let input: AsyncStream<AnalyzerInput>.Continuation

    init(lang: String) async throws {
        let module: any SpeechModule
        if lang == "ar" {
            let arabic = DictationTranscriber(locale: Locale(identifier: "ar_SA"), contentHints: [], transcriptionOptions: [], reportingOptions: [.volatileResults, .frequentFinalization], attributeOptions: [])
            module = arabic
            Task {
                do {
                    for try await result in arabic.results { Captioner.emit(String(result.text.characters), result.isFinal, result.range) }
                } catch {
                    Captioner.note("The live words stopped: \(error.localizedDescription)")
                }
            }
        } else {
            let english = SpeechTranscriber(locale: Locale(identifier: "en_US"), transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
            module = english
            Task {
                do {
                    for try await result in english.results { Captioner.emit(String(result.text.characters), result.isFinal, result.range) }
                } catch {
                    Captioner.note("The live words stopped: \(error.localizedDescription)")
                }
            }
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            Captioner.note("Downloading the listener for this language. The words start when it is ready.")
            try await request.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw RecorderError.message("The listener has no sound format.")
        }
        self.format = format
        converter = format == source ? nil : AVAudioConverter(from: source, to: format)
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        input = continuation
        analyzer = SpeechAnalyzer(modules: [module])
        try await analyzer.start(inputSequence: stream)
    }

    /// 16 kHz mono samples, converted to the listener's format.
    func feed(_ samples: ArraySlice<Int16>) {
        guard !samples.isEmpty, let raw = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        raw.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { raw.int16ChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        var ready = raw
        if let converter {
            let frames = AVAudioFrameCount((Double(samples.count) * format.sampleRate / 16000).rounded(.up)) + 16
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
            var given = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if given {
                    status.pointee = .noDataNow
                    return nil
                }
                given = true
                status.pointee = .haveData
                return raw
            }
            guard error == nil, out.frameLength > 0 else { return }
            ready = out
        }
        input.yield(AnalyzerInput(buffer: ready))
    }

    /// Hear what is left, with a short cap so Stop is never slow.
    func finish() async {
        input.finish()
        let analyzer = self.analyzer
        await withTaskGroup(of: Void.self) { group in
            group.addTask { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
            group.addTask { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            await group.next()
            group.cancelAll()
        }
    }

    static func emit(_ text: String, _ final: Bool, _ range: CMTimeRange) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let from = range.start.seconds.isFinite ? range.start.seconds : 0
        let to = range.end.seconds.isFinite ? range.end.seconds : from
        line(["text": trimmed, "final": final, "from": from, "to": to])
    }

    static func note(_ text: String) {
        line(["note": text])
    }

    private static func line(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        printLock.lock()
        print(text)
        fflush(stdout)
        printLock.unlock()
    }
}

private enum RecorderError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

/// A short sentence for the page when macOS blocked the recording.
private func plain(_ error: Error) -> String {
    let text = error.localizedDescription
    let lower = text.lowercased()
    if lower.contains("declin") || lower.contains("not authorized") || lower.contains("permission") || lower.contains("tcc") {
        return "macOS blocked the recording. Open System Settings, go to Privacy & Security, then Screen Recording, and turn on Second Brain. Also allow the Microphone for Second Brain."
    }
    return text
}

/// True when the program was started with a pipe for input, not as an app.
private func stdinIsPipe() -> Bool {
    var info = stat()
    guard fstat(STDIN_FILENO, &info) == 0 else { return false }
    let kind = info.st_mode & S_IFMT
    return kind == S_IFIFO || kind == S_IFSOCK
}

let arguments = CommandLine.arguments
guard arguments.count == 2 || arguments.count == 3 else {
    fputs("Usage: screenrec /path/to/file.mp4 [en|ar]\n", stderr)
    exit(2)
}

let recorder = Recorder()
recorder.lang = arguments.count == 3 ? arguments[2] : "en"
let url = URL(fileURLWithPath: arguments[1])
// Second Brain reads this number so Stop can reach this program.
let pidURL = url.deletingPathExtension().appendingPathExtension("pid")
try? String(ProcessInfo.processInfo.processIdentifier).write(to: pidURL, atomically: true, encoding: .utf8)

// Stop when Second Brain sends stop. A pipe input (the direct launch) also stops when it closes.
// A normal app launch has no pipe, and must not stop just because there is no input.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let onInterrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
onInterrupt.setEventHandler { Task { await recorder.stop() } }
onInterrupt.resume()
let onTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
onTerm.setEventHandler { Task { await recorder.stop() } }
onTerm.resume()

if stdinIsPipe() {
    var stdinBuffer = [UInt8](repeating: 0, count: 64)
    let onClose = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
    onClose.setEventHandler {
        let n = read(STDIN_FILENO, &stdinBuffer, stdinBuffer.count)
        if n <= 0 {
            onClose.cancel()
            Task { await recorder.stop() }
        }
    }
    onClose.resume()
}

// The main loop has to be running so macOS can show the permission question
// and so Stop is noticed. The recording itself waits in the background.
Task {
    do {
        try await recorder.start(url: url)
    } catch {
        fputs("\(plain(error))\n", stderr)
        exit(1)
    }
    print("recording")
    fflush(stdout)
}
dispatchMain()
