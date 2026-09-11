import SwiftUI

/// A ```diff fence with whole added and removed rows washed, the way a tool
/// call's diff reads, rather than only its ink tinted. `---` and `+++` file
/// headers before the first hunk are left alone; once a hunk starts every
/// leading sign counts, so a removed `-- comment` still reads as a deletion.
struct DiffFenceView: View {
    let patch: String

    private static let maxLines = 400

    private enum Row { case add, remove, hunk, header, context }

    var body: some View {
        let lines = patch.split(separator: "\n", omittingEmptySubsequences: false)
        BlockWell(label: "Diff", symbol: "plus.forwardslash.minus") {
            CopyBlockControl(text: patch)
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(Self.classify(lines).prefix(Self.maxLines).enumerated()), id: \.offset) { _, row in
                    Text(row.text.isEmpty ? " " : row.text)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(ink(row.kind))
                        .padding(.horizontal, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(wash(row.kind))
                }
                if lines.count > Self.maxLines {
                    Text("… \(lines.count - Self.maxLines) more lines")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(OS1VisualStyle.codeWellGutter)
                        .padding(.horizontal, 10)
                }
            }
            .padding(.vertical, 8)
            .textSelection(.enabled)
        }
        .accessibilityLabel("Diff")
    }

    private static func classify(_ lines: [Substring]) -> [(text: String, kind: Row)] {
        var inHunk = false
        return lines.map { line in
            let text = String(line)
            if text.hasPrefix("@@") {
                inHunk = true
                return (text, .hunk)
            }
            if !inHunk, text.hasPrefix("+++") || text.hasPrefix("---") {
                return (text, .header)
            }
            if text.hasPrefix("+") { return (text, .add) }
            if text.hasPrefix("-") { return (text, .remove) }
            return (text, .context)
        }
    }

    private func ink(_ kind: Row) -> Color {
        switch kind {
        case .add: OS1VisualStyle.codeWellAdd
        case .remove: OS1VisualStyle.codeWellRemove
        case .hunk: OS1VisualStyle.codeWellHunk
        case .header: OS1VisualStyle.codeWellGutter
        case .context: OS1VisualStyle.codeWellText
        }
    }

    private func wash(_ kind: Row) -> Color {
        switch kind {
        case .add: OS1VisualStyle.codeWellAdd.opacity(0.12)
        case .remove: OS1VisualStyle.codeWellRemove.opacity(0.12)
        default: .clear
        }
    }
}
