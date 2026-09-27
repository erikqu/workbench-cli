import Foundation
import WorkbenchCore
// Integration entrypoint: supply a test fixture JSON, never production credentials.
struct Configuration: Decodable {
    let relay: String
    let machineId: String
    let hostKey: String
    let login: Login
    let privateKey: String
    let sessionId: String
    let workspaceId: String
    let parentDirectory: String
    let imagePath: String
    let imageBase64: String
    let binaryPath: String
    let binarySize: Int
}
struct CheckFailed: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw CheckFailed(message) }
}
guard CommandLine.arguments.count == 2 else { fatalError("Usage: workbench-transport-check fixture.json") }
do {
    let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    let origin = try relayOrigin(config.relay)
    try require(["127.0.0.1", "localhost", "::1", "[::1]"].contains(origin.host ?? ""), "Transport checks require an isolated loopback relay")
    guard let privateKey = Data(base64Encoded: config.privateKey), let imageData = Data(base64Encoded: config.imageBase64) else { throw CheckFailed("Invalid test fixture bytes") }
    let connection = SSHConnection()
    defer { connection.close() }
    let identity = try DeviceIdentity(rawPrivateKey: privateKey)
    try await connection.connect(origin: origin, machineId: config.machineId, hostKey: config.hostKey, login: config.login, identity: identity,
        onEvent: { event in print("EVENT \(event.type)") },
        onDisconnect: { error in FileHandle.standardError.write(Data("DISCONNECTED \(error)\n".utf8)) })

    let requestId = UUID().uuidString
    let created = try await connection.createWorkspace(requestId: requestId, name: "Swift transport workspace", parentDirectory: config.parentDirectory, agent: "terminal")
    try require(created.name == "Swift transport workspace", "Workspace response name was mismatched")
    try require(created.cwd == URL(fileURLWithPath: config.parentDirectory).appendingPathComponent(created.name).path, "Workspace was created outside its fixture parent")
    try require(created.panes.count == 1 && created.panes[0].kind == "terminal" && created.panes[0].live, "Workspace terminal is not live")
    let retry = try await connection.createWorkspace(requestId: requestId, name: created.name, parentDirectory: config.parentDirectory, agent: "terminal")
    try require(retry == created, "A retried creation changed its workspace or session identity")
    let empty = try await connection.listFiles(workspaceId: created.id, path: "")
    try require(empty.entries.isEmpty && !empty.truncated, "New workspace should start empty")
    print("SWIFT_WORKSPACE_RETRY_OK")

    // All three operations are outstanding together while watch snapshots arrive.
    // Their different response shapes/paths prove request IDs are matched correctly.
    async let directoryRequest = connection.listFiles(workspaceId: config.workspaceId, path: "")
    async let imageRequest = connection.readFile(workspaceId: config.workspaceId, path: config.imagePath, offset: 0)
    async let binaryRequest = connection.readFile(workspaceId: config.workspaceId, path: config.binaryPath, offset: 0)
    let (directory, image, firstChunk) = try await (directoryRequest, imageRequest, binaryRequest)
    try require(directory.path.isEmpty && directory.entries.contains(where: { $0.path == config.imagePath && $0.kind == "file" }), "Image was not listed in the fixture workspace")
    try require(image.path == config.imagePath && image.offset == 0 && image.eof && image.size == imageData.count && image.nextOffset == imageData.count, "Image response metadata was mismatched")
    try require(Data(base64Encoded: image.data) == imageData, "PNG bytes were corrupted in Swift transport")
    try require(!image.version.isEmpty, "Image version token is missing")

    var chunk = firstChunk, received = 0, chunks = 0
    let version = firstChunk.version
    try require(!version.isEmpty, "Binary version token is missing")
    while true {
        guard let bytes = Data(base64Encoded: chunk.data) else { throw CheckFailed("Invalid file chunk encoding") }
        try require(chunk.path == config.binaryPath && chunk.size == config.binarySize && chunk.offset == received, "File chunk was matched to the wrong request")
        try require(chunk.version == version && chunk.nextOffset == received + bytes.count, "File changed or chunk offsets are inconsistent")
        try require(!bytes.isEmpty && bytes.enumerated().allSatisfy { $0.element == UInt8(truncatingIfNeeded: received + $0.offset) }, "Binary chunk bytes were corrupted")
        received = chunk.nextOffset; chunks += 1
        if chunk.eof { break }
        try require(received < config.binarySize && chunks < 10, "File chunks made no progress")
        chunk = try await connection.readFile(workspaceId: config.workspaceId, path: config.binaryPath, offset: received)
    }
    try require(received == config.binarySize && chunks > 1, "Large file did not exercise multiple chunks")
    print("SWIFT_FILE_IMAGE_AND_CHUNKS_OK")

    do {
        _ = try await connection.readFile(workspaceId: created.id, path: "../workbench-ui-state.json", offset: 0)
        throw CheckFailed("File traversal was unexpectedly accepted")
    } catch WorkbenchError.message(let message) {
        try require(message.contains("leave the workspace"), "Unexpected host error: \(message)")
    }
    let recovered = try await connection.listFiles(workspaceId: created.id, path: "")
    try require(recovered.entries.isEmpty, "An errored request broke later response matching")
    print("SWIFT_CONTROL_ERROR_RECOVERY_OK")

    try await connection.attach(sessionId: config.sessionId, cols: 80, rows: 24, output: { data in print("OUTPUT \(data.count)") }, ended: { print("TERMINAL CLOSED") })
    try await Task.sleep(nanoseconds: 500_000_000)
    try await connection.input(Data("printf '\\nSWIFT_TRANSPORT_OK\\n'\r".utf8))
    try await Task.sleep(nanoseconds: 1_000_000_000)
} catch {
    FileHandle.standardError.write(Data("TRANSPORT FAILED: \(error)\n".utf8))
    exit(1)
}
