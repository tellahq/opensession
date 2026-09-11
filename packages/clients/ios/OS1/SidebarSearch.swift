import Foundation

/// What the sidebar's search field matches a row on, shared by the live list
/// and the archived results under it. The transcript hits the server returns
/// are the caller's fallback for rows this rule does not admit.
enum SidebarSearch {
    /// Whether a session's metadata answers the query. The title, repository,
    /// branch and workspace name forgive a typo; the id is pasted, not typed,
    /// so it only matches as written.
    static func matches(_ session: Session, workspaceName: String?, query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return true }
        if FuzzyMatch.best(
            query,
            in: [session.title, session.effectiveRepo, session.branch, workspaceName]
        ) > 0 {
            return true
        }
        return session.id.range(of: query, options: .caseInsensitive) != nil
    }

    /// A workspace row answers through its own name or any session in it.
    static func matches(
        _ workspace: SidebarWorkspace,
        workspaceNames: [String: String],
        query: String
    ) -> Bool {
        FuzzyMatch.score(query, in: workspace.title) > 0
            || workspace.sessions.contains {
                matches($0, workspaceName: name(of: $0, in: workspaceNames), query: query)
            }
    }

    /// The name a session's workspace goes by: the names map when it has
    /// loaded, else the name the session itself carries.
    static func name(of session: Session, in workspaceNames: [String: String]) -> String? {
        session.workspaceId.flatMap { workspaceNames[$0] } ?? session.workspaceName
    }
}
