import Foundation

public enum WebLink {
    /// Terminal output can contain arbitrary URI schemes. Only web navigation
    /// belongs in the browser; never launch a pairing URI or a local file here.
    public static func url(_ text: String) -> URL? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count <= 8192, !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        if value.lowercased().hasPrefix("www.") { value = "https://" + value }
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        return components.url
    }
}
