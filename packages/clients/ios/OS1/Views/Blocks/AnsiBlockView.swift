import SwiftUI

/// An ```ansi or ```terminal fence with its SGR colours, painted from the
/// Terminal panel's palette so a fence and a live shell agree. Copy copies
/// the text without its escape codes.
struct AnsiBlockView: View {
    let lines: [TerminalLine]
    let plain: String

    private static let maxLines = 400

    var body: some View {
        BlockWell(label: "Terminal", symbol: "terminal") {
            CopyBlockControl(text: plain)
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(lines.prefix(Self.maxLines)) { line in
                    Text(attributed(line))
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: 15, alignment: .leading)
                }
                if lines.count > Self.maxLines {
                    Text("… \(lines.count - Self.maxLines) more lines")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(OS1VisualStyle.codeWellGutter)
                }
            }
            .padding(10)
            .textSelection(.enabled)
        }
        .accessibilityLabel("Terminal output")
        .accessibilityValue(plain)
    }

    private func attributed(_ line: TerminalLine) -> AttributedString {
        var result = AttributedString()
        for run in line.runs {
            var piece = AttributedString(run.text)
            piece.foregroundColor = TerminalPalette.color(for: run.style.ink, dim: run.style.dim)
            if run.style.bold {
                piece.font = .system(.caption, design: .monospaced).weight(.semibold)
            }
            result.append(piece)
        }
        if result.characters.isEmpty { result = AttributedString(" ") }
        return result
    }
}
