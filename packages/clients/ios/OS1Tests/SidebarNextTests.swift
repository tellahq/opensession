import XCTest
@testable import OS1

final class SidebarNextTests: XCTestCase {
    private func row(_ id: String, running: Bool = false) -> SidebarWorkspace {
        var session = Session(id: "session-\(id)")
        session.isRunning = running
        return SidebarWorkspace(
            id: id,
            title: id,
            sessions: [session],
            mainSession: session
        )
    }

    private func draft(_ id: String) -> SidebarWorkspace {
        let workspace = OS1API.WorkspaceSummary(
            id: id,
            name: id,
            repo: nil,
            createdBy: nil,
            createdAt: nil,
            draft: OS1API.WorkspaceDraft(
                text: "Parked prompt",
                updatedAt: "2026-08-20T12:00:00Z",
                by: nil,
                autoName: nil
            )
        )
        return SidebarWorkspace(
            id: id,
            title: id,
            sessions: [],
            mainSession: Session(id: "workspace-draft:\(id)"),
            workspace: workspace
        )
    }

    func testUnreadSettledWorkWinsInRenderedOrder() {
        let rows = [row("current"), row("running", running: true), row("read"), row("ready")]
        let unread: Set<String> = ["current", "running", "ready"]

        let next = SidebarNext.workspace(after: "current", in: rows) {
            unread.contains($0.id)
        }

        XCTAssertEqual(next?.id, "ready")
    }

    func testFallbackWrapsToTheNextChat() {
        let rows = [row("first"), row("middle"), row("current")]

        XCTAssertEqual(
            SidebarNext.workspace(after: "current", in: rows) { _ in false }?.id,
            "first"
        )
    }

    func testFallbackSkipsRunningWork() {
        let rows = [row("current"), row("running", running: true), row("ready")]

        XCTAssertEqual(
            SidebarNext.workspace(after: "current", in: rows) { _ in false }?.id,
            "ready"
        )
    }

    func testFallbackReturnsNilWhenEveryOtherChatIsRunning() {
        let rows = [row("current"), row("running", running: true)]

        XCTAssertNil(SidebarNext.workspace(after: "current", in: rows) { _ in false })
    }

    func testPinnedCopiesAndDraftRowsDoNotBecomeExtraChats() {
        let current = row("current")
        let next = row("next")
        let rows = [current, draft("draft"), next, current, next]

        XCTAssertEqual(
            SidebarNext.workspace(after: "current", in: rows) { _ in false }?.id,
            "next"
        )
        XCTAssertNil(SidebarNext.workspace(after: "current", in: [current, current]) { _ in true })
    }

    func testAHiddenCurrentRowContinuesIntoWhatIsVisible() {
        let rows = [row("read"), row("ready")]

        XCTAssertEqual(
            SidebarNext.workspace(after: "hidden", in: rows) { $0.id == "ready" }?.id,
            "ready"
        )
    }
}
