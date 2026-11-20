import Foundation

// Settings responses are intentionally permissive: the server evolves often and
// older native builds should continue to render the fields they understand.

struct SettingsOK: Codable, Sendable {
    var ok: Bool?
    var error: String?
}

struct Automation: Codable, Sendable, Identifiable {
    var id: String?
    var name: String?
    var prompt: String?
    var schedule: String?
    var mode: String?
    var model: String?
    var fallbackModel: String?
    var accountId: String?
    var accountStrict: Bool?
    var usageCredits: Bool?
    var mcpServers: [String]?
    var owner: String?
    var workspaceId: String?
    var eventKey: String?
    var createdBy: String?
    var createdAt: String?
    var enabled: Bool?
    var isRunning: Bool?
    var runs: [AutomationRun]?
}

struct AutomationRun: Codable, Sendable, Identifiable {
    var id: String? { sessionId ?? at }
    var at: String?
    var sessionId: String?
    var status: String?
    var trigger: String?
    var durationMs: Int?
    var error: String?
}

struct Goal: Codable, Sendable, Identifiable {
    var id: String?
    var name: String?
    var mission: String?
    var mode: String?
    var repo: String?
    var model: String?
    var fallbackModel: String?
    var mcpServers: [String]?
    var minWakeMinutes: Int?
    var maxWakes: Int?
    var wakeCount: Int?
    var status: String?
    var phase: String?
    var pauseReason: String?
    var nextWakeAt: String?
    var lastRunAt: String?
    var createdBy: String?
    var createdAt: String?
    var isRunning: Bool?
    var ledger: String?
}

struct ActionInput: Codable, Sendable, Identifiable {
    var id: String? { name }
    var name: String?
    var label: String?
    var type: String?
    var required: Bool?
    var `default`: String?
    var options: [String]?
    var hint: String?
}

struct Action: Codable, Sendable, Identifiable {
    var id: String?
    var name: String?
    var description: String?
    var kind: String?
    var repo: String?
    var scriptPath: String?
    var argMode: String?
    var mcpServer: String?
    var toolName: String?
    var inputs: [ActionInput]?
    var confirm: Bool?
    var model: String?
    var seeded: Bool?
    var createdBy: String?
    var createdAt: String?
    var lastRunAt: String?
    var lastRunSessionId: String?
}

struct ActionRunResult: Codable, Sendable {
    var sessionId: String?
    var error: String?
}

struct SecurityState: Codable, Sendable {
    var scans: [SecurityScan]?
    var profiles: [SecurityProfile]?
    var repos: [SecurityRepo]?
}

struct SecurityRepo: Codable, Sendable, Identifiable {
    var id: String?
    var defaultBranch: String?
}

struct SecurityProfile: Codable, Sendable, Identifiable {
    var id: String?
    var name: String?
    var prompt: String?
    var createdBy: String?
    var createdAt: String?
}

struct SecurityScan: Codable, Sendable, Identifiable {
    var id: String?
    var repos: [String]?
    var profileId: String?
    var profileName: String?
    var instructions: String?
    var interactive: Bool?
    var status: String?
    var error: String?
    var createdBy: String?
    var createdAt: String?
    var finishedAt: String?
    var sessions: [SecurityScanSession]?
}

struct SecurityScanSession: Codable, Sendable, Identifiable {
    var id: String? { sessionId }
    var repo: String?
    var sessionId: String?
    var status: String?
    var error: String?
}

struct SecurityScanResult: Codable, Sendable {
    var scan: SecurityScan?
    var sessionId: String?
    var automation: Automation?
    var error: String?
}

struct ModelCatalogSettings: Codable, Sendable {
    var models: [SettingsModelOption]?
    /// Engines a model can be routed to. Absent on a server that predates
    /// them, which reads the same as a single-engine instance.
    var engines: [ModelEngineOption]?
    var `default`: String?
    var interactiveDefault: String?
    var autoFallback: Bool?
}

struct SettingsModelOption: Codable, Sendable, Identifiable {
    var id: String?
    var provider: String?
    var label: String?
    var aliases: [String]?
    var efforts: [String]?
    var accountProvider: String?
    var group: String?
    var description: String?
    var fastModeSupported: Bool?
    var ultrafastSupported: Bool?
}

struct ModelDefaults: Codable, Sendable {
    var `default`: String?
    var interactiveDefault: String?
    var autoFallback: Bool?
}

struct ProviderAccount: Codable, Sendable, Identifiable, Equatable {
    var id: String?
    var name: String?
    /// Display name chosen in web Settings; shown instead of the email.
    var label: String?
    var owner: String?
    var kind: String?
    var usable: Bool?
    var exhaustedUntil: String?
    var tokenMasked: String?
    var valueMasked: String?
    var email: String?
    var plan: String?
    var credentialsPath: String?
    /// How full the subscription is, and when it frees up. Read on Settings →
    /// Usage; `nil` from a server that cannot see the account's usage at all.
    var usage: AccountUsage?
    /// The token has no usage scope, so there is nothing to meter rather than
    /// nothing spent. The two look identical without this.
    var noUsageScope: Bool?
    /// A SuperGrok account whose refresh grant died: only a fresh device-code
    /// sign-in brings it back.
    var reloginRequired: Bool?
    var refreshError: String?
}

struct ProviderAccountsResponse: Codable, Sendable {
    var accounts: [ProviderAccount]?
}

struct CodexDeviceLogin: Codable, Sendable, Identifiable {
    var id: String?
    var name: String?
    var state: String?
    var url: String?
    var code: String?
    var error: String?
}

/// A SuperGrok device-code sign-in in flight. The account name comes from
/// the signed-in email, so there is no name to send.
struct XaiDeviceLogin: Codable, Sendable, Identifiable {
    var id: String?
    var state: String?
    var url: String?
    var code: String?
    var error: String?
}

struct ModelProvider: Codable, Sendable, Identifiable {
    var id: String?
    var apiKeyMasked: String?
    var baseURL: String?
    var models: [String]?
    var name: String?
    /// Stored opt-in: saves and the discover route read the model list.
    var discoverModels: Bool?
    /// The server can list this provider's models: it has a base URL, or it
    /// is the Gemini API, which needs none.
    var canDiscover: Bool?

    /// Pi's slug for the Gemini API. A Google AI Studio key is stored under it.
    static let geminiID = "google"

    var isGemini: Bool { id == Self.geminiID }

    /// The models after `pi/<id>/`, as the picker shows them.
    var modelNames: [String] {
        (models ?? []).map { model in
            let parts = model.split(separator: "/", omittingEmptySubsequences: false)
            return parts.count > 2 && parts[0] == "pi" ? parts.dropFirst(2).joined(separator: "/") : model
        }
    }

    /// Gemini gets its own card ahead of the generic list, as on the web.
    static func splitGemini(_ providers: [ModelProvider]) -> (gemini: ModelProvider?, own: [ModelProvider]) {
        let named = providers.filter { $0.id?.isEmpty == false }
        return (named.first(where: \.isGemini), named.filter { !$0.isGemini })
    }

    /// Pasted keys often carry line-wrap newlines; the server strips them too.
    static func cleanKey(_ key: String) -> String {
        key.filter { !$0.isWhitespace }
    }
}

/// `PUT /api/settings/model-providers/:id`. `discovery` or `discoveryError`
/// is present only when the save asked for `discoverModels`.
struct ModelProviderSaveResult: Decodable, Sendable {
    struct Discovery: Decodable, Sendable {
        var added: Int?
        var models: [String]?
    }
    var provider: ModelProvider?
    var discovery: Discovery?
    var discoveryError: String?

    /// The line the Gemini card shows after a save, worded as on the web.
    var geminiSummary: String {
        if let discoveryError { return "Gemini key saved. \(discoveryError)" }
        if let discovery { return "Gemini key saved, \(discovery.models?.count ?? 0) models available" }
        return "Gemini key saved"
    }
    var discoveryFailed: Bool { discoveryError != nil }
}

/// `POST /api/settings/model-providers/:id/discover`.
struct ModelDiscoveryResult: Decodable, Sendable {
    var added: Int?
    var models: [String]?
    var provider: ModelProvider?

    var summary: String { "\(models?.count ?? 0) models listed, \(added ?? 0) added to the picker" }
}

struct ModelProvidersResponse: Codable, Sendable {
    var providers: [ModelProvider]?
    var pickerModels: [String]?
}

struct MCPConnection: Codable, Sendable, Identifiable {
    var id: String? { name }
    var name: String?
    var status: String?
    var transport: String?
    var target: String?
    var detail: String?
    var allowedUsers: [String]?
}

struct ConnectionsResponse: Codable, Sendable {
    var mcpServers: [MCPConnection]?
    var agents: [String: SettingsAgentHealth]?
    /// Execution engines enabled for new sessions. Models are shared by all.
    var engines: [String]?
}

struct SettingsAgentHealth: Codable, Sendable {
    var status: String?
    var activeSessions: Int?
    var detail: String?
}

/// Who an MCP server is authenticated as. `users` are the people who granted
/// their own account (Settings → Account); `shared` is the workspace-wide
/// grant everyone else falls back to; `capable` says the server can do OAuth at
/// all, even when it runs on a workspace API key today.
struct MCPOauthStatus: Codable, Sendable {
    var users: [String]?
    var shared: MCPOauthSharedGrant?
    var capable: Bool?
}

struct MCPOauthSharedGrant: Codable, Sendable {
    var connectedBy: String?
}

/// The provider consent page a per-user grant starts at.
struct MCPOauthStart: Codable, Sendable {
    var url: String?
}

struct GitHubConnectionStatus: Codable, Sendable {
    var enabled: Bool?
    var clientIdConfigured: Bool?
    var accounts: [GitHubConnectedAccount]?
    var team: [GitHubTeamConnection]?
}

struct GitHubConnectedAccount: Codable, Sendable, Identifiable {
    var id: String? { login }
    var login: String?
    var name: String?
    var connectedAt: String?
    var scopes: String?
    /// GitHub has revoked the renewal since this account connected. It is not
    /// a working connection any more, and only reconnecting fixes it.
    var needsReconnect: Bool?
}

/// One configured teammate and whether their own GitHub grant is live. The
/// server answers with the whole roster, not just connected people, so an
/// unconnected teammate is visible rather than absent.
struct GitHubTeamConnection: Codable, Sendable, Identifiable {
    var id: String? { github }
    var name: String?
    var github: String?
    var connected: Bool?
    /// Connected once, but GitHub has since revoked the renewal. The row says
    /// so instead of reading "Connected", which is the whole point of the
    /// field: a dead grant otherwise looks healthy until a PR fails.
    var needsReconnect: Bool?
    var canManage: Bool?
}

struct GitHubDeviceFlow: Codable, Sendable {
    var deviceCode: String?
    var userCode: String?
    var verificationUri: String?
    var interval: Int?
    var status: String?
    var login: String?
    var error: String?
}

struct PlainRouterConfig: Codable, Sendable {
    var prompt: String?
    var isCustom: Bool?
    var basicModel: String?
    var defaultPrompt: String?
    var defaultBasicModel: String?
}

/// One memory entry. The original native shape carried `text`/`by`/`at`;
/// `GET /api/memory` now answers summaries (`summary`, `scopeKey`, `kind`,
/// `updatedAt`, and in repo mode the `repo` and `path` it lives in). Both
/// decode into this, so cached entries from either shape still render.
/// `source` is an object there and is deliberately not decoded.
struct MemoryEntry: Codable, Sendable, Identifiable {
    var id: String?
    var text: String?
    var by: String?
    var at: String?
    var summary: String?
    var scopeKey: String?
    var kind: String?
    var state: String?
    var updatedAt: String?
    var repo: String?
    var path: String?

    var displayText: String { text ?? summary ?? "" }
    var byline: String {
        [by ?? kind, at ?? updatedAt.map { String($0.prefix(10)) }]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }
}

struct MemoryScopeInfo: Codable, Sendable {
    var key: String?
    var kind: String?
    var label: String?
}

struct MemoryScope: Codable, Sendable, Identifiable {
    var id: String? { scope?.key }
    var scope: MemoryScopeInfo?
    var entries: [MemoryEntry]?
    /// The memory repository this scope lives in (repo mode only).
    var repo: String?
}

struct MemoryResponse: Codable, Sendable {
    var scopes: [MemoryScope]?
    var entry: MemoryEntry?
}

struct WarmTemplate: Codable, Sendable, Identifiable {
    var id: String? { repoId }
    var repoId: String?
    var enabled: Bool?
    var intervalHours: Int?
    var refreshing: Bool?
    var spares: Int?
    var state: WarmTemplateState?
}

struct WarmTemplateState: Codable, Sendable {
    var sha: String?
    var refreshedAt: String?
    var lastDurationMs: Int?
    var ok: Bool?
    var lastError: String?
    var manifestEntries: Int?
}

struct WarmTemplatesResponse: Codable, Sendable {
    var repos: [WarmTemplate]?
}

struct PreviewPool: Codable, Sendable, Identifiable {
    var id: String? { repoId }
    var repoId: String?
    var config: PreviewPoolConfig?
    var golden: PreviewGoldenImage?
    var goldenBuilding: Bool?
    var containers: [PreviewPoolContainer]?
}

struct PreviewPoolConfig: Codable, Sendable {
    var enabled: Bool?
    var backend: String?
    var running: Int?
    var paused: Int?
    var cpus: Int?
    var memory: String?
    var goldenIntervalHours: Int?
    var devAuthBypass: Bool?
    var claimIdleMinutes: Int?
}

struct PreviewGoldenImage: Codable, Sendable {
    var sha: String?
    var builtAt: String?
    var lastError: String?
}

struct PreviewPoolContainer: Codable, Sendable, Identifiable {
    var id: String? { name }
    var name: String?
    var state: String?
    var hostPort: Int?
    var sessionWorktree: String?
    var claimedAt: String?
}

struct PreviewPoolResponse: Codable, Sendable {
    var repos: [PreviewPool]?
}

struct Papercut: Codable, Sendable, Identifiable {
    var id: String? { "\(ts ?? "")-\(message ?? "")" }
    var ts: String?
    var message: String?
    var repo: String?
    var sessionId: String?
    var model: String?
    var runKind: String?
    var by: String?
}

struct PapercutsRepoConfig: Codable, Sendable, Identifiable {
    var id: String? { repoId }
    var repoId: String?
    var enabled: Bool?
}

struct PapercutsResponse: Codable, Sendable {
    var entries: [Papercut]?
    var repos: [PapercutsRepoConfig]?
}

struct AuditPage: Codable, Sendable {
    var dates: [String]?
    var events: [AuditEvent]?
    var total: Int?
    var types: [String]?
}

struct AuditEvent: Codable, Sendable, Identifiable {
    var id: String? {
        eventId ?? "\(time ?? at ?? "")-\(kind ?? type ?? msg ?? "event")-\(bksSessionId ?? sessionId ?? "")"
    }
    var eventId: String?
    var time: String?
    var kind: String?
    var msg: String?
    var bksSessionId: String?
    var at: String?
    var type: String?
    var sessionId: String?
    var message: String?
    var user: String?

    var displayType: String { kind ?? msg ?? type ?? "Event" }
    var displayTime: String { time ?? at ?? "" }
    var displaySession: String { bksSessionId ?? sessionId ?? "" }
    var displayMessage: String { message ?? displaySession }

    enum CodingKeys: String, CodingKey {
        case eventId, time, kind, msg, at, type, sessionId, message, user
        case bksSessionId = "bks_session_id"
    }
}
