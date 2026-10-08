import Foundation

/// Settings → Keychain: the credentials people lend to sessions, and what has
/// been lent out.
///
/// The server never returns a secret (`KeychainCredentialMeta` in
/// src/server/keychain.ts), so nothing here can hold one. Every field is
/// optional so an older or newer server never fails the whole page; unknown
/// fields are ignored. A grant's id was once the broker bearer token, which is
/// why a grant row offers revoking and never copying.
struct KeychainCredential: Codable, Sendable, Identifiable, Equatable {
    struct Injection: Codable, Sendable, Equatable {
        var header: String?
        var scheme: String?
    }

    var id: String?
    /// The roster first name of whoever approves asks for it.
    var owner: String?
    /// Lookup and display key, e.g. "vercel".
    var service: String?
    var detail: String?
    /// "login" for a username and password typed into a sign-in page. Absent
    /// (or "api") for an API credential the broker injects.
    var kind: String?
    /// A login's sign-in page. Its host is `host`.
    var loginUrl: String?
    /// A login's username. Not secret: teammates and the agent see it.
    var username: String?
    /// Broker target host, https assumed. For a login, the sign-in page's host.
    var host: String?
    var injection: Injection?
    /// Empty means every method is allowed.
    var allowedMethods: [String]?
    /// Empty means every path is allowed.
    var allowedPathPrefixes: [String]?
    /// Calls return only the HTTP status, never headers or body.
    var statusOnly: Bool?
    var createdAt: String?
    var updatedAt: String?
    /// The signed-in person owns it, so they can delete it. Absent from older
    /// servers, which enforce ownership on delete themselves.
    var mine: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, owner, service, kind, loginUrl, username, host, injection
        case allowedMethods, allowedPathPrefixes, statusOnly, createdAt, updatedAt, mine
        // Every Swift type already answers to `description`, so the wire name
        // is mapped rather than shadowing it.
        case detail = "description"
    }

    var isLogin: Bool { kind == "login" }

    /// Hidden only when the server says it is someone else's.
    var canDelete: Bool { mine != false }

    /// The row title: a login is told apart by its account, an API key by
    /// where it is sent.
    var title: String {
        let name = service ?? "Credential"
        let second = isLogin ? username : host
        guard let second, second.isEmpty == false else { return name }
        return "\(name) · \(second)"
    }

    /// What the row says under the title: what it is, whose it is, and how
    /// narrowly it is scoped.
    var scopeSummary: String {
        var parts: [String] = []
        if isLogin {
            parts.append("Login on \(nonEmpty(loginUrl) ?? nonEmpty(host) ?? "its sign-in page")")
        }
        if let owner = nonEmpty(owner) { parts.append("owner \(owner)") }
        if isLogin == false {
            let methods = (allowedMethods ?? []).filter { $0.isEmpty == false }
            parts.append(methods.isEmpty ? "any method" : methods.joined(separator: "/"))
            let prefixes = (allowedPathPrefixes ?? []).filter { $0.isEmpty == false }
            if prefixes.isEmpty == false { parts.append(prefixes.joined(separator: ", ")) }
            if statusOnly == true { parts.append("status only") }
        }
        return parts.joined(separator: " · ")
    }
}

/// What an owner approves for a scripted run: this exact command. Records
/// from before the call cap was dropped may still carry `maxCalls`; it is
/// ignored.
struct KeychainScriptedRun: Codable, Sendable, Equatable {
    struct Group: Codable, Sendable, Equatable {
        var id: String?
        /// Every credential in the run, in the order asked.
        var members: [Member]?
    }

    struct Member: Codable, Sendable, Equatable {
        var service: String?
        var host: String?
        var owner: String?
    }

    var command: String?
    /// Set when the run uses several credentials.
    var group: Group?

    var groupMembers: [Member] { group?.members ?? [] }
}

/// One lending of a credential to one session.
struct KeychainGrant: Codable, Sendable, Identifiable, Equatable {
    var id: String?
    var credentialId: String?
    var owner: String?
    var sessionId: String?
    var requestedBy: String?
    var purpose: String?
    /// "once", "standing", "run" or "release".
    var mode: String?
    var status: String?
    var run: KeychainScriptedRun?
    var createdAt: String?
    var expiresAt: String?
    var usedAt: String?
    var revokedAt: String?
    var askId: String?

    /// Only an active grant can be revoked; the rest are history.
    var isActive: Bool { status == "active" }
}

/// A session asking for a credential it has not been given. Only the owner
/// answers it, here or in their direct message; never on a card in the asking
/// session, where anyone watching could click it.
struct KeychainAsk: Codable, Sendable, Identifiable, Equatable {
    var id: String?
    var credentialId: String?
    var owner: String?
    var sessionId: String?
    var requestedBy: String?
    var purpose: String?
    var requestedMode: String?
    var run: KeychainScriptedRun?
    var status: String?
    var createdAt: String?
    /// Pending, and the signed-in person owns the credential. Absent from
    /// older servers, which reads as "not yours to answer".
    var canAnswer: Bool?

    var isPending: Bool { status == "pending" }
    var isAnswerable: Bool { isPending && canAnswer == true }
}

struct KeychainResponse: Codable, Sendable, Equatable {
    var credentials: [KeychainCredential]?
    var grants: [KeychainGrant]?
    var asks: [KeychainAsk]?
}

struct KeychainCredentialResponse: Codable, Sendable {
    var credential: KeychainCredential?
}

/// An owner's answer to an ask, as `POST /api/keychain/asks/:id/answer` takes it.
enum KeychainDecision: String, Sendable, CaseIterable {
    case once, standing, run, release, decline

    var label: String {
        switch self {
        case .once: "Allow once"
        case .standing: "Allow 7 days"
        case .run: "Allow run"
        case .release: "Release password"
        case .decline: "Decline"
        }
    }

    /// The approvals an ask accepts, most generous last, then Decline. A run is
    /// approved as a run or not at all, a login as a release or not at all.
    static func choices(for ask: KeychainAsk) -> [KeychainDecision] {
        switch ask.requestedMode {
        case "release": [.decline, .release]
        case "run": [.decline, .run]
        default: ask.run != nil ? [.decline, .run] : [.decline, .standing, .once]
        }
    }
}

/// Labels shared by the Keychain screen and its tests. Plain functions over
/// the decoded models so the wording can be checked without a view.
enum KeychainPresentation {
    static func modeLabel(_ mode: String?) -> String? {
        switch mode {
        case "once": "One call"
        case "standing": "7 days"
        case "run": "Scripted run"
        case "release": "Password release"
        case let other?: other.isEmpty ? nil : other
        case nil: nil
        }
    }

    /// The one-line description of a scripted run. A grouped run names every
    /// credential with its owner, because no single owner can start it.
    static func runSummary(_ run: KeychainScriptedRun) -> String {
        let members = run.groupMembers
        var head: String
        if members.isEmpty {
            head = "Scripted run"
        } else {
            let list = members.map { member in
                let name = member.service ?? "credential"
                return member.owner.map { "\(name) (owner \($0))" } ?? name
            }
            head = "Scripted run with \(list.joined(separator: ", ")); starts once every owner allows it"
        }
        if let command = run.command?.trimmingCharacters(in: .whitespacesAndNewlines), command.isEmpty == false {
            head += " · \(command)"
        }
        return head
    }

    /// Pending asks the signed-in person owns, one row per grouped run: an
    /// owner's credentials in a multi-credential run are a single answer, so
    /// the first of them stands for the rest.
    static func asksToAnswer(_ asks: [KeychainAsk]) -> [KeychainAsk] {
        var seenGroups = Set<String>()
        return asks.filter { ask in
            guard ask.id?.isEmpty == false, ask.isAnswerable else { return false }
            guard let group = ask.run?.group?.id, group.isEmpty == false else { return true }
            return seenGroups.insert(group).inserted
        }
    }

    /// The signed-in person's own credentials named in the same grouped run.
    static func sameRun(_ ask: KeychainAsk, in asks: [KeychainAsk]) -> [KeychainAsk] {
        guard let group = ask.run?.group?.id, group.isEmpty == false else { return [ask] }
        return asks.filter { $0.isAnswerable && $0.run?.group?.id == group }
    }

    /// Pending asks someone else has to answer: the signed-in person's own
    /// requests, waiting on a credential's owner.
    static func asksWaiting(_ asks: [KeychainAsk]) -> [KeychainAsk] {
        asks.filter { $0.id?.isEmpty == false && $0.isPending && $0.canAnswer != true }
    }

    /// What an owner is being asked to approve.
    static func askDetail(_ ask: KeychainAsk) -> String {
        let purpose = nonEmpty(ask.purpose) ?? "No reason given"
        if ask.requestedMode == "release" {
            return "Wants the password, which the agent will see · \(purpose)"
        }
        if let run = ask.run { return "\(runSummary(run)) · \(purpose)" }
        let wants = ask.requestedMode == "once" ? "one call" : ask.requestedMode == "standing" ? "7 days" : nil
        return [wants.map { "Asked for \($0)" }, purpose].compactMap { $0 }.joined(separator: " · ")
    }

    /// What a grant row says under its title.
    static func grantDetail(_ grant: KeychainGrant, expiry: String?) -> String {
        var parts: [String] = []
        if let run = grant.run {
            parts.append(runSummary(run))
        } else if let mode = modeLabel(grant.mode) {
            parts.append(mode)
        }
        if let owner = nonEmpty(grant.owner) { parts.append("owner \(owner)") }
        if let expiry { parts.append(expiry) }
        if let purpose = nonEmpty(grant.purpose) { parts.append(purpose) }
        return parts.joined(separator: " · ")
    }
}

/// The add-credential form's state, kept in memory only: it is never Codable,
/// never cached, and the sheet that owns it clears the secret on save and is
/// discarded on cancel. Validation mirrors `normalizeCredentialSpec` in
/// src/server/keychain.ts, so a mistake is explained before it round-trips.
struct KeychainCredentialDraft: Equatable {
    enum Kind: String, CaseIterable, Identifiable {
        case api, login
        var id: String { rawValue }
        var label: String { self == .api ? "API" : "Login" }
    }

    var kind: Kind = .api
    var service = ""
    var detail = ""
    var secret = ""
    // API
    var host = ""
    var header = ""
    var scheme = ""
    var methods = ""
    var pathPrefixes = ""
    var statusOnly = false
    // Login
    var loginUrl = ""
    var username = ""

    static let httpMethods: Set<String> = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

    /// Every required field has something in it.
    var isComplete: Bool {
        guard trimmed(service).isEmpty == false, secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            return false
        }
        switch kind {
        case .api: return trimmed(host).isEmpty == false
        case .login: return trimmed(loginUrl).isEmpty == false && trimmed(username).isEmpty == false
        }
    }

    /// The first thing the server would refuse, as a sentence for the form.
    /// Nil when nothing typed so far is wrong; empty fields are not problems
    /// until `isComplete` asks for them.
    var issue: String? {
        let slug = trimmed(service).lowercased()
        if slug.isEmpty == false, slug.range(of: #"^[a-z0-9][a-z0-9._-]*$"#, options: .regularExpression) == nil {
            return "Service must be a short lowercase name: letters, digits, dot, dash or underscore."
        }
        switch kind {
        case .api:
            if trimmed(host).isEmpty == false {
                let bare = normalizedHost
                if bare.isEmpty || bare.contains(":")
                    || bare.range(of: #"^[a-z0-9][a-z0-9.-]*$"#, options: .regularExpression) == nil {
                    return "Host must be a bare host name, like api.example.test, with no port or path."
                }
            }
            if let bad = parsedMethods.first(where: { Self.httpMethods.contains($0) == false }) {
                return "\(bad) is not an HTTP method."
            }
            if let bad = parsedPrefixes.first(where: { $0.hasPrefix("/") == false }) {
                return "Path prefixes start with /, so \(bad) needs one."
            }
            let headerValue = trimmed(header)
            if headerValue.isEmpty == false,
               headerValue.range(of: #"^[A-Za-z0-9-]{1,64}$"#, options: .regularExpression) == nil {
                return "Header must be a plain header name, like Authorization."
            }
            let schemeValue = trimmed(scheme)
            if schemeValue.isEmpty == false,
               schemeValue.range(of: #"^[A-Za-z0-9-]{1,32}$"#, options: .regularExpression) == nil {
                return "Scheme must be a single word, like Bearer."
            }
        case .login:
            let url = trimmed(loginUrl)
            if url.isEmpty == false {
                guard let parsed = URLComponents(string: url), parsed.scheme?.lowercased() == "https",
                      parsed.host?.isEmpty == false, parsed.user == nil, parsed.password == nil else {
                    return "Sign-in page must be a full https:// address."
                }
            }
            let name = trimmed(username)
            if name.count > 200 || name.unicodeScalars.contains(where: Self.isUnsafeDisplay) {
                return "Username must be plain text of at most 200 characters."
            }
        }
        return nil
    }

    var isReady: Bool { isComplete && issue == nil }

    /// The `POST /api/keychain/credentials` body. Only fields the kind uses are
    /// sent: the server refuses a login that carries API scope, and an API
    /// credential that carries a username.
    var payload: [String: Any] {
        var body: [String: Any] = ["service": trimmed(service).lowercased()]
        if trimmed(detail).isEmpty == false { body["description"] = trimmed(detail) }
        switch kind {
        case .api:
            body["host"] = normalizedHost
            body["secret"] = secret.trimmingCharacters(in: .whitespacesAndNewlines)
            if parsedMethods.isEmpty == false { body["allowedMethods"] = parsedMethods }
            if parsedPrefixes.isEmpty == false { body["allowedPathPrefixes"] = parsedPrefixes }
            var injection: [String: String] = [:]
            if trimmed(header).isEmpty == false { injection["header"] = trimmed(header) }
            if trimmed(scheme).isEmpty == false { injection["scheme"] = trimmed(scheme) }
            if injection.isEmpty == false { body["injection"] = injection }
            if statusOnly { body["statusOnly"] = true }
        case .login:
            body["kind"] = "login"
            body["loginUrl"] = trimmed(loginUrl)
            body["username"] = trimmed(username)
            // A password may begin or end with a space; send it as typed.
            body["secret"] = secret
        }
        return body
    }

    private var normalizedHost: String {
        var value = trimmed(host).lowercased()
        for prefix in ["https://", "http://"] where value.hasPrefix(prefix) {
            value.removeFirst(prefix.count)
        }
        if let cut = value.firstIndex(where: { "/?#".contains($0) }) { value = String(value[..<cut]) }
        return value
    }

    private var parsedMethods: [String] { split(methods).map { $0.uppercased() } }
    private var parsedPrefixes: [String] { split(pathPrefixes) }

    private func split(_ value: String) -> [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.isEmpty == false }
    }

    private func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Control and bidi-override characters, which the server refuses in a
    /// username because they can make it read as something else.
    private static func isUnsafeDisplay(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        return v < 0x20 || v == 0x7F || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
    }
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, value.isEmpty == false else { return nil }
    return value
}
