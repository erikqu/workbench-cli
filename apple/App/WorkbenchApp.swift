import SwiftUI
import AuthenticationServices
import WorkbenchCore

@main struct WorkbenchRemoteApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .preferredColorScheme(.dark).tint(Color(red: 0.72, green: 0.86, blue: 0.58))
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { model.setForeground(false) }
                    else if phase == .active { model.setForeground(true) }
                }
                .onOpenURL { model.receivePairing($0.absoluteString) }
        }
    }
}
struct RootView: View {
    @ObservedObject var model: AppModel
    @State private var showPairing = false
    @State private var path = NavigationPath()
    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.login == nil { welcome }
                else {
                    List {
                        if model.machines.isEmpty {
                            ContentUnavailableView("Your work, wherever you are", systemImage: "desktopcomputer", description: Text("Pair a development machine to find its live Workbench sessions."))
                                .listRowBackground(Color.clear)
                        }
                        ForEach(model.machines) { machine in
                            NavigationLink(value: machine) {
                                HStack(spacing: 14) {
                                    Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 5) { Text(machine.name).font(.headline); Text(machine.online ? "Online" : "Companion offline").font(.caption).foregroundStyle(.secondary) }
                                    Spacer(); Circle().fill(machine.online ? Color.green : Color.gray).frame(width: 7, height: 7)
                                }.padding(.vertical, 8)
                            }
                        }
                        Button { showPairing = true } label: { Label("Add a machine", systemImage: "plus") }
                    }.refreshable { await model.refreshMachines() }.task { await model.refreshMachines() }
                }
            }
            .navigationTitle("Workbench")
            .toolbar {
                if model.login != nil {
                    ToolbarItem(placement: .topBarTrailing) { Menu { Button("Refresh") { Task { await model.refreshMachines() } }; Button("Sign out") { path = NavigationPath(); model.signOut() } } label: { Image(systemName: "person.crop.circle") } }
                }
            }
            .navigationDestination(for: Machine.self) { machine in WorkspaceList(model: model, machine: machine) }
            .navigationDestination(for: Pane.self) { pane in TerminalScreen(model: model, pane: pane) }
        }
        .sheet(isPresented: $showPairing) { PairingView(model: model) }
        .alert("Workbench", isPresented: Binding(get: { model.error != nil && !showPairing }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
        .onChange(of: model.pairing?.pairingId) { _, value in if value != nil { showPairing = true } }
        .task {
            if model.isPreview, path.isEmpty, let machine = model.machines.first,
               let pane = model.workspaces.first?.panes.first {
                path.append(machine)
                if !ProcessInfo.processInfo.arguments.contains("--workspace-list-preview") && !ProcessInfo.processInfo.arguments.contains("--workspace-activity-preview") { path.append(pane) }
            }
        }
    }
    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Image(systemName: "terminal.fill").font(.system(size: 48)).foregroundStyle(.tint).padding(.top, 30)
                Text("Leave your desk.\nKeep your momentum.").font(.system(size: 34, weight: .medium, design: .serif))
                Text("Your agents and terminals keep running on your machine. Pick up the same sessions here.").foregroundStyle(.secondary)
                Button { showPairing = true } label: { Label(model.pairing == nil ? "Scan a pairing code" : "Continue pairing", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large)
                if model.pairingAuthentication {
                    Text("Private connection through Tailscale").font(.subheadline.bold())
                    Text(model.relayText.isEmpty ? "Scan Supernova’s pairing code to connect." : model.relayText)
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text("Connection service").font(.subheadline.bold())
                    TextField("https://relay.example.com", text: $model.relayText).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        .onChange(of: model.relayText) { _, _ in model.challenge = nil }
                    if let challenge = model.challenge {
                        SignInWithAppleButton(.signIn) { request in request.nonce = DeviceIdentity.nonceHash(challenge.nonce) } onCompletion: { result in Task { await model.signIn(result) } }
                            .signInWithAppleButtonStyle(.white).frame(height: 50)
                    } else {
                        Button("Continue to sign-in") { Task { await model.prepareSignIn() } }.buttonStyle(.bordered).disabled(model.relayText.isEmpty)
                    }
                }
                Text("Scan the host’s QR code to fill in its relay address. Session content is encrypted between this iPhone and your machine.").font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }
    }
}
struct WorkspaceList: View {
    @ObservedObject var model: AppModel
    let machine: Machine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    @State private var devices = false
    @State private var newWorkspace = false
    @State private var createdPane: Pane?
    @State private var fileWorkspace: Workspace?
    private var visibleWorkspaces: [Workspace] {
        let filtered = model.workspaces.filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.cwd.localizedCaseInsensitiveContains(query)
        }
        // Partition instead of sorting: preserve host order inside both groups.
        return filtered.filter { activity(in: $0).isActive } + filtered.filter { !activity(in: $0).isActive }
    }

    private func isActive(_ pane: Pane) -> Bool {
        model.connected && pane.live && pane.kind == "agent" && ["working", "recent"].contains(pane.activity ?? "")
    }

    private func activity(in workspace: Workspace) -> WorkspaceListActivity {
        let agents = workspace.panes.filter(isActive)
        return WorkspaceListActivity(working: agents.filter { $0.activity == "working" }.count,
                                     recent: agents.filter { $0.activity == "recent" }.count)
    }

    private func paneStatus(_ pane: Pane) -> String {
        if !pane.live { return "Saved · not running" }
        if !model.connected { return "Offline" }
        if isActive(pane) { return pane.activity == "working" ? "Working" : "Recent activity" }
        return pane.kind == "agent" ? "Idle" : "Live session"
    }

    @ViewBuilder private var activeIndicator: some View {
        if reduceMotion {
            Image(systemName: "circle.fill").font(.system(size: 8)).foregroundStyle(.green)
                .accessibilityHidden(true)
        } else {
            ProgressView().controlSize(.mini).tint(.green).accessibilityHidden(true)
        }
    }

    var body: some View {
        List {
            Section {
                HStack { if model.connecting { ProgressView() }; Text(model.status).font(.footnote).foregroundStyle(.secondary) }
                if !model.connected { Button("Reconnect") { model.connect(machine) }.disabled(model.connecting) }
                Button { newWorkspace = true } label: { Label("New workspace", systemImage: "folder.badge.plus") }
                    .disabled(!model.connected || !model.canCreateWorkspace).accessibilityIdentifier("workspace.new")
                if model.connected && !model.canCreateWorkspace {
                    Text("Update the host companion to create workspaces here.").font(.caption).foregroundStyle(.secondary)
                }
            }
            ForEach(visibleWorkspaces) { workspace in
                Section {
                    ForEach(workspace.panes) { pane in
                        NavigationLink(value: pane) {
                            Label {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(pane.name)
                                    Text(paneStatus(pane)).font(.caption)
                                        .foregroundStyle(isActive(pane) ? Color.green : Color.secondary)
                                }
                            } icon: {
                                if isActive(pane) { activeIndicator }
                                else { Image(systemName: pane.kind == "agent" ? "sparkle" : "terminal") }
                            }
                        }.disabled(!pane.live || !model.connected)
                            .accessibilityIdentifier("workspace.pane.\(pane.id)")
                            .accessibilityLabel(pane.name).accessibilityValue(paneStatus(pane))
                    }
                    if !workspace.cwd.isEmpty {
                        Button { fileWorkspace = workspace } label: { Label("Files", systemImage: "folder") }
                            .disabled(!model.connected || !model.canBrowseFiles)
                    }
                } header: {
                    let summary = activity(in: workspace)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(workspace.name).accessibilityIdentifier("workspace.header.\(workspace.id)")
                        if summary.isActive {
                            HStack(spacing: 7) {
                                activeIndicator
                                Text(summary.label).font(.caption).foregroundStyle(.green)
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Workspace activity")
                            .accessibilityValue(summary.label)
                            .accessibilityIdentifier("workspace.activity.\(workspace.id)")
                        }
                    }.textCase(nil)
                } footer: { Text(workspace.cwd).font(.caption2) }
            }
        }
        .accessibilityIdentifier("workspace.list")
        .navigationTitle(machine.name).searchable(text: $query, prompt: "Find a workspace")
        .task { if model.activeMachine?.id != machine.id || (!model.connected && !model.connecting) { model.connect(machine) } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button { newWorkspace = true } label: { Label("New", systemImage: "plus") }.disabled(!model.connected || !model.canCreateWorkspace) }
            ToolbarItem(placement: .topBarTrailing) { Button { devices = true } label: { Image(systemName: "iphone.and.arrow.forward") }.accessibilityLabel("Paired devices") }
        }
        .sheet(isPresented: $newWorkspace) {
            NewWorkspaceView(model: model) { workspace in
                query = ""
                createdPane = workspace.panes.first(where: { $0.live })
            }
        }
        .navigationDestination(item: $createdPane) { pane in TerminalScreen(model: model, pane: pane) }
        .sheet(item: $fileWorkspace) { workspace in WorkspaceFilesView(model: model, workspace: workspace) }
        .sheet(isPresented: $devices) {
            NavigationStack {
                List(model.grants) { grant in
                    HStack { VStack(alignment: .leading) { Text(grant.name); if grant.id == model.login?.deviceId { Text("This iPhone").font(.caption).foregroundStyle(.secondary) } }; Spacer(); Button("Revoke", role: .destructive) { Task { await model.revoke(grant) } } }
                }.navigationTitle("Paired devices").task { await model.loadGrants() }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { devices = false } } }
            }
        }
    }
}

private struct WorkspaceListActivity {
    let working: Int
    let recent: Int
    var isActive: Bool { working + recent > 0 }
    var label: String {
        if working > 0 {
            return "Working · \(working) \(working == 1 ? "agent" : "agents")" + (recent > 0 ? " · \(recent) recent" : "")
        }
        return "Recent activity · \(recent) \(recent == 1 ? "agent" : "agents")"
    }
}
