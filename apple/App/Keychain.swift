import Foundation
import Security
import WorkbenchCore

enum Keychain {
    static func read(_ name: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.workbench.remote", kSecAttrAccount as String: name, kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw WorkbenchError.message("Could not read secure storage (\(status)). Unlock your iPhone and try again.") }
        return result as? Data
    }
    static func write(_ name: String, data: Data?) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.workbench.remote", kSecAttrAccount as String: name]
        if let data {
            let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
            let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                let added = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
                guard added == errSecSuccess else { throw WorkbenchError.message("Could not save secure credentials (\(added)).") }
            } else if status != errSecSuccess { throw WorkbenchError.message("Could not update secure credentials (\(status)).") }
        } else { SecItemDelete(query as CFDictionary) }
    }
}
