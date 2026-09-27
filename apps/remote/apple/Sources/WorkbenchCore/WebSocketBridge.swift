import Foundation
import Dispatch
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// A private socket pair adapts URLSession's authenticated WSS transport to NIO.
// SSH packets are opaque to URLSession and the relay. Each direction is ordered
// and bounded; a slow socket or network sender applies backpressure.
final class WebSocketBridge: @unchecked Sendable {
    let nioDescriptor: Int32
    private let socket: URLSessionWebSocketTask
    private let queue = DispatchQueue(label: "workbench.websocket")
    private let reader: DispatchSourceRead
    private let writer: DispatchIO
    private var suspended = false
    private var closed = false
    private var receiveTask: Task<Void, Never>?
    private let onClose: @Sendable (Error) -> Void
    init(request: URLRequest, onClose: @escaping @Sendable (Error) -> Void) throws {
        var descriptors: [Int32] = [0, 0]
        #if canImport(Darwin)
        let kind = SOCK_STREAM
        #else
        let kind = Int32(SOCK_STREAM.rawValue)
        #endif
        guard socketpair(AF_UNIX, kind, 0, &descriptors) == 0 else { throw WorkbenchError.message("Could not create the secure connection transport.") }
        nioDescriptor = descriptors[0]
        let descriptor = descriptors[1]
        _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        #if canImport(Darwin)
        var enabled: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        #endif
        let writeDescriptor = dup(descriptor)
        guard writeDescriptor >= 0 else { systemClose(descriptors[0]); systemClose(descriptor); throw WorkbenchError.disconnected }
        self.onClose = onClose
        socket = URLSession.shared.webSocketTask(with: request)
        socket.maximumMessageSize = 128 * 1024
        reader = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        writer = DispatchIO(type: .stream, fileDescriptor: writeDescriptor, queue: queue) { _ in systemClose(writeDescriptor) }
        reader.setCancelHandler { systemClose(descriptor) }
        reader.setEventHandler { [weak self] in self?.read(descriptor) }
        reader.activate()
    }
    func start() {
        socket.resume()
        receiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard case .data(let data) = message else { throw WorkbenchError.message("Invalid encrypted tunnel frame.") }
                    try await write(data)
                }
            } catch { close(error) }
        }
    }
    // NIO owns this descriptor only if its bootstrap succeeds.
    func bootstrapFailed() { systemClose(nioDescriptor) }
    private func read(_ descriptor: Int32) {
        guard !closed else { return }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        let count = buffer.withUnsafeMutableBytes { systemRead(descriptor, $0.baseAddress!, $0.count) }
        if count == 0 { close(WorkbenchError.disconnected); return }
        if count < 0 { if errno != EAGAIN && errno != EINTR { close(WorkbenchError.disconnected) }; return }
        suspended = true; reader.suspend()
        let data = Data(buffer.prefix(count))
        Task { [weak self] in
            guard let self else { return }
            do {
                try await socket.send(.data(data))
                queue.async { [weak self] in guard let self, !closed, suspended else { return }; suspended = false; reader.resume() }
            } catch { close(error) }
        }
    }
    private func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let dispatchData = data.withUnsafeBytes { DispatchData(bytes: $0) }
            writer.write(offset: 0, data: dispatchData, queue: queue) { done, _, error in
                if done { if error == 0 { continuation.resume() } else { continuation.resume(throwing: WorkbenchError.disconnected) } }
            }
        }
    }
    func close(_ error: Error = WorkbenchError.disconnected) {
        queue.async { [self] in
            guard !closed else { return }; closed = true
            receiveTask?.cancel(); socket.cancel(with: .goingAway, reason: nil)
            if suspended { suspended = false; reader.resume() }
            reader.cancel(); writer.close(flags: .stop); onClose(error)
        }
    }
}
private func systemClose(_ fd: Int32) { _ = close(fd) }
private func systemRead(_ fd: Int32, _ buffer: UnsafeMutableRawPointer, _ count: Int) -> Int { read(fd, buffer, count) }
