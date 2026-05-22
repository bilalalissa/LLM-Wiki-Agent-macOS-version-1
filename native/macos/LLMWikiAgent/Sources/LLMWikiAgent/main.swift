import AppKit
import ServiceManagement
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var closeBehaviorItem: NSMenuItem!
    private let closeBehaviorKey = "closeButtonKeepsRunning"
    private let port = "8789"
    private var appSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LLM Wiki Agent", isDirectory: true)
    }
    private var configURL: URL { appSupport.appendingPathComponent("config.env") }
    private var agentURL: URL { Bundle.main.resourceURL!.appendingPathComponent("agent", isDirectory: true) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        ensureConfig()
        installStatusItem()
        makeWindow()
        startServer()
        runStartupChecks()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)")!))
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    private func makeWindow() {
        webView = WKWebView(frame: .zero)
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "LLM Wiki Agent"
        window.delegate = self
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "text.book.closed", accessibilityDescription: "LLM Wiki Agent")
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show App", action: #selector(showApp), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "Open Config", action: #selector(openConfig), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Open Vaults Folder", action: #selector(openVaults), keyEquivalent: "v"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Start at Login", action: #selector(toggleLoginItem), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Show Dock Icon", action: #selector(toggleDockIcon), keyEquivalent: ""))
        closeBehaviorItem = NSMenuItem(title: "Close Button Keeps Running", action: #selector(toggleCloseBehavior), keyEquivalent: "")
        closeBehaviorItem.state = closeButtonKeepsRunning ? .on : .off
        menu.addItem(closeBehaviorItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closeButtonKeepsRunning {
            sender.orderOut(nil)
            NSApp.setActivationPolicy(.accessory)
            return false
        }
        NSApp.terminate(nil)
        return false
    }

    @objc private func showApp() {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openConfig() {
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        let configuration = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open([configURL], withApplicationAt: textEdit, configuration: configuration) { _, error in
            if let error {
                DispatchQueue.main.async {
                    self.showAlert("Open Config", "Could not open config.env in TextEdit: \(error.localizedDescription)\n\nConfig path:\n\(self.configURL.path)")
                }
            }
        }
    }

    @objc private func openVaults() {
        let root = readConfigValue("VAULTS_ROOT") ?? "~/Documents/Obsidian-Vaults"
        NSWorkspace.shared.open(URL(fileURLWithPath: expandTilde(root)))
    }

    @objc private func toggleLoginItem() {
        if #available(macOS 13.0, *) {
            do {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                } else {
                    try SMAppService.mainApp.register()
                }
            } catch {
                showAlert("Start at Login", "Could not update login item: \(error.localizedDescription)")
            }
        } else {
            showAlert("Start at Login", "Start at Login requires macOS 13 or later in this build.")
        }
    }

    @objc private func toggleDockIcon() {
        let next: NSApplication.ActivationPolicy = NSApp.activationPolicy() == .regular ? .accessory : .regular
        NSApp.setActivationPolicy(next)
        if next == .regular { showApp() }
    }

    @objc private func toggleCloseBehavior() {
        UserDefaults.standard.set(!closeButtonKeepsRunning, forKey: closeBehaviorKey)
        closeBehaviorItem.state = closeButtonKeepsRunning ? .on : .off
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func ensureConfig() {
        try? FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: configURL.path) {
            let bundled = Bundle.main.resourceURL!.appendingPathComponent("config.example.env")
            if FileManager.default.fileExists(atPath: bundled.path) {
                try? FileManager.default.copyItem(at: bundled, to: configURL)
            }
        }
    }

    private var closeButtonKeepsRunning: Bool {
        if UserDefaults.standard.object(forKey: closeBehaviorKey) == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: closeBehaviorKey)
    }

    private func startServer() {
        let process = Process()
        process.currentDirectoryURL = agentURL
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "src/server.mjs"]
        var env = ProcessInfo.processInfo.environment
        env["LLM_WIKI_ENV_FILE"] = configURL.path
        process.environment = env
        serverProcess = process
        do {
            try process.run()
        } catch {
            showAlert("Node.js required", "Install Node.js, then restart LLM Wiki Agent.\n\nError: \(error.localizedDescription)")
        }
    }

    private func runStartupChecks() {
        var problems: [String] = []
        if !FileManager.default.fileExists(atPath: "/Applications/Obsidian.app") &&
            !FileManager.default.fileExists(atPath: "\(NSHomeDirectory())/Applications/Obsidian.app") {
            problems.append("Install Obsidian from https://obsidian.md and create/configure at least one vault.")
        }
        if !detectClipper() {
            problems.append("Install Obsidian Web Clipper from https://obsidian.md/clipper.")
        }
        let vaultRoot = expandTilde(readConfigValue("VAULTS_ROOT") ?? "")
        if vaultRoot.isEmpty || !hasConfiguredVault(in: vaultRoot) {
            problems.append("Set VAULTS_ROOT in config.env to a folder containing at least one Obsidian vault. The app creates AGENTS.md, CLAUDE.md, index.md, log.md, raw/, and wiki/ automatically.")
        }
        if !providerConfigured() {
            problems.append("Configure at least one AI provider in config.env. For ChatGPT subscription mode, install Codex CLI and run `codex login`.")
        }
        if !problems.isEmpty {
            showAlert("Setup required", problems.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n\n"))
        }
    }

    private func detectClipper() -> Bool {
        let home = NSHomeDirectory()
        let chromiumId = "cnjifjpddelmedmihgijeibhnjfabmlf"
        let edgeId = "eigdjhmgnaaeaonimdklocfekkaanfme"
        let candidates = [
            "\(home)/Library/Application Support/Google/Chrome/Default/Extensions/\(chromiumId)",
            "\(home)/Library/Application Support/BraveSoftware/Brave-Browser/Default/Extensions/\(chromiumId)",
            "\(home)/Library/Application Support/Microsoft Edge/Default/Extensions/\(edgeId)",
            "/Applications/Obsidian Web Clipper.app",
            "\(home)/Applications/Obsidian Web Clipper.app"
        ]
        return candidates.contains { FileManager.default.fileExists(atPath: $0) }
    }

    private func hasConfiguredVault(in root: String) -> Bool {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: root) else { return false }
        return items.contains { name in
            name.hasSuffix("-vault") && FileManager.default.fileExists(atPath: "\(root)/\(name)/AGENTS.md")
        }
    }

    private func providerConfigured() -> Bool {
        let provider = readConfigValue("DEFAULT_AI_PROVIDER") ?? ""
        if provider == "openai_subscription" {
            return runQuick(["codex", "login", "status"]).lowercased().contains("logged in")
        }
        let keyNames = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_COMPAT_API_KEY", "GEMINI_API_KEY", "GEMINI_OAUTH_ACCESS_TOKEN"]
        return keyNames.contains { key in
            guard let value = readConfigValue(key) else { return false }
            return !value.isEmpty && !value.hasPrefix("replace-with-")
        }
    }

    private func readConfigValue(_ key: String) -> String? {
        guard let text = try? String(contentsOf: configURL, encoding: .utf8) else { return nil }
        return text.split(separator: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.hasPrefix("#"), let eq = trimmed.firstIndex(of: "=") else { return nil }
            return String(trimmed[..<eq]) == key ? String(trimmed[trimmed.index(after: eq)...]).trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) : nil
        }.first
    }

    private func runQuick(_ args: [String]) -> String {
        let p = Process()
        let pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        p.standardOutput = pipe
        p.standardError = pipe
        try? p.run()
        p.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    private func expandTilde(_ path: String) -> String {
        path.replacingOccurrences(of: "~", with: NSHomeDirectory())
    }

    private func showAlert(_ title: String, _ message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.runModal()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
