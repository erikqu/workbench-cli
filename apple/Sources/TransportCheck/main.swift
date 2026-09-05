import Foundation
import WorkbenchCore
// Integration entrypoint: supply a test fixture JSON, never production credentials.
struct Configuration: Decodable { let relay: String; let machineId: String; let hostKey: String; let login: Login; let privateKey: String; let sessionId: String }
guard CommandLine.arguments.count == 2 else { fatalError("Usage: workbench-transport-check fixture.json") }
do {
let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let connection = SSHConnection()
let identity = try DeviceIdentity(rawPrivateKey: Data(base64Encoded: config.privateKey)!)
try await connection.connect(origin: relayOrigin(config.relay), machineId: config.machineId, hostKey: config.hostKey, login: config.login, identity: identity, onEvent: { event in print("EVENT \(event.type)") }, onDisconnect: { error in FileHandle.standardError.write(Data("DISCONNECTED \(error)\n".utf8)) })
try await connection.attach(sessionId: config.sessionId, cols: 80, rows: 24, output: { data in print("OUTPUT \(data.count)") }, ended: { print("TERMINAL CLOSED") })
try await Task.sleep(nanoseconds: 500_000_000)
try await connection.input(Data("printf '\\nSWIFT_TRANSPORT_OK\\n'\r".utf8))
try await Task.sleep(nanoseconds: 1_000_000_000)
connection.close()
} catch {
    FileHandle.standardError.write(Data("TRANSPORT FAILED: \(error)\n".utf8))
    exit(1)
}
