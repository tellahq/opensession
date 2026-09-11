import Foundation

/// Which of an entry's images[]/videos[] its body already shows.
///
/// The server rewrites an `OPENSESSION_IMAGE:` / `_VIDEO:` / `_COMPARE:` line
/// into markdown where it was written (`server/transcript-media.ts`) and
/// still lists the media on the entry, since the turn fold's strip and the
/// gallery read the lists. The thumbnail row under a message is for what the
/// body did NOT place: a Read's image block, a path that turned up in prose,
/// and every entry from before the rewrite, whose body has no `/media` image
/// at all. Mirrors the web's `lib/placed-media.ts`.
enum PlacedMedia {
    static let mediaPrefix = "/media?path="

    /// The `/media?path=` sources a body renders in place: a markdown image
    /// with such a target, and the `before:` / `after:` lines of a compare
    /// fence.
    static func placedSources(in content: String) -> Set<String> {
        guard content.contains(mediaPrefix) else { return [] }
        var placed: Set<String> = []
        for line in content.split(separator: "\n") {
            var rest = Substring(line)
            while let bang = rest.range(of: "![") {
                rest = rest[bang.upperBound...]
                guard let close = rest.firstIndex(of: "]"),
                      rest.index(after: close) < rest.endIndex,
                      rest[rest.index(after: close)] == "("
                else { continue }
                let afterParen = rest.index(close, offsetBy: 2)
                let target = rest[afterParen...].prefix { $0 != ")" && !$0.isWhitespace }
                if target.hasPrefix(mediaPrefix) { placed.insert(String(target)) }
                rest = rest[target.endIndex...]
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            for key in ["before:", "after:"] where trimmed.lowercased().hasPrefix(key) {
                let value = trimmed.dropFirst(key.count).trimmingCharacters(in: .whitespaces)
                if value.hasPrefix(mediaPrefix), !value.contains(where: \.isWhitespace) {
                    placed.insert(value)
                }
            }
        }
        return placed
    }

    /// `media` minus what `content` already places.
    static func unplaced(_ media: [String]?, in content: String) -> [String] {
        guard let media, !media.isEmpty else { return [] }
        let placed = placedSources(in: content)
        if placed.isEmpty { return media }
        return media.filter { !placed.contains($0) }
    }

    /// A paragraph that is nothing but one image of session media is the
    /// agent showing something where it wrote it. `line` is that paragraph's
    /// single line; the result is the figure it describes.
    static func figure(fromParagraphLine line: Substring) -> MediaFigure? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("!["), trimmed.hasSuffix(")"),
              let close = trimmed.firstIndex(of: "]"),
              trimmed.index(after: close) < trimmed.endIndex,
              trimmed[trimmed.index(after: close)] == "("
        else { return nil }
        let caption = String(trimmed[trimmed.index(trimmed.startIndex, offsetBy: 2)..<close])
        let target = trimmed[trimmed.index(close, offsetBy: 2)..<trimmed.index(before: trimmed.endIndex)]
        guard !target.contains(where: \.isWhitespace), target.hasPrefix(mediaPrefix),
              !caption.contains("]")
        else { return nil }
        return MediaFigure(source: String(target), caption: caption.isEmpty ? nil : caption)
    }
}

/// One placed picture or recording and its caption.
struct MediaFigure: Equatable {
    var source: String
    var caption: String?

    private static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "m4v"]

    var isVideo: Bool {
        let path = source.removingPercentEncoding ?? source
        let name = path.split(separator: "/").last.map(String.init) ?? path
        guard let dot = name.lastIndex(of: ".") else { return false }
        return Self.videoExtensions.contains(name[name.index(after: dot)...].lowercased())
    }
}
