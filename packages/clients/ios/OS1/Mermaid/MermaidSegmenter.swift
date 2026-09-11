import Foundation

/// Splits transcript markdown into the ```mermaid fences and the plain
/// markdown around them, so `MarkdownBody` can hand the fences to the diagram
/// renderer and everything else to SwiftStreamingMarkdown unchanged.
///
/// The fence grammar (three-backtick or tilde fences, up to three leading
/// spaces, unterminated fences kept as prose) lives in
/// `MarkdownFenceSegmenter`; this is that segmenter claiming exactly one
/// info string. `TranscriptRichBlocks` claims the rest of the web's block
/// kinds through the same door.
enum MermaidSegmenter {
    enum Segment: Equatable {
        case markdown(String)
        case mermaid(String)
    }

    /// The segments of `text`, in order. A string with no complete mermaid
    /// fence comes back as a single `.markdown` segment — the common case, and
    /// the one that must stay allocation-cheap.
    static func split(_ text: String) -> [Segment] {
        guard text.contains("```mermaid") || text.contains("~~~mermaid") else {
            return [.markdown(text)]
        }
        return MarkdownFenceSegmenter.split(text, claims: { $0 == "mermaid" }).map { segment in
            switch segment {
            case .markdown(let value): .markdown(value)
            case .fence(_, let source, _): .mermaid(source)
            }
        }
    }
}
