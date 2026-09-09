import XCTest
@testable import OS1

/// The list applies `session_row` / `session_row_removed` frames in place
/// between polls (`SessionsListViewModel.apply`). These pin the merge: a
/// changed row lands where the poll would sort it, a removed one leaves, the
/// local overlays the poll honours are honoured here too, and the grouping
/// the views read is published in the same step as the list.
@MainActor
final class SessionRowUpdateTests: XCTestCase {
    private func session(
        _ id: String,
        title: String? = nil,
        at lastActivity: String? = nil,
        workspaceId: String? = nil
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.lastActivity = lastActivity
        session.workspaceId = workspaceId
        return session
    }

    /// Newest first, the order `prepared` publishes.
    private func loaded() -> [Session] {
        [
            session("bks-3", title: "Three", at: "2026-09-09T08:03:00.000Z"),
            session("bks-2", title: "Two", at: "2026-09-09T08:02:00.000Z"),
            session("bks-1", title: "One", at: "2026-09-09T08:01:00.000Z"),
        ]
    }

    // MARK: - The pure merge

    func testReplacedRowKeepsItsPlaceWhenItsActivityDidNot() {
        let next = SessionsListViewModel.applyingRowChanges(
            to: loaded(),
            upserting: [session("bks-2", title: "Two, renamed", at: "2026-09-09T08:02:00.000Z")],
            removing: []
        )
        XCTAssertEqual(next.map(\.id), ["bks-3", "bks-2", "bks-1"])
        XCTAssertEqual(next[1].title, "Two, renamed")
    }

    func testRowWithNewerActivityMovesToTheFront() {
        let next = SessionsListViewModel.applyingRowChanges(
            to: loaded(),
            upserting: [session("bks-1", title: "One", at: "2026-09-09T08:10:00.000Z")],
            removing: []
        )
        XCTAssertEqual(next.map(\.id), ["bks-1", "bks-3", "bks-2"])
    }

    func testUnknownRowIsInsertedByRecency() {
        let next = SessionsListViewModel.applyingRowChanges(
            to: loaded(),
            upserting: [session("bks-new", at: "2026-09-09T08:02:30.000Z")],
            removing: []
        )
        XCTAssertEqual(next.map(\.id), ["bks-3", "bks-new", "bks-2", "bks-1"])
    }

    func testRowWithoutActivitySortsLast() {
        let next = SessionsListViewModel.applyingRowChanges(
            to: loaded(), upserting: [session("bks-undated")], removing: []
        )
        XCTAssertEqual(next.last?.id, "bks-undated")
    }

    func testRemovalDropsTheRowAndNothingElse() {
        let next = SessionsListViewModel.applyingRowChanges(
            to: loaded(), upserting: [], removing: ["bks-2", "bks-never-listed"]
        )
        XCTAssertEqual(next.map(\.id), ["bks-3", "bks-1"])
    }

    func testNothingToApplyReturnsTheSameList() {
        let base = loaded()
        XCTAssertEqual(
            SessionsListViewModel.applyingRowChanges(to: base, upserting: [], removing: []),
            base
        )
    }

    // MARK: - Through the view model

    func testRowFrameUpdatesTheListAndItsRows() async {
        let viewModel = SessionsListViewModel()
        viewModel.loadFixture(loaded())
        XCTAssertEqual(viewModel.sidebarWorkspaces.map(\.title), ["Three", "Two", "One"])

        viewModel.apply(.row(session("bks-2", title: "Two, renamed", at: "2026-09-09T08:02:00.000Z")))
        await viewModel.flushRowChanges()

        XCTAssertEqual(viewModel.sessions[1].title, "Two, renamed")
        XCTAssertEqual(viewModel.sidebarWorkspaces.map(\.title), ["Three", "Two, renamed", "One"])
    }

    func testRemovedFrameDropsTheRow() async {
        let viewModel = SessionsListViewModel()
        viewModel.loadFixture(loaded())

        viewModel.apply(.removed(id: "bks-3"))
        await viewModel.flushRowChanges()

        XCTAssertEqual(viewModel.sessions.map(\.id), ["bks-2", "bks-1"])
        XCTAssertEqual(viewModel.sidebarWorkspaces.map(\.title), ["Two", "One"])
    }

    /// The live list never shows archived or desk rows; a row frame saying
    /// so is a removal, whatever the frame's type.
    func testArchivedOrDeskRowFrameReadsAsRemoval() async {
        let viewModel = SessionsListViewModel()
        viewModel.loadFixture(loaded())

        var archived = session("bks-1", title: "One", at: "2026-09-09T08:01:00.000Z")
        archived.archived = true
        var desk = session("bks-2", title: "Two", at: "2026-09-09T08:02:00.000Z")
        desk.desk = true
        viewModel.apply(.row(archived))
        viewModel.apply(.row(desk))
        await viewModel.flushRowChanges()

        XCTAssertEqual(viewModel.sessions.map(\.id), ["bks-3"])
    }

    /// A burst of frames for one session folds into its latest snapshot.
    func testLatestFrameForASessionWins() async {
        let viewModel = SessionsListViewModel()
        viewModel.loadFixture(loaded())

        viewModel.apply(.row(session("bks-3", title: "First", at: "2026-09-09T08:03:00.000Z")))
        viewModel.apply(.row(session("bks-3", title: "Second", at: "2026-09-09T08:03:00.000Z")))
        await viewModel.flushRowChanges()

        XCTAssertEqual(viewModel.sessions.first?.title, "Second")
    }

    /// Before the first list has landed there is nothing to merge into, and a
    /// one-row list ahead of the real one would only flash.
    func testFramesAheadOfTheFirstLoadAreDropped() async {
        let viewModel = SessionsListViewModel()

        viewModel.apply(.row(session("bks-1", title: "One", at: "2026-09-09T08:01:00.000Z")))
        await viewModel.flushRowChanges()

        XCTAssertTrue(viewModel.sessions.isEmpty)
        XCTAssertFalse(viewModel.hasLoaded)
    }

    /// The server's own row retires the placeholder the create drew.
    func testServerRowRetiresTheOptimisticPlaceholder() async {
        let viewModel = SessionsListViewModel()
        viewModel.loadFixture(loaded())
        let pending = Session.optimistic(
            id: "bks-created",
            title: "Created here",
            repo: "opensession",
            mode: "code",
            model: nil,
            effort: nil,
            fastMode: false,
            startedBy: "Alex"
        )
        viewModel.addOptimistic(pending)
        XCTAssertEqual(viewModel.sessions.first?.id, "bks-created")
        XCTAssertTrue(viewModel.sessions.first?.isOptimistic == true)

        viewModel.apply(.row(session("bks-created", title: "Created here", at: "2026-09-09T09:00:00.000Z")))
        await viewModel.flushRowChanges()

        XCTAssertEqual(viewModel.sessions.first?.id, "bks-created")
        XCTAssertFalse(viewModel.sessions.first?.isOptimistic == true)
    }

    /// The poll consumes a hide when the hidden row is blocked on a question,
    /// so the row can't disappear again once it's answered. A pushed row has
    /// to do the same, or answering before the next poll re-hides it.
    func testPushedRowThatNeedsInputConsumesItsHide() async {
        let viewModel = SessionsListViewModel()
        viewModel.loadFixture(loaded())
        HideStore.shared.applyHydrated(
            ["workspace:ws-2": "2026-09-09T08:00:00.000Z", "bks-1": "2026-09-09T08:00:00.000Z"],
            persist: false
        )
        defer { HideStore.shared.applyHydrated([:], persist: false) }

        var blocked = session("bks-2", title: "Two", at: "2026-09-09T08:02:00.000Z", workspaceId: "ws-2")
        blocked.waitingForInput = true
        viewModel.apply(.row(blocked))
        viewModel.apply(.row(session("bks-1", title: "One, still idle", at: "2026-09-09T08:01:00.000Z")))
        await viewModel.flushRowChanges()

        XCTAssertNil(HideStore.shared.hides["workspace:ws-2"])
        XCTAssertNotNil(HideStore.shared.hides["bks-1"])
    }

    func testAutomationRowThatNeedsInputKeepsItsHide() {
        var bot = session("bks-bot", workspaceId: "ws-bot")
        bot.waitingForInput = true
        bot.startedBy = "nightly (automation)"

        XCTAssertEqual(
            SessionsListViewModel.resurfacedHideKeys(in: [bot], hidden: ["workspace:ws-bot", "bks-bot"]),
            []
        )
    }
}
