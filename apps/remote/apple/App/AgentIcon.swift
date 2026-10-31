import SwiftUI
import WorkbenchCore

/// Bundled vendor marks identify the agent; activity is a separate indicator at the call site.
struct AgentIcon: View {
    private let agent: Agent
    private let size: CGFloat

    init(pane: Pane, size: CGFloat = 18) {
        agent = pane.kind == "agent" ? Self.identify(harnessId: pane.harnessId, name: pane.name) : .terminal
        self.size = size
    }

    init(harnessId: String, size: CGFloat = 18) {
        agent = Self.identify(harnessId: harnessId, name: harnessId)
        self.size = size
    }

    var body: some View {
        Group {
            switch agent {
            case .codex:
                Image("AgentCodex").resizable().renderingMode(.template).scaledToFit().foregroundStyle(.primary)
            case .claude:
                Image("AgentClaude").resizable().renderingMode(.original).scaledToFit()
            case .unknown:
                Image(systemName: "sparkle").resizable().scaledToFit().foregroundStyle(.secondary)
            case .terminal:
                Image(systemName: "terminal").resizable().scaledToFit().foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(agent.label)
        .accessibilityIdentifier("agent.icon.\(agent.rawValue)")
    }

    private enum Agent: String {
        case codex, claude, unknown, terminal
        var label: String {
            switch self {
            case .codex: return "Codex"
            case .claude: return "Claude"
            case .unknown: return "Agent"
            case .terminal: return "Terminal"
            }
        }
    }

    private static func identify(harnessId: String?, name: String) -> Agent {
        func known(_ value: String) -> Agent? {
            let normalized = value.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains).map(String.init).joined()
            switch normalized {
            case "codex", "codexcli", "openaicodex": return .codex
            case "claude", "claudecode", "anthropicclaude", "anthropicclaudecode": return .claude
            default: return nil
            }
        }
        return harnessId.flatMap(known) ?? known(name) ?? .unknown
    }
}
