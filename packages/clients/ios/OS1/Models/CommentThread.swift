import Foundation

// Wire model of a session's comment threads
// (src/server/comment-threads.ts, routes/comment-threads.ts).
//
// A thread with an `anchor` is an inline comment on a passage of one
// transcript entry; without one it is a team note that sits in the timeline,
// ordered by `ts`. People talk to each other here; the agent's run never sees
// it. Decoding is tolerant: optional fields fall back, unknown fields are
// ignored, and a comment this build cannot read is dropped rather than
// failing the thread.

/// The passage a thread points at: the selected words plus a little context
/// either side, scoped to one transcript entry.
struct TextAnchor: Codable, Equatable, Hashable, Sendable {
    let entryId: String
    let exact: String
    let prefix: String
    let suffix: String

    init(entryId: String, exact: String, prefix: String = "", suffix: String = "") {
        self.entryId = entryId
        self.exact = exact
        self.prefix = prefix
        self.suffix = suffix
    }

    private enum CodingKeys: String, CodingKey { case entryId, exact, prefix, suffix }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entryId = try c.decode(String.self, forKey: .entryId)
        exact = try c.decode(String.self, forKey: .exact)
        prefix = ((try? c.decodeIfPresent(String.self, forKey: .prefix)) ?? nil) ?? ""
        suffix = ((try? c.decodeIfPresent(String.self, forKey: .suffix)) ?? nil) ?? ""
    }

    var body: [String: Any] {
        ["entryId": entryId, "exact": exact, "prefix": prefix, "suffix": suffix]
    }
}

struct ThreadComment: Decodable, Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let user: String
    let text: String
    let images: [String]?
    /// Milliseconds since 1970.
    let ts: Double
    let editedAt: Double?
    /// Written by the agent rather than a person.
    let agent: Bool

    init(
        id: String,
        user: String,
        text: String,
        images: [String]? = nil,
        ts: Double,
        editedAt: Double? = nil,
        agent: Bool = false
    ) {
        self.id = id
        self.user = user
        self.text = text
        self.images = images
        self.ts = ts
        self.editedAt = editedAt
        self.agent = agent
    }

    private enum CodingKeys: String, CodingKey { case id, user, text, images, ts, editedAt, agent }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        user = ((try? c.decodeIfPresent(String.self, forKey: .user)) ?? nil) ?? ""
        text = ((try? c.decodeIfPresent(String.self, forKey: .text)) ?? nil) ?? ""
        let images = (try? c.decodeIfPresent([String].self, forKey: .images)) ?? nil
        self.images = images?.isEmpty == false ? images : nil
        ts = ((try? c.decodeIfPresent(Double.self, forKey: .ts)) ?? nil) ?? 0
        editedAt = (try? c.decodeIfPresent(Double.self, forKey: .editedAt)) ?? nil
        agent = ((try? c.decodeIfPresent(Bool.self, forKey: .agent)) ?? nil) ?? false
    }

    var date: Date { Date(timeIntervalSince1970: ts / 1_000) }
}

/// One teammate's read receipt on a thread: who, and when they last saw it.
struct ThreadSeen: Decodable, Equatable, Hashable, Sendable {
    let user: String
    /// Milliseconds since 1970.
    let ts: Double

    init(user: String, ts: Double) {
        self.user = user
        self.ts = ts
    }
}

struct CommentThread: Decodable, Identifiable, Equatable, Hashable, Sendable {
    enum Status: String, Sendable { case open, resolved }

    let id: String
    let sessionId: String
    let anchor: TextAnchor?
    let status: Status
    let createdBy: String
    /// Milliseconds since 1970 of the first comment.
    let ts: Double
    let updatedAt: Double
    let resolvedBy: String?
    let resolvedAt: Double?
    let assignee: String?
    /// When the agent started answering in the thread.
    let agentPendingSince: Double?
    let comments: [ThreadComment]
    /// Built from a legacy `session_note` by a client talking to a server that
    /// predates threads. Such a thread takes no replies or state changes.
    let legacy: Bool
    /// Read receipts, one per person, newest sighting each.
    let seenBy: [ThreadSeen]

    init(
        id: String,
        sessionId: String,
        anchor: TextAnchor? = nil,
        status: Status = .open,
        createdBy: String,
        ts: Double,
        updatedAt: Double? = nil,
        resolvedBy: String? = nil,
        resolvedAt: Double? = nil,
        assignee: String? = nil,
        agentPendingSince: Double? = nil,
        comments: [ThreadComment],
        legacy: Bool = false,
        seenBy: [ThreadSeen] = []
    ) {
        self.id = id
        self.sessionId = sessionId
        self.anchor = anchor
        self.status = status
        self.createdBy = createdBy
        self.ts = ts
        self.updatedAt = updatedAt ?? ts
        self.resolvedBy = resolvedBy
        self.resolvedAt = resolvedAt
        self.assignee = assignee
        self.agentPendingSince = agentPendingSince
        self.comments = comments
        self.legacy = legacy
        self.seenBy = seenBy
    }

    /// A team note from the old notes API, as the session-level thread the
    /// server now stores it as (the note id IS the thread id).
    init(legacyNote note: SessionNote, sessionId: String) {
        self.init(
            id: note.id,
            sessionId: sessionId,
            createdBy: note.user,
            ts: note.ts,
            updatedAt: note.editedAt ?? note.ts,
            comments: [ThreadComment(
                id: note.id,
                user: note.user,
                text: note.text,
                images: note.images,
                ts: note.ts,
                editedAt: note.editedAt
            )],
            legacy: true
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id, sessionId, anchor, status, createdBy, ts, updatedAt
        case resolvedBy, resolvedAt, assignee, agentPendingSince, comments, seenBy
    }

    private struct LossySeen: Decodable {
        let seen: ThreadSeen?
        init(from decoder: Decoder) throws {
            guard let c = try? decoder.container(keyedBy: Keys.self),
                  let user = (try? c.decodeIfPresent(String.self, forKey: .user)) ?? nil,
                  !user.trimmingCharacters(in: .whitespaces).isEmpty,
                  let ts = (try? c.decodeIfPresent(Double.self, forKey: .ts)) ?? nil
            else { seen = nil; return }
            seen = ThreadSeen(user: user, ts: ts)
        }
        private enum Keys: String, CodingKey { case user, ts }
    }

    private struct LossyComment: Decodable {
        let comment: ThreadComment?
        init(from decoder: Decoder) throws { comment = try? ThreadComment(from: decoder) }
    }

    struct Empty: Error {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String? {
            let value = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil
            return value?.isEmpty == false ? value : nil
        }
        func number(_ key: CodingKeys) -> Double? {
            (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil
        }
        id = try c.decode(String.self, forKey: .id)
        sessionId = string(.sessionId) ?? ""
        anchor = (try? c.decodeIfPresent(TextAnchor.self, forKey: .anchor)) ?? nil
        status = Status(rawValue: string(.status) ?? "") ?? .open
        let comments = (((try? c.decodeIfPresent([LossyComment].self, forKey: .comments)) ?? nil) ?? [])
            .compactMap(\.comment)
        // A thread is its opening comment; without one there is nothing to show.
        guard let root = comments.first else { throw Empty() }
        self.comments = comments
        createdBy = string(.createdBy) ?? root.user
        ts = number(.ts) ?? root.ts
        updatedAt = number(.updatedAt) ?? ts
        resolvedBy = string(.resolvedBy)
        resolvedAt = number(.resolvedAt)
        assignee = string(.assignee)
        agentPendingSince = number(.agentPendingSince)
        seenBy = (((try? c.decodeIfPresent([LossySeen].self, forKey: .seenBy)) ?? nil) ?? [])
            .compactMap(\.seen)
        legacy = false
    }

    var root: ThreadComment { comments[0] }
    var isResolved: Bool { status == .resolved }
    var replyCount: Int { max(0, comments.count - 1) }
    var date: Date { Date(timeIntervalSince1970: ts / 1_000) }

    /// A side answer that has been "in progress" this long was cut off by a
    /// restart; stop showing it as working (web `agentIsAnswering`).
    static let agentPendingStaleMs: Double = 10 * 60_000

    func agentIsAnswering(now: Date = .now) -> Bool {
        guard let since = agentPendingSince else { return false }
        return now.timeIntervalSince1970 * 1_000 - since < Self.agentPendingStaleMs
    }

    /// The agent's name in this thread, as the server wrote it.
    var agentName: String? { comments.first { $0.agent }?.user }

    /// One line of the opening comment, for lists and tooltips.
    func preview(length: Int = 80) -> String {
        let text = root.text
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return text.count > length ? String(text.prefix(length - 1)) + "\u{2026}" : text
    }

    /// The message this thread becomes in the composer when it is sent to the
    /// main session (web `sendToSessionText`): the passage, the conversation,
    /// and how to answer back into the thread.
    var sendToSessionText: String {
        var parts: [String] = []
        if let anchor { parts += [CommentThreads.quote(anchor.exact), ""] }
        parts += ["From a comment thread on this session:", ""]
        for comment in comments {
            parts.append(
                "**\(comment.user)\(comment.agent ? " (you, answering on the side)" : ""):** \(comment.text)"
            )
        }
        parts += [
            "",
            "Please take care of this. When you're done, reply in the thread (opensession-comments reply_to_comment_thread, threadId `\(id)`) with what you did.",
        ]
        return parts.joined(separator: "\n")
    }
}

/// A teammate tagged in a thread's newest comment, and when they saw it
/// (web `TagReceipt`).
struct TagReceipt: Equatable, Sendable {
    let name: String
    /// Milliseconds since 1970 they saw the newest comment; nil until they have.
    var seenAt: Double?
}

/// Read receipts on a team note. Mirrors `taggedReceipts`, `needsSeenMark`
/// and `seenByLabel` in src/frontend/lib/comment-threads.ts, with the web's
/// `parseMentions` for which `@word` names somebody.
enum NoteReceipts {
    /// A roster entry: the first name the wire uses, and the full name.
    struct Person: Equatable, Sendable {
        let name: String
        let fullName: String
    }

    @MainActor static var roster: [Person] {
        let directory = TeamDirectory.shared
        return directory.names.map { Person(name: $0, fullName: directory.fullName(for: $0)) }
    }

    /// The web's TOKEN_RE, JavaScript's ASCII `\w` included. A URL is matched
    /// first so an `@` inside one is not a mention.
    private static let regex = try? NSRegularExpression(
        pattern: #"(@[A-Za-z][A-Za-z0-9_.-]*)|(https?://[^\s<>"')\]]+)"#
    )

    /// Roster names the text @-mentions, in order, repeats kept.
    static func mentions(_ text: String, people: [Person]) -> [String] {
        guard let regex, !text.isEmpty else { return [] }
        var out: [String] = []
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range(at: 1), in: text) else { continue }
            var typed = String(text[range].dropFirst())
            while let last = typed.last, ".,;:!?".contains(last) { typed.removeLast() }
            let lower = typed.lowercased()
            if let person = people.first(where: { $0.name.lowercased() == lower || $0.fullName.lowercased() == lower }) {
                out.append(person.name)
            }
        }
        return out
    }

    private static func sameName(_ a: String, _ b: String) -> Bool {
        a.trimmingCharacters(in: .whitespaces).lowercased() == b.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// Milliseconds since 1970 of the newest thing to read: a comment or an edit.
    static func lastActivityAt(_ thread: CommentThread) -> Double {
        thread.comments.reduce(0) { max($0, $1.editedAt ?? $1.ts, $1.ts) }
    }

    /// Receipts for the people the newest comment tags, in tag order, never
    /// its author. Nobody tagged means no receipt.
    static func tagged(_ thread: CommentThread, people: [Person]) -> [TagReceipt] {
        guard let latest = thread.comments.last, !latest.agent else { return [] }
        let since = lastActivityAt(thread)
        var out: [TagReceipt] = []
        for name in mentions(latest.text, people: people) {
            if sameName(name, latest.user) || out.contains(where: { sameName($0.name, name) }) { continue }
            let person = people.first { sameName($0.name, name) }
            let seen = thread.seenBy.first { seen in
                seen.ts >= since
                    && (sameName(seen.user, name) || (person.map { sameName(seen.user, $0.fullName) } ?? false))
            }
            out.append(TagReceipt(name: name, seenAt: seen?.ts))
        }
        return out
    }

    /// Whether `me` still owes the thread a receipt: the newest comment tags
    /// me and I have not seen it since.
    static func needsSeenMark(_ thread: CommentThread, me: String, people: [Person]) -> Bool {
        guard !me.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return tagged(thread, people: people).contains { sameName($0.name, me) && $0.seenAt == nil }
    }

    /// "Ada", "Ada and Bob", "Ada, Bob and 2 others".
    static func label(_ names: [String]) -> String {
        if names.count <= 2 { return names.joined(separator: " and ") }
        if names.count == 3 { return "\(names[0]), \(names[1]) and \(names[2])" }
        return "\(names[0]), \(names[1]) and \(names.count - 2) others"
    }

    /// "Seen by Ada · Not seen by Bob", or nil when nobody is tagged.
    static func line(_ receipts: [TagReceipt]) -> String? {
        let seen = receipts.filter { $0.seenAt != nil }.map(\.name)
        let waiting = receipts.filter { $0.seenAt == nil }.map(\.name)
        let parts = [
            seen.isEmpty ? nil : "Seen by \(label(seen))",
            waiting.isEmpty ? nil : "Not seen by \(label(waiting))",
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00b7} ")
    }
}

enum CommentThreads {
    static func quote(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces).isEmpty ? ">" : "> \($0)" }
            .joined(separator: "\n")
    }

    static func sameUser(_ a: String?, _ b: String?) -> Bool {
        guard let a = a?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty,
              let b = b?.trimmingCharacters(in: .whitespacesAndNewlines), !b.isEmpty
        else { return false }
        return a.localizedCaseInsensitiveCompare(b) == .orderedSame
    }

    /// The thread a link points at: `?thread=<id>` on a session link, the
    /// shape the server writes into every comment notification.
    static func threadId(inLink url: String) -> String? {
        guard let query = url.split(separator: "?", maxSplits: 1).dropFirst().first else { return nil }
        let items = URLComponents(string: "?" + query.prefix { $0 != "#" })?.queryItems ?? []
        let id = items.first { $0.name == "thread" }?.value
        return id?.isEmpty == false ? id : nil
    }

    /// The session-relative link that opens a session with one thread
    /// focused, the same one the server puts in notifications.
    static func link(sessionId: String, threadId: String) -> String {
        "/session/\(OS1API.pathComponent(sessionId))?thread=\(OS1API.pathComponent(threadId))"
    }
}

/// Lists of threads in the comments panel.
enum CommentThreadFilter: String, CaseIterable, Sendable {
    case open, assigned, resolved

    var title: String {
        switch self {
        case .open: "Open"
        case .assigned: "Assigned to me"
        case .resolved: "Resolved"
        }
    }

    func apply(_ threads: [CommentThread], me: String) -> [CommentThread] {
        threads.filter { thread in
            switch self {
            case .open: !thread.isResolved
            case .assigned: !thread.isResolved && CommentThreads.sameUser(thread.assignee, me)
            case .resolved: thread.isResolved
            }
        }
        .sorted { $0.updatedAt > $1.updatedAt }
    }
}
