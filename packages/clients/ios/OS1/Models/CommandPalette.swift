import Foundation

#if os(macOS)

/// One row the Mac command palette can show: a command it runs, or a session
/// it switches to.
///
/// Data only, no closure, so ranking is a pure function over values and can be
/// tested without a view — `CommandPaletteItem` is what pairs an entry with
/// what selecting it does.
struct CommandPaletteEntry: Identifiable, Equatable, Sendable {
    enum Kind: Int, Sendable {
        /// Something the app does. Listed above sessions, in declared order.
        case command
        /// Somewhere the app goes. Ranked by how well it matched, then by how
        /// recently it was active.
        case session
    }

    let id: String
    let title: String
    /// The line under the title: what a command does, or where a session lives.
    var subtitle: String?
    /// Words that should find the row without being written on it — a
    /// session's repo, branch and workspace, a command's synonyms.
    var keywords: [String] = []
    /// The keys that run the same thing without opening the palette, one cap
    /// each. Empty when there is no shortcut, rather than a fake one.
    var shortcut: [String] = []
    var symbol: String = "circle"
    var kind: Kind = .command
    /// Breaks ties between sessions. Nil on commands, which keep the order
    /// they were declared in.
    var recency: Date?
}

/// Which rows a query keeps, and in what order.
///
/// Matching is the shared `FuzzyMatch`, the same rules as the web palette:
/// every whitespace-separated term has to land somewhere in the row, exactly,
/// within a small edit distance, or as an abbreviation of one word, so
/// "relase" still finds Release. Where it lands is the rank: a match in the
/// title beats one that needed the subtitle or a keyword, and within each the
/// scorer's own order holds (the title's start over a word inside it, over a
/// typo).
enum CommandPaletteRanking {
    private struct Candidate {
        let entry: CommandPaletteEntry
        let order: Int
        let score: Int
    }

    static func results(
        _ entries: [CommandPaletteEntry],
        query: String,
        sessionLimit: Int = 40,
        contentMatches: Set<String> = []
    ) -> [CommandPaletteEntry] {
        var matched: [Candidate] = []
        for (order, entry) in entries.enumerated() {
            let score = score(entry, query: query)
            if score > 0 {
                matched.append(Candidate(entry: entry, order: order, score: score))
            } else if entry.kind == .session, contentMatches.contains(entry.id) {
                // A backend transcript hit ranks after every metadata match,
                // whose weakest score is still at least one.
                matched.append(Candidate(entry: entry, order: order, score: 0))
            }
        }

        matched.sort { left, right in
            if left.entry.kind != right.entry.kind {
                return left.entry.kind.rawValue < right.entry.kind.rawValue
            }
            if left.score != right.score { return left.score > right.score }
            if left.entry.kind == .session {
                let leftDate = left.entry.recency ?? .distantPast
                let rightDate = right.entry.recency ?? .distantPast
                if leftDate != rightDate { return leftDate > rightDate }
            }
            return left.order < right.order
        }

        var sessions = 0
        return matched.compactMap { candidate in
            guard candidate.entry.kind == .session else { return candidate.entry }
            sessions += 1
            return sessions <= sessionLimit ? candidate.entry : nil
        }
    }

    /// 0 when the row does not match. A title match sits a full band above a
    /// match that needed the subtitle or keywords, and a query whose terms are
    /// spread across both still counts, since the row as a whole is searched.
    private static func score(_ entry: CommandPaletteEntry, query: String) -> Int {
        let title = FuzzyMatch.score(query, entry.title)
        if title > 0 { return 100 + title }
        let rest = ([entry.title, entry.subtitle].compactMap { $0 } + entry.keywords)
            .joined(separator: " ")
        return FuzzyMatch.score(query, rest)
    }
}

#endif
