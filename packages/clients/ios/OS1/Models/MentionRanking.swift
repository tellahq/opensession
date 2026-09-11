import Foundation

/// The rows the `@` palette ranks on this device. The server already scores
/// tools, workspaces and sessions with the same matcher; people come from the
/// roster the app holds, so their order is decided here.
enum MentionRanking {
    /// Teammates whose first or full name matches, best score first. Among
    /// equal scores the signed-in person leads, then the roster's own order,
    /// so a keystroke never reshuffles rows that scored the same.
    static func people(
        _ names: [String],
        query: String,
        current: String,
        fullName: (String) -> String
    ) -> [String] {
        let current = current.lowercased()
        let scored = names.enumerated().compactMap { offset, name -> Row? in
            let score = FuzzyMatch.best(query, in: [name, fullName(name)])
            guard score > 0 else { return nil }
            return Row(
                name: name,
                score: score,
                isCurrent: name.lowercased() == current,
                offset: offset
            )
        }
        return scored
            .sorted { left, right in
                if left.score != right.score { return left.score > right.score }
                if left.isCurrent != right.isCurrent { return left.isCurrent }
                return left.offset < right.offset
            }
            .map(\.name)
    }

    private struct Row {
        let name: String
        let score: Int
        let isCurrent: Bool
        let offset: Int
    }
}
