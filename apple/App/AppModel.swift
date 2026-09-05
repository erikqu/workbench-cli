import Foundation
import Combine
import AuthenticationServices
import UIKit
import WorkbenchCore

@MainActor final class AppModel: ObservableObject {
    @Published var relayText = ""
    @Published var login: Login?
    @Published var challenge: LoginChallenge?
    @Published var machines: [Machine] = []
    @Published var workspaces: [Workspace] = []
    @Published var activeMachine: Machine?
    @Published var activePane: Pane?
    @Published var sessionState: SessionState?
    @Published var connected = false
    @Published var connecting = false
    @Published var canCreateWorkspace = false
    @Published var canBrowseFiles = false
    @Published var status = "Ready to connect"
    @Published var error: String?
    @Published var pairing: PairingQR?
    @Published var pairingCode: String?
    @Published var claiming = false
    @Published var grants: [DeviceGrant] = []
    @Published var draft = ""
    @Published var fontSize: Double = 13 {
        didSet { if !isPreview { UserDefaults.standard.set(fontSize, forKey: "terminalFontSize") } }
    }
    let output = PassthroughSubject<Data, Never>()
    let resetTerminal = PassthroughSubject<Void, Never>()
    let keyboardVisibility = PassthroughSubject<Bool, Never>()
    var terminalSize = (cols: 80, rows: 24)
    private var attachment = UUID()
    private var fitOnNextWritableState = false
    private var lastWorkspaceDirectory: String?
    var isPreview: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("--terminal-render-fixture")
#else
        false
#endif
    }
    var bracketedPaste = false
    private var identity: DeviceIdentity?
    private var pins: [String: String] = [:]
    private var connection: SSHConnection?
    private var generation = UUID()
    private var retries = 0
    private var reconnectTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var foreground = true
    private var desiredSession: Pane?
    private var pairingTask: Task<Void, Never>?
    private var disconnectHandled = false
    private struct SavedLogin: Codable { let relay: String; let login: Login }
    var pairingAuthentication: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "WorkbenchAuthMode") as? String)?.lowercased() == "pairing"
    }
    init() {
#if DEBUG
        if isPreview {
            machines = [PreviewSession.machine]
            workspaces = [PreviewSession.workspace]
            login = PreviewSession.login
            canCreateWorkspace = true
            canBrowseFiles = true
            return
        }
#endif
        if let saved = UserDefaults.standard.object(forKey: "terminalFontSize") as? Double {
            fontSize = min(22, max(10, saved))
        }
        relayText = UserDefaults.standard.string(forKey: "relay") ?? (Bundle.main.object(forInfoDictionaryKey: "WorkbenchRelayURL") as? String ?? "")
        if relayText.contains("$(") { relayText = "" }
        do {
            identity = try DeviceIdentity(rawPrivateKey: Keychain.read("device-key"))
            try Keychain.write("device-key", data: identity!.rawPrivateKey)
            if let data = try Keychain.read("host-pins") { pins = try JSONDecoder().decode([String: String].self, from: data) }
            if let data = try Keychain.read("login") {
                let saved = try JSONDecoder().decode(SavedLogin.self, from: data)
                if saved.login.expiresAt > Date().timeIntervalSince1970 * 1000 { relayText = saved.relay; login = saved.login }
            }
        } catch { self.error = error.localizedDescription }
    }
    private func api() throws -> APIClient { APIClient(origin: try relayOrigin(relayText), accessToken: login?.accessToken) }
    private func pinKey(_ machineId: String) -> String { relayText.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + machineId }
    func prepareSignIn() async {
        do { challenge = try await api().request("v1/auth/challenge", method: "POST", body: [:]); error = nil }
        catch { self.error = error.localizedDescription; challenge = nil }
    }
    func signIn(_ result: Result<ASAuthorization, Error>) async {
        defer { challenge = nil }
        do {
            let authorization = try result.get()
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential, let data = credential.identityToken,
                  let identityToken = String(data: data, encoding: .utf8), let challenge, let identity else { throw WorkbenchError.message("Apple sign-in did not return a valid identity. Try again.") }
            let value: Login = try await api().request("v1/auth/apple", method: "POST", body: ["identityToken": identityToken, "challengeId": challenge.challengeId, "publicKey": identity.publicKey, "name": UIDevice.current.name])
            let origin = try relayOrigin(relayText).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            try Keychain.write("login", data: JSONEncoder().encode(SavedLogin(relay: origin, login: value)))
            relayText = origin; login = value; UserDefaults.standard.set(origin, forKey: "relay")
            await refreshMachines()
        } catch { self.error = error.localizedDescription }
    }
    func signInWithPairing() async {
        guard let pairing, let identity else { return }
        claiming = true
        defer { claiming = false }
        do {
            let value: Login = try await api().request("v1/auth/pairing", method: "POST", body: [
                "pairingId": pairing.pairingId, "secret": pairing.secret,
                "publicKey": identity.publicKey, "name": UIDevice.current.name
            ])
            let origin = try relayOrigin(relayText).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            try Keychain.write("login", data: JSONEncoder().encode(SavedLogin(relay: origin, login: value)))
            relayText = origin; login = value; UserDefaults.standard.set(origin, forKey: "relay")
            await claimPairing()
        } catch { self.error = error.localizedDescription }
    }
    func signOut() {
        disconnect(); pairingTask?.cancel(); pairing = nil; pairingCode = nil
        do { try Keychain.write("login", data: nil); login = nil; machines = []; challenge = nil }
        catch { self.error = error.localizedDescription }
    }
    func refreshMachines() async {
        if isPreview { return }
        guard login != nil else { return }
        do { let response: MachinesResponse = try await api().request("v1/machines"); machines = response.machines }
        catch { self.error = error.localizedDescription }
    }
    func receivePairing(_ link: String) {
        do {
            let value = try PairingQR(link: link)
            let origin = try relayOrigin(value.relay).absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if login != nil && origin != relayText { throw WorkbenchError.message("This code uses a different relay. Sign out before switching servers.") }
            relayText = origin; pairing = value; pairingCode = nil; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func claimPairing() async {
        guard let pairing, let identity, login != nil else { return }
        claiming = true
        defer { claiming = false }
        do {
            let _: StatusResponse = try await api().request("v1/pairings/\(pairing.pairingId)/claim", method: "POST", body: ["secret": pairing.secret])
            pairingCode = try pairing.verificationCode(devicePublicKey: identity.publicKey)
            pairingTask?.cancel()
            pairingTask = Task { [weak self] in
                guard let self else { return }
                for _ in 0..<120 {
                    if Task.isCancelled { return }
                    await refreshMachines()
                    if machines.contains(where: { $0.id == pairing.machineId }) {
                        pins[pinKey(pairing.machineId)] = pairing.hostKey
                        do { try Keychain.write("host-pins", data: JSONEncoder().encode(pins)) }
                        catch { self.error = error.localizedDescription; return }
                        self.pairing = nil; pairingCode = nil; status = "Machine paired"; return
                    }
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
                error = "Pairing was not confirmed. Generate a new code on the host and try again."
            }
        } catch { self.error = error.localizedDescription }
    }
    func cancelPairing() { pairingTask?.cancel(); pairing = nil; pairingCode = nil }
    func connect(_ machine: Machine) {
#if DEBUG
        if isPreview {
            activeMachine = machine; connected = true; status = "Preview · sample session"
            return
        }
#endif
        guard let login, let identity else { return }
        reconnectTask?.cancel(); connectTask?.cancel(); connection?.close()
        let attempt = UUID(); generation = attempt
        disconnectHandled = false; reconnectTask = nil
        if activeMachine?.id != machine.id { desiredSession = nil; activePane = nil; workspaces = []; lastWorkspaceDirectory = nil }
        activeMachine = machine; connected = false; connecting = true; sessionState = nil; status = "Connecting…"
        canCreateWorkspace = false
        canBrowseFiles = false
        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard let key = pins[pinKey(machine.id)], key == machine.hostKey else { throw WorkbenchError.hostIdentityChanged }
                let remote = SSHConnection(); connection = remote
                try await remote.connect(origin: relayOrigin(relayText), machineId: machine.id, hostKey: key, login: login, identity: identity,
                    onEvent: { [weak self] event in Task { @MainActor in guard let self, self.generation == attempt else { return }; self.handle(event) } },
                    onDisconnect: { [weak self] error in Task { @MainActor in guard let self, self.generation == attempt else { return }; self.lost(error) } })
                guard generation == attempt, !Task.isCancelled else { remote.close(); return }
                connecting = false; connected = true; retries = 0; status = "Connected to \(machine.name)"
                if let desiredSession { await open(desiredSession) }
            } catch {
                guard generation == attempt else { return }
                connecting = false; lost(error)
            }
        }
    }
    private func handle(_ event: ControlEvent) {
        if event.type == "hello" {
            canCreateWorkspace = event.capabilities?.contains("createWorkspace") == true
            canBrowseFiles = event.capabilities?.contains("files") == true
        }
        if let snapshot = event.snapshot { workspaces = snapshot.workspaces; if let warning = snapshot.warning { status = warning } }
        if let state = event.sessionState, state.sessionId == activePane?.id { receiveSessionState(state) }
        if event.type == "error" { error = event.message }
    }
    private func receiveSessionState(_ state: SessionState) {
        sessionState = state
        guard fitOnNextWritableState, state.writable else { return }
        fitOnNextWritableState = false
        guard !state.phoneLayout else { return }
        let attempt = generation, opened = attachment
        Task { [weak self] in
            guard let self, generation == attempt, attachment == opened,
                  activePane?.id == state.sessionId else { return }
            await setPhoneLayout(true)
        }
    }
    func open(_ pane: Pane) async {
        lastWorkspaceDirectory = workspaces.first { $0.panes.contains { $0.id == pane.id } }?.cwd ?? lastWorkspaceDirectory
#if DEBUG
        if isPreview {
            activePane = pane; connected = true; status = "Preview · sample session"
            fitOnNextWritableState = !ProcessInfo.processInfo.arguments.contains("--desktop-preview")
            receiveSessionState(PreviewSession.state(sessionId: pane.id, phoneLayout: false, cols: 120, rows: 40))
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled, activePane?.id == pane.id else { return }
            resetTerminal.send(())
            output.send(Data(PreviewSession.sample.utf8))
            return
        }
#endif
        guard connected, pane.live, let connection else { return }
        if activePane?.id == pane.id, sessionState != nil { return }
        saveDraft()
        activePane = pane; desiredSession = pane; sessionState = nil
        fitOnNextWritableState = true
        draft = UserDefaults.standard.string(forKey: draftKey) ?? ""
        resetTerminal.send(())
        attachment = UUID()
        let attempt = generation, paneId = pane.id, opened = attachment
        do {
            try await connection.attach(sessionId: pane.id, cols: terminalSize.cols, rows: terminalSize.rows, output: { [weak self] data in
                Task { @MainActor in guard let self, self.generation == attempt, self.attachment == opened, self.activePane?.id == paneId else { return }; self.output.send(data) }
            }, ended: { [weak self] in
                Task { @MainActor in guard let self, self.generation == attempt, self.attachment == opened, self.activePane?.id == paneId else { return }; self.sessionState = nil; self.status = "Session detached. Reopen it to reconnect." }
            })
        } catch { if generation == attempt, attachment == opened, !(error is CancellationError) { self.error = error.localizedDescription } }
    }
    var defaultWorkspaceParent: String {
        let cwd = lastWorkspaceDirectory ?? workspaces.first(where: { !$0.cwd.isEmpty })?.cwd
        return cwd.map { ($0 as NSString).deletingLastPathComponent }.flatMap { $0.isEmpty ? nil : $0 } ?? "~"
    }
    func createWorkspace(requestId: String, name: String, parentDirectory: String, agent: String) async throws -> Workspace {
        guard connected else { throw WorkbenchError.disconnected }
#if DEBUG
        if isPreview {
            let workspace = PreviewSession.newWorkspace(name: name, parentDirectory: parentDirectory, agent: agent)
            workspaces.append(workspace)
            return workspace
        }
#endif
        guard let connection, canCreateWorkspace else { throw WorkbenchError.message("Update the host companion to create workspaces from this iPhone.") }
        let attempt = generation
        let workspace = try await connection.createWorkspace(requestId: requestId, name: name, parentDirectory: parentDirectory, agent: agent)
        guard generation == attempt else { throw WorkbenchError.disconnected }
        if !workspaces.contains(where: { $0.id == workspace.id }) { workspaces.append(workspace) }
        return workspace
    }
    func listFiles(workspaceId: String, path: String) async throws -> DirectoryListing {
#if DEBUG
        if isPreview { return PreviewSession.files(path: path) }
#endif
        guard connected, let connection, canBrowseFiles else { throw WorkbenchError.message("Connect to an updated host companion to browse files.") }
        let attempt = generation
        let listing = try await connection.listFiles(workspaceId: workspaceId, path: path)
        guard generation == attempt else { throw WorkbenchError.disconnected }
        return listing
    }
    func readFile(workspaceId: String, path: String, progress: @escaping (Double) -> Void) async throws -> Data {
#if DEBUG
        if isPreview { progress(1); return PreviewSession.fileData(path: path) }
#endif
        guard connected, let connection, canBrowseFiles else { throw WorkbenchError.message("Connect to an updated host companion to preview files.") }
        let attempt = generation
        var result = Data(), expectedSize: Int?, expectedVersion: String?
        while true {
            try Task.checkCancellation()
            let chunk = try await connection.readFile(workspaceId: workspaceId, path: path, offset: result.count)
            guard generation == attempt else { throw WorkbenchError.disconnected }
            guard chunk.path == path, chunk.size >= 0, chunk.size <= 20 * 1024 * 1024,
                  !chunk.version.isEmpty, expectedVersion == nil || expectedVersion == chunk.version,
                  expectedSize == nil || expectedSize == chunk.size,
                  chunk.offset == result.count, let bytes = Data(base64Encoded: chunk.data), bytes.count <= 192 * 1024,
                  chunk.nextOffset == chunk.offset + bytes.count, chunk.nextOffset <= chunk.size,
                  chunk.eof == (chunk.nextOffset == chunk.size), !bytes.isEmpty || chunk.eof else {
                throw WorkbenchError.message("The file changed while loading or its response was invalid. Try opening it again.")
            }
            expectedSize = chunk.size; expectedVersion = chunk.version; result.append(bytes)
            progress(chunk.size == 0 ? 1 : Double(result.count) / Double(chunk.size))
            if chunk.eof { return result }
        }
    }
    func send(_ data: Data) {
#if DEBUG
        if isPreview {
            if let text = String(data: data, encoding: .utf8), text.hasPrefix("\u{1b}[<64;") || text.hasPrefix("\u{1b}[<65;") {
                status = text.hasPrefix("\u{1b}[<64;") ? "Preview · scrolled up" : "Preview · scrolled down"
                return
            }
            output.send(data == Data([3]) ? Data("^C\r\n› ".utf8) : data)
            return
        }
#endif
        guard connected, sessionState?.writable == true, let connection else { return }
        let attempt = generation, paneId = activePane?.id
        Task {
            guard generation == attempt, activePane?.id == paneId else { return }
            do { try await connection.input(data) }
            catch { self.error = "Input delivery could not be confirmed. Check the terminal before resending." }
        }
    }
    func sendDraft() async {
        guard connected, sessionState?.writable == true, let connection, !draft.isEmpty else { return }
        let original = draft
        let paneId = activePane?.id, machineId = activeMachine?.id
        let text = bracketedPaste ? "\u{1b}[200~\(original)\u{1b}[201~\r" : original.replacingOccurrences(of: "\n", with: "\r") + "\r"
        do { try await connection.input(Data(text.utf8)); if activePane?.id == paneId, activeMachine?.id == machineId, draft == original { draft = ""; saveDraft() } }
        catch { self.error = "Delivery is uncertain. Your draft was kept; check the terminal before resending." }
    }
    func resize(cols: Int, rows: Int) { terminalSize = (cols, rows); connection?.resize(cols: cols, rows: rows) }
    func leaveTerminal() { saveDraft(); attachment = UUID(); fitOnNextWritableState = false; connection?.detachTerminal(); activePane = nil; desiredSession = nil; sessionState = nil }
    func takeControl() async { guard let pane = activePane else { return }; do { try await connection?.takeControl(sessionId: pane.id) } catch { self.error = error.localizedDescription } }
    func setPhoneLayout(_ enabled: Bool) async {
#if DEBUG
        if isPreview {
            sessionState = PreviewSession.state(sessionId: activePane?.id ?? "workbench_h_preview", phoneLayout: enabled, cols: enabled ? terminalSize.cols : 120, rows: enabled ? terminalSize.rows : 40)
            return
        }
#endif
        guard let pane = activePane else { return }
        do { try await connection?.setPhoneLayout(sessionId: pane.id, enabled: enabled) }
        catch { self.error = error.localizedDescription }
    }
    private var draftKey: String { "draft:\(relayText):\(activeMachine?.id ?? ""):\(activePane?.id ?? "")" }
    func saveDraft() { if activePane != nil && !isPreview { UserDefaults.standard.set(draft, forKey: draftKey) } }
    private func lost(_ error: Error) {
        guard !disconnectHandled else { return }; disconnectHandled = true
        connected = false; connecting = false; sessionState = nil
        status = "Disconnected. Remote sessions are still running."
        if error as? WorkbenchError == .hostIdentityChanged { self.error = error.localizedDescription; return }
        guard foreground, let machine = activeMachine else { return }
        if retries >= 5 { self.error = "Could not reconnect. Check your connection and the host companion, then reconnect manually."; return }
        reconnectTask?.cancel(); retries += 1
        let delay = min(30, 1 << retries)
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            self?.connect(machine)
        }
    }
    func setForeground(_ value: Bool) {
        if isPreview { return }
        foreground = value
        if !value { saveDraft(); generation = UUID(); reconnectTask?.cancel(); connectTask?.cancel(); connection?.close(); connected = false; connecting = false; sessionState = nil }
        else if let activeMachine { retries = 0; connect(activeMachine) }
    }
    func disconnect() {
        saveDraft(); generation = UUID(); reconnectTask?.cancel(); connectTask?.cancel(); connection?.close(); connection = nil
        connected = false; connecting = false; activeMachine = nil; activePane = nil; desiredSession = nil; sessionState = nil; workspaces = []; status = "Disconnected; sessions remain running."
    }
    func loadGrants() async {
        guard let machine = activeMachine else { return }
        do { let result: DevicesResponse = try await api().request("v1/machines/\(machine.id)/devices"); grants = result.devices }
        catch { self.error = error.localizedDescription }
    }
    func revoke(_ grant: DeviceGrant) async {
        guard let machine = activeMachine else { return }
        do {
            let _: StatusResponse = try await api().request("v1/machines/\(machine.id)/devices/\(grant.id)", method: "DELETE")
            if grant.id == login?.deviceId { disconnect(); await refreshMachines() } else { await loadGrants() }
        } catch { self.error = error.localizedDescription }
    }
}
