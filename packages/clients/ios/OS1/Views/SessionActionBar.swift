#if os(iOS)
import SwiftUI

/// The composer's neighbours, as one floating glass capsule directly above
/// it: a new session and the next chat. Both are about where you go next, so
/// they sit under the thumb that is already on the composer. The session's
/// own actions, archive and the ⋯ menu, live in the navigation bar beside the
/// title instead (see `SessionView`'s toolbar).
///
/// It stays directly above the composer when the keyboard opens, keeping the
/// buttons visible and reachable in the keyboard-adjusted safe area.
///
/// The glass is a background SIBLING of the row, not an ancestor of it. A
/// `Menu` whose label sits INSIDE a glass subtree makes the system treat that
/// glass as the menu's morph source, which takes the whole bar off screen for
/// as long as the menu is open. The composer learned this the hard way. See
/// `SessionInputBar.composer`.
struct SessionActionBar: View {
    var onNewSession: (() -> Void)?
    var onNextChat: (() -> Void)?

    /// Matches the composer's round controls, so the two read as one system.
    private static let control: CGFloat = 44

    var body: some View {
        HStack(spacing: 2) {
            if let onNewSession {
                iconButton("plus", label: "New session", action: onNewSession)
            }
            if let onNextChat {
                iconButton("arrow.right", label: "Next chat", action: onNextChat)
            }
        }
        .padding(.horizontal, 2)
        .fixedSize()
        .clipShape(Capsule())
        // Regular Liquid Glass keeps these secondary actions floating above
        // the solid writing surface without flattening either. It stays a
        // sibling so nothing inside can become the glass's morph source.
        .background { Color.clear.glassSurface(in: Capsule()) }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 6)
    }

    private func iconButton(
        _ symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                // Weight from the font, never `.resizable()`, so this sits at
                // the same stroke as the composer's controls.
                .font(.system(size: 19))
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(width: Self.control, height: Self.control)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
#endif
