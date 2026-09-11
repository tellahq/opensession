import Foundation

/// Splits transcript markdown into the fenced code blocks a caller claims and
/// the plain markdown around them. `MermaidSegmenter` is the original client;
/// `TranscriptRichBlocks` claims every fence kind the web renders as a block.
///
/// The split runs on the RAW text, before the link rewrites: linkifying first
/// would turn a URL or a file path inside a fence into markdown link syntax
/// and the source would stop parsing.
///
/// Deliberately conservative. Only a fence at the start of a line (CommonMark
/// allows up to three leading spaces) whose info string's first word is
/// claimed becomes a block; a fence nested in a list item, or one that hasn't
/// been closed yet, stays plain markdown and renders as an ordinary code
/// block. That last case is what a streaming or head-clamped message looks
/// like, and it matches the web, where incomplete source keeps its fence.
enum MarkdownFenceSegmenter {
    enum Segment: Equatable {
        case markdown(String)
        /// `lang` is the info string's first word, lowercased. `raw` is the
        /// fence exactly as written, opening and closing lines included, so a
        /// block whose parser refuses the source can go back as code.
        case fence(lang: String, source: String, raw: String)
    }

    /// The segments of `text`, in order. A string with no complete claimed
    /// fence comes back as a single `.markdown` segment — the common case, and
    /// the one that must stay allocation-cheap.
    static func split(_ text: String, claims: (String) -> Bool) -> [Segment] {
        guard text.contains("```") || text.contains("~~~") else {
            return [.markdown(text)]
        }
        var segments: [Segment] = []
        // Everything since the last emitted segment, still unclaimed.
        var pending: [Substring] = []
        // The fence currently being collected, if any, plus what closes it.
        var open: (lang: String, lines: [Substring], marker: Character, length: Int, opening: Substring)?
        // An unclaimed fence swallows everything until it closes, so a claimed
        // fence inside a ```markdown example is never split out.
        var otherFence: (marker: Character, length: Int)?

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if var block = open {
                if closes(line, marker: block.marker, length: block.length) {
                    append(&segments, markdown: pending)
                    pending = []
                    let raw = ([block.opening] + block.lines + [line]).joined(separator: "\n")
                    segments.append(.fence(
                        lang: block.lang,
                        source: block.lines.joined(separator: "\n"),
                        raw: raw
                    ))
                    open = nil
                } else {
                    block.lines.append(line)
                    open = block
                }
                continue
            }
            if let other = otherFence {
                pending.append(line)
                if closes(line, marker: other.marker, length: other.length) {
                    otherFence = nil
                }
                continue
            }
            guard let fence = opening(line) else {
                pending.append(line)
                continue
            }
            let lang = fence.info.split(whereSeparator: \.isWhitespace).first
                .map { $0.lowercased() } ?? ""
            if claims(lang) {
                open = (lang, [], fence.marker, fence.length, line)
            } else {
                pending.append(line)
                otherFence = (fence.marker, fence.length)
            }
        }

        // An unterminated fence rejoins the markdown exactly as written,
        // closing marker and all still absent.
        if let block = open {
            pending.append(block.opening)
            pending.append(contentsOf: block.lines)
        }
        append(&segments, markdown: pending)
        return segments.isEmpty ? [.markdown(text)] : segments
    }

    /// Adds the collected lines as a markdown segment, unless they are only
    /// the blank lines around a block — an empty `MarkdownView` would still
    /// occupy a slot in the stack and space itself from its neighbours.
    private static func append(_ segments: inout [Segment], markdown lines: [Substring]) {
        guard lines.contains(where: { !$0.allSatisfy(\.isWhitespace) }) else { return }
        segments.append(.markdown(lines.joined(separator: "\n")))
    }

    /// The fence marker, its run length and its info string, for a line that
    /// opens a fenced code block — nil for anything else.
    static func opening(
        _ line: Substring
    ) -> (marker: Character, length: Int, info: String)? {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        // Four spaces in is an indented code block, not a fence.
        if rest.first == " " { return nil }
        guard let marker = rest.first, marker == "`" || marker == "~" else { return nil }
        let run = rest.prefix { $0 == marker }
        guard run.count >= 3 else { return nil }
        let info = rest.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        // A backtick fence's info string may not contain a backtick.
        if marker == "`", info.contains("`") { return nil }
        return (marker, run.count, info)
    }

    /// Whether `line` closes a fence opened with `length` of `marker`: the same
    /// marker, at least as long, and nothing after it.
    static func closes(_ line: Substring, marker: Character, length: Int) -> Bool {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        let run = rest.prefix { $0 == marker }
        guard run.count >= length else { return false }
        return rest.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
    }
}
