import Foundation

/// The phase a running turn is in, from the live-only `stream_activity`
/// frame (protocol `RunActivity` in `events.ts`). The transcript above the
/// busy row already shows a tool, a thought or a reply, so only a compaction
/// and a retry wait get words on screen; every phase is still named for
/// VoiceOver. A kind this build does not know decodes as no activity.
enum RunActivity: Equatable, Sendable {
    /// A request is with the model and nothing has come back yet.
    case waiting
    /// The model is reasoning before it answers or acts.
    case thinking
    /// The model is writing text.
    case writing
    /// The model is writing the arguments of a tool call.
    case preparing(toolName: String?)
    /// Tool calls are executing. `toolName` is the most recent one.
    case tool(toolName: String?, count: Int)
    /// The engine is summarizing older messages to free context.
    case compacting
    /// A provider request failed and the engine waits to send it again.
    case retrying(attempt: Int, maxAttempts: Int, retryAt: Date)

    /// The wire object, read tolerantly: a missing or unknown kind, or a
    /// retry without its numbers, is no activity rather than a failed frame.
    struct Wire: Decodable, Sendable {
        let value: RunActivity?

        private enum Keys: String, CodingKey {
            case kind, toolName, count, attempt, maxAttempts, retryAt
        }

        init(from decoder: Decoder) throws {
            guard let c = try? decoder.container(keyedBy: Keys.self),
                  let kind = try? c.decode(String.self, forKey: .kind)
            else {
                value = nil
                return
            }
            let toolName = try? c.decodeIfPresent(String.self, forKey: .toolName)
            switch kind {
            case "waiting": value = .waiting
            case "thinking": value = .thinking
            case "writing": value = .writing
            case "preparing": value = .preparing(toolName: toolName ?? nil)
            case "tool":
                let count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? nil
                value = .tool(toolName: toolName ?? nil, count: count ?? 1)
            case "compacting": value = .compacting
            case "retrying":
                guard let attempt = try? c.decode(Int.self, forKey: .attempt),
                      let maxAttempts = try? c.decode(Int.self, forKey: .maxAttempts),
                      let retryAt = try? c.decode(Double.self, forKey: .retryAt)
                else {
                    value = nil
                    return
                }
                value = .retrying(
                    attempt: attempt,
                    maxAttempts: maxAttempts,
                    retryAt: Date(timeIntervalSince1970: retryAt / 1000)
                )
            default: value = nil
            }
        }
    }
}

/// What the busy row at the end of a live transcript says. Mirrors the web's
/// `busyActivityStatus` (`lib/busy-activity.ts`): the elapsed time from the
/// run's first second, plus words only for a pause nothing above explains.
struct BusyActivityStatus: Equatable {
    /// Words beside the dot: only a compaction or a retry wait gets them.
    var label: String?
    /// A quieter second fact about the same phase ("attempt 2 of 3").
    var detail: String?
    /// The phase in words for VoiceOver, which cannot see the dot.
    var spoken: String
    var elapsed: String

    init(elapsed: TimeInterval, activity: RunActivity?, now: Date = Date()) {
        self.elapsed = Self.liveElapsed(elapsed)
        let named = activity.map { Self.label(for: $0, now: now) }
        spoken = named?.label ?? "Working"
        switch activity {
        case .compacting, .retrying:
            label = named?.label
            detail = named?.detail
        default:
            label = nil
            detail = nil
        }
    }

    /// A run's live age, counted up from the first second: "0s", "59s",
    /// "1m 05s", "1h 02m". Floored, so the count never runs ahead of the
    /// clock, and padded past a minute, so the seconds hold their width.
    static func liveElapsed(_ interval: TimeInterval) -> String {
        guard interval.isFinite else { return "0s" }
        let secs = Int(max(0, interval).rounded(.down))
        if secs < 60 { return "\(secs)s" }
        let mins = secs / 60
        if mins < 60 { return "\(mins)m \(Self.pad(secs % 60))s" }
        return "\(mins / 60)h \(Self.pad(mins % 60))m"
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }

    /// A tool's family by name alone, as its row would draw it.
    private static func family(_ toolName: String?) -> ToolFamily {
        guard let toolName, !toolName.isEmpty else { return .other }
        return ToolPresentation.make(toolName: toolName, input: nil).family
    }

    private static func label(
        for activity: RunActivity,
        now: Date
    ) -> (label: String, detail: String?) {
        switch activity {
        case .waiting: return ("Waiting for the model", nil)
        case .thinking: return ("Thinking", nil)
        case .writing: return ("Writing", nil)
        case .preparing(let toolName):
            switch family(toolName) {
            case .run: return ("Writing a command", nil)
            case .edit: return ("Writing an edit", nil)
            default: return ("Preparing a tool call", nil)
            }
        case .tool(let toolName, let count):
            if count > 1 { return ("Running \(count) tools", nil) }
            return (family(toolName).activityLabel, nil)
        case .compacting: return ("Compacting the conversation", nil)
        case .retrying(let attempt, let maxAttempts, let retryAt):
            let seconds = Int(retryAt.timeIntervalSince(now).rounded(.up))
            return (
                seconds > 0 ? "Retrying in \(seconds)s" : "Retrying",
                "attempt \(attempt) of \(maxAttempts)"
            )
        }
    }
}
