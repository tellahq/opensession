import Foundation

/// Typo-tolerant matching for the small search surfaces: the sidebar search,
/// the Mac command palette, and the composer's "@" people list. The same rules
/// as the web client's `shared/fuzzy-match.ts`, so a query finds the same row
/// whichever client it is typed in.
///
/// Scores run from 0 (no match) to 100 (exact). Every whitespace-separated term
/// must land somewhere in the text: as a substring, as a word within a small
/// edit distance (a transposition counts as one edit), or as a subsequence of
/// one word ("wksp" for "workspace"). Case and accents are ignored. Short terms
/// get no edit budget, so "cat" never finds "cut".
enum FuzzyMatch {
    /// Score `text` against `query`. 0 means no match; higher is better. An
    /// empty query matches everything at 1.
    static func score(_ query: String, in text: String) -> Int {
        let q = fold(query)
        if q.isEmpty { return 1 }
        let t = fold(text)
        if t.isEmpty { return 0 }
        if t == q { return 100 }
        if t.hasPrefix(q) { return 90 }
        let words = words(of: t)
        if words.contains(where: { $0.hasPrefix(q) }) { return 80 }
        if t.contains(q) { return 70 }
        let terms = q.split(separator: " ").map(String.init)
        var total = 0
        for term in terms {
            let score = termScore(term, in: t, words: words)
            if score == 0 { return 0 }
            total += score
        }
        return Int((Double(total) / Double(terms.count)).rounded())
    }

    /// The best score across several fields of one item. 0 means no match.
    static func best(_ query: String, in values: [String?]) -> Int {
        var best = 0
        for case let value? in values where !value.isEmpty {
            best = max(best, score(query, in: value))
            if best == 100 { break }
        }
        return best
    }

    /// Lowercased, accent-insensitive, trimmed, with runs of whitespace
    /// collapsed to one space, so "Café  Deploy" and "cafe deploy" are the
    /// same haystack.
    static func fold(_ text: String) -> String {
        text
            .folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    /// The letter-and-digit runs of an already folded text.
    static func words(of folded: String) -> [String] {
        folded
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
    }

    /// How close one term comes to a word without being inside it: 50 minus 10
    /// per edit while within the term's budget, 20 for an in-word abbreviation,
    /// 0 for neither. Callers that rank an exact placement (a title prefix, a
    /// keyword) above a near miss check for the substring themselves first.
    static func nearMiss(_ term: String, in words: [String]) -> Int {
        let budget = editBudget(term)
        if budget > 0 {
            let termChars = Array(term)
            var best = budget + 1
            for word in words {
                if word.count < term.count - budget { continue }
                let wordChars = Array(word)
                // Compare against the whole word and its prefix of the term's
                // length, so "wrokspace" and "relase" both land on their word.
                let distance = min(
                    editDistance(termChars, wordChars, max: budget),
                    editDistance(termChars, Array(wordChars.prefix(termChars.count)), max: budget)
                )
                best = min(best, distance)
                if best == 0 { break }
            }
            if best <= budget { return 50 - best * 10 }
        }
        if term.count >= 3, words.contains(where: { isSubsequence(term, of: $0) }) {
            return 20
        }
        return 0
    }

    private static func termScore(_ term: String, in text: String, words: [String]) -> Int {
        if text.contains(term) { return 60 }
        return nearMiss(term, in: words)
    }

    /// Edits a term may absorb: none for short ones, one up to seven letters,
    /// two beyond.
    private static func editBudget(_ term: String) -> Int {
        if term.count < 4 { return 0 }
        if term.count < 8 { return 1 }
        return 2
    }

    /// Optimal string alignment distance, capped at `max + 1`.
    private static func editDistance(_ a: [Character], _ b: [Character], max: Int) -> Int {
        if abs(a.count - b.count) > max { return max + 1 }
        guard !a.isEmpty, !b.isEmpty else { return Swift.max(a.count, b.count) }
        var prev2: [Int] = []
        var prev = Array(0...b.count)
        for i in 1...a.count {
            var row = [i]
            row.reserveCapacity(b.count + 1)
            var rowMin = i
            for j in 1...b.count {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1
                var d = Swift.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
                if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1], prev2[j - 2] + 1 < d {
                    d = prev2[j - 2] + 1
                }
                row.append(d)
                rowMin = Swift.min(rowMin, d)
            }
            if rowMin > max { return max + 1 }
            prev2 = prev
            prev = row
        }
        return prev[b.count]
    }

    private static func isSubsequence(_ term: String, of word: String) -> Bool {
        var remaining = term[...]
        for character in word {
            guard let next = remaining.first else { return true }
            if character == next { remaining = remaining.dropFirst() }
        }
        return remaining.isEmpty
    }
}
