import Foundation

/// What run environments this instance offers new sessions, from
/// `GET /api/sandbox/status`. Only the fields the composer needs are decoded;
/// managing providers is desktop admin.
struct InstanceSandboxStatus: Decodable, Equatable, Sendable {
    struct Provider: Decodable, Equatable, Sendable {
        let id: String
        let configured: Bool?
        let certified: Bool?
    }

    /// A configured provider account. Its `state` is the one that decides
    /// whether a session can actually start there.
    struct Connection: Decodable, Equatable, Sendable {
        let provider: String?
        let state: String?
    }

    let enabled: Bool?
    let killSwitch: Bool?
    let providers: [Provider]?
    let connections: [Connection]?
}

/// The composer's sandbox rules, kept out of the view so they can be tested
/// against real server payloads. They mirror the web palette
/// (src/frontend/components/NewSession.tsx).
enum SandboxOffering {
    /// This machine: the host, no sandbox. The empty id is what the picker
    /// carries; the create request spells it `local`.
    static let host = ""

    /// The sandboxes a new session may actually choose, in the server's order.
    ///
    /// Connections win outright once the instance has any: a provider that is
    /// configured in principle but has no ready connection cannot run a
    /// session, and offering it would fail at create time.
    static func choices(_ status: InstanceSandboxStatus?) -> [String] {
        guard let status, status.enabled != false, status.killSwitch != true else { return [] }
        let connections = status.connections ?? []
        if !connections.isEmpty {
            return unique(
                connections
                    .filter { $0.state == "ready" }
                    .compactMap { $0.provider }
                    .filter { !$0.isEmpty }
            )
        }
        return unique(
            (status.providers ?? [])
                .filter { $0.configured == true && $0.certified == true }
                .map(\.id)
                .filter { !$0.isEmpty }
        )
    }

    /// The server's own names for the providers.
    static func label(_ id: String) -> String {
        switch id {
        case host: "This machine"
        case "docker": "Docker"
        case "daytona": "Daytona"
        case "e2b": "E2B"
        case "box": "Box"
        case "modal": "Modal"
        case "lambda-microvm": "AWS Lambda MicroVM"
        default: id
        }
    }

    /// What to send as the create's `sandbox`. The host is explicit — omitting
    /// the field lets the instance's own default decide, which would make the
    /// chip say one thing and the session do another.
    static func createValue(_ id: String) -> String {
        id.isEmpty ? "local" : id
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}
