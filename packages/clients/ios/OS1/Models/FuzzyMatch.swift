import Foundation

/// Typo-tolerant matching for the small search surfaces: the composer's `@`
/// palette, the Mac command palette, and the sidebar filter.
///
/// A port of the server's `src/shared/fuzzy-match.ts`, rule for rule, so a
/// query ranks the same here as in the web client and in the rows the server
/// scores for the `@` palette. Change both or neither.
///
/// Scores are 0 (no match) to 100 (exact). Every whitespace-separated term
/// must land somewhere in the text: as a substring, as a word within a small
/// edit distance (an adjacent transposition counts as one edit), or as a
/// subsequence of one word. Accents and case are ignored.
enum FuzzyMatch {
    /// Score `text` against `query`. 0 means no match; higher is a better
    /// match. An empty query matches everything at 1.
    static func score(_ query: String, _ text: String) -> Int {
        let q = trimmed(normalize(query))
        if q.isEmpty { return 1 }
        let t = normalize(text)
        if t.isEmpty { return 0 }
        if t == q { return 100 }
        if t.starts(with: q) { return 90 }
        let words = split(t)
        if words.contains(where: { $0.starts(with: q) }) { return 80 }
        if contains(t, q) { return 70 }
        let terms = q.split(whereSeparator: { $0.properties.isWhitespace }).map(Array.init)
        var total = 0
        for term in terms {
            let score = termScore(term, text: t, words: words)
            if score == 0 { return 0 }
            total += score
        }
        return Int((Double(total) / Double(terms.count)).rounded(.toNearestOrAwayFromZero))
    }

    /// The best score across several fields of one item. 0 means no match.
    static func best(_ query: String, in values: [String?]) -> Int {
        var best = 0
        for case let value? in values where !value.isEmpty {
            let score = score(query, value)
            if score > best { best = score }
            if best == 100 { break }
        }
        return best
    }

    // MARK: - Rules

    private typealias Scalars = [Unicode.Scalar]

    /// Edits a term may absorb: none for short ones, so "cat" never finds
    /// "cut".
    private static func editBudget(_ term: Scalars) -> Int {
        if term.count < 4 { return 0 }
        if term.count < 8 { return 1 }
        return 2
    }

    private static func termScore(_ term: Scalars, text: Scalars, words: [Scalars]) -> Int {
        if contains(text, term) { return 60 }
        let budget = editBudget(term)
        if budget > 0 {
            var best = budget + 1
            for word in words {
                if word.count < term.count - budget { continue }
                // Compare against the whole word and its prefix of the term's
                // length, so "wrokspace" and "relase" both land on their
                // intended word.
                let d = min(
                    editDistance(term, word, max: budget),
                    editDistance(term, Array(word.prefix(term.count)), max: budget)
                )
                if d < best { best = d }
                if best == 0 { break }
            }
            if best <= budget { return 50 - best * 10 }
        }
        // "wksp" for "workspace": abbreviations skip letters but keep their
        // order.
        if term.count >= 3, words.contains(where: { isSubsequence(term, of: $0) }) {
            return 20
        }
        return 0
    }

    /// Optimal string alignment distance, capped at `max + 1`.
    private static func editDistance(_ a: Scalars, _ b: Scalars, max: Int) -> Int {
        if abs(a.count - b.count) > max { return max + 1 }
        var prev2: [Int] = []
        var prev = Array(0...b.count)
        for i in 1..<(a.count + 1) {
            var row = [i]
            row.reserveCapacity(b.count + 1)
            var rowMin = i
            for j in 1..<(b.count + 1) {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1
                var d = Swift.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
                if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1],
                   prev2[j - 2] + 1 < d {
                    d = prev2[j - 2] + 1
                }
                row.append(d)
                if d < rowMin { rowMin = d }
            }
            if rowMin > max { return max + 1 }
            prev2 = prev
            prev = row
        }
        return prev[b.count]
    }

    private static func isSubsequence(_ term: Scalars, of word: Scalars) -> Bool {
        var i = 0
        for ch in word {
            if i < term.count, ch == term[i] { i += 1 }
            if i == term.count { return true }
        }
        return i == term.count
    }

    // MARK: - Text

    /// Lowercased, compatibility-decomposed, with combining marks stripped:
    /// the same three steps as the shared TypeScript.
    private static func normalize(_ value: String) -> Scalars {
        value.lowercased()
            .decomposedStringWithCompatibilityMapping
            .unicodeScalars
            .filter { !(0x300...0x36F).contains($0.value) }
    }

    private static func trimmed(_ value: Scalars) -> Scalars {
        Array(
            value
                .drop(while: { $0.properties.isWhitespace })
                .reversed()
                .drop(while: { $0.properties.isWhitespace })
                .reversed()
        )
    }

    /// Words are runs of ASCII letters and digits, as in the shared matcher.
    private static func split(_ value: Scalars) -> [Scalars] {
        value.split(whereSeparator: { !isWordScalar($0) }).map(Array.init)
    }

    private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x61...0x7A, 0x30...0x39: true
        default: false
        }
    }

    private static func contains(_ text: Scalars, _ needle: Scalars) -> Bool {
        if needle.isEmpty { return true }
        guard text.count >= needle.count else { return false }
        for start in 0...(text.count - needle.count)
        where text[start] == needle[0] && text[start..<(start + needle.count)].elementsEqual(needle) {
            return true
        }
        return false
    }
}
