#if os(iOS)
import SwiftUI

/// One unread session Next can open: the web's `UnreadChat`
/// (lib/unread-chats.ts), built from the sidebar's own rows.
struct UnreadChat: Equatable, Identifiable {
    let id: String
    let title: String
    /// The workspace row it sits under, shown when it differs from `title`.
    let workspace: String
    let repo: String?

    /// What the Next tab names: the workspace, or the session when it has none.
    var label: String { workspace.isEmpty ? title : workspace }
}

/// Where a conversation pushed from the sidebar can go next, installed by the
/// sidebar on the pushed session (`SessionsListView`).
///
/// Equatable on what it shows, not on its closures: the handlers are fresh on
/// every sidebar update, and an environment value that never compares equal
/// would re-evaluate the session view, transcript and all, on every poll.
/// The same reasoning as `OpenPanelAction`.
struct PhoneSessionNavigation: Equatable {
    /// Your unread sessions, in sidebar order starting after the open one.
    var chats: [UnreadChat] = []
    /// The last unread session was just opened: the tab says so briefly.
    var allRead = false
    fileprivate var openChat: ((String) -> Void)?
    fileprivate var archiveAndNext: (() -> Void)?

    init() {}

    init(
        chats: [UnreadChat],
        allRead: Bool,
        openChat: @escaping (String) -> Void,
        archiveAndNext: (() -> Void)?
    ) {
        self.chats = chats
        self.allRead = allRead
        self.openChat = openChat
        self.archiveAndNext = archiveAndNext
    }

    var canArchive: Bool { archiveAndNext != nil }

    func open(_ id: String) { openChat?(id) }
    func archive() { archiveAndNext?() }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.chats == rhs.chats
            && lhs.allRead == rhs.allRead
            && (lhs.openChat == nil) == (rhs.openChat == nil)
            && (lhs.archiveAndNext == nil) == (rhs.archiveAndNext == nil)
    }
}

/// The transcript's way back to the latest, handed to the action pill.
/// Equatable on what it shows, for the same reason as
/// `PhoneSessionNavigation`: the closure is fresh on every session update.
struct ScrollToLatest: Equatable {
    var hasNewOutput: Bool
    fileprivate var action: () -> Void

    init(hasNewOutput: Bool, action: @escaping () -> Void) {
        self.hasNewOutput = hasNewOutput
        self.action = action
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.hasNewOutput == rhs.hasNewOutput
    }
}

/// Whether the action pill is on screen to carry the arrow. While it steps
/// aside for the keyboard, the transcript floats its own.
struct ActionBarShownKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

extension EnvironmentValues {
    @Entry var phoneSessionNavigation = PhoneSessionNavigation()
    @Entry var actionBarScrollToLatest: ScrollToLatest? = nil
}

/// What the session offers under the thumb, as one floating glass capsule
/// above the composer: Next, which names the unread session it opens, with the
/// transcript's scroll-to-latest arrow beside it. Archive lives in the ⋯ menu
/// in the navigation bar beside the title, and a new workspace starts from the
/// list, not from inside a chat. It steps aside while the keyboard is up.
///
/// The glass is a background SIBLING of the row, not an ancestor of it. A
/// `Menu` whose label sits INSIDE a glass subtree makes the system treat that
/// glass as the menu's morph source, which takes the whole bar off screen for
/// as long as the menu is open. See `SessionInputBar.composer`.
struct SessionActionBar: View {
    /// Where Next goes.
    var next: PhoneSessionNavigation
    /// The transcript's arrow back to the latest, shown left of the capsule
    /// while the reader is scrolled up. nil hides it.
    var scrollToLatest: ScrollToLatest?

    /// Matches the composer's round controls, so the two read as one system.
    static let control: CGFloat = 44

    var body: some View {
        NextUnreadSegment(navigation: next)
        .padding(.horizontal, 2)
        .padding(.vertical, 2)
        .fixedSize(horizontal: false, vertical: true)
        .clipShape(Capsule())
        .background { Color.clear.glassSurface(in: Capsule()) }
        // The arrow's lane is kept on both sides, always, so the capsule sits
        // centred over the composer and does not move when the arrow comes
        // and goes. Next leaves the label room for that.
        .padding(.horizontal, Self.arrowLane)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .leading) {
            if let scrollToLatest {
                ScrollToLatestButton(hasNewOutput: scrollToLatest.hasNewOutput) {
                    scrollToLatest.action()
                }
                // The button pads its 40pt disc to 44, so this puts the disc
                // 12pt in, on the capsule's own margin.
                .padding(.leading, 10)
                .transition(.opacity.combined(with: .scale(scale: 0.8)))
            }
        }
        .padding(.bottom, 8)
    }

    /// The 12pt margin, the arrow's 44pt target, and 8pt before the capsule.
    private static let arrowLane: CGFloat = 12 + 44 + 8
}

/// The web phone's Next button (`NextUnreadButton`) as the action capsule's
/// content, naming where it goes. Tap opens your next unread session; a
/// long press lists every unread one. When the last one has just been opened
/// it reads "All read" for a moment, then goes. The label truncates before
/// the capsule outgrows the screen.
private struct NextUnreadSegment: View {
    let navigation: PhoneSessionNavigation

    var body: some View {
        if let next = navigation.chats.first {
            Menu {
                Section("Unread sessions · \(navigation.chats.count)") {
                    ForEach(navigation.chats) { chat in
                        Button {
                            Haptics.play(.selection)
                            navigation.open(chat.id)
                        } label: {
                            Text(chat.title)
                            if !chat.workspace.isEmpty, chat.workspace != chat.title {
                                Text(chat.workspace)
                            }
                        }
                    }
                }
            } label: {
                segment {
                    if let repo = next.repo, !repo.isEmpty {
                        RepoTile(name: repo, size: 18)
                            .accessibilityHidden(true)
                    }
                    Text(next.label)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 15, weight: .semibold))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(OS1VisualStyle.text)
            } primaryAction: {
                Haptics.play(.selection)
                navigation.open(next.id)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("Next unread: \(next.label)")
            .accessibilityHint("Hold to choose another unread session.")
        } else if navigation.allRead {
            segment {
                Text("All read")
            }
            .foregroundStyle(OS1VisualStyle.textDim)
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private func segment(@ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 8) { content() }
            .font(.subheadline.weight(.medium))
            .padding(.leading, 10)
            .padding(.trailing, 14)
            .frame(height: SessionActionBar.control)
            .contentShape(Capsule())
    }
}
#endif
