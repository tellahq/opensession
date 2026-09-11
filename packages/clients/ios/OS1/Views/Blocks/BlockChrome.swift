import SwiftUI

/// The shared dress of a transcript block that carries its own controls: a
/// well in the markdown code colour, a hairline, and a header row with a
/// label on the left and the block's buttons on the right. A block that is
/// still code someone might copy (a JSON tree, terminal output, a diff)
/// keeps a copy control here, the way the web keeps its code controls.
struct BlockWell<Header: View, Content: View>: View {
    var label: String?
    var symbol: String?
    @ViewBuilder var header: () -> Header
    @ViewBuilder var content: () -> Content

    init(
        label: String? = nil,
        symbol: String? = nil,
        @ViewBuilder header: @escaping () -> Header,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.label = label
        self.symbol = symbol
        self.header = header
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if label != nil || !(Header.self is EmptyView.Type) {
                HStack(spacing: 8) {
                    if let label {
                        HStack(spacing: 5) {
                            if let symbol {
                                Image(systemName: symbol)
                                    .font(.caption2.weight(.medium))
                            }
                            Text(label)
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                    }
                    Spacer(minLength: 0)
                    header()
                }
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(OS1VisualStyle.border).frame(height: 0.5)
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OS1VisualStyle.markdownCodeWell, in: BlockChrome.shape)
        .clipShape(BlockChrome.shape)
        .overlay {
            BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
        }
    }
}

extension BlockWell where Header == EmptyView {
    init(
        label: String? = nil,
        symbol: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(label: label, symbol: symbol, header: { EmptyView() }, content: content)
    }
}

enum BlockChrome {
    static var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
    }
}

/// A small header control: an SF Symbol, an optional title, and a plain
/// button style that reads as chrome rather than as a call to action.
struct BlockControl: View {
    let title: String?
    let symbol: String
    var accessibilityLabel: String?
    var isOn = false
    let action: () -> Void

    init(
        _ title: String? = nil,
        symbol: String,
        accessibilityLabel: String? = nil,
        isOn: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.symbol = symbol
        self.accessibilityLabel = accessibilityLabel
        self.isOn = isOn
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.caption.weight(.medium))
                if let title {
                    Text(title)
                        .font(.caption.weight(.medium))
                }
            }
            .foregroundStyle(isOn ? OS1VisualStyle.accentInk : OS1VisualStyle.textDim)
            .padding(.horizontal, 6)
            .frame(minHeight: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel ?? title ?? "")
        .help(accessibilityLabel ?? title ?? "")
    }
}

/// A copy control that confirms itself for a moment, the way the web's does.
struct CopyBlockControl: View {
    let text: String
    var label = "Copy"

    @State private var copied = false

    var body: some View {
        BlockControl(
            copied ? "Copied" : label,
            symbol: copied ? "checkmark" : "document.on.document",
            accessibilityLabel: copied ? "Copied" : label
        ) {
            copyToPasteboard(text)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.4))
                copied = false
            }
        }
    }
}
