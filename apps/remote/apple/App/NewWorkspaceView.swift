import SwiftUI
import WorkbenchCore

struct NewWorkspaceView: View {
    @ObservedObject var model: AppModel
    var created: (Workspace) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var parent = ""
    @State private var mode = "create"
    @State private var existingFolder = ""
    @State private var pickingFolder = false
    @State private var agent = "codex"
    @State private var creating = false
    @State private var failure: String?
    @State private var requestId = UUID().uuidString
    private var valid: Bool {
        if mode == "open" { return model.canBrowseFolders && !existingFolder.isEmpty }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 80 && ![".", ".."].contains(trimmed)
            && trimmed.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\").union(.controlCharacters)) == nil && !parent.isEmpty
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Workspace", selection: $mode) {
                        Text("Create new").tag("create")
                        Text("Open existing").tag("open")
                    }.pickerStyle(.segmented).accessibilityIdentifier("workspace.mode")
                }
                if mode == "create" {
                Section {
                    TextField("Folder name", text: $name).accessibilityIdentifier("workspace.name")
                    TextField("Parent folder on your computer", text: $parent).accessibilityIdentifier("workspace.parent")
                    Button { pickingFolder = true } label: { Label("Choose parent folder", systemImage: "folder") }
                        .disabled(!model.canBrowseFolders).accessibilityIdentifier("workspace.browseParent")
                } header: { Text("New folder") } footer: {
                    Text("Creates \(parent.hasSuffix("/") ? parent : parent + "/")\(name.isEmpty ? "your-project" : name) on \(model.activeMachine?.name ?? "your computer"). Existing folders are never overwritten.")
                }
                } else {
                    Section {
                        TextField("Existing folder on your computer", text: $existingFolder)
                            .accessibilityIdentifier("workspace.existingFolder")
                        Button { pickingFolder = true } label: { Label("Choose existing folder", systemImage: "folder") }
                            .disabled(!model.canBrowseFolders).accessibilityIdentifier("workspace.browseExisting")
                    } header: { Text("Existing folder") } footer: {
                        Text(model.canBrowseFolders ? "Opens this folder without replacing its files. If it already has a workspace, its sessions are reused." : "Update the host companion to browse and open existing folders.")
                    }
                }
                Section {
                    Picker("Session", selection: $agent) {
                        if model.canStartSession {
                            Label("Workspace only", systemImage: "folder").tag("none")
                        }
                        Label { Text("Codex + terminal") } icon: { AgentIcon(harnessId: "codex", size: 18) }.tag("codex")
                        if model.canStartSession {
                            Label { Text("Claude + terminal") } icon: { AgentIcon(harnessId: "claude", size: 18) }.tag("claude")
                        }
                        Label("Terminal only", systemImage: "terminal").tag("terminal")
                    }.accessibilityIdentifier("workspace.agent")
                } header: { Text("Start with") } footer: {
                    Text(model.canStartSession ? "Optional. You can start agents later from the workspace. Opening a known workspace keeps its existing sessions." : "Update the host companion to create an empty workspace or start Claude.")
                }
                if let failure { Section { Text(failure).foregroundStyle(.red).accessibilityIdentifier("workspace.error") } }
                if creating { Section { HStack { ProgressView(); Text(mode == "open" ? "Opening on your computer…" : "Creating on your computer…") } } }
            }
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .disabled(creating)
            .navigationTitle(mode == "open" ? "Open workspace" : "New workspace").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(creating) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(mode == "open" ? "Open" : "Create") {
                        creating = true; failure = nil
                        Task {
                            do {
                                let folderName: String, parentDirectory: String
                                if mode == "open" {
                                    let folder = try await model.listFolders(path: existingFolder)
                                    guard folder.path != "/" else { throw WorkbenchError.message("Choose a project folder, not the filesystem root.") }
                                    folderName = (folder.path as NSString).lastPathComponent
                                    parentDirectory = (folder.path as NSString).deletingLastPathComponent
                                } else {
                                    folderName = name.trimmingCharacters(in: .whitespacesAndNewlines)
                                    parentDirectory = parent
                                }
                                let workspace = try await model.createWorkspace(requestId: requestId, name: folderName, parentDirectory: parentDirectory, agent: agent, mode: mode)
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
            .onChange(of: mode) { _, _ in requestId = UUID().uuidString; failure = nil }
            .onChange(of: existingFolder) { _, _ in requestId = UUID().uuidString; failure = nil }
            .sheet(isPresented: $pickingFolder) {
                HostFolderPicker(model: model, initialPath: mode == "open" ? (existingFolder.isEmpty ? parent : existingFolder) : parent) { path in
                    if mode == "open" { existingFolder = path } else { parent = path }
                }
            }
            .interactiveDismissDisabled(creating)
        }
    }
}
