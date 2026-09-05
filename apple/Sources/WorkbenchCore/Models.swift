import Foundation
import Crypto
import NIOSSH

public struct Machine: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let hostKey: String
    public let online: Bool
}
public struct Workspace: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let cwd: String
    public let panes: [Pane]
}
public struct Pane: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let tmux: String
    public let kind: String
    public let live: Bool
}
public struct Snapshot: Codable, Sendable {
    public let workspaces: [Workspace]
    public let warning: String?
    public let updatedAt: Double
}
public struct SessionState: Codable, Sendable {
    public let sessionId: String
    public let writable: Bool
    public let localAttached: Bool
    public let cols: Int
    public let rows: Int
}
public struct ControlEvent: Decodable, Sendable {
    public let type: String
    public let version: Int?
    public let snapshot: Snapshot?
    public let message: String?
    public let sessionId: String?
    public let writable: Bool?
    public let localAttached: Bool?
    public let cols: Int?
    public let rows: Int?
    public var sessionState: SessionState? {
        guard let sessionId, let writable, let localAttached, let cols, let rows else { return nil }
        return SessionState(sessionId: sessionId, writable: writable, localAttached: localAttached, cols: cols, rows: rows)
    }
}
public struct LoginChallenge: Decodable, Sendable { public let challengeId: String; public let nonce: String }
public struct Login: Codable, Sendable { public let accessToken: String; public let deviceId: String; public let expiresAt: Double }
public struct DeviceGrant: Decodable, Identifiable, Sendable { public let id: String; public let name: String; public let publicKey: String }
public struct MachinesResponse: Decodable, Sendable { public let machines: [Machine] }
public struct DevicesResponse: Decodable, Sendable { public let devices: [DeviceGrant] }
public struct StatusResponse: Decodable, Sendable { public let status: String?; public let revoked: Bool? }

public enum WorkbenchError: LocalizedError, Equatable {
    case message(String), hostIdentityChanged, disconnected, unsupportedProtocol
    public var errorDescription: String? {
        switch self {
        case .message(let message): return message
        case .hostIdentityChanged: return "This machine’s identity changed. Pair it again from its terminal before connecting."
        case .disconnected: return "Connection closed. Your remote sessions are still running."
        case .unsupportedProtocol: return "Update the app and companion to compatible versions."
        }
    }
}
public func relayOrigin(_ value: String) throws -> URL {
    guard let url = URL(string: value), let host = url.host,
          url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty || url.path == "/" else { throw WorkbenchError.message("Use an HTTPS relay address without a path.") }
    return url
}
public struct PairingQR: Codable, Sendable {
    public let version: Int
    public let relay: String
    public let pairingId: String
    public let secret: String
    public let machineId: String
    public let hostKey: String
    public init(link: String) throws {
        guard link.count < 8192, let components = URLComponents(string: link), components.scheme == "workbench-remote", components.host == "pair",
              var encoded = components.queryItems?.first(where: { $0.name == "data" })?.value else { throw WorkbenchError.message("Not a Workbench pairing code.") }
        encoded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded) else { throw WorkbenchError.message("Invalid pairing code.") }
        self = try JSONDecoder().decode(PairingQR.self, from: data)
        guard version == 1, UUID(uuidString: pairingId) != nil, UUID(uuidString: machineId) != nil, secret.count >= 32, secret.count <= 100 else { throw WorkbenchError.message("Invalid or unsupported pairing code.") }
        _ = try relayOrigin(relay)
        _ = try NIOSSHPublicKey(openSSHPublicKey: hostKey)
    }
    public func verificationCode(devicePublicKey: String) throws -> String {
        let host = String(openSSHPublicKey: try NIOSSHPublicKey(openSSHPublicKey: hostKey))
        let device = String(openSSHPublicKey: try NIOSSHPublicKey(openSSHPublicKey: devicePublicKey))
        let digest = SHA256.hash(data: Data("\(secret)\n\(host)\n\(device)".utf8))
        let prefix = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return String(format: "%06u", prefix % 1_000_000)
    }
}
public struct DeviceIdentity: Sendable {
    public let rawPrivateKey: Data
    public init(rawPrivateKey: Data? = nil) throws {
        let key = try rawPrivateKey.map { try Curve25519.Signing.PrivateKey(rawRepresentation: $0) } ?? Curve25519.Signing.PrivateKey()
        self.rawPrivateKey = key.rawRepresentation
    }
    public var privateKey: NIOSSHPrivateKey { NIOSSHPrivateKey(ed25519Key: try! Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)) }
    public var publicKey: String { String(openSSHPublicKey: privateKey.publicKey) }
    public static func nonceHash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
}
