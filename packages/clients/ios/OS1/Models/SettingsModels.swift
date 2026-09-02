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
}

struct ModelDefaults: Codable, Sendable {
    var `default`: String?
    var interactiveDefault: String?
    var autoFallback: Bool?
}

struct ProviderAccount: Codable, Sendable, Identifiable {
    var id: String?
    var name: String?
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

struct MemoryEntry: Codable, Sendable, Identifiable {
    var id: String?
    var text: String?
    var by: String?
    var at: String?
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
