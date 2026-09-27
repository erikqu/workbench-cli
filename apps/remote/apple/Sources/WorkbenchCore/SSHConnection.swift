import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import NIOCore
import NIOPosix
import NIOSSH

@MainActor public final class SSHConnection {
    private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private var bridge: WebSocketBridge?
    private var parent: Channel?
    private var control: Channel?
    private var terminal: Channel?
    private var closed = false
    private var disconnected: (@Sendable (Error) -> Void)?
    private var requests: [String: CheckedContinuation<ControlEvent, Error>] = [:]
    private var requestTimeouts: [String: Task<Void, Never>] = [:]
    private var attachmentGeneration = UUID()
    public init() {}
    public func connect(origin: URL, machineId: String, hostKey: String, login: Login, identity: DeviceIdentity,
                        onEvent: @escaping @Sendable (ControlEvent) -> Void,
                        onDisconnect: @escaping @Sendable (Error) -> Void) async throws {
        disconnected = onDisconnect
        var components = URLComponents(url: origin.appendingPathComponent("v1/tunnel/\(machineId)"), resolvingAgainstBaseURL: false)!
        components.scheme = origin.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: components.url!); request.timeoutInterval = 20
        request.setValue("Bearer \(login.accessToken)", forHTTPHeaderField: "Authorization")
        let bridge = try WebSocketBridge(request: request) { [weak self] error in Task { @MainActor in self?.fail(error) } }
        self.bridge = bridge
        let rejectHost: @Sendable () -> Void = { [weak self] in Task { @MainActor in self?.fail(WorkbenchError.hostIdentityChanged) } }
        let reportError: @Sendable (Error) -> Void = { [weak self] error in Task { @MainActor in self?.fail(error) } }
        let watchdog = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            self?.fail(WorkbenchError.message("The secure connection timed out."))
        }
        defer { watchdog.cancel() }
        do {
            parent = try await NIOPipeBootstrap(group: group).channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    let config = SSHClientConfiguration(userAuthDelegate: DeviceAuthentication(deviceId: login.deviceId, identity: identity), serverAuthDelegate: PinnedHost(hostKey: try NIOSSHPublicKey(openSSHPublicKey: hostKey), rejected: rejectHost))
                    try channel.pipeline.syncOperations.addHandler(NIOSSHHandler(role: .client(config), allocator: channel.allocator, inboundChildChannelInitializer: nil))
                    try channel.pipeline.syncOperations.addHandler(ConnectionErrors(report: reportError))
                }
            }.takingOwnershipOfDescriptor(inputOutput: bridge.nioDescriptor).get()
            parent?.closeFuture.whenComplete { [weak self] _ in Task { @MainActor in self?.fail(WorkbenchError.disconnected) } }
            bridge.start()
            control = try await makeChannel(request: .control, output: { _ in }, event: { [weak self] event in
                Task { @MainActor in
                    guard let self else { return }
                    if let id = event.id, self.requests[id] != nil {
                        if event.type == "error" { self.finishRequest(id, result: .failure(WorkbenchError.message(event.message ?? "The operation failed."))) }
                        else { self.finishRequest(id, result: .success(event)) }
                        return
                    }
                    onEvent(event)
                }
            }, ended: { [weak self] in Task { @MainActor in self?.fail(WorkbenchError.disconnected) } })
            try await command(method: "watch")
        } catch { if parent == nil { bridge.bootstrapFailed() }; close(); throw error }
    }
    private func makeChannel(request: StreamHandler.Request, output: @escaping @Sendable (Data) -> Void, event: @escaping @Sendable (ControlEvent) -> Void, ended: @escaping @Sendable () -> Void) async throws -> Channel {
        guard let parent else { throw WorkbenchError.disconnected }
        let failed: @Sendable (Error) -> Void = { [weak self] error in Task { @MainActor in self?.fail(error) } }
        let promise = parent.eventLoop.makePromise(of: Channel.self)
        parent.eventLoop.execute {
            do {
                let ssh = try parent.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
                ssh.createChannel(promise) { channel, type in
                    guard type == .session else { return channel.eventLoop.makeFailedFuture(WorkbenchError.unsupportedProtocol) }
                    return channel.eventLoop.makeCompletedFuture { try channel.pipeline.syncOperations.addHandler(StreamHandler(request: request, output: output, event: event, ended: ended, failed: failed)) }
                }
            } catch { promise.fail(error) }
        }
        return try await promise.futureResult.get()
    }
    public func attach(sessionId: String, cols: Int, rows: Int, output: @escaping @Sendable (Data) -> Void, ended: @escaping @Sendable () -> Void) async throws {
        guard sessionId.range(of: "^workbench_[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw WorkbenchError.message("Invalid session identifier.") }
        let attempt = UUID(); attachmentGeneration = attempt
        let previous = terminal; terminal = nil
        if let previous { try? await previous.close().get() }
        guard attachmentGeneration == attempt, !Task.isCancelled else { throw CancellationError() }
        let channel = try await makeChannel(request: .terminal(sessionId, cols, rows), output: output, event: { _ in }, ended: ended)
        guard attachmentGeneration == attempt, !Task.isCancelled else { channel.close(promise: nil); throw CancellationError() }
        terminal = channel
    }
    public func input(_ data: Data) async throws {
        guard data.count <= 1_048_576, let terminal, terminal.isActive else { throw WorkbenchError.disconnected }
        var buffer = terminal.allocator.buffer(capacity: data.count); buffer.writeBytes(data)
        try await terminal.writeAndFlush(buffer).get()
    }
    public func resize(cols: Int, rows: Int) {
        guard let terminal else { return }
        terminal.triggerUserOutboundEvent(SSHChannelRequestEvent.WindowChangeRequest(terminalCharacterWidth: clamp(cols), terminalRowHeight: clamp(rows), terminalPixelWidth: 0, terminalPixelHeight: 0), promise: nil)
    }
    public func takeControl(sessionId: String) async throws { try await command(method: "takeControl", sessionId: sessionId) }
    public func setPhoneLayout(sessionId: String, enabled: Bool) async throws { try await command(method: "setPhoneLayout", sessionId: sessionId, enabled: enabled) }
    public func detachTerminal() { attachmentGeneration = UUID(); terminal?.close(promise: nil); terminal = nil }
    public func refresh() async throws { try await command(method: "list") }
    private struct Command: Encodable {
        let id: String
        let method: String
        let sessionId: String?
        let enabled: Bool?
        var name: String? = nil
        var parentDirectory: String? = nil
        var agent: String? = nil
        var workspaceId: String? = nil
        var path: String? = nil
        var offset: Int? = nil
    }
    private func command(method: String, sessionId: String? = nil, enabled: Bool? = nil) async throws {
        try await writeCommand(Command(id: UUID().uuidString, method: method, sessionId: sessionId, enabled: enabled))
    }
    private func writeCommand(_ command: Command) async throws {
        guard let control else { throw WorkbenchError.disconnected }
        var data = try JSONEncoder().encode(command); data.append(10)
        var buffer = control.allocator.buffer(capacity: data.count); buffer.writeBytes(data)
        try await control.writeAndFlush(buffer).get()
    }
    public func createWorkspace(requestId: String, name: String, parentDirectory: String, agent: String) async throws -> Workspace {
        let event = try await request(Command(id: requestId, method: "createWorkspace", sessionId: nil, enabled: nil, name: name, parentDirectory: parentDirectory, agent: agent))
        guard let workspace = event.workspace else { throw WorkbenchError.unsupportedProtocol }
        return workspace
    }
    public func listFiles(workspaceId: String, path: String) async throws -> DirectoryListing {
        let event = try await request(Command(id: UUID().uuidString, method: "listFiles", sessionId: nil, enabled: nil, workspaceId: workspaceId, path: path))
        guard let directory = event.directory else { throw WorkbenchError.unsupportedProtocol }
        return directory
    }
    public func readFile(workspaceId: String, path: String, offset: Int) async throws -> FileChunk {
        let event = try await request(Command(id: UUID().uuidString, method: "readFile", sessionId: nil, enabled: nil, workspaceId: workspaceId, path: path, offset: offset))
        guard let chunk = event.fileChunk else { throw WorkbenchError.unsupportedProtocol }
        return chunk
    }
    private func request(_ command: Command) async throws -> ControlEvent {
        guard !closed, control != nil else { throw WorkbenchError.disconnected }
        let id = command.id
        guard requests[id] == nil else { throw WorkbenchError.message("This operation is already in progress.") }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                requests[id] = continuation
                requestTimeouts[id] = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                    self?.finishRequest(id, result: .failure(WorkbenchError.message("The operation has not been confirmed. If creating a workspace, retry without changing its fields to check safely.")))
                }
                Task { [weak self] in
                    guard let self, requests[id] != nil else { return }
                    do { try await writeCommand(command) }
                    catch { finishRequest(id, result: .failure(error)) }
                }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in self?.finishRequest(id, result: .failure(CancellationError())) }
        }
    }
    private func finishRequest(_ id: String, result: Result<ControlEvent, Error>) {
        requestTimeouts.removeValue(forKey: id)?.cancel()
        requests.removeValue(forKey: id)?.resume(with: result)
    }
    private func cancelRequests() {
        for id in Array(requests.keys) { finishRequest(id, result: .failure(WorkbenchError.message("Connection lost. If creating a workspace, retry with the same fields to check safely."))) }
    }
    private func fail(_ error: Error) {
        let notify = !closed; closed = true
        guard notify else { return }
        cancelRequests()
        bridge?.close(); parent?.close(promise: nil); disconnected?(error)
    }
    public func close() {
        closed = true
        attachmentGeneration = UUID(); cancelRequests()
        bridge?.close(); parent?.close(promise: nil)
    }
    deinit { bridge?.close(); parent?.close(promise: nil); group.shutdownGracefully { _ in } }
}
private func clamp(_ value: Int) -> Int { min(500, max(2, value)) }
private final class DeviceAuthentication: NIOSSHClientUserAuthenticationDelegate {
    let deviceId: String, identity: DeviceIdentity
    init(deviceId: String, identity: DeviceIdentity) { self.deviceId = deviceId; self.identity = identity }
    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods, nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard availableMethods.contains(.publicKey) else { nextChallengePromise.fail(WorkbenchError.message("Device authentication was rejected. Pair this iPhone again.")); return }
        nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: deviceId, serviceName: "", offer: .privateKey(.init(privateKey: identity.privateKey))))
    }
}
private final class PinnedHost: NIOSSHClientServerAuthenticationDelegate {
    let hostKey: NIOSSHPublicKey
    let rejected: @Sendable () -> Void
    init(hostKey: NIOSSHPublicKey, rejected: @escaping @Sendable () -> Void) { self.hostKey = hostKey; self.rejected = rejected }
    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        if self.hostKey == hostKey { validationCompletePromise.succeed(()) } else { rejected(); validationCompletePromise.fail(WorkbenchError.hostIdentityChanged) }
    }
}
private final class StreamHandler: ChannelDuplexHandler {
    typealias InboundIn = SSHChannelData
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = SSHChannelData
    enum Request: Sendable { case control, terminal(String, Int, Int) }
    let request: Request
    let output: @Sendable (Data) -> Void
    let event: @Sendable (ControlEvent) -> Void
    let ended: @Sendable () -> Void
    let failed: @Sendable (Error) -> Void
    var pending = Data()
    init(request: Request, output: @escaping @Sendable (Data) -> Void, event: @escaping @Sendable (ControlEvent) -> Void, ended: @escaping @Sendable () -> Void, failed: @escaping @Sendable (Error) -> Void) {
        self.request = request; self.output = output; self.event = event; self.ended = ended; self.failed = failed
    }
    func channelActive(context: ChannelHandlerContext) {
        switch request {
        case .control:
            context.triggerUserOutboundEvent(SSHChannelRequestEvent.SubsystemRequest(subsystem: "workbench-control-v1", wantReply: true), promise: nil)
        case .terminal(let session, let cols, let rows):
            context.triggerUserOutboundEvent(SSHChannelRequestEvent.PseudoTerminalRequest(wantReply: true, term: "xterm-256color", terminalCharacterWidth: clamp(cols), terminalRowHeight: clamp(rows), terminalPixelWidth: 0, terminalPixelHeight: 0, terminalModes: SSHTerminalModes([:])), promise: nil)
            context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: "workbench-attach:\(session)", wantReply: true), promise: nil)
        }
        context.fireChannelActive()
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard case .byteBuffer(let buffer) = message.data else { return }
        let data = Data(buffer.readableBytesView)
        switch request {
        case .terminal: output(data)
        case .control:
            pending.append(data)
            if pending.count > 4_194_304 { context.close(promise: nil); return }
            while let newline = pending.firstIndex(of: 10) {
                let line = pending[..<newline]; pending.removeSubrange(...newline)
                do {
                    let value = try JSONDecoder().decode(ControlEvent.self, from: line)
                    if value.type == "hello" && value.version != 1 { failed(WorkbenchError.unsupportedProtocol); context.close(promise: nil); return }
                    event(value)
                } catch { failed(error); context.close(promise: nil); return }
            }
        }
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(unwrapOutboundIn(data)))), promise: promise)
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { failed(error); context.close(promise: nil) }
    func channelInactive(context: ChannelHandlerContext) { ended(); context.fireChannelInactive() }
}
private final class ConnectionErrors: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    let report: @Sendable (Error) -> Void
    init(report: @escaping @Sendable (Error) -> Void) { self.report = report }
    func errorCaught(context: ChannelHandlerContext, error: Error) { report(error); context.close(promise: nil) }
}
