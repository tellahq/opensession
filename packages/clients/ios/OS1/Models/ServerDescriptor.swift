import Foundation

/// Additive server metadata. Unknown keys and value types never enable features.
struct ServerDescriptor: Decodable, Sendable {
    let serverVersion: String?
    let protocolVersion: Int?
    let capabilities: [String: JSONValue]?

    func supports(_ key: String, minimumVersion: Int = 1) -> Bool {
        switch capabilities?[key] {
        case .bool(true): return minimumVersion <= 1
        case .number(let version):
            return version.isFinite && version.rounded() == version && version >= Double(minimumVersion)
        default: return false
        }
    }
}
