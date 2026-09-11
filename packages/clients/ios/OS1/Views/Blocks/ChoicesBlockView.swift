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
        FlowLayout(spacing: 8) {
            ForEach(choices, id: \.self) { choice in
                chip(choice)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quick replies")
    }

    private func chip(_ choice: String) -> some View {
        let sent = chosen == choice
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
            .foregroundStyle(chipInk(sent: sent))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(chipFill(sent: sent), in: Capsule())
            .overlay {
                Capsule().stroke(
                    sent ? Color.clear : (isOpen ? OS1VisualStyle.accent.opacity(0.35) : OS1VisualStyle.border),
                    lineWidth: 1
                )
            }
            .contentShape(Capsule())
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

    private func chipInk(sent: Bool) -> Color {
        if sent { return OS1VisualStyle.onAccent }
        return isOpen ? OS1VisualStyle.accentInk : OS1VisualStyle.textDim
    }

    private func chipFill(sent: Bool) -> Color {
        if sent { return OS1VisualStyle.accent }
        return isOpen ? OS1VisualStyle.accent.opacity(0.10) : OS1VisualStyle.chipFill
    }
}
