import Foundation
import Observation

struct ServerAccount: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var url: String
    var userName: String
    var githubLogin: String

    var displayLabel: String {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        let candidate = url.contains("://") ? url : "https://\(url)"
        return URL(string: candidate)?.host ?? "Organization"
    }
}

struct ServerConnection: Equatable, Sendable {
    let accountID: String
    let baseURL: URL
    let token: String

    var wsURL: URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/ws"
        return components.url
    }

    func authorizedRequest(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

/// Server endpoints + credentials. Non-secret account metadata lives in
/// UserDefaults; each account's bearer token has its own keychain entry.
///
/// The computed compatibility properties keep the rest of the native client
/// scoped to the active account while account-aware surfaces can use `accounts`
/// and `connection(for:)` directly.
// Deliberately not actor-isolated: views read `shared` from nonisolated
// property initializers, and the backing stores (UserDefaults/Keychain) are
// safe to touch from any thread.
@Observable
final class ServerConfig {
    static let shared = ServerConfig()

    private static let accountsDefaultsKey = "os1.serverAccounts"
    private static let activeIDDefaultsKey = "os1.activeServerAccountId"
    private static let legacyURLDefaultsKey = "os1.serverURL"
    private static let legacyUserNameDefaultsKey = "os1.userName"
    private static let legacyGithubLoginDefaultsKey = "os1.githubLogin"
    private static let legacyTokenKeychainKey = "os1.token"
    private static let tokenKeychainPrefix = "os1.token.account."

    /// What `userName` holds before anything has set it — a stand-in, not a
    /// name, so surfaces that present the name can fall back to GitHub login.
    static let placeholderUserName = "ios"

    private(set) var accounts: [ServerAccount]
    private(set) var activeId: String
    private(set) var accountBadges: [String: Int] = [:]
    private var tokens: [String: String]

    @ObservationIgnored private let environmentAccountID: String?

    private init() {
        let defaults = UserDefaults.standard
        let env = ProcessInfo.processInfo.environment
        let bundledDefault = Bundle.main.object(
            forInfoDictionaryKey: "OS1DefaultServerURL"
        ) as? String
        let decodedAccounts = defaults.data(forKey: Self.accountsDefaultsKey).flatMap {
            try? JSONDecoder().decode([ServerAccount].self, from: $0)
        }

        if let server = env["OS1_SERVER"] {
            let id = "environment"
            accounts = [ServerAccount(
                id: id,
                label: URL(string: server)?.host ?? "Development",
                url: server,
                // `OS1_USER` names the viewer for a dev launch, so a screenshot
                // can read as a particular teammate (their personal accounts,
                // their sidebar lens) without touching the device's defaults.
                userName: env["OS1_USER"]
                    ?? defaults.string(forKey: Self.legacyUserNameDefaultsKey)
                    ?? Self.placeholderUserName,
                githubLogin: ""
            )]
            activeId = id
            let token = env["OS1_TOKEN"] ?? ""
            tokens = [id: token]
            environmentAccountID = id
            return
        }

        environmentAccountID = nil
        if let decodedAccounts, !decodedAccounts.isEmpty {
            accounts = decodedAccounts
            let storedID = defaults.string(forKey: Self.activeIDDefaultsKey)
            if let storedID, decodedAccounts.contains(where: { $0.id == storedID }) {
                activeId = storedID
            } else {
                activeId = decodedAccounts[0].id
            }
            tokens = Dictionary(uniqueKeysWithValues: decodedAccounts.map { account in
                (account.id, Keychain.get(Self.tokenKey(for: account.id)) ?? "")
            })
            return
        }

        let url = defaults.string(forKey: Self.legacyURLDefaultsKey)
            ?? bundledDefault
            ?? "http://127.0.0.1:3850"
        let id = UUID().uuidString
        accounts = [ServerAccount(
            id: id,
            label: Self.label(for: url),
            url: url,
            userName: defaults.string(forKey: Self.legacyUserNameDefaultsKey)
                ?? Self.placeholderUserName,
            githubLogin: defaults.string(forKey: Self.legacyGithubLoginDefaultsKey) ?? ""
        )]
        activeId = id
        let legacyToken = Keychain.get(Self.legacyTokenKeychainKey) ?? ""
        tokens = [id: legacyToken]
        if !legacyToken.isEmpty {
            Keychain.set(legacyToken, for: Self.tokenKey(for: id))
            Keychain.delete(Self.legacyTokenKeychainKey)
        }
        persist()
    }

    var activeAccount: ServerAccount {
        accounts.first { $0.id == activeId } ?? accounts[0]
    }

    var baseURLString: String {
        get { activeAccount.url }
        set { updateActive { $0.url = newValue } }
    }

    var userName: String {
        get { activeAccount.userName }
        set { updateActive { $0.userName = newValue } }
    }

    var githubLogin: String {
        get { activeAccount.githubLogin }
        set { updateActive { $0.githubLogin = newValue } }
    }

    var token: String {
        get { tokens[activeId] ?? "" }
        set {
            guard activeId != environmentAccountID else { return }
            tokens[activeId] = newValue
            if newValue.isEmpty {
                Keychain.delete(Self.tokenKey(for: activeId))
                githubLogin = ""
            } else {
                Keychain.set(newValue, for: Self.tokenKey(for: activeId))
            }
        }
    }

    @discardableResult
    func addAccount() -> String {
        let id = UUID().uuidString
        accounts.append(ServerAccount(
            id: id,
            label: "Organization",
            url: "",
            userName: Self.placeholderUserName,
            githubLogin: ""
        ))
        tokens[id] = ""
        activeId = id
        persist()
        return id
    }

    func activate(_ id: String) {
        guard id != activeId, accounts.contains(where: { $0.id == id }) else { return }
        activeId = id
        accountBadges[id] = nil
        persist()
    }

    func removeAccount(_ id: String) {
        guard environmentAccountID == nil, let index = accounts.firstIndex(where: { $0.id == id }) else {
            return
        }
        Keychain.delete(Self.tokenKey(for: id))
        tokens[id] = nil
        accounts.remove(at: index)
        accountBadges[id] = nil
        if accounts.isEmpty {
            let nextID = UUID().uuidString
            accounts = [ServerAccount(
                id: nextID,
                label: "Organization",
                url: "",
                userName: Self.placeholderUserName,
                githubLogin: ""
            )]
            tokens[nextID] = ""
        }
        if !accounts.contains(where: { $0.id == activeId }) {
            activeId = accounts[min(index, accounts.count - 1)].id
        }
        persist()
    }

    func updateActiveLabel(_ label: String) {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        updateActive { $0.label = trimmed }
    }

    func incrementBadge(for accountID: String) {
        guard accountID != activeId else { return }
        accountBadges[accountID] = 1
    }

    func connection(for account: ServerAccount) -> ServerConnection? {
        guard let baseURL = Self.normalizedURL(account.url) else { return nil }
        let accountToken = tokens[account.id] ?? ""
        guard !accountToken.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return ServerConnection(accountID: account.id, baseURL: baseURL, token: accountToken)
    }

    var connection: ServerConnection? { connection(for: activeAccount) }

    /// Base URL without a trailing slash, e.g. `https://sessions.example.com`.
    var baseURL: URL? { Self.normalizedURL(baseURLString) }

    /// The UI WebSocket endpoint: same host, `/ws`, ws(s) scheme.
    var wsURL: URL? { connection?.wsURL }

    var isConfigured: Bool { connection != nil }

    func authorizedRequest(_ url: URL) -> URLRequest {
        connection?.authorizedRequest(url) ?? URLRequest(url: url)
    }

    /// Whether `url` is on the active server and may carry its token.
    func isOwnURL(_ url: URL) -> Bool {
        guard let base = baseURL,
              let ours = URLComponents(url: base, resolvingAgainstBaseURL: false),
              let theirs = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let ourHost = ours.host?.lowercased(),
              let theirHost = theirs.host?.lowercased()
        else { return false }
        return ours.scheme?.lowercased() == theirs.scheme?.lowercased()
            && ourHost == theirHost
            && ours.port == theirs.port
    }

    private func updateActive(_ mutate: (inout ServerAccount) -> Void) {
        guard let index = accounts.firstIndex(where: { $0.id == activeId }) else { return }
        mutate(&accounts[index])
        persist()
    }

    private func persist() {
        guard environmentAccountID == nil else { return }
        let defaults = UserDefaults.standard
        if let data = try? JSONEncoder().encode(accounts) {
            defaults.set(data, forKey: Self.accountsDefaultsKey)
        }
        defaults.set(activeId, forKey: Self.activeIDDefaultsKey)
    }

    private static func tokenKey(for id: String) -> String { tokenKeychainPrefix + id }

    private static func normalizedURL(_ raw: String) -> URL? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        return URL(string: trimmed)
    }

    private static func label(for raw: String) -> String {
        normalizedURL(raw)?.host ?? "Organization"
    }
}
