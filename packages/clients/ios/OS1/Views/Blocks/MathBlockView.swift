import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Display math, set from `MathTypesetter`'s runs: identifiers in a serif
/// italic, operators upright, scripts raised or lowered at a smaller size.
/// Centred in the column the way a displayed equation sits on a page. The
/// context menu copies the TeX source.
struct MathBlockView: View {
    let lines: [[MathTypesetter.Run]]
    let source: String
    var dimmed = false

    var body: some View {
        VStack(spacing: 6) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, runs in
                Text(attributed(runs))
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .textSelection(.enabled)
        .contextMenu {
            Button {
                copyToPasteboard(source)
            } label: {
                Label("Copy TeX", systemImage: "document.on.document")
            }
        }
        .accessibilityLabel("Math")
        .accessibilityValue(source)
    }

    private var ink: Color { dimmed ? OS1VisualStyle.textNarration : OS1VisualStyle.text }

    private func attributed(_ runs: [MathTypesetter.Run]) -> AttributedString {
        var out = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            piece.foregroundColor = ink
            let script = run.script != .normal
            piece.font = Self.font(italic: run.identifier, bold: run.bold, script: script)
            if run.script == .superscript { piece.baselineOffset = 7 }
            if run.script == .lowered { piece.baselineOffset = -4 }
            out.append(piece)
        }
        return out
    }

    private static func font(italic: Bool, bold: Bool, script: Bool) -> Font {
        #if os(iOS)
        let size: CGFloat = script ? 12 : 19
        #else
        let size: CGFloat = script ? 10 : 16
        #endif
        var font = Font.system(size: size, weight: bold ? .semibold : .regular, design: .serif)
        if italic { font = font.italic() }
        return font
    }
}
