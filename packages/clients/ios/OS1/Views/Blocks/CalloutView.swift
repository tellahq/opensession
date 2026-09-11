import SwiftUI

/// A GitHub callout: a titled block in its kind's ink with an icon and a
/// bar down the left, the body as ordinary markdown.
struct CalloutView: View {
    let callout: Callout
    var dimmed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.footnote.weight(.semibold))
                Text(callout.kind.title)
                    .font(.footnote.weight(.semibold))
            }
            .foregroundStyle(ink)
            if !callout.body.isEmpty {
                MarkdownBody(callout.body, dimmed: dimmed, richBlocks: false)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ink.opacity(0.07), in: BlockChrome.shape)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(ink)
                .frame(width: 3)
                .clipShape(BlockChrome.shape)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(callout.kind.title)
    }

    private var ink: Color {
        switch callout.kind {
        case .note: OS1VisualStyle.blueInk
        case .tip: OS1VisualStyle.greenInk
        case .important: OS1VisualStyle.purpleInk
        case .warning: OS1VisualStyle.yellowInk
        case .caution: OS1VisualStyle.redInk
        }
    }

    private var symbol: String {
        switch callout.kind {
        case .note: "info.circle"
        case .tip: "lightbulb"
        case .important: "exclamationmark.bubble"
        case .warning: "exclamationmark.triangle"
        case .caution: "octagon"
        }
    }
}
