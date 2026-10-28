import AppKit
import WebKit
import ScreenCaptureKit
import CoreMedia
import CoreAudio
import AVFoundation

// OX-SCOPE 1.4: Native macOS window + stereo system-audio capture.
// No virtual audio driver, no cloud requests, no Electron.
// macOS 13+ with ScreenCaptureKit; target machine is macOS 15.
final class OXDesktop: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate,
                      NSWindowDelegate, SCStreamOutput, SCStreamDelegate {
    private var metadataTimer: Timer?
    private var metadataBusy = false
    private var metadataSignature = ""
    private var noMetadataNoticeSent = false
    var window: NSWindow!
    var webView: WKWebView!
    private var captureStream: SCStream?
    private var captureStarting = false
    private var captureEpoch = 0
    private let audioQueue = DispatchQueue(label: "oxscope.system.audio", qos: .userInteractive)
    // These variables are only accessed on audioQueue (stream callback).
    private var storedL: [Float] = []
    private var storedR: [Float] = []
    private var lastAudioSend: TimeInterval = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(self, name: "native")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 740),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "OX-SCOPE 1.4"
        window.minSize = NSSize(width: 480, height: 385)
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("OX-SCOPE-Player-Frame")
        setMenus()
        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") else {
            let alert = NSAlert()
            alert.messageText = "OX-SCOPE resources not found"
            alert.informativeText = "Rebuild the app using Build OX-SCOPE.command."
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        window.makeKeyAndOrderFront(nil)
        // Reads macOS Now Playing track artwork through an optional, locally
        // installed helper. Audio capture itself needs NO additional tool.
        metadataTimer = Timer.scheduledTimer(timeInterval: 2.5, target: self,
                                             selector: #selector(pollNowPlaying),
                                             userInfo: nil, repeats: true)
        pollNowPlaying()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func windowWillClose(_ notification: Notification) {
        metadataTimer?.invalidate()
        stopSystemAudio()
        NSApp.terminate(nil)
    }

    private func jsonJS(_ data: [String: Any]) -> String? {
        guard let encoded = try? JSONSerialization.data(withJSONObject: data, options: [.fragmentsAllowed]) else { return nil }
        return String(data: encoded, encoding: .utf8)
    }
    private func sendState(_ name: String, _ message: String? = nil) {
        var obj: [String: Any] = ["state": name]
        if let message = message { obj["message"] = message }
        guard let json = jsonJS(obj) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.oxscopeNative?.nativeEvent(\(json))", completionHandler: nil)
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "native", let command = message.body as? String else { return }
        switch command {
        case "fullscreen": window.toggleFullScreen(nil)
        case "startSystemAudio": startSystemAudio()
        case "stopSystemAudio": stopSystemAudio()
        case "media:0", "media:1", "media:2", "media:3", "media:4", "media:5":
            if let n = Int(command.split(separator: ":")[1]) { sendMediaCommand("send", String(n)) }
        default:
            if command.hasPrefix("mediaSeek:"), let sec = Double(command.dropFirst("mediaSeek:".count)),
               sec.isFinite, sec >= 0, sec < 864000 {
                sendMediaCommand("seek", String(Int64(sec * 1_000_000)))
            }
        }
    }

    // 1.4: Bundle the BSD-licensed MediaRemote Adapter (same upstream component
    // Amee uses). No user-installed Homebrew or media-control required.
    // MediaRemote is a private system interface; Apple could change it.
    private func bundledAdapter() -> (String, String)? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let dir = resources.appendingPathComponent("mediaremote-adapter", isDirectory: true)
        let script = dir.appendingPathComponent("mediaremote-adapter.pl").path
        let framework = dir.appendingPathComponent("MediaRemoteAdapter.framework", isDirectory: true).path
        guard FileManager.default.fileExists(atPath: script), FileManager.default.fileExists(atPath: framework) else { return nil }
        return (script, framework)
    }
    private func sendMediaCommand(_ command: String, _ argument: String) {
        guard let adapter = bundledAdapter() else {
            sendNowPlaying(["error": "System media controls unavailable: bundled adapter missing."])
            return
        }
        DispatchQueue.global(qos: .utility).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
            p.arguments = [adapter.0, adapter.1, command, argument]
            p.standardOutput = Pipe()
            p.standardError = Pipe()
            do { try p.run(); p.waitUntilExit() } catch { }
        }
    }
    // Apple's public audio API does NOT also provide another app's artwork.
    // MediaRemote Adapter reads the separate Now Playing session.
    private func metadataCommand() -> (URL, [String], String)? {
        if let a = bundledAdapter() {
            return (URL(fileURLWithPath: "/usr/bin/perl"), [a.0, a.1, "get", "--now"], "helper")
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["/opt/homebrew/bin/media-control", "/usr/local/bin/media-control",
                          home + "/.local/bin/media-control", "/opt/local/bin/media-control"]
        if let binary = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return (URL(fileURLWithPath: binary), ["get", "--now"], "helper")
        }
        let running = NSWorkspace.shared.runningApplications
        let spotify = running.contains { $0.bundleIdentifier == "com.spotify.client" }
        let music = running.contains { $0.bundleIdentifier == "com.apple.Music" }
        let app = spotify ? "Spotify" : music ? "Music" : ""
        if !app.isEmpty {
            // No UI automation or network access; only asks the named player
            // for its own currently-playing track. macOS may ask permission.
            let script = """
            tell application "\(app)"
                if player state is not playing then return ""
                set t to current track
                set separator to ASCII character 31
                return (name of t as string) & separator & (artist of t as string) & separator & (album of t as string) & separator & (duration of t as string)
            end tell
            """
            return (URL(fileURLWithPath: "/usr/bin/osascript"), ["-e", script], app == "Spotify" ? "Spotify" : "Music")
        }
        return nil
    }

    @objc private func pollNowPlaying() {
        guard !metadataBusy else { return }
        guard captureStream != nil || captureStarting else { return }
        guard let command = metadataCommand() else {
            if !noMetadataNoticeSent {
                noMetadataNoticeSent = true
                sendNowPlaying(["error": "Metadata adapter not available in the app bundle. Build packaging incomplete; capture can still work."])
            }
            return
        }
        metadataBusy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let proc = Process()
            proc.executableURL = command.0
            proc.arguments = command.1
            let stdout = Pipe(), stderr = Pipe()
            proc.standardOutput = stdout
            proc.standardError = stderr
            var payload: [String: Any]?
            var issue: String?
            do {
                try proc.run()
                let data = stdout.fileHandleForReading.readDataToEndOfFile()
                let errorData = stderr.fileHandleForReading.readDataToEndOfFile()
                proc.waitUntilExit()
                if proc.terminationStatus == 0, data.count < 8 * 1024 * 1024 {
                    if command.2 == "helper" {
                        payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    } else {
                        let line = (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let fields = line.components(separatedBy: "\u{001F}")
                        if fields.count >= 4, !fields[0].isEmpty {
                            let raw = Double(fields[3]) ?? 0
                            payload = ["title": fields[0], "artist": fields[1], "album": fields[2],
                                       "duration": command.2 == "Spotify" ? raw / 1000 : raw,
                                       "source": command.2.uppercased()]
                        }
                    }
                    if payload == nil { issue = "Now Playing has no readable track information." }
                } else {
                    let explanation = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    issue = explanation.isEmpty ? "Metadata helper exited with code \(proc.terminationStatus)" : String(explanation.prefix(170))
                }
            } catch { issue = error.localizedDescription }
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.metadataBusy = false
                guard self.captureStream != nil else { return }
                if let info = payload {
                    var sanitized: [String: Any] = [:]
                    for key in ["title", "artist", "album", "duration", "elapsedTime", "elapsedTimeNow", "playing", "artworkMimeType", "artworkData", "bundleIdentifier", "source"] {
                        if let item = info[key], !(item is NSNull) { sanitized[key] = item }
                    }
                    guard let title = sanitized["title"] as? String, !title.isEmpty else {
                        self.clearNowPlaying(); return
                    }
                    if let art = sanitized["artworkData"] as? String, art.count > 4_000_000 {
                        sanitized.removeValue(forKey: "artworkData")
                    }
                    let newSig = "\(title)|\(sanitized["artist"] ?? "")|\(sanitized["album"] ?? "")|\(sanitized["artworkData"] as? String ?? "")"
                    if newSig == self.metadataSignature {
                        sanitized.removeValue(forKey: "artworkData")
                        sanitized["keepArtwork"] = true
                    } else { self.metadataSignature = newSig }
                    self.noMetadataNoticeSent = false
                    sanitized["source"] = sanitized["source"] ?? self.friendlySource(sanitized["bundleIdentifier"] as? String ?? "")
                    sanitized["elapsed"] = sanitized["elapsedTimeNow"] ?? sanitized["elapsedTime"]
                    self.sendNowPlaying(sanitized)
                } else {
                    self.clearNowPlaying()
                    if let issue = issue, !self.noMetadataNoticeSent {
                        self.noMetadataNoticeSent = true
                        self.sendNowPlaying(["error": issue])
                    }
                }
            }
        }
    }
    private func friendlySource(_ bundle: String) -> String {
        if bundle.localizedCaseInsensitiveContains("telegram") { return "TELEGRAM / NOW PLAYING" }
        if bundle.contains("spotify") { return "SPOTIFY" }
        if bundle.contains("Chrome") { return "CHROME / NOW PLAYING" }
        if bundle.contains("Safari") { return "SAFARI / NOW PLAYING" }
        if bundle.contains("Music") { return "APPLE MUSIC" }
        return "MAC NOW PLAYING"
    }
    private func clearNowPlaying() {
        if !metadataSignature.isEmpty {
            metadataSignature = ""
            sendNowPlaying([:])
        }
    }
    private func sendNowPlaying(_ info: [String: Any]) {
        guard let json = jsonJS(info) else { return }
        webView?.evaluateJavaScript("window.oxscopeNative?.receiveNowPlaying(\(json))", completionHandler: nil)
    }

    // Start audio capture through Apple's ScreenCaptureKit. A very small/slow screen
    // stream serves only as the capture filter. We do NOT save or deliver video frames.
    private func startSystemAudio() {
        if captureStream != nil || captureStarting { return }
        captureStarting = true
        captureEpoch += 1
        let epoch = captureEpoch
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let display = content.displays.first else {
                    throw NSError(domain: "OX-SCOPE", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available for system audio capture."])
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let settings = SCStreamConfiguration()
                settings.capturesAudio = true
                settings.excludesCurrentProcessAudio = true
                settings.sampleRate = 48000
                settings.channelCount = 2
                settings.width = 32
                settings.height = 32
                settings.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                settings.queueDepth = 3
                let stream = SCStream(filter: filter, configuration: settings, delegate: self)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
                try await stream.startCapture()
                if epoch != self.captureEpoch {
                    try? await stream.stopCapture()
                    return
                }
                self.captureStream = stream
                self.captureStarting = false
                self.audioQueue.async { [weak self] in
                    self?.storedL.removeAll(keepingCapacity: true)
                    self?.storedR.removeAll(keepingCapacity: true)
                    self?.lastAudioSend = 0
                }
                self.sendState("started")
                DispatchQueue.main.async { self.pollNowPlaying() }
            } catch {
                guard epoch == self.captureEpoch else { return }
                self.captureStarting = false
                self.captureStream = nil
                self.sendState("error", error.localizedDescription + " — Check System Settings > Privacy & Security > Screen & System Audio Recording. You may need to restart OX-SCOPE after granting permission.")
            }
        }
    }

    private func stopSystemAudio() {
        captureEpoch += 1
        captureStarting = false
        let stream = captureStream
        captureStream = nil
        audioQueue.async { [weak self] in
            self?.storedL.removeAll(keepingCapacity: true)
            self?.storedR.removeAll(keepingCapacity: true)
        }
        sendState("stopped")
        if let stream = stream {
            Task { try? await stream.stopCapture() }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.captureStream === stream else { return }
            self.stopSystemAudio()
            self.sendState("error", error.localizedDescription)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let desc = sampleBuffer.formatDescription?.audioStreamBasicDescription,
              desc.mFormatID == kAudioFormatLinearPCM, desc.mBitsPerChannel == 32,
              (desc.mFormatFlags & kAudioFormatFlagIsFloat) != 0 else { return }
        let channels = max(1, Int(desc.mChannelsPerFrame))
        let planar = (desc.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return }
        var left: [Float] = []
        var right: [Float] = []
        // withAudioBufferList retains the underlying memory for the closure.
        // We copy only samples, never hold CMSampleBuffer memory beyond it.
        try? sampleBuffer.withAudioBufferList { buffers, _ in
            var pointers: [UnsafePointer<Float>] = []
            var counts: [Int] = []
            for buffer in buffers {
                guard let p = buffer.mData else { continue }
                pointers.append(UnsafePointer(p.assumingMemoryBound(to: Float.self)))
                counts.append(Int(buffer.mDataByteSize) / MemoryLayout<Float>.size)
            }
            guard !pointers.isEmpty else { return }
            if planar {
                let n = min(frames, counts[0], pointers.count > 1 ? counts[1] : counts[0])
                if n <= 0 { return }
                left.reserveCapacity(n); right.reserveCapacity(n)
                for i in 0..<n {
                    let l = pointers[0][i]
                    let r = pointers.count > 1 ? pointers[1][i] : l
                    left.append(l.isFinite ? l : 0)
                    right.append(r.isFinite ? r : 0)
                }
            } else {
                let n = min(frames, counts[0] / channels)
                if n <= 0 { return }
                left.reserveCapacity(n); right.reserveCapacity(n)
                for i in 0..<n {
                    let base = i * channels
                    let l = pointers[0][base]
                    let r = channels > 1 ? pointers[0][base+1] : l
                    left.append(l.isFinite ? l : 0)
                    right.append(r.isFinite ? r : 0)
                }
            }
        }
        guard !left.isEmpty else { return }
        storedL.append(contentsOf: left)
        storedR.append(contentsOf: right)
        if storedL.count > 8192 { storedL.removeFirst(storedL.count - 8192) }
        if storedR.count > 8192 { storedR.removeFirst(storedR.count - 8192) }
        // Limit JS bridge updates to 20 FPS; store enough stereo samples for time controls.
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastAudioSend >= 0.05 else { return }
        lastAudioSend = now
        let payloadL = storedL
        let payloadR = storedR
        let rate = Int(desc.mSampleRate)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.captureStream === stream else { return }
            guard let json = self.jsonJS(["l": payloadL, "r": payloadR, "rate": rate]) else { return }
            self.webView?.evaluateJavaScript("window.oxscopeNative?.receiveSystemAudio(\(json))", completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    @objc func openAudio(_ sender: Any?) { webView.evaluateJavaScript("document.getElementById('audioInput').click()", completionHandler: nil) }
    @objc func chooseArtwork(_ sender: Any?) { webView.evaluateJavaScript("document.getElementById('artInput').click()", completionHandler: nil) }
    @objc func toggleFullscreen(_ sender: Any?) { window.toggleFullScreen(nil) }
    @objc func startCaptureFromMenu(_ sender: Any?) { startSystemAudio() }
    @objc func stopCaptureFromMenu(_ sender: Any?) { stopSystemAudio() }
    @objc func changeMode(_ item: NSMenuItem) {
        let name = ["bars", "spectrogram", "o", "l"][item.tag]
        webView.evaluateJavaScript("window.oxscope.selectMode('\(name)')", completionHandler: nil)
    }

    private func setMenus() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "OX-SCOPE")
        appMenu.addItem(withTitle: "About OX-SCOPE", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit OX-SCOPE", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        let open = fileMenu.addItem(withTitle: "Add Audio to Playlist…", action: #selector(openAudio(_:)), keyEquivalent: "o")
        open.target = self
        let artwork = fileMenu.addItem(withTitle: "Choose Artwork…", action: #selector(chooseArtwork(_:)), keyEquivalent: "")
        artwork.target = self
        fileItem.submenu = fileMenu; main.addItem(fileItem)

        let inputItem = NSMenuItem()
        let inputMenu = NSMenu(title: "Input")
        let start = inputMenu.addItem(withTitle: "Start System Audio", action: #selector(startCaptureFromMenu(_:)), keyEquivalent: "")
        start.target = self
        let stop = inputMenu.addItem(withTitle: "Stop System Audio", action: #selector(stopCaptureFromMenu(_:)), keyEquivalent: "")
        stop.target = self
        inputItem.submenu = inputMenu; main.addItem(inputItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        for (n, name) in ["Bars", "Spectrogram", "Waveform L/R", "Oscilloscope X/Y"].enumerated() {
            let item = viewMenu.addItem(withTitle: name, action: #selector(changeMode(_:)), keyEquivalent: "")
            item.tag = n
            item.target = self
        }
        viewMenu.addItem(NSMenuItem.separator())
        let full = viewMenu.addItem(withTitle: "Toggle Full Screen", action: #selector(toggleFullscreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.control, .command]
        full.target = self
        viewItem.submenu = viewMenu; main.addItem(viewItem)
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = OXDesktop()
app.delegate = delegate
app.run()
