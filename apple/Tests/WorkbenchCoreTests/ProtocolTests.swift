import XCTest
@testable import WorkbenchCore
final class ProtocolTests: XCTestCase {
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
