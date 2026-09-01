import SwiftStreamingMarkdown
import SwiftUI
#if os(iOS)
import UIKit
#endif
#if os(macOS)
import AppKit
#endif

private struct TranscriptSessionIdKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var transcriptSessionId: String? {
        get { self[TranscriptSessionIdKey.self] }
        set { self[TranscriptSessionIdKey.self] = newValue }
    }
}

/// CommonMark/GFM rendering for durable assistant messages. Parsing and
/// renderable-document construction happen asynchronously inside the library.
struct MarkdownBody: View {
    let text: String
    /// Reasoning inside a work fold renders dimmer than a final answer — the
    /// library owns its own colours, so a `.foregroundStyle` on the outside
    /// would be ignored.
    var dimmed = false
    /// Which session's transcript this is, for the file paths only that
    /// session can resolve. Read from `openPanel` rather than passed down:
    /// it already carries the session id, it is Equatable and stable, and a
    /// surface with nowhere to push (the Mac app) has no id and gets no file
    /// links — which is right, since the push is the whole point of one.
    @Environment(\.openPanel) private var openPanel
    /// Repo context exists on both native clients. The Mac has no pushable
    /// `openPanel`, but its commit references still need the session's repo.
    @Environment(\.transcriptSessionId) private var transcriptSessionId
    @Environment(\.transcriptQuoteSelection) private var quoteSelection

    init(_ text: String, dimmed: Bool = false) {
        self.text = text
        self.dimmed = dimmed
    }

    /// One rendered piece of a message: prose for the library, a diagram, or a
    /// table this app lays out itself.
    private enum Block {
        case markdown(String)
        case mermaid(String)
        case table(MarkdownTable)
    }

    var body: some View {
        // ```mermaid fences are lifted out before anything else touches the
        // text: they render as drawn diagrams, and the link rewrites below
        // would corrupt a URL or file path inside a diagram label into
        // markdown link syntax that mermaid can no longer parse. Tables come
        // out of what's left, for the width reasons in MarkdownTableSegmenter.
        let blocks = Self.blocks(of: text)
        if blocks.count == 1, case .markdown(let only) = blocks[0] {
            // The overwhelmingly common shape — no extra stack around it.
            markdown(only)
        } else {
            VStack(alignment: .leading, spacing: Self.segmentSpacing) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case .markdown(let value):
                        markdown(value)
                    case .mermaid(let source):
                        MermaidDiagramView(source: source)
                    case .table(let table):
                        MarkdownTableView(table: linkified(table), dimmed: dimmed)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private static func blocks(of text: String) -> [Block] {
        MermaidSegmenter.split(text).flatMap { segment -> [Block] in
            switch segment {
            case .mermaid(let source):
                return [.mermaid(source)]
            case .markdown(let value):
                return MarkdownTableSegmenter.split(value).map { piece in
                    switch piece {
                    case .markdown(let prose): .markdown(prose)
                    case .table(let table): .table(table)
                    }
                }
            }
        }
    }

    private func markdown(_ value: String) -> some View {
        let base = dimmed ? MarkdownRenderConfig.os1Dim : .os1Static
        let config = quoteSelection == nil
            ? base
            : base.withTextContextMenu(value: .os1QuoteSelection)
        return SwiftStreamingMarkdown.MarkdownView(
            text: linkified(value),
            config: config,
            listener: quoteSelection?.listener
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A table's cells get the same rewrites as prose, applied per cell —
    /// after the split, since a path or a session id never contains a pipe.
    /// Without this, the file named in a table cell would be dead text while
    /// the same name in the sentence above it is a link.
    private func linkified(_ table: MarkdownTable) -> MarkdownTable {
        var out = table
        out.headers = table.headers.map(linkified)
        out.rows = table.rows.map { $0.map(linkified) }
        return out
    }

    /// PR and commit references, automation and session ids, file paths, scratch files and bare URLs
    /// become links here rather than in the display pass: the entry's own text
    /// stays the raw markdown, so copying a message still yields what the
    /// agent actually wrote. `PrLinks` runs FIRST, because a pasted PR URL is
    /// its to claim: left to `MarkdownAutolink` it would already be an
    /// external link by the time the PR rewrite looked at it, and tapping it
    /// would leave the app for the browser. Autolinking runs next, so a
    /// session URL is already a link target by the time `SessionLinks` looks
    /// for loose ids, and each rewrite after it leaves the links already there
    /// alone. `AssetLinks` runs last, so a name that is both a repo path and a
    /// scratch file keeps its diff. `CommitLinks` also runs before autolinking:
    /// a bare configured GitHub commit URL is the long form of the same
    /// reference, not a generic browser link.
    private func linkified(_ value: String) -> String {
        // Subscribes this row to the registries the rewrites below read.
        // They are static tables rather than observable state, so without
        // this a row drawn before the first poll — every row of a cold deep
        // link — keeps the chips it could make of empty ones, forever. See
        // `TranscriptLinks` for why one global counter is cheap enough.
        _ = TranscriptLinks.shared.generation
        return AssetLinks.linkify(
            FileLinks.linkify(
                SessionLinks.linkify(
                    AutomationLinks.linkify(
                        MarkdownAutolink.linkify(
                            CommitLinks.linkify(
                                PrLinks.linkify(value, sessionId: openPanel.sessionId),
                                sessionId: openPanel.sessionId ?? transcriptSessionId
                            )
                        )
                    )
                ),
                sessionId: openPanel.sessionId
            ),
            sessionId: openPanel.sessionId
        )
    }

    /// The gap between a diagram and the prose around it, matching the block
    /// spacing the renderer uses inside each markdown segment — otherwise the
    /// seam reads as a paragraph break of a different rhythm.
    private static var segmentSpacing: CGFloat {
        #if os(iOS)
        8
        #else
        12
        #endif
    }
}

/// Bridges Open Session's coalesced full-text snapshots to the library's streaming API.
/// Buffering only the newest value avoids parsing stale snapshots when parsing
/// briefly falls behind incoming text.
final class MarkdownStreamSource: ObservableObject, StreamedMarkdownSource {
    let text: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation

    init(initialText: String) {
        let stream = AsyncStream.makeStream(
            of: String.self,
            bufferingPolicy: .bufferingNewest(1)
        )
        text = stream.stream
        continuation = stream.continuation
        continuation.yield(initialText)
    }

    func update(_ text: String) {
        continuation.yield(text)
    }

    deinit {
        continuation.finish()
    }
}

/// Persistent streamed renderer for the in-flight assistant bubble. The source
/// survives SwiftUI body updates, so snapshots flow through one parser and one
/// rendered document instead of recreating the renderer on every 8 Hz flush.
///
/// The link rewrites `MarkdownBody` applies are deliberately not run here: a
/// URL arrives a few characters at a time, so linkifying each snapshot would
/// mean repeatedly building a link to a truncated address. Links appear when
/// the message settles into its durable row.
struct StreamingMarkdownBody: View {
    let text: String
    @StateObject private var source: MarkdownStreamSource

    init(_ text: String) {
        self.text = text
        _source = StateObject(wrappedValue: MarkdownStreamSource(initialText: text))
    }

    var body: some View {
        StreamedMarkdownView(source: source, config: .os1Streaming)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onChange(of: text) { _, newText in
                source.update(newText)
            }
    }
}

#if os(iOS)
private extension TextFonts {
    /// Heading font set at Open Session metrics. The library's bundled `Typography`
    /// ramp renders headings at 28/24/20/20/20/20pt in REGULAR weight (the
    /// heading block applies `TextFonts.normal`), which against the 17pt body
    /// reads as oversized unemphasised text with h3–h6 indistinguishable from
    /// each other. Sizes are scaled through `UIFontMetrics` exactly as the
    /// library does, so headings keep following Dynamic Type.
    static func ios(
        size: CGFloat,
        weight: UIFont.Weight = .semibold,
        lineHeight: CGFloat,
        letterSpacing: CGFloat
    ) -> TextFonts {
        let scaled = UIFontMetrics.default.scaledValue(for: size)
        let normal = UIFont.systemFont(ofSize: scaled, weight: weight)
        // `normal` paints the heading itself; `bold` only shows up for a bold
        // run inside a heading, so it steps one weight further.
        let bold = UIFont.systemFont(
            ofSize: scaled,
            weight: weight == .bold ? .heavy : .bold
        )
        return TextFonts(
            normal: normal,
            italic: italicVariant(of: normal),
            bold: bold,
            boldItalic: italicVariant(of: bold),
            preferredLetterSpacing: letterSpacing,
            preferredLineHeight: UIFontMetrics.default.scaledValue(for: lineHeight)
        )
    }

    private static func italicVariant(of font: UIFont) -> UIFont {
        let traits = font.fontDescriptor.symbolicTraits.union(.traitItalic)
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(traits) else {
            return font
        }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }
}
#endif

#if os(macOS)
private extension TextFonts {
    /// Mac-metric font set. The library's bundled `Typography` ramp hardcodes
    /// iOS point sizes (17pt body, 28pt h1, 15pt code), which read oversized
    /// next to the 13pt-based Mac UI, so the Mac config builds its own fonts.
    static func mac(
        size: CGFloat,
        weight: NSFont.Weight = .regular,
        lineHeight: CGFloat? = nil
    ) -> TextFonts {
        let normal = NSFont.systemFont(ofSize: size, weight: weight)
        let bold = NSFont.systemFont(
            ofSize: size,
            weight: weight == .regular ? .semibold : .bold
        )
        return TextFonts(
            normal: normal,
            italic: italicVariant(of: normal),
            bold: bold,
            boldItalic: italicVariant(of: bold),
            preferredLetterSpacing: nil,
            preferredLineHeight: lineHeight
        )
    }

    private static func italicVariant(of font: NSFont) -> NSFont {
        NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
    }
}
#endif

private extension TextFonts {
    /// Reasoning keeps markdown structure, but strong markers are provider
    /// activity chrome rather than answer emphasis. Match the web transcript
    /// by resolving bold runs to the surrounding regular or italic face.
    var withoutStrongWeight: TextFonts {
        TextFonts(
            normal: normal,
            italic: italic,
            bold: normal,
            boldItalic: italic ?? normal,
            preferredLetterSpacing: preferredLetterSpacing,
            preferredLineHeight: preferredLineHeight
        )
    }
}

// Not fileprivate: `MarkdownTableView` renders with the same configs when it
// hands a table too wide to fit back to the library.
extension MarkdownRenderConfig {
    /// `text` is the body colour: full strength for an answer, dimmed for the
    /// narration inside a work fold, which is context rather than conclusion.
    /// Bold runs and inline code follow it rather than being pinned to the
    /// full-strength label, so a dimmed paragraph can never come out grey
    /// with black words punched through it. The renderer resolves both from
    /// the paragraph colour today, so this changes no pixels — it is here so
    /// the config stops asserting something it does not mean. `quote` is the
    /// one colour already subordinate at full strength, so it cannot simply
    /// follow `text`.
    ///
    /// Inline code is the web's treatment: a 6% ink tint and nothing else.
    /// The library also draws a dotted underline under every code run, which
    /// on top of a fill boxes the same word twice — a sentence naming four
    /// files came out as four underlined boxes. The tint alone is enough to
    /// separate a name from the prose around it, so the underline is
    /// `.clear`.
    static func os1Config(
        text: Color,
        quote: Color,
        withoutStrongWeight: Bool = false
    ) -> MarkdownRenderConfig {
        func fonts(_ value: TextFonts) -> TextFonts {
            withoutStrongWeight ? value.withoutStrongWeight : value
        }
        // Inline chips are attachments, and an attachment is only drawn by the
        // view provider once that provider owns the file type. Registering
        // here rather than at launch keeps the two halves of the mechanism in
        // one place: nothing can render markdown without going through a
        // config first. See `TranscriptChip`.
        TranscriptChipViewProvider.registerIfNeeded()
        #if os(iOS)
        let base = MarkdownRenderConfig.default
        return MarkdownRenderConfig(
            blockQuoteStyle: .init(
                textFonts: fonts(base.blockQuoteStyle.textFonts),
                textColor: quote
            ),
            // Stepped 22/20/18/17 against the 17pt body, semibold and lightly
            // tracked-in, so a heading reads as a heading without shouting.
            // Agent answers lean on h2/h3, so those levels stay close to body
            // size — the emphasis carries the structure, not the scale.
            headingStyle: .init(
                h1Font: fonts(.ios(size: 22, lineHeight: 28, letterSpacing: -0.35)),
                h2Font: fonts(.ios(size: 20, lineHeight: 26, letterSpacing: -0.3)),
                h3Font: fonts(.ios(size: 18, lineHeight: 24, letterSpacing: -0.25)),
                h4Font: fonts(.ios(size: 17, lineHeight: 23, letterSpacing: -0.2)),
                h5Font: fonts(.ios(size: 17, lineHeight: 23, letterSpacing: -0.2)),
                h6Font: fonts(.ios(size: 17, lineHeight: 23, letterSpacing: -0.2)),
                textColor: text
            ),
            orderedListStyle: .init(
                textFonts: fonts(base.orderedListStyle.textFonts),
                textColor: text
            ),
            paragraphStyle: .init(
                textFonts: fonts(base.paragraphStyle.textFonts),
                textColor: text
            ),
            tableStyle: .init(
                textFonts: fonts(base.tableStyle.textFonts),
                headerTextColor: OS1VisualStyle.text,
                regularTextColor: OS1VisualStyle.text,
                headerBackgroundColor: OS1VisualStyle.panel,
                borderColor: OS1VisualStyle.border,
                actionButtonColor: OS1VisualStyle.accentInk
            ),
            inlineStyle: .init(
                boldTextColor: text,
                linkTextFont: base.inlineStyle.linkTextFont,
                linkTextColor: OS1VisualStyle.link,
                codeTextFont: base.inlineStyle.codeTextFont,
                codeTextColor: text,
                codeBackgroundColor: OS1VisualStyle.markdownInlineCode,
                codeUnderlineColor: .clear
            ),
            citationConfig: .os1Chips,
            codeBlockConfig: .init(
                theme: .github,
                backgroundColor: OS1VisualStyle.markdownCodeWell,
                foregroundColor: OS1VisualStyle.textDim
            ),
            blockSpacing: 8,
            thematicBreakColor: OS1VisualStyle.border
        )
        #else
        // Same deliberate palette as the iOS branch, at Mac text metrics:
        // 13pt body on a 19pt line, headings stepped 20/17/15/14/13, 12pt
        // code, and a 12pt block gap for readable paragraph rhythm.
        let body = fonts(.mac(size: 13, lineHeight: 19))
        return MarkdownRenderConfig(
            blockQuoteStyle: .init(textFonts: body, textColor: quote),
            headingStyle: .init(
                h1Font: fonts(.mac(size: 20, weight: .bold)),
                h2Font: fonts(.mac(size: 17, weight: .semibold)),
                h3Font: fonts(.mac(size: 15, weight: .semibold)),
                h4Font: fonts(.mac(size: 14, weight: .semibold)),
                h5Font: fonts(.mac(size: 13, weight: .semibold)),
                h6Font: fonts(.mac(size: 13, weight: .semibold)),
                textColor: text
            ),
            orderedListStyle: .init(textFonts: body, textColor: text),
            paragraphStyle: .init(textFonts: body, textColor: text),
            tableStyle: .init(
                textFonts: fonts(.mac(size: 12)),
                headerTextColor: OS1VisualStyle.text,
                regularTextColor: OS1VisualStyle.text,
                headerBackgroundColor: OS1VisualStyle.panel,
                borderColor: OS1VisualStyle.border,
                actionButtonColor: OS1VisualStyle.accentInk
            ),
            inlineStyle: .init(
                boldTextColor: text,
                linkTextFont: .systemFont(ofSize: 13),
                linkTextColor: OS1VisualStyle.link,
                codeTextFont: .monospacedSystemFont(ofSize: 12, weight: .regular),
                codeTextColor: text,
                codeBackgroundColor: OS1VisualStyle.markdownInlineCode,
                codeUnderlineColor: .clear
            ),
            citationConfig: .os1Chips,
            codeBlockConfig: .init(
                theme: .github,
                backgroundColor: OS1VisualStyle.markdownCodeWell,
                foregroundColor: OS1VisualStyle.textDim
            ),
            blockSpacing: 12,
            thematicBreakColor: OS1VisualStyle.border
        )
        #endif
    }

    static let os1Base = os1Config(
        text: OS1VisualStyle.text,
        quote: OS1VisualStyle.textDim
    )

    static let os1Static = os1Base
        .withShouldAnimateText(value: false)

    static let os1Dim = os1Config(
        text: OS1VisualStyle.textNarration,
        quote: OS1VisualStyle.textNarration,
        withoutStrongWeight: true
    )
    .withShouldAnimateText(value: false)

    static let os1Streaming = os1Base
        .withShouldAnimateText(value: true)
}
