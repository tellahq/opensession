import Foundation

/// Quick replies: a ```choices fence listing one reply per line renders as a
/// row of chips (docs/blocks.md, "Quick replies"). The grammar mirrors the
/// web's `lib/choices-block.ts`.
enum ChoicesBlock {
    static let maxChoices = 12
    static let maxChoiceLength = 200

    /// One reply per non-empty line; a leading `- `, `* `, `+ ` or `1. ` is
    /// tolerated and dropped, and a repeated line counts once. Nil when the
    /// fence is not a usable list: empty, too many, or a line long enough to
    /// be prose rather than a reply.
    static func parse(_ source: String) -> [String]? {
        var seen: Set<String> = []
        var choices: [String] = []
        for raw in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            let text = stripMarker(line)
            if text.isEmpty || seen.contains(text) { continue }
            if text.count > maxChoiceLength { return nil }
            seen.insert(text)
            choices.append(text)
        }
        guard !choices.isEmpty, choices.count <= maxChoices else { return nil }
        return choices
    }

    /// The entry ids whose quick replies are still current: everything after
    /// the last user message. A block in an earlier entry has been answered,
    /// by a chip or by the composer, and goes quiet.
    static func openEntryIds(_ entries: [TranscriptEntry]) -> Set<String> {
        let lastUser = entries.lastIndex(where: \.isUser) ?? -1
        return Set(entries[(lastUser + 1)...].map(\.id))
    }

    private static func stripMarker(_ line: String) -> String {
        var rest = Substring(line)
        if let first = rest.first, "-*+".contains(first) {
            let after = rest.dropFirst()
            if after.isEmpty || after.first == " " || after.first == "\t" {
                rest = after
            }
        } else {
            let digits = rest.prefix(while: \.isNumber)
            if !digits.isEmpty {
                let after = rest.dropFirst(digits.count)
                if let mark = after.first, mark == "." || mark == ")" {
                    let tail = after.dropFirst()
                    if tail.isEmpty || tail.first == " " || tail.first == "\t" {
                        rest = tail
                    }
                }
            }
        }
        return rest.trimmingCharacters(in: .whitespaces)
    }
}
