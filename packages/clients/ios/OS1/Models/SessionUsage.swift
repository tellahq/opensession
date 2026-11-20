import Foundation

/// Cumulative token and cost accounting for one session, as the server folds
/// it (`SessionUsage` in packages/core/protocol). It rides on the session row and
/// is pushed live during a run by the `usage_update` frame.
///
/// Every field has a zero default: a server that predates one of them, or a
/// session that has never run, has to read as "nothing spent yet" rather than
/// fail to decode.
struct SessionUsage: Decodable, Equatable, Hashable, Sendable {
    var costUsd: Double = 0
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var cacheReadTokens: Int = 0
    var cacheCreationTokens: Int = 0
    /// The most recent turn's whole prompt — what the window currently holds.
    var contextTokens: Int = 0
    /// The token ceiling of the model that produced `contextTokens`. Zero
    /// where the engine didn't report one, which hides the context readout
    /// rather than showing a percentage of nothing.
    var contextWindow: Int = 0
    /// Completed turns folded into these totals.
    var turns: Int = 0
    var updatedAt: String?
    /// What `contextTokens` is made of, when the engine can tell. Nil from a
    /// server or engine that does not report it, which hides the breakdown.
    var context: ContextBreakdown?

    private enum CodingKeys: String, CodingKey {
        case costUsd, inputTokens, outputTokens, cacheReadTokens
        case cacheCreationTokens, contextTokens, contextWindow, turns, updatedAt
        case context
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        costUsd = try container.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0
        inputTokens = try container.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try container.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cacheReadTokens =
            try container.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheCreationTokens =
            try container.decodeIfPresent(Int.self, forKey: .cacheCreationTokens) ?? 0
        contextTokens = try container.decodeIfPresent(Int.self, forKey: .contextTokens) ?? 0
        contextWindow = try container.decodeIfPresent(Int.self, forKey: .contextWindow) ?? 0
        turns = try container.decodeIfPresent(Int.self, forKey: .turns) ?? 0
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        // A malformed breakdown costs the breakdown, never the usage row.
        context = try? container.decodeIfPresent(ContextBreakdown.self, forKey: .context)
    }

    /// For tests and the empty state a menu renders before the first run.
    init(
        costUsd: Double = 0,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheCreationTokens: Int = 0,
        contextTokens: Int = 0,
        contextWindow: Int = 0,
        turns: Int = 0,
        updatedAt: String? = nil,
        context: ContextBreakdown? = nil
    ) {
        self.costUsd = costUsd
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.turns = turns
        self.updatedAt = updatedAt
        self.context = context
    }
}

/// An estimate of what fills the context window (`ContextBreakdown` in
/// packages/core/protocol/src/events.ts). The fixed sections are sized from
/// their text and `messages` takes the remainder, so the sections add up to
/// `contextTokens`.
struct ContextBreakdown: Decodable, Equatable, Hashable, Sendable {
    var sections: [ContextSection] = []
    /// Prompt size at which the engine compacts the conversation.
    var compactAtTokens: Int?
    /// How many times this conversation has been compacted so far.
    var compactions: Int?

    private enum CodingKeys: String, CodingKey {
        case sections, compactAtTokens, compactions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // One bad section is dropped on its own rather than losing the rest.
        sections = (try? container.decodeIfPresent([LossySection].self, forKey: .sections))?
            .compactMap(\.value) ?? []
        compactAtTokens = try? container.decodeIfPresent(Int.self, forKey: .compactAtTokens)
        compactions = try? container.decodeIfPresent(Int.self, forKey: .compactions)
    }

    init(sections: [ContextSection] = [], compactAtTokens: Int? = nil, compactions: Int? = nil) {
        self.sections = sections
        self.compactAtTokens = compactAtTokens
        self.compactions = compactions
    }

    private struct LossySection: Decodable {
        let value: ContextSection?
        init(from decoder: Decoder) throws { value = try? ContextSection(from: decoder) }
    }
}

/// One part of the prompt. `kind` stays a string: a newer server can send a
/// kind this build does not know, and it still has to count.
struct ContextSection: Decodable, Equatable, Hashable, Sendable {
    var kind: String
    var tokens: Int
}

// MARK: - Context

/// How full the context is, measured two ways, as the web's `contextFill`
/// (UsageMeter.tsx). The gauge runs to the point the engine compacts, since
/// that is the next thing that happens to the conversation; on a 1M model
/// that is well under half the window. The warning tone still reads the
/// window itself: only a prompt near the real ceiling is a problem.
struct ContextFill: Equatable, Sendable {
    var tokens: Int
    var window: Int
    /// The gauge's ceiling: the compaction point when it sits under the
    /// window, otherwise the window. Zero hides the gauge.
    var limit: Int
    /// The gauge runs to the compaction point rather than the window.
    var compacts: Bool { limit > 0 && limit < window }
    /// 0...1 of `limit`.
    var fraction: Double { limit > 0 ? min(Double(tokens) / Double(limit), 1) : 0 }
    var percent: Int { Int((fraction * 100).rounded()) }
    /// Past 85% of the window itself, where the web turns its readout red.
    var isTight: Bool { window > 0 && Double(tokens) / Double(window) >= 0.85 }

    init(_ usage: SessionUsage?) {
        tokens = usage?.contextTokens ?? 0
        window = usage?.contextWindow ?? 0
        let compactAt = usage?.context?.compactAtTokens ?? 0
        limit = compactAt > 0 && compactAt < window ? compactAt : window
    }
}

/// One row of the context breakdown, in display order.
struct ContextRow: Equatable, Sendable, Identifiable {
    enum Kind: String, CaseIterable, Sendable {
        // The conversation first, then what is sent before it.
        case messages, summary
        case systemPrompt = "system-prompt"
        case instructions, tools
        case mcpTools = "mcp-tools"
        case skills
        /// Any kind this build does not know, folded into one row.
        case other

        var label: String {
            switch self {
            case .messages: "Messages"
            case .summary: "Earlier summary"
            case .systemPrompt: "System prompt"
            case .instructions: "Project instructions"
            case .tools: "Tools"
            case .mcpTools: "MCP tools"
            case .skills: "Skills"
            case .other: "Other"
            }
        }
    }

    var kind: Kind
    var tokens: Int
    var label: String { kind.label }
    var id: String { kind.rawValue }
}

extension ContextBreakdown {
    /// The sections in display order, empty ones dropped, with every kind
    /// this build does not know summed into one "Other" row rather than
    /// lost: the rows must keep adding up to the total above them.
    var rows: [ContextRow] {
        var totals: [ContextRow.Kind: Int] = [:]
        for section in sections where section.tokens > 0 {
            let kind = ContextRow.Kind(rawValue: section.kind) ?? .other
            totals[kind, default: 0] += section.tokens
        }
        return ContextRow.Kind.allCases.compactMap { kind in
            totals[kind].map { ContextRow(kind: kind, tokens: $0) }
        }
    }

    /// Whole percent of the breakdown one row takes.
    static func share(_ row: ContextRow, of rows: [ContextRow]) -> Int {
        let total = rows.reduce(0) { $0 + $1.tokens }
        guard total > 0 else { return 0 }
        return Int((Double(row.tokens) / Double(total) * 100).rounded())
    }
}

// MARK: - Display

/// The formatting is a deliberate copy of the web's `UsageMeter.tsx`, down to
/// the thresholds: the same conversation read on a phone and in a browser has
/// to say the same number, or one of the two is quietly wrong. The grouping
/// and decimal marks follow the reader's locale, as the web's own
/// `Intl.NumberFormat(undefined, …)` does — which is why every entry point
/// takes a locale instead of baking one in.
extension SessionUsage {
    /// `$0.00` at nothing, `<$0.01` for a fraction of a cent, two decimals
    /// under $100, whole dollars above it.
    static func costLabel(_ amount: Double, locale: Locale = .autoupdatingCurrent) -> String {
        if amount <= 0 { return "$0.00" }
        if amount < 0.01 { return "<$0.01" }
        if amount < 100 { return String(format: "$%.2f", amount) }
        return "$" + Int(amount.rounded()).formatted(.number.locale(locale))
    }

    /// Exact under a thousand, compact above it — `45.3K`, `1.2M`.
    static func tokenLabel(_ count: Int, locale: Locale = .autoupdatingCurrent) -> String {
        if count < 1_000 { return String(count) }
        return count.formatted(
            .number.notation(.compactName)
                .precision(.fractionLength(0...1))
                .locale(locale)
        )
    }

    func costLabel(locale: Locale = .autoupdatingCurrent) -> String {
        Self.costLabel(costUsd, locale: locale)
    }

    var contextFill: ContextFill { ContextFill(self) }

    /// `128.4K / 200K (64%)`, or nil when the engine reported no window:
    /// a percentage of an unknown ceiling means nothing. Measured against
    /// the compaction point when the engine reports one under the window.
    func contextLabel(locale: Locale = .autoupdatingCurrent) -> String? {
        let fill = contextFill
        guard fill.limit > 0 else { return nil }
        return "\(Self.tokenLabel(fill.tokens, locale: locale))"
            + " / \(Self.tokenLabel(fill.limit, locale: locale))"
            + " (\(fill.percent)%)"
    }

    /// True once the window is nearly full: the point the web turns its
    /// readout red rather than leaving it as dim chrome.
    var contextIsTight: Bool { contextFill.isTight }

    /// When the conversation is next summarized, and how often it has been:
    /// `Compacts at 400K of a 1M window. Compacted twice.` Nil when there is
    /// nothing to say.
    func compactionNote(locale: Locale = .autoupdatingCurrent) -> String? {
        let fill = contextFill
        var parts: [String] = []
        if fill.compacts {
            parts.append(
                "Compacts at \(Self.tokenLabel(fill.limit, locale: locale))"
                    + " of a \(Self.tokenLabel(fill.window, locale: locale)) window"
            )
        }
        let times = context?.compactions ?? 0
        if times > 0 { parts.append("Compacted \(times == 1 ? "once" : "\(times) times")") }
        return parts.isEmpty ? nil : parts.joined(separator: ". ") + "."
    }

    /// Every token the conversation has sent or received, cache included.
    var totalTokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens }

    /// Share of everything sent that the provider served from cache.
    var cacheHitPercent: Int {
        let total = inputTokens + cacheReadTokens + cacheCreationTokens
        guard total > 0 else { return 0 }
        return Int((Double(cacheReadTokens) / Double(total) * 100).rounded())
    }

    func cacheReadLabel(locale: Locale = .autoupdatingCurrent) -> String {
        "\(Self.tokenLabel(cacheReadTokens, locale: locale)) (\(cacheHitPercent)%)"
    }

    var turnsLabel: String { "\(turns) turn\(turns == 1 ? "" : "s")" }
}
