#if DEBUG
import Foundation
import WorkbenchCore

// Sample data only: the UI is always RootView -> WorkspaceList -> TerminalScreen.
// Preview mode never reads credentials or opens a network connection.
enum PreviewSession {
    static let machine: Machine = decode(#"{"id":"preview","name":"Supernova preview","hostKey":"","online":true}"#)
    static let workspace: Workspace = decode(#"{"id":"preview","name":"workbench-app","cwd":"~/workbench-app","panes":[{"id":"workbench_h_preview","tmux":"workbench_h_preview","name":"Workbench","kind":"agent","live":true}]}"#)
    static let login: Login = decode(#"{"accessToken":"preview-only","deviceId":"preview","expiresAt":0}"#)

    static func state(phoneLayout: Bool, cols: Int = 48, rows: Int = 30) -> SessionState {
        decode("{\"sessionId\":\"workbench_h_preview\",\"writable\":true,\"localAttached\":true,\"phoneLayout\":\(phoneLayout),\"cols\":\(cols),\"rows\":\(rows)}")
    }

    static let sample = ([
        // A steady cursor keeps UI automation from waiting on a repeating animation.
        "\u{1b}[2J\u{1b}[H\u{1b}[2 q\u{1b}[?1000h\u{1b}[?1006h\u{1b}[1;38;5;114mWORKBENCH\u{1b}[0m  \u{1b}[90msample session\u{1b}[0m",
        "\u{1b}[90m~/workbench-app\u{1b}[0m", "",
        "\u{1b}[1mReady to pick up your work.\u{1b}[0m", "",
        "  \u{1b}[32m✓\u{1b}[0m Your terminal, on your phone",
        "  \u{1b}[32m✓\u{1b}[0m A menu for layout and text size",
        "  \u{1b}[32m✓\u{1b}[0m Keyboard shortcuts within reach", "",
        "\u{1b}[90m┌──────────────────────────────┐",
        "│ Preview — no live connection │",
        "└──────────────────────────────┘\u{1b}[0m", "",
        "Use Menu to change the text size.",
        "Tap Keyboard to try the key row.",
        "Compose gives you room to write.", "",
        "\u{1b}[1;38;5;114m›\u{1b}[0m "
    ]).joined(separator: "\r\n")

    private static func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
#endif
