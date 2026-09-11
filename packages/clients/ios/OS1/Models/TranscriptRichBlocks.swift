import Foundation

/// One rendered piece of a durable message: prose for the library, or a
/// block this app lays out itself. `MarkdownBody` switches over these; the
/// grammar of each kind lives in its own model (`ChoicesBlock`, `TreeBlock`,
/// …) and every one of them falls back to `.markdown` with the fence as
/// written when its parser refuses the source, which is what the web does
/// with a fence it cannot upgrade.
enum TranscriptRichBlock {
    case markdown(String)
    case mermaid(String)
    case table(MarkdownTable)
    case chart(VegaLiteChart, source: String)
    case compare(CompareSpec)
    case choices([String])
    case tree([TreeNode])
    case palette([PaletteEntry])
    case dataGrid(DataTable)
    case jsonTree(JsonNode, raw: String)
    case ansi(lines: [TerminalLine], plain: String)
    case diff(String)
    case math(lines: [[MathTypesetter.Run]], source: String)
    case metrics([Metric])
    case artifact(ArtifactDocument)
    case slides([String])
    case figure(MediaFigure)
    case callout(Callout)
}

/// A GitHub admonition: a blockquote whose first line is `[!NOTE]`, `[!TIP]`,
/// `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` and nothing else, the rest
/// of the quote being the body (docs/blocks.md, "Callouts").
struct Callout: Equatable {
    enum Kind: String, CaseIterable {
        case note, tip, important, warning, caution

        var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    }

    var kind: Kind
    /// Ordinary markdown, quote markers stripped.
    var body: String
}

/// Turns a durable message into the blocks `MarkdownBody` draws.
///
/// The split runs on the RAW text, before the link rewrites, for the reason
/// `MarkdownFenceSegmenter` gives. Three passes: claimed fences first, then
/// the line-shaped blocks inside what is left (placed media figures,
/// callouts, `$$` math), then GFM tables. Consecutive markdown pieces merge,
/// so the common message with no block at all stays one `MarkdownView`.
enum TranscriptRichBlocks {
    /// Every fence kind a block claims. A shell fence is claimed and handed
    /// straight back unless it carries an escape byte (`AnsiBlock.claims`).
    static let claimedLangs: Set<String> = Set([
        "mermaid", "vega-lite", "vegalite", "chart", "compare", "choices", "tree", "palette",
        "csv", "tsv", "table", "json", "ansi", "terminal", "diff", "math", "metrics",
        "artifact", "svg", "slides",
    ]).union(AnsiBlock.escapeClaimLangs)

    static func blocks(of text: String) -> [TranscriptRichBlock] {
        var out: [TranscriptRichBlock] = []
        func markdown(_ value: String) {
            if case .markdown(let previous)? = out.last {
                out[out.count - 1] = .markdown(previous + "\n" + value)
            } else {
                out.append(.markdown(value))
            }
        }
        for segment in MarkdownFenceSegmenter.split(text, claims: claimedLangs.contains) {
            switch segment {
            case .fence(let lang, let source, let raw):
                if let block = block(lang: lang, source: source) {
                    out.append(block)
                } else {
                    markdown(raw)
                }
            case .markdown(let value):
                for piece in lineBlocks(of: value) {
                    if case .markdown(let prose) = piece {
                        for table in MarkdownTableSegmenter.split(prose) {
                            switch table {
                            case .markdown(let plain): markdown(plain)
                            case .table(let parsed): out.append(.table(parsed))
                            }
                        }
                    } else {
                        out.append(piece)
                    }
                }
            }
        }
        return out.isEmpty ? [.markdown(text)] : out
    }

    /// The block a fence becomes, or nil to keep the fence as code.
    static func block(lang: String, source: String) -> TranscriptRichBlock? {
        switch lang {
        case "mermaid":
            return .mermaid(source)
        case "vega-lite", "vegalite", "chart":
            return VegaLiteChart.parse(source).map { .chart($0, source: source) }
        case "compare":
            return CompareSpec.parse(source).map(TranscriptRichBlock.compare)
        case "choices":
            return ChoicesBlock.parse(source).map(TranscriptRichBlock.choices)
        case "tree":
            return TreeBlock.parse(source).map(TranscriptRichBlock.tree)
        case "palette":
            return PaletteBlock.parse(source).map(TranscriptRichBlock.palette)
        case "csv", "tsv", "table":
            return DataTableBlock.parse(source, lang: lang).map(TranscriptRichBlock.dataGrid)
        case "json":
            guard JsonTreeBlock.worthFolding(source), let node = JsonTreeBlock.parse(source) else { return nil }
            return .jsonTree(node, raw: source)
        case "diff":
            return source.contains(where: { !$0.isWhitespace }) ? .diff(source) : nil
        case "math":
            return MathTypesetter.typeset(source).map { .math(lines: $0, source: source) }
        case "metrics":
            return MetricsBlock.parse(source).map(TranscriptRichBlock.metrics)
        case "artifact", "svg":
            return ArtifactDocument.parse(lang: lang, source: source).map(TranscriptRichBlock.artifact)
        case "slides":
            let slides = SlidesBlock.split(source)
            return slides.isEmpty ? nil : .slides(slides)
        default:
            guard AnsiBlock.claims(lang: lang, source: source) else { return nil }
            let parsed = AnsiBlock.lines(lang: lang, source: source)
            return .ansi(lines: parsed.lines, plain: parsed.plain)
        }
    }

    // MARK: - Line-shaped blocks

    /// Figures, callouts and `$$` blocks lifted out of prose. Each may only
    /// start a block: the top of the text, or after a blank line. An
    /// unclaimed fence inside the prose is skipped whole.
    static func lineBlocks(of text: String) -> [TranscriptRichBlock] {
        guard text.contains("![") || text.contains("[!") || text.contains("$$") else {
            return [.markdown(text)]
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var out: [TranscriptRichBlock] = []
        var pending: [Substring] = []
        var fence: (marker: Character, length: Int)?
        var previousBlank = true
        var index = 0

        func flush() {
            guard pending.contains(where: { !$0.allSatisfy(\.isWhitespace) }) else {
                pending = []
                return
            }
            out.append(.markdown(pending.joined(separator: "\n")))
            pending = []
        }

        while index < lines.count {
            let line = lines[index]
            if let open = fence {
                pending.append(line)
                if MarkdownFenceSegmenter.closes(line, marker: open.marker, length: open.length) { fence = nil }
                previousBlank = false
                index += 1
                continue
            }
            if let opened = MarkdownFenceSegmenter.opening(line) {
                pending.append(line)
                fence = (opened.marker, opened.length)
                previousBlank = false
                index += 1
                continue
            }
            if previousBlank {
                if let figure = figure(lines, at: index) {
                    flush()
                    out.append(.figure(figure.figure))
                    index = figure.end
                    previousBlank = false
                    continue
                }
                if let callout = callout(lines, at: index) {
                    flush()
                    out.append(.callout(callout.callout))
                    index = callout.end
                    previousBlank = false
                    continue
                }
                if let math = displayMath(lines, at: index) {
                    flush()
                    out.append(math.block)
                    index = math.end
                    previousBlank = false
                    continue
                }
            }
            pending.append(line)
            previousBlank = line.allSatisfy(\.isWhitespace)
            index += 1
        }
        flush()
        return out.isEmpty ? [.markdown(text)] : out
    }

    /// A paragraph that is one placed image, followed by a blank line or the
    /// end of the text.
    private static func figure(_ lines: [Substring], at index: Int) -> (figure: MediaFigure, end: Int)? {
        guard let figure = PlacedMedia.figure(fromParagraphLine: lines[index]) else { return nil }
        let next = index + 1
        guard next == lines.count || lines[next].allSatisfy(\.isWhitespace) else { return nil }
        return (figure, next)
    }

    private static func callout(_ lines: [Substring], at index: Int) -> (callout: Callout, end: Int)? {
        guard let first = quoteBody(lines[index]) else { return nil }
        let marker = first.trimmingCharacters(in: .whitespaces)
        guard marker.hasPrefix("[!"), marker.hasSuffix("]"),
              let kind = Callout.Kind(rawValue: marker.dropFirst(2).dropLast().lowercased())
        else { return nil }
        var body: [String] = []
        var end = index + 1
        while end < lines.count, let inner = quoteBody(lines[end]) {
            body.append(inner)
            end += 1
        }
        // Lazy continuation: a non-blank line right after a quote line is
        // still the quote, as in CommonMark.
        while end < lines.count, !lines[end].allSatisfy(\.isWhitespace),
              MarkdownFenceSegmenter.opening(lines[end]) == nil, !lines[end].hasPrefix("#") {
            body.append(String(lines[end]))
            end += 1
        }
        return (Callout(kind: kind, body: body.joined(separator: "\n")), end)
    }

    /// The text after a top-level `>` marker, or nil for a line that is not
    /// a quote line.
    private static func quoteBody(_ line: Substring) -> String? {
        var rest = line[...]
        var indent = 0
        while let first = rest.first, first == " ", indent < 3 {
            rest = rest.dropFirst()
            indent += 1
        }
        guard rest.first == ">" else { return nil }
        rest = rest.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    /// `$$` alone on a line opens the block, `$$` alone on a line closes it.
    /// A one-line `$$E=mc^2$$` is display math where it sits.
    private static func displayMath(_ lines: [Substring], at index: Int) -> (block: TranscriptRichBlock, end: Int)? {
        let line = lines[index].trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("$$") else { return nil }
        if line == "$$" {
            var body: [Substring] = []
            var end = index + 1
            while end < lines.count {
                if lines[end].trimmingCharacters(in: .whitespaces) == "$$" {
                    let source = body.joined(separator: "\n")
                    guard let set = MathTypesetter.typeset(source) else { return nil }
                    let after = end + 1
                    guard after == lines.count || lines[after].allSatisfy(\.isWhitespace) else { return nil }
                    return (.math(lines: set, source: source), after)
                }
                body.append(lines[end])
                end += 1
            }
            return nil
        }
        guard line.hasSuffix("$$"), line.count > 4 else { return nil }
        let source = String(line.dropFirst(2).dropLast(2))
        guard !source.contains("$"), let set = MathTypesetter.typeset(source) else { return nil }
        let next = index + 1
        guard next == lines.count || lines[next].allSatisfy(\.isWhitespace) else { return nil }
        return (.math(lines: set, source: source), next)
    }
}
