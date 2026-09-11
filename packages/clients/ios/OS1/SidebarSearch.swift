import Foundation

/// The sidebar filter's metadata match: which rows and sessions the typed
/// query finds by title, repository, branch, workspace name, or id.
///
/// Computed once per query as a set of ids rather than inside the row
/// predicate, because the match is typo-tolerant (`FuzzyMatch`) and the list
/// can be thousands of rows with the person lens on everyone: scoring every
/// field of every row per body evaluation would pin the main actor on each
/// keystroke. `SessionsListView` runs `matches` in a detached task and keeps
/// the previous answer on screen until the next one lands.
enum SidebarSearch {
    struct Matches: Equatable, Sendable {
        /// The query these ids answer. Empty means "not filtering", and then
        /// every row passes, which is also what the frame before the first
        /// keystroke's answer arrives should show.
        var query = ""
        var workspaceIds: Set<String> = []
        var sessionIds: Set<String> = []

        func matches(_ workspace: SidebarWorkspace) -> Bool {
            query.isEmpty || workspaceIds.contains(workspace.id)
        }

        func matches(_ session: Session) -> Bool {
            query.isEmpty || sessionIds.contains(session.id)
        }
    }

    static func matches(
        query: String,
        rows: [SidebarWorkspace],
        archived: [Session],
        workspaceNames: [String: String]
    ) -> Matches {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var out = Matches(query: query)
        guard !query.isEmpty else { return out }
        for row in rows {
            var hit = FuzzyMatch.score(query, row.title) > 0
            for session in row.sessions
            where sessionMatches(session, query: query, workspaceNames: workspaceNames) {
                out.sessionIds.insert(session.id)
                hit = true
            }
            if hit { out.workspaceIds.insert(row.id) }
        }
        for session in archived
        where sessionMatches(session, query: query, workspaceNames: workspaceNames) {
            out.sessionIds.insert(session.id)
        }
        return out
    }

    /// One session's metadata against the query. The workspace name counts
    /// for its sessions, as on the web sidebar: a workspace shows through
    /// them. The id stays an exact substring match, since a hex id would
    /// otherwise answer to any three-letter abbreviation.
    static func sessionMatches(
        _ session: Session,
        query: String,
        workspaceNames: [String: String] = [:]
    ) -> Bool {
        let workspaceName = session.workspaceName
            ?? session.workspaceId.flatMap { workspaceNames[$0] }
        if FuzzyMatch.best(
            query,
            in: [session.title, session.effectiveRepo, session.branch, workspaceName]
        ) > 0 {
            return true
        }
        return session.id.lowercased().contains(query.lowercased())
    }
}
