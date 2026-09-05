import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
public struct APIClient: Sendable {
    public let origin: URL
    public var accessToken: String?
    public init(origin: URL, accessToken: String? = nil) { self.origin = origin; self.accessToken = accessToken }
    public func request<T: Decodable>(_ route: String, method: String = "GET", body: [String: String]? = nil) async throws -> T {
        var request = URLRequest(url: origin.appendingPathComponent(route)); request.httpMethod = method; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw WorkbenchError.message("Invalid relay response") }
        guard response.statusCode == 200 else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: String]
            throw WorkbenchError.message(object?["error"] ?? "The relay returned \(response.statusCode).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
