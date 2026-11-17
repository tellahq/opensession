import SwiftUI

/// A ```choices fence: quick replies as a row of chips that wrap. A tap
/// sends the chip's text as the next message; the context menu puts it in
/// the composer instead, for the reader who wants to edit it first. Chips go
/// quiet once a later user message exists, and wherever there is no session
/// to send into.
struct ChoicesBlockView: View {
    let choices: [String]

    @Environment(\.quickReplyRelay) private var relay
    @Environment(\.transcriptEntryId) private var entryId
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var chosen: String?

    private var isOpen: Bool {
        chosen == nil && relay?.isOpen(entryId: entryId) == true
    }

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(choices, id: \.self) { choice in
                chip(choice)
            }
        }
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quick replies")
    }

    /// Round pills in the composer's material with a hairline, the same as
    /// the reply suggestions above the composer: a reply offered in the
    /// answer is the same kind of thing as one offered below it. The web made
    /// the same change (styles/blocks/choices.css) after a filled, tinted chip
    /// read heavier than the question asking it. Once answered, the pills
    /// stay as a record at the weight of a note; the one you sent keeps its
    /// fill and a check.
    #if os(macOS)
    private static let oneLineHeight: CGFloat = 34
    private static let horizontalPadding: CGFloat = 14
    private static let verticalPadding: CGFloat = 6
    #else
    private static let oneLineHeight: CGFloat = 44
    private static let horizontalPadding: CGFloat = 16
    private static let verticalPadding: CGFloat = 10
    #endif

    /// Half the one-line height rather than a capsule, so a reply long enough
    /// to wrap keeps rounded ends instead of turning into a lozenge.
    private static var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: oneLineHeight / 2, style: .circular)
    }

    private func chip(_ choice: String) -> some View {
        let sent = chosen == choice
        let live = isOpen || sent
        return Button {
            guard isOpen, let relay else { return }
            Haptics.play(.send)
            if reduceMotion {
                chosen = choice
            } else {
                withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { chosen = choice }
            }
            relay.send(choice)
        } label: {
            HStack(spacing: 5) {
                if sent {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                }
                Text(choice)
                    .font(.subheadline.weight(.medium))
                    .multilineTextAlignment(.leading)
            }
            .foregroundStyle(live ? OS1VisualStyle.text : OS1VisualStyle.textFaint)
            .padding(.horizontal, Self.horizontalPadding)
            .padding(.vertical, Self.verticalPadding)
            .frame(minHeight: Self.oneLineHeight)
            .background(live ? OS1VisualStyle.composerSurface : Color.clear, in: Self.shape)
            .overlay {
                Self.shape.strokeBorder(
                    live ? OS1VisualStyle.replyPillEdge : OS1VisualStyle.border.opacity(0.55),
                    lineWidth: 1
                )
            }
            .contentShape(Self.shape)
        }
        .buttonStyle(.plain)
        .disabled(!isOpen)
        .contextMenu {
            if isOpen, let relay {
                Button {
                    relay.fill(choice)
                } label: {
                    Label("Put in message box", systemImage: "text.insert")
                }
            }
            Button {
                copyToPasteboard(choice)
            } label: {
                Label("Copy", systemImage: "document.on.document")
            }
        }
        .accessibilityHint(isOpen ? "Sends this reply" : "")
        .accessibilityValue(sent ? "Sent" : "")
    }
}
