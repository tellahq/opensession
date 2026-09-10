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
/// Every whitespace-separated token has to land somewhere in the row, and
/// where it lands is the score — the title's start beats a word inside it,
/// which beats the subtitle or a keyword. A token that lands nowhere exactly
/// may still land as a near miss (`FuzzyMatch`: a bounded edit distance or an
/// in-word abbreviation), which ranks under every exact placement. It is not a
/// free subsequence matcher: on a list where most rows are sessions with long,
/// similar titles, that turns every query into a wall of near-misses.
enum CommandPaletteRanking {
    /// A row with its searchable text folded once per call. Folding inside the
    /// comparator would redo it for every comparison.
    private struct Candidate {
        let entry: CommandPaletteEntry
        let order: Int
        let title: String
        let rest: String
        let titleWords: [String]
        let restWords: [String]
        var score = 0

        init(entry: CommandPaletteEntry, order: Int) {
            self.entry = entry
            self.order = order
            title = FuzzyMatch.fold(entry.title)
            rest = FuzzyMatch.fold(
                ([entry.subtitle].compactMap { $0 } + entry.keywords).joined(separator: " ")
            )
            titleWords = FuzzyMatch.words(of: title)
            restWords = FuzzyMatch.words(of: rest)
        }
    }

    static func results(
        _ entries: [CommandPaletteEntry],
        query: String,
        sessionLimit: Int = 40,
        contentMatches: Set<String> = []
    ) -> [CommandPaletteEntry] {
        let tokens = FuzzyMatch.fold(query).split(separator: " ").map(String.init)
        var matched: [Candidate] = []
        for (order, entry) in entries.enumerated() {
            var candidate = Candidate(entry: entry, order: order)
            var total = 0
            var matchedEveryToken = true
            for token in tokens {
                guard let score = score(token, in: candidate) else {
                    matchedEveryToken = false
                    break
                }
                total += score
            }
            if matchedEveryToken {
                candidate.score = total
            } else if entry.kind == .session, contentMatches.contains(entry.id) {
                // A backend transcript hit ranks after every metadata match,
                // whose weakest score is still at least one.
                candidate.score = 0
            } else {
                continue
            }
            matched.append(candidate)
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

    /// Exact placements score in hundreds; a near miss scores its
    /// `FuzzyMatch.nearMiss` (20 to 50), lifted by 25 when it is in the title.
    /// Everything stays at least one, so a transcript-only hit's zero still
    /// sorts last.
    private static func score(_ token: String, in candidate: Candidate) -> Int? {
        if candidate.title.hasPrefix(token) { return 400 }
        if let range = candidate.title.range(of: token) {
            return startsWord(candidate.title, at: range.lowerBound) ? 300 : 200
        }
        if candidate.rest.contains(token) { return 100 }
        let inTitle = FuzzyMatch.nearMiss(token, in: candidate.titleWords)
        if inTitle > 0 { return inTitle + 25 }
        let inRest = FuzzyMatch.nearMiss(token, in: candidate.restWords)
        if inRest > 0 { return inRest }
        return nil
    }

    private static func startsWord(_ text: String, at index: String.Index) -> Bool {
        guard index > text.startIndex else { return true }
        let before = text[text.index(before: index)]
        return !before.isLetter && !before.isNumber
    }
}

#endif
