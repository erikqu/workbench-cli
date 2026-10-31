import SwiftUI
import AuthenticationServices
import WorkbenchCore

@main struct WorkbenchRemoteApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .preferredColorScheme(.dark).tint(Color.accentColor)
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
                                    Spacer(); Circle().fill(machine.online ? Color.accentColor : Color.gray).frame(width: 7, height: 7)
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
                if !["--workspace-list-preview", "--workspace-activity-preview", "--session-cycle-preview", "--saved-workspaces-preview"].contains(where: ProcessInfo.processInfo.arguments.contains) { path.append(pane) }
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
    @State private var showPastSessions = false
    @State private var devices = false
    @State private var newWorkspace = false
    @State private var createdPane: Pane?
    @State private var fileWorkspace: Workspace?
    @State private var gitSummaries: [String: GitSummary] = [:]
    @State private var startTarget: WorkspaceSessionStart?
    @State private var pendingDeletion: WorkspaceSessionDeletion?
    @State private var confirmingDeletion = false
    @State private var deletingSessionId: String?
    @State private var deletionError: String?
    private var matchingWorkspaces: [Workspace] {
        model.workspaces.filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.cwd.localizedCaseInsensitiveContains(query)
        }
    }
    private var hasPastSessions: Bool {
        matchingWorkspaces.contains { $0.panes.isEmpty || $0.panes.contains { !$0.live } }
    }
    private var visibleWorkspaces: [Workspace] {
        let filtered = matchingWorkspaces.filter { showPastSessions || $0.panes.contains { $0.live } }
        // An explicit request for attention comes first; preserve host order inside each group.
        return filtered.filter { activity(in: $0).waiting > 0 }
            + filtered.filter { activity(in: $0).waiting == 0 && activity(in: $0).isActive }
            + filtered.filter { !activity(in: $0).isActive }
    }

    private func isActive(_ pane: Pane) -> Bool {
        model.connected && pane.live && pane.kind == "agent" && ["waiting", "working", "recent"].contains(pane.activity ?? "")
    }

    private func activity(in workspace: Workspace) -> WorkspaceListActivity {
        let agents = workspace.panes.filter(isActive)
        return WorkspaceListActivity(waiting: agents.filter { $0.activity == "waiting" }.count,
                                     working: agents.filter { $0.activity == "working" }.count,
                                     recent: agents.filter { $0.activity == "recent" }.count)
    }

    private func paneStatus(_ pane: Pane) -> String {
        pane.statusLabel(connected: model.connected)
    }

    private func statusColor(_ pane: Pane) -> Color {
        guard isActive(pane) else { return .secondary }
        return pane.activity == "waiting" ? .orange : .accentColor
    }

    private func startAgent(for pane: Pane) -> String {
        let value = (pane.harnessId ?? pane.name).lowercased().filter { $0.isLetter || $0.isNumber }
        return ["claude", "claudecode", "anthropicclaude", "anthropicclaudecode"].contains(value) ? "claude" : "codex"
    }

    private func requestStart(in workspace: Workspace, agent: String = "codex") {
        guard canStart(in: workspace) else { return }
        startTarget = WorkspaceSessionStart(workspace: workspace, agent: agent)
    }

    private func hasSafeFolder(_ workspace: Workspace) -> Bool {
        !workspace.cwd.isEmpty && workspace.id != "__unlisted" && workspace.cwd != "__unlisted"
    }

    private func canStart(in workspace: Workspace) -> Bool {
        model.connected && model.canStartSession && deletingSessionId == nil && hasSafeFolder(workspace)
    }

    @ViewBuilder private func paneLabel(_ pane: Pane) -> some View {
        HStack(spacing: 10) {
            AgentIcon(pane: pane, size: 18)
            Text(pane.name).font(.subheadline).lineLimit(1)
            Spacer(minLength: 6)
            HStack(spacing: 5) {
                if isActive(pane) {
                    if pane.activity == "waiting" { Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange).accessibilityHidden(true) }
                    else if pane.activity == "working" { activeIndicator }
                    else { Circle().fill(Color.accentColor).frame(width: 6, height: 6).accessibilityHidden(true) }
                }
                Text(paneStatus(pane)).font(.caption).lineLimit(1).foregroundStyle(statusColor(pane))
            }
        }.frame(minHeight: 44).contentShape(Rectangle())
    }

    @ViewBuilder private var activeIndicator: some View {
        if reduceMotion {
            Image(systemName: "circle.fill").font(.system(size: 8)).foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
        } else {
            ProgressView().controlSize(.mini).tint(Color.accentColor).accessibilityHidden(true)
        }
    }

    @ViewBuilder private func workspaceHeader(_ workspace: Workspace, displayedPanes: [Pane]) -> some View {
        let summary = activity(in: workspace)
        HStack(spacing: 8) {
            Image(systemName: "folder.fill")
                .font(.subheadline)
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.name).font(.headline).foregroundStyle(.primary)
                    .lineLimit(1).layoutPriority(1)
                    .accessibilityIdentifier("workspace.header.\(workspace.id)")
                    .accessibilityHint(workspace.cwd)
                if let git = gitSummaries[workspace.id], git.isRepository {
                    HStack(spacing: 7) {
                        if git.added > 0 { Text("+\(git.added)").foregroundStyle(.green) }
                        if git.deleted > 0 { Text("−\(git.deleted)").foregroundStyle(.red) }
                        if git.untracked > 0 { Text("\(git.untracked) new").foregroundStyle(.secondary) }
                        if git.added == 0 && git.deleted == 0 && git.untracked == 0 { Text("Git clean").foregroundStyle(.secondary) }
                    }
                    .font(.caption.monospacedDigit())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Git changes")
                    .accessibilityValue("\(git.added) added lines, \(git.deleted) deleted lines, \(git.untracked) untracked files")
                    .accessibilityIdentifier("workspace.git.\(workspace.id)")
                }
            }
            Spacer(minLength: 0)
            if summary.isActive {
                HStack(spacing: 5) {
                    if summary.waiting > 0 { Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange).accessibilityHidden(true) }
                    else if summary.working > 0 { activeIndicator }
                    else { Circle().fill(Color.accentColor).frame(width: 6, height: 6).accessibilityHidden(true) }
                    Text(summary.compactLabel).font(.caption2).foregroundStyle(summary.waiting > 0 ? Color.orange : Color.accentColor).lineLimit(1)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Workspace activity")
                .accessibilityValue(summary.label)
                .accessibilityIdentifier("workspace.activity.\(workspace.id)")
            }
            Button { requestStart(in: workspace) } label: {
                Image(systemName: "plus").font(.subheadline).frame(width: 44, height: 44)
            }
            .buttonStyle(.borderless).disabled(!canStart(in: workspace))
            .accessibilityLabel("Start agent in \(workspace.name)")
            .accessibilityHint(hasSafeFolder(workspace) ? "Start a new agent or terminal without changing existing sessions" : "This workspace has no project folder. Open a folder first.")
            .accessibilityIdentifier("workspace.start.\(workspace.id)")
            if hasSafeFolder(workspace) {
                Button { fileWorkspace = workspace } label: {
                    Image(systemName: "folder").font(.subheadline).frame(width: 44, height: 44)
                }
                .buttonStyle(.borderless).disabled(!model.connected || !model.canBrowseFiles)
                .accessibilityLabel("Files in \(workspace.name)")
                .accessibilityIdentifier("workspace.files.\(workspace.id)")
            }
            if !displayedPanes.isEmpty && !displayedPanes.contains(where: { $0.kind == "agent" }) {
                Menu {
                    ForEach(displayedPanes) { pane in
                        Button { createdPane = pane } label: { Label("Open \(pane.name)", systemImage: "terminal") }
                            .disabled(!model.connected || !pane.live)
                            .accessibilityIdentifier("workspace.terminal.\(pane.id)")
                        Button { requestDeletion(pane, workspace: workspace) } label: { Label("Delete \(pane.name)", systemImage: "trash") }
                            .disabled(!model.canDeleteSession)
                            .accessibilityIdentifier("session.delete.\(pane.id)")
                    }
                    if !model.canDeleteSession { Text("Update the host companion to delete sessions.") }
                } label: {
                    Image(systemName: "terminal").font(.subheadline).frame(width: 44, height: 44)
                }
                .disabled(!model.connected || deletingSessionId != nil)
                .accessibilityLabel("Open terminal in \(workspace.name)")
                .accessibilityIdentifier("workspace.terminals.\(workspace.id)")
            }
        }
        .padding(.leading, 4)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .listRowBackground(Color.accentColor.opacity(0.08))
    }

    private func requestDeletion(_ pane: Pane, workspace: Workspace) {
        guard model.connected, model.canDeleteSession, deletingSessionId == nil else { return }
        pendingDeletion = WorkspaceSessionDeletion(pane: pane, workspaceId: workspace.id, workspaceName: workspace.name)
        confirmingDeletion = true
    }

    private func deleteSession(_ target: WorkspaceSessionDeletion) {
        guard deletingSessionId == nil else { return }
        guard model.connected, model.canDeleteSession else {
            pendingDeletion = nil
            deletionError = "Reconnect to a compatible host companion before deleting “\(target.pane.name)” in “\(target.workspaceName)”. No deletion was requested."
            return
        }
        deletingSessionId = target.pane.id
        pendingDeletion = nil
        Task { @MainActor in
            defer { deletingSessionId = nil }
            do { try await model.deleteSession(target.pane, workspaceId: target.workspaceId) }
            catch {
                deletionError = "Couldn’t delete “\(target.pane.name)” in “\(target.workspaceName)”. \(error.localizedDescription)"
            }
        }
    }

    var body: some View {
        List {
            if !model.connected {
                HStack(spacing: 8) {
                    if model.connecting { ProgressView().controlSize(.small) }
                    Text(model.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Spacer(minLength: 8)
                    if !model.connecting { Button("Reconnect") { model.connect(machine) }.font(.subheadline) }
                }
            }
            if hasPastSessions {
                Button {
                    showPastSessions.toggle()
                } label: {
                    Label(showPastSessions ? "Hide past sessions" : "Show past sessions", systemImage: "clock.arrow.circlepath")
                }
                .font(.subheadline)
                .accessibilityIdentifier("workspace.pastSessions")
            }
            if visibleWorkspaces.isEmpty {
                if !matchingWorkspaces.isEmpty {
                    ContentUnavailableView("No live sessions", systemImage: "terminal", description: Text("Use Past sessions to find saved workspaces or start a new agent."))
                } else if query.isEmpty {
                    ContentUnavailableView("No workspaces yet", systemImage: "folder", description: Text("Use New to create a workspace or open an existing folder."))
                } else {
                    ContentUnavailableView.search(text: query)
                }
            }
            ForEach(visibleWorkspaces) { workspace in
                let displayedPanes = workspace.panes.filter { showPastSessions || $0.live }
                Section {
                    workspaceHeader(workspace, displayedPanes: displayedPanes)
                    if displayedPanes.isEmpty {
                        HStack {
                            Text("No live sessions").font(.subheadline).foregroundStyle(.secondary)
                            Spacer()
                            Button("Start agent") { requestStart(in: workspace) }
                                .buttonStyle(.borderless).font(.subheadline)
                                .frame(minHeight: 44)
                                .disabled(!canStart(in: workspace))
                                .accessibilityIdentifier("workspace.start.empty.\(workspace.id)")
                        }.padding(.leading, 10)
                            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }
                    ForEach(displayedPanes.filter { $0.kind == "agent" }) { pane in
                        HStack(spacing: 2) {
                            if pane.live {
                                NavigationLink(value: pane) { paneLabel(pane) }
                                    .buttonStyle(.plain)
                                    .disabled(!model.connected || deletingSessionId == pane.id)
                                    .accessibilityIdentifier("workspace.pane.\(pane.id)")
                                    .accessibilityLabel(pane.name).accessibilityValue(paneStatus(pane))
                            } else {
                                Button { requestStart(in: workspace, agent: startAgent(for: pane)) } label: { paneLabel(pane) }
                                    .buttonStyle(.plain)
                                    .disabled(!canStart(in: workspace))
                                    .accessibilityIdentifier("workspace.pane.\(pane.id)")
                                    .accessibilityLabel(pane.name).accessibilityValue(paneStatus(pane))
                                    .accessibilityHint("Start a new session. The stopped session is kept until you delete it.")
                            }
                            Menu {
                                Button { requestStart(in: workspace, agent: startAgent(for: pane)) } label: {
                                    Label("Start new \(startAgent(for: pane) == "claude" ? "Claude" : "Codex")", systemImage: "plus")
                                }
                                .disabled(!canStart(in: workspace))
                                .accessibilityIdentifier("workspace.startNew.\(pane.id)")
                                if !model.canStartSession { Text("Update the host companion to start sessions.") }
                                Button { requestDeletion(pane, workspace: workspace) } label: {
                                    Label("Delete session", systemImage: "trash")
                                }
                                .disabled(!model.canDeleteSession)
                                .accessibilityIdentifier("session.delete.\(pane.id)")
                                if !model.canDeleteSession { Text("Update the host companion to delete sessions.") }
                            } label: {
                                Group {
                                    if deletingSessionId == pane.id { ProgressView().controlSize(.small) }
                                    else { Image(systemName: "ellipsis").font(.subheadline) }
                                }.frame(width: 44, height: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            .disabled(!model.connected || deletingSessionId != nil)
                            .accessibilityLabel("Session actions for \(pane.name)")
                            .accessibilityIdentifier("workspace.actions.\(pane.id)")
                        }
                        .padding(.leading, 10)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button { requestDeletion(pane, workspace: workspace) } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            .tint(.red)
                            .disabled(!model.connected || !model.canDeleteSession || deletingSessionId != nil)
                            .accessibilityIdentifier("session.delete.\(pane.id)")
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }
                }
            }
        }
        .listStyle(.plain)
        .contentMargins(.top, 8, for: .scrollContent)
        .environment(\.defaultMinListRowHeight, 44)
        .accessibilityIdentifier("workspace.list")
        .navigationTitle(machine.name).navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Find a workspace")
        .alert("Delete session?", isPresented: $confirmingDeletion, presenting: pendingDeletion) { target in
            Button("Cancel", role: .cancel) { pendingDeletion = nil }
                .accessibilityIdentifier("session.delete.cancel")
            Button("Delete session", role: .destructive) { deleteSession(target) }
                .accessibilityIdentifier("session.delete.confirm")
        } message: { target in
            Text("Delete “\(target.pane.name)” in “\(target.workspaceName)”? Any running agent or shell will stop, and its terminal history will be lost. Workspace files are kept.")
        }
        .alert("Couldn’t delete session", isPresented: Binding(get: { deletionError != nil }, set: { if !$0 { deletionError = nil } })) {
            Button("OK", role: .cancel) { deletionError = nil }
        } message: { Text(deletionError ?? "") }
        .task { if model.activeMachine?.id != machine.id || (!model.connected && !model.connecting) { model.connect(machine) } }
        .task(id: "\(machine.id)-\(model.connected)-\(model.canViewGitChanges)-\(model.workspaces.map(\.id).joined(separator: ","))") {
            gitSummaries = [:]
            guard model.connected && model.canViewGitChanges else { return }
            while !Task.isCancelled {
                for workspace in model.workspaces where hasSafeFolder(workspace) {
                    if Task.isCancelled { return }
                    if let summary = try? await model.gitSummary(workspaceId: workspace.id) {
                        gitSummaries[workspace.id] = summary
                    }
                }
                try? await Task.sleep(for: .seconds(15))
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New") { newWorkspace = true }
                    .disabled(!model.connected || !model.canCreateWorkspace)
                    .accessibilityLabel("New workspace").accessibilityIdentifier("workspace.new")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { createdPane = model.nextSession() } label: { Image(systemName: "arrow.right.to.line") }
                    .disabled(!model.connected || model.liveSessionCount == 0)
                    .accessibilityLabel("Next session")
                    .accessibilityHint("Cycles through live sessions across all workspaces")
                    .accessibilityIdentifier("workspace.nextSession")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Text(model.status)
                    Text("Activity is estimated. Open a session to check approvals.")
                    if model.connected && !model.canCreateWorkspace { Text("Update the host companion to create workspaces.") }
                    if model.connected && !model.canStartSession { Text("Update the host companion to start sessions.") }
                    Button { devices = true } label: { Label("Paired devices", systemImage: "iphone.and.arrow.forward") }
                } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Workspace options")
                    .accessibilityIdentifier("workspace.options")
            }
        }
        .sheet(isPresented: $newWorkspace) {
            NewWorkspaceView(model: model) { workspace in
                query = ""
                if !workspace.panes.contains(where: { $0.live }) { showPastSessions = true }
                createdPane = workspace.panes.first(where: { $0.live && $0.kind == "agent" }) ?? workspace.panes.first(where: { $0.live })
            }
        }
        .navigationDestination(item: $createdPane) { pane in TerminalScreen(model: model, pane: pane) }
        .sheet(item: $startTarget) { target in
            StartSessionView(model: model, workspace: target.workspace, initialAgent: target.agent) { pane in
                createdPane = pane
            }
        }
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

private struct WorkspaceSessionDeletion {
    let pane: Pane
    let workspaceId: String
    let workspaceName: String
}

private struct WorkspaceSessionStart: Identifiable {
    let id = UUID()
    let workspace: Workspace
    let agent: String
}

private struct WorkspaceListActivity {
    let waiting: Int
    let working: Int
    let recent: Int
    var isActive: Bool { waiting + working + recent > 0 }
    var compactLabel: String {
        if waiting > 0 { return "\(waiting) need input" }
        if working > 0 { return "\(working) working" + (recent > 0 ? " · \(recent) output" : "") }
        return "\(recent) output"
    }
    var label: String {
        if waiting > 0 {
            return "Needs input · \(waiting) \(waiting == 1 ? "agent" : "agents")" + (working > 0 ? " · \(working) working" : "") + (recent > 0 ? " · \(recent) recent output" : "")
        }
        if working > 0 {
            return "Working · \(working) \(working == 1 ? "agent" : "agents")" + (recent > 0 ? " · \(recent) recent output" : "")
        }
        return "Recent output · \(recent) \(recent == 1 ? "agent" : "agents")"
    }
}
