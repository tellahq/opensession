import Foundation

/// Native counterpart of the web sidebar's Next chat navigation.
///
/// The phone opens one workspace row into a sibling-tab conversation, so the
/// unit of navigation here is a workspace rather than an individual session.
enum SidebarNext {
    /// Pick the next rendered chat, prioritizing unread work that has settled.
    ///
    /// `rendered` may contain the same workspace twice because pinned rows also
    /// stay in their ordinary section. The first visible occurrence defines its
    /// position. Draft-only workspace rows are destinations for a composer, not
    /// chats, so Next leaves them out.
    nonisolated static func workspace(
        after currentWorkspaceID: String,
        in rendered: [SidebarWorkspace],
        isUnread: (SidebarWorkspace) -> Bool
    ) -> SidebarWorkspace? {
        var seen = Set<String>()
        let chats = rendered.filter { workspace in
            !workspace.isDraftWorkspace && seen.insert(workspace.id).inserted
        }
        guard !chats.isEmpty else { return nil }

        let candidates: [SidebarWorkspace]
        if let current = chats.firstIndex(where: { $0.id == currentWorkspaceID }) {
            guard chats.count > 1 else { return nil }
            candidates = Array(chats[(current + 1)...]) + Array(chats[..<current])
        } else {
            // The open row may have moved behind a collapsed section while the
            // conversation was on screen. Continue into what is still visible.
            candidates = chats
        }

        return candidates.first { isUnread($0) && !$0.isRunning }
            ?? candidates.first { !$0.isRunning }
    }
}
