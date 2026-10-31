import SwiftUI
import WorkbenchCore

@MainActor struct StartSessionView: View {
    @ObservedObject var model: AppModel
    let workspace: Workspace
    var onStarted: (Pane) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var agent: String
    @State private var starting = false
    @State private var failure: String?
    @State private var requestId = UUID().uuidString
    @State private var attempted = false
    @State private var confirmingNewAttempt = false

    init(model: AppModel, workspace: Workspace, initialAgent: String = "codex", onStarted: @escaping (Pane) -> Void) {
        self.model = model; self.workspace = workspace; self.onStarted = onStarted
        _agent = State(initialValue: initialAgent == "terminal" ? "terminal" : (initialAgent.lowercased().contains("claude") ? "claude" : "codex"))
    }
    private var agentName: String { agent == "terminal" ? "terminal" : (agent == "claude" ? "Claude" : "Codex") }
    private var pendingKey: String { "pending-start:\(model.relayText):\(model.activeMachine?.id ?? ""):\(workspace.id):\(agent)" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(workspace.name).font(.headline)
                    Text(workspace.cwd).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                } header: { Text("Workspace") }
                Section {
                    Picker("Start", selection: $agent) {
                        Label { Text("Codex") } icon: { AgentIcon(harnessId: "codex") }.tag("codex")
                        Label { Text("Claude") } icon: { AgentIcon(harnessId: "claude") }.tag("claude")
                        Label("Terminal", systemImage: "terminal").tag("terminal")
                    }.accessibilityIdentifier("session.start.agent")
                } footer: {
                    Text("Starts a new session in this folder. Existing sessions and files stay unchanged. Agent approval prompts appear in the terminal.")
                }
                Section {
                    Button { start() } label: {
                        HStack {
                            if starting { ProgressView() }
                            Text(starting ? "Starting on your computer…" : (attempted ? "Check / retry start" : "Start \(agentName)"))
                        }.foregroundStyle(.black).frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.borderedProminent).listRowBackground(Color.clear)
                        .disabled(starting || !model.connected || !model.canStartSession || workspace.cwd.isEmpty)
                        .accessibilityIdentifier("session.start.confirm")
                }
                if !model.connected { Text("Reconnect to your computer to start a session.").foregroundStyle(.secondary) }
                else if !model.canStartSession { Text("Update the host companion to start sessions in existing workspaces.").foregroundStyle(.secondary) }
                if let failure { Section { Text(failure).foregroundStyle(.red).textSelection(.enabled).accessibilityIdentifier("session.start.error") } }
                if attempted && !starting {
                    Section {
                        Button("Start a separate session…") { confirmingNewAttempt = true }.accessibilityIdentifier("session.start.newAttempt")
                    } footer: {
                        Text("Retry checks the same request without duplicating a session. If it stopped during startup, correct the error and start a separate session.")
                    }
                }
            }
            .navigationTitle("Start session").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(starting) } }
            .onAppear { restoreRequest() }
            .onChange(of: agent) { _, _ in restoreRequest(); failure = nil }
            .disabled(starting)
            .interactiveDismissDisabled(starting)
            .alert("Start another session?", isPresented: $confirmingNewAttempt) {
                Button("Cancel", role: .cancel) {}
                Button("New request") {
                    requestId = UUID().uuidString; attempted = false; failure = nil
                    if !model.isPreview { UserDefaults.standard.removeObject(forKey: pendingKey) }
                }
            } message: { Text("The previous request may already have started a session. Check the workspace first. This creates a separate request and leaves that session unchanged.") }
        }
    }
    private func restoreRequest() {
        if !model.isPreview, let saved = UserDefaults.standard.string(forKey: pendingKey), UUID(uuidString: saved) != nil {
            requestId = saved; attempted = true
        } else { requestId = UUID().uuidString; attempted = false }
    }
    private func start() {
        guard !starting else { return }
        starting = true; failure = nil; attempted = true
        let key = pendingKey, request = requestId, choice = agent
        if !model.isPreview { UserDefaults.standard.set(request, forKey: key) }
        Task {
            do {
                let pane = try await model.startSession(requestId: request, workspaceId: workspace.id, agent: choice)
                if !model.isPreview { UserDefaults.standard.removeObject(forKey: key) }
                starting = false; onStarted(pane); dismiss()
            } catch { starting = false; failure = error.localizedDescription }
        }
    }
}
