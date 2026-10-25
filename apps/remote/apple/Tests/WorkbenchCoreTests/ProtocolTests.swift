import XCTest
@testable import WorkbenchCore
final class ProtocolTests: XCTestCase {
    func testWorkspaceCapabilitiesAndActivity() throws {
        let decoder = JSONDecoder()
        let hello = try decoder.decode(ControlEvent.self, from: Data(#"{"type":"hello","version":1,"capabilities":["createWorkspace","files"]}"#.utf8))
        XCTAssertEqual(hello.capabilities, ["createWorkspace", "files"])
        let created = try decoder.decode(ControlEvent.self, from: Data(#"{"id":"request","type":"workspaceCreated","workspace":{"id":"ws","name":"project","cwd":"/tmp/project","panes":[{"id":"workbench_h_test","tmux":"workbench_h_test","name":"Codex","kind":"agent","live":true,"harnessId":"codex","activity":"working"}]}}"#.utf8))
        XCTAssertEqual(created.id, "request")
        XCTAssertEqual(created.workspace?.name, "project")
        XCTAssertEqual(created.workspace?.panes.first?.activity, "working")
    }

    func testDirectoryAndBinaryChunkProtocol() throws {
        let decoder = JSONDecoder()
        let directory = try decoder.decode(ControlEvent.self, from: Data(#"{"id":"request","type":"directory","directory":{"path":"images","entries":[{"name":"photo.png","path":"images/photo.png","kind":"file","size":3}],"truncated":false}}"#.utf8))
        XCTAssertEqual(directory.directory?.entries.first?.path, "images/photo.png")
        XCTAssertEqual(directory.directory?.truncated, false)
        let file = try decoder.decode(ControlEvent.self, from: Data(#"{"id":"request","type":"fileChunk","fileChunk":{"path":"images/photo.png","version":"test-version","size":3,"offset":0,"nextOffset":3,"data":"AP+A","eof":true}}"#.utf8))
        XCTAssertEqual(file.fileChunk?.nextOffset, 3)
        XCTAssertEqual(Data(base64Encoded: file.fileChunk!.data), Data([0, 255, 128]))
    }

    func testIdentityRoundTrip() throws {
        let identity = try DeviceIdentity()
        XCTAssertEqual(identity.publicKey, try DeviceIdentity(rawPrivateKey: identity.rawPrivateKey).publicKey)
        XCTAssertTrue(identity.publicKey.hasPrefix("ssh-ed25519 "))
    }
    func testRejectInsecureRelay() throws {
        XCTAssertThrowsError(try relayOrigin("http://remote.example"))
        XCTAssertThrowsError(try relayOrigin("https://user:password@remote.example"))
        XCTAssertThrowsError(try relayOrigin("https://remote.example/path"))
        XCTAssertEqual(try relayOrigin("http://127.0.0.1:8080").port, 8080)
    }
    func testCompactPairingRoundTripAndRejectTruncation() throws {
        let host = try DeviceIdentity()
        let pairId = UUID(), machineId = UUID()
        let secret = Data(repeating: 17, count: 32)
        var pairUUID = pairId.uuid, machineUUID = machineId.uuid
        var payload = Data([2])
        payload.append(withUnsafeBytes(of: &pairUUID) { Data($0) })
        payload.append(secret)
        payload.append(withUnsafeBytes(of: &machineUUID) { Data($0) })
        payload.append(Data(base64Encoded: host.publicKey.split(separator: " ")[1].description)!)
        payload.append(Data("https://computer.example.ts.net:8443".utf8))
        func link(_ bytes: Data) -> String {
            "workbench-remote://pair?data=" + bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let pairing = try PairingQR(link: link(payload))
        XCTAssertEqual(pairing.pairingId.lowercased(), pairId.uuidString.lowercased())
        XCTAssertEqual(pairing.machineId.lowercased(), machineId.uuidString.lowercased())
        XCTAssertEqual(pairing.hostKey, host.publicKey)
        XCTAssertEqual(pairing.secret, secret.base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_"))
        XCTAssertEqual(pairing.relay, "https://computer.example.ts.net:8443")
        XCTAssertThrowsError(try PairingQR(link: link(payload.prefix(115))))
    }
    func testPairingValidation() throws {
        let identity = try DeviceIdentity()
        let payload: [String: Any] = ["version": 1, "relay": "https://relay.example", "pairingId": UUID().uuidString, "machineId": UUID().uuidString, "secret": String(repeating: "a", count: 43), "hostKey": identity.publicKey]
        let encoded = try JSONSerialization.data(withJSONObject: payload).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let pairing = try PairingQR(link: "workbench-remote://pair?data=\(encoded)")
        XCTAssertEqual(try pairing.verificationCode(devicePublicKey: identity.publicKey).count, 6)
        XCTAssertThrowsError(try PairingQR(link: "https://example.com"))
    }
    func testSharedVerificationVector() throws {
        let host = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea"
        let device = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM"
        let payload: [String: Any] = ["version": 1, "relay": "https://relay.example", "pairingId": UUID().uuidString, "machineId": UUID().uuidString, "secret": String(repeating: "a", count: 43), "hostKey": host]
        let pairing = try JSONDecoder().decode(PairingQR.self, from: JSONSerialization.data(withJSONObject: payload))
        XCTAssertEqual(try pairing.verificationCode(devicePublicKey: device), "085885")
    }
}
