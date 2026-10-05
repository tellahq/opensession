import Foundation

// Wire models for the session action cards: a credential the agent asked the
// driver to register, keychain asks the viewer owns, a force merge waiting for
// the driver, and the session's supervised script runs. Shapes mirror the
// server's routes (`routes/keychain.ts`, `force-merge.ts`, `scripts.ts`) and
// the socket frames in the protocol package. Everything but an id is optional
// so a newer server's additions, or an older one's omissions, never drop a
// card. None of these ever carries a secret: a credential's secret is typed
// into the card and posted over HTTP, and is never held here.

/// Decodes an array element by element, dropping the ones that do not decode,
/// so one malformed or newer-shaped item cannot hide the others.
struct LossyList<Element: Decodable & Sendable>: Decodable, Sendable {
    let items: [Element]

    init(items: [Element]) { self.items = items }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var items: [Element] = []
        while !container.isAtEnd {
            if let item = try? container.decode(Element.self) {
                items.append(item)
            } else {
                _ = try? container.decode(Discard.self)
            }
        }
        self.items = items
    }

    private struct Discard: Decodable {}
}

// MARK: - Credential registration (register_credential)

struct CredentialRegistrationRequest: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let service: String
    let host: String
    let description: String?
    /// "login" asks for a password for a sign-in page; anything else is an
    /// API secret.
    let kind: String?
    let loginUrl: String?
    let username: String?
    let allowedMethods: [String]
    let allowedPathPrefixes: [String]
    let owner: String

    var isLogin: Bool { kind == "login" }

    /// "GET, POST · /v1/, /v2/": the limits the credential will carry.
    var limits: String? {
        let parts = [allowedMethods, allowedPathPrefixes]
            .filter { !$0.isEmpty }
            .map { $0.joined(separator: ", ") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private enum CodingKeys: String, CodingKey {
        case id, service, host, description, kind, loginUrl, username
        case allowedMethods, allowedPathPrefixes, owner
    }

    init(
        id: String,
        service: String,
        host: String = "",
        description: String? = nil,
        kind: String? = nil,
        loginUrl: String? = nil,
        username: String? = nil,
        allowedMethods: [String] = [],
        allowedPathPrefixes: [String] = [],
        owner: String = ""
    ) {
        self.id = id
        self.service = service
        self.host = host
        self.description = description
        self.kind = kind
        self.loginUrl = loginUrl
        self.username = username
        self.allowedMethods = allowedMethods
        self.allowedPathPrefixes = allowedPathPrefixes
        self.owner = owner
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        service = (try? c.decodeIfPresent(String.self, forKey: .service)) ?? "Credential"
        host = (try? c.decodeIfPresent(String.self, forKey: .host)) ?? ""
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        loginUrl = try? c.decodeIfPresent(String.self, forKey: .loginUrl)
        username = try? c.decodeIfPresent(String.self, forKey: .username)
        allowedMethods = (try? c.decodeIfPresent([String].self, forKey: .allowedMethods)) ?? []
        allowedPathPrefixes =
            (try? c.decodeIfPresent([String].self, forKey: .allowedPathPrefixes)) ?? []
        owner = (try? c.decodeIfPresent(String.self, forKey: .owner)) ?? ""
    }
}

/// `GET /api/keychain/registrations?sessionId=`. `canAnswer` is decided by the
/// server against the verified sign-in; the client never infers it.
struct PendingCredentialRegistration: Equatable, Sendable {
    let request: CredentialRegistrationRequest
    let canAnswer: Bool
}

struct CredentialRegistrationResponse: Decodable, Sendable {
    let request: CredentialRegistrationRequest?
    let canAnswer: Bool

    private enum CodingKeys: String, CodingKey { case request, canAnswer }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        request = try? c.decodeIfPresent(CredentialRegistrationRequest.self, forKey: .request)
        canAnswer = (try? c.decodeIfPresent(Bool.self, forKey: .canAnswer)) ?? false
    }

    var pending: PendingCredentialRegistration? {
        request.map { PendingCredentialRegistration(request: $0, canAnswer: canAnswer) }
    }
}

// MARK: - Keychain asks (request_credential), owner only

struct SessionKeychainAsk: Decodable, Equatable, Sendable, Identifiable {
    enum Decision: String, Equatable, Sendable {
        case once, standing, run, release, decline
    }

    struct Run: Decodable, Equatable, Sendable {
        let command: String
    }

    struct Credential: Decodable, Equatable, Sendable {
        let service: String
        let host: String
        let kind: String?
        let username: String?
        let loginUrl: String?

        private enum CodingKeys: String, CodingKey { case service, host, kind, username, loginUrl }

        init(service: String, host: String = "", kind: String? = nil,
             username: String? = nil, loginUrl: String? = nil) {
            self.service = service
            self.host = host
            self.kind = kind
            self.username = username
            self.loginUrl = loginUrl
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            service = (try? c.decodeIfPresent(String.self, forKey: .service)) ?? "Credential"
            host = (try? c.decodeIfPresent(String.self, forKey: .host)) ?? ""
            kind = try? c.decodeIfPresent(String.self, forKey: .kind)
            username = try? c.decodeIfPresent(String.self, forKey: .username)
            loginUrl = try? c.decodeIfPresent(String.self, forKey: .loginUrl)
        }
    }

    let id: String
    let requestedBy: String
    let purpose: String
    /// "once" | "standing" | "run" | "release". Unknown values read as "once".
    let requestedMode: String
    let run: Run?
    let credentials: [Credential]

    private enum CodingKeys: String, CodingKey {
        case id, requestedBy, purpose, requestedMode, run, credentials
    }

    init(id: String, requestedBy: String, purpose: String, requestedMode: String,
         run: Run? = nil, credentials: [Credential]) {
        self.id = id
        self.requestedBy = requestedBy
        self.purpose = purpose
        self.requestedMode = requestedMode
        self.run = run
        self.credentials = credentials
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        requestedBy = (try? c.decodeIfPresent(String.self, forKey: .requestedBy)) ?? "A session"
        purpose = (try? c.decodeIfPresent(String.self, forKey: .purpose)) ?? ""
        requestedMode = (try? c.decodeIfPresent(String.self, forKey: .requestedMode)) ?? "once"
        run = try? c.decodeIfPresent(Run.self, forKey: .run)
        credentials = (try? c.decodeIfPresent(LossyList<Credential>.self, forKey: .credentials))?
            .items ?? []
    }

    var isRelease: Bool { requestedMode == "release" }

    /// The buttons after Decline, in order; the LAST is the primary one, and
    /// it is always the mode the agent asked for.
    var choices: [(decision: Decision, label: String)] {
        if isRelease { return [(.release, "Release password")] }
        if run != nil { return [(.run, "Allow run")] }
        if requestedMode == "standing" {
            return [(.once, "Allow once"), (.standing, "Allow 7 days")]
        }
        return [(.standing, "Allow 7 days"), (.once, "Allow once")]
    }

    func headline(agent: String) -> String {
        if isRelease { return "\(agent) wants the password for your login" }
        if run != nil { return "\(agent) wants to run a script with your credential" }
        return "\(agent) wants to borrow your credential"
    }

    var askedBy: String {
        guard !isRelease, run == nil else { return "Asked by \(requestedBy)" }
        return "Asked by \(requestedBy) for \(requestedMode == "standing" ? "7 days" : "one call")"
    }

    func summary(agent: String) -> String {
        if isRelease {
            return "\(agent) will see the password: it types it into the sign-in page itself. Release only a test account."
        }
        if let run {
            return "Runs this script until it exits or times out, within the credential's limits. The script never sees the secret, and every call is audited."
        }
        return "The secret is never shown to the session. Calls go through the keychain broker within the credential's limits, and each one is audited."
    }
}

struct SessionKeychainAsksResponse: Decodable, Sendable {
    let asks: [SessionKeychainAsk]

    private enum CodingKeys: String, CodingKey { case asks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        asks = (try? c.decodeIfPresent(LossyList<SessionKeychainAsk>.self, forKey: .asks))?
            .items ?? []
    }
}

// MARK: - Force merge (force_merge_pull_request)

struct ForceMergeRequest: Decodable, Equatable, Sendable, Identifiable {
    struct Bypass: Decodable, Equatable, Sendable {
        /// "check" | "review" | "branch".
        let kind: String
        let name: String?
        /// For a check: "failing" | "pending" | "missing".
        let state: String?
        let required: Bool
        let detail: String?

        private enum CodingKeys: String, CodingKey { case kind, name, state, required, detail }

        init(kind: String, name: String? = nil, state: String? = nil,
             required: Bool = false, detail: String? = nil) {
            self.kind = kind
            self.name = name
            self.state = state
            self.required = required
            self.detail = detail
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "branch"
            name = try? c.decodeIfPresent(String.self, forKey: .name)
            state = try? c.decodeIfPresent(String.self, forKey: .state)
            required = (try? c.decodeIfPresent(Bool.self, forKey: .required)) ?? false
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        }

        /// "Check ci failing (required)", or a review/branch rule's detail.
        var label: String {
            guard kind == "check" else { return detail ?? kind }
            let described = switch state {
            case "failing": "failing"
            case "pending": "still running"
            default: "not reported"
            }
            return "Check \(name ?? "unnamed") \(described)\(required ? " (required)" : "")"
        }
    }

    let id: String
    let ghRepo: String
    let number: Int
    let title: String
    let url: String?
    let base: String
    let head: String
    let headSha: String
    let method: String
    let reason: String
    let bypass: [Bypass]
    let driver: String

    private enum CodingKeys: String, CodingKey {
        case id, ghRepo, repo, number, title, url, base, head, headSha, method, reason, bypass, driver
    }

    init(id: String, ghRepo: String, number: Int, title: String, url: String? = nil,
         base: String, head: String, headSha: String, method: String, reason: String,
         bypass: [Bypass], driver: String) {
        self.id = id
        self.ghRepo = ghRepo
        self.number = number
        self.title = title
        self.url = url
        self.base = base
        self.head = head
        self.headSha = headSha
        self.method = method
        self.reason = reason
        self.bypass = bypass
        self.driver = driver
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ghRepo = (try? c.decodeIfPresent(String.self, forKey: .ghRepo))
            ?? (try? c.decodeIfPresent(String.self, forKey: .repo)) ?? ""
        number = (try? c.decodeIfPresent(Int.self, forKey: .number)) ?? 0
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        base = (try? c.decodeIfPresent(String.self, forKey: .base)) ?? ""
        head = (try? c.decodeIfPresent(String.self, forKey: .head)) ?? ""
        headSha = (try? c.decodeIfPresent(String.self, forKey: .headSha)) ?? ""
        method = (try? c.decodeIfPresent(String.self, forKey: .method)) ?? "squash"
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        bypass = (try? c.decodeIfPresent(LossyList<Bypass>.self, forKey: .bypass))?.items ?? []
        driver = (try? c.decodeIfPresent(String.self, forKey: .driver)) ?? "the driver"
    }
}

struct PendingForceMerge: Equatable, Sendable {
    let request: ForceMergeRequest
    /// Only the verified driver may confirm; anyone signed in may cancel.
    let canConfirm: Bool
}

struct ForceMergeResponse: Decodable, Sendable {
    let request: ForceMergeRequest?
    let canConfirm: Bool

    private enum CodingKeys: String, CodingKey { case request, canConfirm }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        request = try? c.decodeIfPresent(ForceMergeRequest.self, forKey: .request)
        canConfirm = (try? c.decodeIfPresent(Bool.self, forKey: .canConfirm)) ?? false
    }

    var pending: PendingForceMerge? {
        request.map { PendingForceMerge(request: $0, canConfirm: canConfirm) }
    }
}

/// What a confirm settled to. Only "merged" is a success; the others carry
/// why, and the card says so.
struct ForceMergeOutcome: Decodable, Equatable, Sendable {
    let status: String
    let error: String?

    init(status: String, error: String? = nil) {
        self.status = status
        self.error = error
    }

    var failureMessage: String? {
        switch status {
        case "merged", "cancelled": nil
        case "expired": "The force merge request expired."
        case "head_changed": "The branch moved since the request, so nothing was merged."
        default: error ?? "Couldn't force merge."
        }
    }
}

// MARK: - Script runs (start_script, run_with_credential)

struct ScriptRun: Decodable, Equatable, Sendable, Identifiable {
    struct CredentialUse: Decodable, Equatable, Sendable, Identifiable {
        let grantId: String
        let service: String
        let calls: Int
        let denied: Int

        var id: String { grantId }

        private enum CodingKeys: String, CodingKey { case grantId, service, calls, denied }

        init(grantId: String, service: String, calls: Int, denied: Int = 0) {
            self.grantId = grantId
            self.service = service
            self.calls = calls
            self.denied = denied
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            grantId = try c.decode(String.self, forKey: .grantId)
            service = (try? c.decodeIfPresent(String.self, forKey: .service)) ?? "Credential"
            calls = (try? c.decodeIfPresent(Int.self, forKey: .calls)) ?? 0
            denied = (try? c.decodeIfPresent(Int.self, forKey: .denied)) ?? 0
        }
    }

    enum Tone: Equatable, Sendable { case running, ok, bad, quiet }

    let id: String
    let sessionId: String
    let title: String
    let command: String
    /// "running" | "exited" | "failed" | "timed_out" | "stopped" | "revoked"
    /// | "lost". An unknown state reads as ended.
    let state: String
    let stopping: Bool
    let startedAt: Date?
    let deadline: Date?
    let endedAt: Date?
    let exitCode: Int?
    let error: String?
    let credentials: [CredentialUse]
    /// Only on the detail route: the end of the log.
    let outputTail: String?

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, title, command, state, stopping, startedAt, deadline, endedAt
        case exitCode, error, credentials, outputTail
    }

    init(id: String, sessionId: String, title: String, command: String = "",
         state: String, stopping: Bool = false, startedAt: Date?, deadline: Date? = nil,
         endedAt: Date? = nil, exitCode: Int? = nil, error: String? = nil,
         credentials: [CredentialUse] = [], outputTail: String? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.title = title
        self.command = command
        self.state = state
        self.stopping = stopping
        self.startedAt = startedAt
        self.deadline = deadline
        self.endedAt = endedAt
        self.exitCode = exitCode
        self.error = error
        self.credentials = credentials
        self.outputTail = outputTail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "Script"
        command = (try? c.decodeIfPresent(String.self, forKey: .command)) ?? ""
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "lost"
        stopping = (try? c.decodeIfPresent(Bool.self, forKey: .stopping)) ?? false
        let date = { (key: CodingKeys) -> Date? in
            Session.parseISO(try? c.decodeIfPresent(String.self, forKey: key))
        }
        startedAt = date(.startedAt)
        deadline = date(.deadline)
        endedAt = date(.endedAt)
        exitCode = try? c.decodeIfPresent(Int.self, forKey: .exitCode)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        credentials = (try? c.decodeIfPresent(LossyList<CredentialUse>.self, forKey: .credentials))?
            .items ?? []
        outputTail = try? c.decodeIfPresent(String.self, forKey: .outputTail)
    }

    var isRunning: Bool { state == "running" }
    var canStop: Bool { isRunning && !stopping }

    /// An ended run stays on screen this long, so its outcome is seen.
    static let endedVisibleFor: TimeInterval = 15 * 60

    func isVisible(at now: Date) -> Bool {
        if isRunning { return true }
        guard let endedAt else { return false }
        return now.timeIntervalSince(endedAt) < Self.endedVisibleFor
    }

    /// Oldest first, running last: the card sits at the end of the transcript,
    /// so what is still going stays next to the composer.
    static func visible(_ runs: [ScriptRun], at now: Date) -> [ScriptRun] {
        runs.filter { $0.isVisible(at: now) }.sorted { a, b in
            if a.isRunning != b.isRunning { return !a.isRunning }
            return (a.startedAt ?? .distantPast) < (b.startedAt ?? .distantPast)
        }
    }

    /// When the next ended run leaves the card, if any is still shown.
    static func nextExpiry(_ runs: [ScriptRun], after now: Date) -> Date? {
        runs.compactMap { run -> Date? in
            guard !run.isRunning, let endedAt = run.endedAt else { return nil }
            let leaves = endedAt.addingTimeInterval(endedVisibleFor)
            return leaves > now ? leaves : nil
        }.min()
    }

    var outcome: (text: String, tone: Tone) {
        let after: String = {
            guard let startedAt, let endedAt else { return "" }
            return " after \(Self.duration(endedAt.timeIntervalSince(startedAt)))"
        }()
        switch state {
        case "running": return (stopping ? "Stopping" : "Running", .running)
        case "exited":
            return exitCode == 0
                ? ("Finished\(after)", .ok)
                : ("Exited with code \(exitCode.map(String.init) ?? "?")\(after)", .bad)
        case "failed": return ("Couldn't run", .bad)
        case "timed_out": return ("Hit its time limit\(after)", .bad)
        case "stopped": return ("Stopped\(after)", .quiet)
        case "revoked": return ("Stopped: its credential was revoked", .bad)
        default: return ("Lost track of it", .bad)
        }
    }

    /// "4s", "3m 12s", "1h 5m".
    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3600)h \((total % 3600) / 60)m"
    }
}

struct ScriptRunsResponse: Decodable, Sendable {
    let runs: [ScriptRun]

    private enum CodingKeys: String, CodingKey { case runs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runs = (try? c.decodeIfPresent(LossyList<ScriptRun>.self, forKey: .runs))?.items ?? []
    }
}

struct ScriptRunDetailResponse: Decodable, Sendable {
    let run: ScriptRun?
}

// MARK: - You should know

/// A "You should know" note (server/you-should-know.ts), split back into its
/// tag and learn line the way the protocol's `parseYouShouldKnowTitle` does.
struct YouShouldKnowNote: Equatable, Sendable {
    static let kind = "you-should-know"

    let tag: String
    let line: String
    let explanation: String

    init(title: String, explanation: String) {
        if let range = title.range(of: " \u{00b7} ") {
            tag = String(title[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
            line = String(title[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        } else {
            tag = "You should know"
            line = title.trimmingCharacters(in: .whitespaces)
        }
        self.explanation = explanation.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The composer draft for "Ask about this": a quote the person replies
    /// under, matching the web's `youShouldKnowChatText`.
    var chatText: String {
        var rows = ["\(tag) \u{00b7} \(line)"]
        if !explanation.isEmpty { rows += [""] + explanation.components(separatedBy: "\n") }
        let quoted = rows.map { $0.isEmpty ? ">" : "> \($0)" }.joined(separator: "\n")
        return "About this note from the side agent:\n\n\(quoted)\n\n"
    }
}
