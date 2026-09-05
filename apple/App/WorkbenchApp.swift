import SwiftUI
import AuthenticationServices
import WorkbenchCore

@main struct WorkbenchRemoteApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            RootView(model: model).preferredColorScheme(.dark).tint(Color(red: 0.72, green: 0.86, blue: 0.58))
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
    }
    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Image(systemName: "terminal.fill").font(.system(size: 48)).foregroundStyle(.tint).padding(.top, 30)
                Text("Leave your desk.\nKeep your momentum.").font(.system(size: 34, weight: .medium, design: .serif))
                Text("Your agents and terminals keep running on your machine. Pick up the same sessions here.").foregroundStyle(.secondary)
                Button { showPairing = true } label: { Label(model.pairing == nil ? "Scan a pairing code" : "Continue pairing", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large)
                Text("Connection service").font(.subheadline.bold())
                TextField("https://relay.example.com", text: $model.relayText).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                    .onChange(of: model.relayText) { _, _ in model.challenge = nil }
                if let challenge = model.challenge {
                    SignInWithAppleButton(.signIn) { request in request.nonce = DeviceIdentity.nonceHash(challenge.nonce) } onCompletion: { result in Task { await model.signIn(result) } }
                        .signInWithAppleButtonStyle(.white).frame(height: 50)
                } else {
                    Button("Continue to sign-in") { Task { await model.prepareSignIn() } }.buttonStyle(.bordered).disabled(model.relayText.isEmpty)
                }
                Text("Scan the host’s QR code to fill in its relay address. Session content is encrypted between this iPhone and your machine.").font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }
    }
}
struct WorkspaceList: View {
    @ObservedObject var model: AppModel
    let machine: Machine
    @State private var query = ""
    @State private var devices = false
    var body: some View {
        List {
            Section {
                HStack { if model.connecting { ProgressView() }; Text(model.status).font(.footnote).foregroundStyle(.secondary) }
                if !model.connected { Button("Reconnect") { model.connect(machine) }.disabled(model.connecting) }
            }
            ForEach(model.workspaces.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.cwd.localizedCaseInsensitiveContains(query) }) { workspace in
                Section {
                    ForEach(workspace.panes) { pane in
                        NavigationLink(value: pane) {
                            Label { VStack(alignment: .leading, spacing: 4) { Text(pane.name); Text(pane.live ? "Live session" : "Saved · not running").font(.caption).foregroundStyle(.secondary) } }
                                icon: { Image(systemName: pane.kind == "agent" ? "sparkle" : "terminal") }
                        }.disabled(!pane.live || !model.connected)
                    }
                } header: { Text(workspace.name) } footer: { Text(workspace.cwd).font(.caption2) }
            }
        }
        .navigationTitle(machine.name).searchable(text: $query, prompt: "Find a workspace")
        .task { if model.activeMachine?.id != machine.id || (!model.connected && !model.connecting) { model.connect(machine) } }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { devices = true } label: { Image(systemName: "iphone.and.arrow.forward") }.accessibilityLabel("Paired devices") } }
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
