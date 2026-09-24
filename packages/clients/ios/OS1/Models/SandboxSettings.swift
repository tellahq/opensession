import Foundation

/// Settings → Sandboxes, from `GET /api/sandbox/status`.
///
/// This is the settings-grade read of the same payload the composer already
/// takes a narrow slice of (`InstanceSandboxStatus`). That one answers "what
/// may this session choose"; this one answers "what does this instance offer,
/// and is any of it actually working" — so it decodes the connection states and
/// the qualification failures the composer has no use for.
///
/// Connections carry credentials and are created on the web. A phone reads them
/// and sets which sandbox its own new sessions start in.
struct SandboxSettingsStatus: Codable, Sendable, Equatable {
    struct Provider: Codable, Sendable, Equatable, Identifiable {
        var id: String?
        var configured: Bool?
        var certified: Bool?
        var lastPassedAt: String?
        var note: String?
    }

    struct Qualification: Codable, Sendable, Equatable {
        /// "checking", "ready" or "failed".
        var status: String?
        var checkedAt: String?
        var failureCode: String?
        var failureSummary: String?
    }

    struct Connection: Codable, Sendable, Equatable, Identifiable {
        var id: String?
        var provider: String?
        var enabled: Bool?
        var hasCredentials: Bool?
        var qualification: Qualification?
        /// The computed readiness the clients gate on. Deliberately stricter
        /// than `qualification.status`: the two routinely disagree, and this is
        /// the one the composer filters by.
        var state: String?
        var createdAt: String?
        var updatedAt: String?

        var isReady: Bool { state == "ready" }
    }

    struct Defaults: Codable, Sendable, Equatable {
        /// What the workspace picked for everyone.
        var workspace: String?
        /// This person's own override, empty when they have none.
        var personal: String?
        /// What a new session actually starts in.
        var effective: String?
    }

    var enabled: Bool?
    var killSwitch: Bool?
    var defaultProvider: String?
    var providers: [Provider]?
    var connections: [Connection]?
    var defaults: Defaults?

    /// The providers a person may pick as their default, in the server's order.
    /// Same rule the composer uses: once an instance has connections at all,
    /// only a ready one can run a session, so a provider that is configured in
    /// principle but has no ready connection is not on offer.
    var readyProviders: [String] {
        guard enabled != false, killSwitch != true else { return [] }
        let live = connections ?? []
        if live.isEmpty == false {
            return unique(live.filter { $0.isReady }.compactMap(\.provider))
        }
        return unique(
            (providers ?? [])
                .filter { $0.configured == true && $0.certified == true }
                .compactMap(\.id)
        )
    }

    private func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { $0.isEmpty == false && seen.insert($0).inserted }
    }

    /// The default vocabulary is the server's, not the composer's: "none" is
    /// the host, and a personal default of "workspace" means "whatever the
    /// workspace picked". `SandboxOffering.label` speaks the composer's, where
    /// the host is the empty id, so this page names them itself.
    static func defaultLabel(_ id: String) -> String {
        id == "none" || id.isEmpty ? "None" : SandboxOffering.label(id)
    }
}

/// What `PUT /api/sandbox/defaults` answers with: the three defaults, resolved
/// again for the person who just changed one.
struct SandboxDefaultsResponse: Codable, Sendable {
    var defaults: SandboxSettingsStatus.Defaults?
}

extension SandboxSettingsStatus.Connection {
    /// The line under a connection: what it is doing, or why it cannot. The
    /// provider's name is the row's title, so it is deliberately not repeated
    /// here.
    var summary: String {
        var parts: [String] = []
        if enabled == false { parts.append("Disabled") }
        if hasCredentials == false { parts.append("No credentials") }
        if let failure = qualification?.failureSummary, failure.isEmpty == false {
            parts.append(failure)
        } else if let code = qualification?.failureCode, code.isEmpty == false {
            parts.append(code)
        }
        return parts.joined(separator: " · ")
    }

    /// How the state reads in a row, in the server's own words.
    var stateLabel: String {
        switch state {
        case "ready": "Ready"
        case "checking": "Checking"
        case "failed": "Failed"
        case "disabled": "Disabled"
        case "not_configured": "Not configured"
        case "needs_attention": "Needs attention"
        case let other?: other
        case nil: "Unknown"
        }
    }
}
