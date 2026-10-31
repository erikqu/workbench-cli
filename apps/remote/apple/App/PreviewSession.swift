#if DEBUG
import Foundation
import UIKit
import SwiftUI
import WorkbenchCore

// Sample data only: the UI is always RootView -> WorkspaceList -> TerminalScreen.
// Preview mode never reads credentials or opens a network connection.
enum PreviewSession {
    static let machine: Machine = decode(#"{"id":"preview","name":"Supernova preview","hostKey":"","online":true}"#)
    static let workspace: Workspace = decode(#"{"id":"preview","name":"workbench-app","cwd":"~/workbench-app","panes":[{"id":"workbench_h_preview","tmux":"workbench_h_preview","name":"Codex","kind":"agent","live":true,"harnessId":"codex","activity":"idle"},{"id":"workbench_t_preview","tmux":"workbench_t_preview","name":"Terminal 1","kind":"terminal","live":true}]}"#.replacingOccurrences(of: "\"activity\":\"idle\"", with: ProcessInfo.processInfo.arguments.contains("--busy-preview") ? "\"activity\":\"working\"" : "\"activity\":\"idle\""))
    static let login: Login = decode(#"{"accessToken":"preview-only","deviceId":"preview","expiresAt":0}"#)
    static let terminalOnlyWorkspace: Workspace = decode(#"{"id":"shell-only","name":"Shell workspace","cwd":"~/shell-workspace","panes":[{"id":"workbench_t_shell_only","tmux":"workbench_t_shell_only","name":"Terminal 1","kind":"terminal","live":true}]}"#)
    static let cycleWorkspaces: [Workspace] = decode(#"[{"id":"cycle-alpha","name":"Project Alpha","cwd":"~/alpha","panes":[{"id":"workbench_h_cycle_codex","tmux":"workbench_h_cycle_codex","name":"Builder","harnessId":"codex","kind":"agent","live":true,"activity":"working"},{"id":"workbench_h_cycle_stopped","tmux":"workbench_h_cycle_stopped","name":"Stopped","harnessId":"codex","kind":"agent","live":false},{"id":"workbench_t_cycle","tmux":"workbench_t_cycle","name":"Terminal 1","kind":"terminal","live":true}]},{"id":"cycle-beta","name":"Project Beta","cwd":"~/beta","panes":[{"id":"workbench_h_cycle_claude","tmux":"workbench_h_cycle_claude","name":"Reviewer","harnessId":"claude-code","kind":"agent","live":true,"activity":"idle"}]}]"#)
    static let savedWorkspaces: [Workspace] = cycleWorkspaces + [
        decode(#"{"id":"saved-project","name":"Old Project","cwd":"~/old-project","panes":[{"id":"workbench_h_saved_codex","tmux":"workbench_h_saved_codex","name":"Codex","harnessId":"codex","kind":"agent","live":false}]}"#)
    ]
    // Idle intentionally precedes busy here so the UI test exercises active-first ordering.
    static let activityWorkspaces: [Workspace] = decode(#"[{"id":"activity-idle","name":"Idle workspace","cwd":"~/idle-project","panes":[{"id":"activity-idle-agent","tmux":"activity-idle-agent","name":"Idle agent","kind":"agent","live":true,"activity":"idle"}]},{"id":"activity-busy","name":"Building the next release","cwd":"~/active-project","panes":[{"id":"activity-working-agent","tmux":"activity-working-agent","name":"Codex","kind":"agent","live":true,"activity":"working"},{"id":"activity-recent-agent","tmux":"activity-recent-agent","name":"Claude","kind":"agent","live":true,"activity":"recent"}]}]"#)

    static func state(sessionId: String = "workbench_h_preview", phoneLayout: Bool, cols: Int = 48, rows: Int = 30) -> SessionState {
        decode("{\"sessionId\":\"\(sessionId)\",\"writable\":true,\"localAttached\":true,\"phoneLayout\":\(phoneLayout),\"cols\":\(cols),\"rows\":\(rows)}")
    }
    static func newWorkspace(name: String, parentDirectory: String, agent: String) -> Workspace {
        let id = UUID().uuidString
        var panes: [[String: Any]] = agent == "none" ? [] : [["id": "workbench_t_" + id, "tmux": "workbench_t_" + id, "name": "Terminal 1", "kind": "terminal", "live": true]]
        if ["codex", "claude"].contains(agent) { panes.insert(["id": "workbench_h_" + id, "tmux": "workbench_h_" + id, "name": agent == "codex" ? "Codex" : "Claude", "kind": "agent", "live": true, "harnessId": agent, "activity": "idle"], at: 0) }
        let value: [String: Any] = ["id": id, "name": name, "cwd": (parentDirectory as NSString).appendingPathComponent(name), "panes": panes]
        return try! JSONDecoder().decode(Workspace.self, from: JSONSerialization.data(withJSONObject: value))
    }
    static func newPane(id: String, agent: String) -> Pane {
        let value: [String: Any] = ["id": id, "tmux": id, "name": agent == "terminal" ? "Terminal" : (agent == "claude" ? "Claude" : "Codex"), "kind": agent == "terminal" ? "terminal" : "agent", "live": true, "harnessId": agent, "activity": "idle"]
        return try! JSONDecoder().decode(Pane.self, from: JSONSerialization.data(withJSONObject: value))
    }
    static func stoppedPane(_ pane: Pane) -> Pane {
        var value = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(pane)) as! [String: Any]
        value["live"] = false
        return try! JSONDecoder().decode(Pane.self, from: JSONSerialization.data(withJSONObject: value))
    }
    static func folders(path: String) throws -> FolderListing {
        let canonical = path == "~" || path == "~/" ? "/home/preview" : path.replacingOccurrences(of: "~/", with: "/home/preview/")
        let tree = ["/": ["home"], "/home": ["preview"], "/home/preview": ["projects", "workbench-app"], "/home/preview/projects": ["existing-project", "empty-folder"], "/home/preview/projects/existing-project": [], "/home/preview/projects/empty-folder": [], "/home/preview/workbench-app": []]
        guard let names = tree[canonical] else { throw WorkbenchError.message("Folder not found on the preview computer.") }
        let value: [String: Any] = ["path": canonical, "parentPath": canonical == "/" ? NSNull() : (canonical as NSString).deletingLastPathComponent as Any, "truncated": false, "entries": names.map { ["name": $0, "path": (canonical as NSString).appendingPathComponent($0)] }]
        return try JSONDecoder().decode(FolderListing.self, from: JSONSerialization.data(withJSONObject: value))
    }
    static func files(path: String) -> DirectoryListing {
        if path == "images" {
            return decode(#"{"path":"images","truncated":false,"entries":[{"name":"preview.png","path":"images/preview.png","kind":"file","size":1000}]}"#)
        }
        return decode(#"{"path":"","truncated":false,"entries":[{"name":"images","path":"images","kind":"directory","size":0},{"name":"README.md","path":"README.md","kind":"file","size":80},{"name":"long-lines.txt","path":"long-lines.txt","kind":"file","size":16000}]}"#)
    }
    static func fileData(path: String) -> Data {
        if path == "long-lines.txt" {
            let first = "This file has a long paragraph that should wrap within the phone screen. " + String(repeating: "Every word stays readable, including Unicode café 日本語 👋. ", count: 4) + "END OF FIRST LINE.\n\n"
            return Data((first + (1...100).map { "Line \($0): " + String(repeating: "readable content ", count: 5) }.joined(separator: "\n") + "\nEND OF FILE.").utf8)
        }
        if path == "images/preview.png" {
            return UIGraphicsImageRenderer(size: CGSize(width: 600, height: 360)).image { context in
                UIColor(red: 0.06, green: 0.11, blue: 0.17, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 600, height: 360))
                ("Image preview" as NSString).draw(at: CGPoint(x: 50, y: 130), withAttributes: [.font: UIFont.systemFont(ofSize: 44, weight: .semibold), .foregroundColor: UIColor(Color.accentColor)])
                ("Sample file · no live connection" as NSString).draw(at: CGPoint(x: 50, y: 205), withAttributes: [.font: UIFont.systemFont(ofSize: 24), .foregroundColor: UIColor.white])
            }.pngData()!
        }
        return Data("# Workbench\n\nRead-only text preview. Files stay on your computer.\n".utf8)
    }

    static let sample = ([
        // A steady cursor keeps UI automation from waiting on a repeating animation.
        "\u{1b}[2J\u{1b}[H\u{1b}[2 q\u{1b}[?1000h\u{1b}[?1006h\u{1b}[1;38;2;137;207;240mWORKBENCH\u{1b}[0m  \u{1b}[90msample session\u{1b}[0m",
        "\u{1b}[90m~/workbench-app\u{1b}[0m", "",
        "\u{1b}[1mReady to pick up your work.\u{1b}[0m", "",
        "  \u{1b}[38;2;137;207;240m✓\u{1b}[0m Your terminal, on your phone",
        "  \u{1b}[38;2;137;207;240m✓\u{1b}[0m A menu for layout and text size",
        "  \u{1b}[38;2;137;207;240m✓\u{1b}[0m Keyboard shortcuts within reach", "",
        "\u{1b}[90m┌──────────────────────────────┐",
        "│ Preview — no live connection │",
        "└──────────────────────────────┘\u{1b}[0m", "",
        "Use Menu to change the text size.",
        "Tap Keyboard to try the key row.",
        "Compose gives you room to write.", "",
        "\u{1b}[1;38;2;137;207;240m›\u{1b}[0m "
    ]).joined(separator: "\r\n")

    private static func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
#endif
