import Foundation

/// Arbitrary JSON — used for `toolInput`, which has no fixed schema.
enum JSONValue: Decodable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }

    /// Pretty multi-line rendering for the expanded tool-input view.
    var pretty: String {
        prettyLines(indent: "")
    }

    private func prettyLines(indent: String) -> String {
        let deeper = indent + "  "
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value == value.rounded() && abs(value) < 1e15
                ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .array(let items):
            if items.isEmpty { return "[]" }
            let body = items
                .map { "\(deeper)- \($0.prettyLines(indent: deeper))" }
                .joined(separator: "\n")
            return "\n" + body
        case .object(let dict):
            if dict.isEmpty { return "{}" }
            let body = dict.keys.sorted()
                .map { "\(deeper)\($0): \(dict[$0]!.prettyLines(indent: deeper))" }
                .joined(separator: "\n")
            return "\n" + body
        }
    }
}

/// One transcript entry, as returned by `GET /api/sessions/:id/transcript` and
/// carried inside WS `transcript_*` / `stream_tool_*` frames.
struct TranscriptEntry: Identifiable, Decodable, Equatable, Sendable {
    let id: String
    let type: String // "user" | "assistant" | "tool_use" | "tool_result" | "system"
    var content: String?
    var timestamp: String?
    var toolName: String?
    var toolInput: JSONValue?
    var toolUseId: String?
    /// Stable outbox identities whose accepted messages formed this user turn.
    /// One engine turn can batch several separately sent messages.
    var sourceMessageIds: [String]?
    /// Content-free marker separating a completed response from a later
    /// system-triggered turn. It affects grouping but never renders a row.
    var turnBoundary: Bool?
    /// Provider-supplied reasoning summary. Optional so transcripts from older
    /// servers keep decoding; only `true` changes presentation.
    var isReasoning: Bool?
    var isError: Bool?
    var model: String?
    var agentId: String?
    var contentClamped: Bool?
    var contentLength: Int?
    /// Image attachments on conversation messages: `data:` URLs or bounded
    /// transcript `os-blob:` references resolved through the image endpoint.
    var images: [String]?
    /// Video attachments and tool-result recordings, served through the media
    /// endpoint and streamed by the native player.
    var videos: [String]?
    /// Images an agent marked as the visual result of its work. A merged-change
    /// share uses the newest local screenshot when no walkthrough still exists.
    var featuredMedia: [String]?
    /// Large pastes sent beside the message. The server lifted them out of
    /// `content` (protocol pasted-text.ts); each renders as a card under the
    /// bubble rather than as pages of log inside it.
    var pastedTexts: [String]?
    /// Set when this entry is an operational notice rather than a message —
    /// a runner line, a recap, a worker's report, a heads-up from another
    /// session. The server classifies it (protocol notices.ts) and strips the
    /// delivery plumbing out of `content`, so every kind renders through one
    /// row here instead of each client re-deriving its own.
    var notice: EntryNotice?
    /// Who sent this turn when it wasn't the session's driver — a teammate who
    /// steered in, or one whose answer was routed back from `senderVia`.
    var sender: String?
    var senderVia: String?
    /// Structured payload of an answered question card. The classified
    /// notice carries it too (`notice.ask`); this is the compatibility spot
    /// for a server that predates the notice-level field.
    var ask: AnsweredAsk?
    /// Server-derived tool identity and summary data. Optional because older
    /// servers do not send it; `ToolPresentation` keeps the native derivation
    /// as the compatibility path.
    var presentation: TranscriptToolPresentation?

    var text: String { content ?? "" }

    var timestampDate: Date? {
        Session.parseISO(timestamp)
    }

    var isUser: Bool { type == "user" }
    var isAssistant: Bool { type == "assistant" }
    var isTool: Bool { type == "tool_use" || type == "tool_result" }
    var isSystem: Bool { type == "system" }

    var media: TranscriptMedia {
        TranscriptMedia(images: images ?? [], videos: videos ?? [])
    }

    /// Resolve the provenance list against the renderable sources. The server
    /// can retain an original path in `featuredMedia` while bounding or
    /// rewriting another source, so only exact renderable matches survive.
    var explicitlyFeaturedMedia: TranscriptMedia {
        let featured = Set(featuredMedia ?? [])
        return TranscriptMedia(
            images: (images ?? []).filter(featured.contains),
            videos: (videos ?? []).filter(featured.contains)
        )
    }
}

/// Renderable media carried by one entry or projected out of a folded turn.
struct TranscriptMedia: Equatable, Sendable {
    var images: [String] = []
    var videos: [String] = []

    var count: Int { images.count + videos.count }
    var isEmpty: Bool { count == 0 }

    var label: String {
        if videos.isEmpty {
            return "\(images.count) image\(images.count == 1 ? "" : "s")"
        }
        if images.isEmpty {
            return "\(videos.count) video\(videos.count == 1 ? "" : "s")"
        }
        return "\(count) media"
    }
}

/// Tolerant subset of the protocol's `ToolPresentation`. Every field stays
/// optional so one newer or incomplete presentation cannot make the enclosing
/// transcript entry fail to decode.
struct TranscriptToolPresentation: Decodable, Equatable, Sendable {
    let canonical: String?
    let mcpServer: String?
    let name: String?
    let family: String?
    let detail: TranscriptToolDetail?
    let lineStats: TranscriptToolLineStats?
}

/// Structured one-line summary from the server. Unknown `kind` values decode
/// successfully and fall back to the native summary formatter.
struct TranscriptToolDetail: Decodable, Equatable, Sendable {
    let kind: String?
    let path: String?
    let paths: [String]?
    let labels: [String]?
    let more: Int?
    let command: String?
    let text: String?
    let total: Int?
    let done: Int?
    let current: String?
}

struct TranscriptToolLineStats: Decodable, Equatable, Sendable {
    let additions: Int?
    let deletions: Int?
}

/// How an entry that isn't a message reads. One shape for all of them: a
/// title, how loudly to say it, optionally a body to put underneath, and at
/// most one action. Unknown `kind`s from a newer server still render, because
/// nothing here branches on it.
struct EntryNotice: Decodable, Equatable, Sendable {
    /// What produced it ("system", "recap", "worker-report", …). Carried for
    /// diagnostics; deliberately not a rendering switch.
    let kind: String
    let title: String
    /// "info" | "warn" | "error" — an unknown value reads as info.
    let tone: String
    /// "inline" (always shown) | "collapsed" (behind show/hide). Absent means
    /// the title is the whole notice.
    let body: String?
    let link: Link?
    /// Present only for an answered question card: the structured record a
    /// client that understands it renders read-only (`AnsweredAskCard`);
    /// title + body stay the compatibility path.
    let ask: AnsweredAsk?
    /// A quiet state mark on an `info` notice: "merge", "deploy", "done".
    /// These lines used to open with an emoji of their own; the server strips
    /// it and names the state instead, so each client draws it in its own
    /// icon set. An unknown name renders as plain text.
    let icon: String?

    struct Link: Decodable, Equatable, Sendable {
        let label: String
        let sessionId: String
    }

    var showsBodyInline: Bool { body == "inline" }
    var isCollapsible: Bool { body == "collapsed" }

    /// The SF Symbol for `icon`. `tone.symbol` outranks it: a warning says
    /// more than a merge mark, and only one glyph fits the line.
    var iconSymbol: String? {
        switch icon {
        case "merge": "arrow.triangle.merge"
        case "deploy": "arrow.up.circle"
        case "done": "checkmark"
        default: nil
        }
    }
}
