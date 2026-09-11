import XCTest
@testable import OS1

final class SidebarSearchTests: XCTestCase {
    private func session(
        _ id: String,
        title: String? = nil,
        branch: String? = nil,
        workspaceId: String? = nil,
        workspaceName: String? = nil
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.branch = branch
        session.workspaceId = workspaceId
        session.workspaceName = workspaceName
        return session
    }

    private func row(_ id: String, title: String, _ sessions: [Session]) -> SidebarWorkspace {
        SidebarWorkspace(id: id, title: title, sessions: sessions, mainSession: sessions[0])
    }

    func testATypoStillFindsTheRowAndItsSession() {
        let release = session("os-1", title: "Release notes")
        let other = session("os-2", title: "Billing audit")
        let matches = SidebarSearch.matches(
            query: "relase",
            rows: [row("a", title: "Release notes", [release]), row("b", title: "Billing audit", [other])],
            archived: [],
            workspaceNames: [:]
        )
        XCTAssertEqual(matches.workspaceIds, ["a"])
        XCTAssertEqual(matches.sessionIds, ["os-1"])
        XCTAssertTrue(matches.matches(release))
        XCTAssertFalse(matches.matches(other))
    }

    func testAWorkspaceNameCountsForItsSessions() {
        // Stamped on the row by the sessions route, or looked up by id when
        // an older server leaves it off.
        let stamped = session("os-1", title: "Fix hover", workspaceId: "w1", workspaceName: "Workspace cleanup")
        let lookedUp = session("os-2", title: "Fix focus", workspaceId: "w2")
        let unrelated = session("os-3", title: "Fix focus", workspaceId: "w3")
        let matches = SidebarSearch.matches(
            query: "wrokspace",
            rows: [
                row("a", title: "Fix hover", [stamped]),
                row("b", title: "Fix focus", [lookedUp]),
                row("c", title: "Fix focus", [unrelated])
            ],
            archived: [],
            workspaceNames: ["w2": "Workspace polish", "w3": "Sidebar"]
        )
        XCTAssertEqual(matches.workspaceIds, ["a", "b"])
    }

    func testArchivedSessionsAreMatchedToo() {
        let archived = session("os-old", title: "Release checklist")
        let matches = SidebarSearch.matches(
            query: "relase",
            rows: [],
            archived: [archived],
            workspaceNames: [:]
        )
        XCTAssertEqual(matches.sessionIds, ["os-old"])
    }

    func testAnIdIsAnExactSubstringOnly() {
        let hex = session("os-4a5b3c", title: "Unrelated")
        XCTAssertTrue(SidebarSearch.sessionMatches(hex, query: "4A5B"))
        // "abc" is a subsequence of the id's hex, which must not count.
        XCTAssertFalse(SidebarSearch.sessionMatches(hex, query: "abc"))
    }

    func testAnEmptyQueryPassesEverything() {
        let matches = SidebarSearch.matches(query: "  ", rows: [], archived: [], workspaceNames: [:])
        XCTAssertTrue(matches.query.isEmpty)
        XCTAssertTrue(matches.matches(session("os-1", title: "Anything")))
    }
}
