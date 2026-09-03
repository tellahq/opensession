import SwiftUI

/// Large pastes sent beside a message (`TranscriptEntry.pastedTexts`). The
/// model saw each block after the message; the reader gets a card per block
/// that opens in place, so a long log does not become the bubble. Mirrors the
/// web's card under the user bubble; the glyph is an SF Symbol because the
/// native app draws its own set (see AGENTS.md).
struct PastedTextCards: View {
    let texts: [String]
    var alignment: HorizontalAlignment = .trailing

    var body: some View {
        if !texts.isEmpty {
            VStack(alignment: alignment, spacing: 6) {
                ForEach(Array(texts.enumerated()), id: \.offset) { _, text in
                    PastedTextCard(text: text)
                }
            }
            .frame(
                maxWidth: .infinity,
                alignment: Alignment(horizontal: alignment, vertical: .center)
            )
        }
    }
}

private struct PastedTextCard: View {
    let text: String

    @State private var isExpanded = false

    private var lineLabel: String {
        let lines = text.split(omittingEmptySubsequences: false) { $0.isNewline }.count
        return "+\(lines) \(lines == 1 ? "line" : "lines")"
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.25)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "text.document")
                        .font(.callout)
                        .foregroundStyle(OS1VisualStyle.textDim)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Pasted text")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.text)
                        Text("\(lineLabel) · \(isExpanded ? "Hide" : "Show")")
                            .font(.caption2)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(.fill.tertiary, in: RoundedRectangle(
                cornerRadius: 10, style: .continuous
            ))
            .accessibilityLabel("Pasted text, \(lineLabel)")
            .accessibilityAddTraits(isExpanded ? [.isSelected] : [])

            if isExpanded {
                ScrollView {
                    Text(text)
                        .font(.footnote.monospaced())
                        .foregroundStyle(OS1VisualStyle.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(maxHeight: 320)
                .background(OS1VisualStyle.panel, in: RoundedRectangle(
                    cornerRadius: 12, style: .continuous
                ))
            }
        }
    }
}
