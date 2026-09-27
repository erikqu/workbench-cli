import SwiftUI
import WorkbenchCore

struct NewWorkspaceView: View {
    @ObservedObject var model: AppModel
    var created: (Workspace) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var parent = ""
    @State private var agent = "codex"
    @State private var creating = false
    @State private var failure: String?
    @State private var requestId = UUID().uuidString
    private var valid: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 80 && ![".", ".."].contains(trimmed)
            && trimmed.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\").union(.controlCharacters)) == nil && !parent.isEmpty
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Folder name", text: $name).accessibilityIdentifier("workspace.name")
                    TextField("Parent folder on your computer", text: $parent).accessibilityIdentifier("workspace.parent")
                } header: { Text("New folder") } footer: {
                    Text("Creates \(parent.hasSuffix("/") ? parent : parent + "/")\(name.isEmpty ? "your-project" : name) on \(model.activeMachine?.name ?? "your computer"). Existing folders are never overwritten.")
                }
                Section("Start with") {
                    Picker("Session", selection: $agent) {
                        Text("Codex + terminal").tag("codex")
                        Text("Terminal only").tag("terminal")
                    }.accessibilityIdentifier("workspace.agent")
                }
                if let failure { Section { Text(failure).foregroundStyle(.red).accessibilityIdentifier("workspace.error") } }
                if creating { Section { HStack { ProgressView(); Text("Creating on your computer…") } } }
            }
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .disabled(creating)
            .navigationTitle("New workspace").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(creating) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        creating = true; failure = nil
                        Task {
                            do {
                                let workspace = try await model.createWorkspace(requestId: requestId, name: name.trimmingCharacters(in: .whitespacesAndNewlines), parentDirectory: parent, agent: agent)
                                creating = false; created(workspace); dismiss()
                            } catch { creating = false; failure = error.localizedDescription }
                        }
                    }.disabled(!valid || creating || !model.connected).accessibilityIdentifier("workspace.create")
                }
            }
            .onAppear { if parent.isEmpty { parent = model.defaultWorkspaceParent } }
            .onChange(of: name) { _, _ in requestId = UUID().uuidString; failure = nil }
            .onChange(of: parent) { _, _ in requestId = UUID().uuidString; failure = nil }
            .onChange(of: agent) { _, _ in requestId = UUID().uuidString; failure = nil }
            .interactiveDismissDisabled(creating)
        }
    }
}
