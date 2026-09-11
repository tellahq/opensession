import Foundation

/// A ```slides fence is markdown split into slides on lines that are exactly
/// `---` (docs/blocks.md, "Slides").
enum SlidesBlock {
    /// Split on lines that are exactly `---` (trailing whitespace allowed). A
    /// `---` inside a nested code fence belongs to that fence, not the deck.
    /// Blank slides are dropped, so a deck that opens with `---` does not
    /// start on an empty one.
    static func split(_ source: String) -> [String] {
        var slides: [String] = []
        var current: [Substring] = []
        var fence: (marker: Character, length: Int)?
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = line.last == "\r" ? line.dropLast() : line
            if let open = fence {
                if MarkdownFenceSegmenter.closes(line, marker: open.marker, length: open.length) {
                    fence = nil
                }
                current.append(line)
                continue
            }
            if let opened = MarkdownFenceSegmenter.opening(line) {
                fence = (opened.marker, opened.length)
                current.append(line)
                continue
            }
            var trimmed = line
            while let last = trimmed.last, last == " " || last == "\t" { trimmed = trimmed.dropLast() }
            if trimmed == "---" {
                slides.append(current.joined(separator: "\n"))
                current = []
                continue
            }
            current.append(line)
        }
        slides.append(current.joined(separator: "\n"))
        return slides
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}
