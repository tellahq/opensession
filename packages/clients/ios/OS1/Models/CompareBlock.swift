import Foundation

/// The ```compare fence: two stills as one before/after control. The server
/// writes the fence for an `OPENSESSION_COMPARE: /a.png /b.png` line
/// (docs/blocks.md, "Before/after"); it can also be written by hand.
struct CompareSpec: Equatable {
    var before: String
    var after: String
    var caption: String?

    /// `before: <src>` and `after: <src>`, one per line, in either order,
    /// plus an optional `caption: <text>`. Anything else on a line, or a
    /// missing half, keeps the fence as code. A source is a root-relative
    /// path (the `/media?path=` form the server writes) or an http(s) URL.
    static func parse(_ source: String) -> CompareSpec? {
        var before: String?
        var after: String?
        var caption: String?
        for raw in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            guard let colon = line.firstIndex(of: ":") else { return nil }
            let key = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            switch key {
            case "caption":
                caption = value.isEmpty ? nil : value
            case "before", "after":
                guard isStill(value) else { return nil }
                if key == "before" { before = value } else { after = value }
            default:
                return nil
            }
        }
        guard let before, let after else { return nil }
        return CompareSpec(before: before, after: after, caption: caption)
    }

    private static func isStill(_ value: String) -> Bool {
        guard !value.isEmpty, !value.contains(where: \.isWhitespace) else { return false }
        return value.hasPrefix("/") || value.hasPrefix("http://") || value.hasPrefix("https://")
    }
}
