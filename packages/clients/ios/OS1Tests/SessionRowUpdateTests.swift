import XCTest
@testable import OS1

/// The sessions list applies `session_row` / `session_row_removed` frames
/// between polls. These pin the merge: a frame is a server snapshot of one
/// row, so it must land the way a poll would for that row and leave every
/// local overlay (an archive or restore made here, a pending create) alone.
final class SessionRowUpdateTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func apply(
        _ updates: [SessionRowUpdate],
        to list: [Session],
        optimistic: Set<String> = [],
        hiding: Set<String> = [],
        restoring: Set<String> = [],
        hidden: Set<String> = []
    ) -> SessionRowUpdateResult {
        SessionsListViewModel.applyingRowUpdates(
            updates,
            to: list,
            optimisticIds: optimistic,
            hiding: hiding,
            restoring: restoring,
            hidden: hidden
        )
    }

    private var baseline: [Session] {
        get throws {
            try sessions(
                """
                [{"id":"os-new","title":"New","lastActivity":"2026-09-05T12:00:00.000Z"},
                 {"id":"os-mid","title":"Mid","lastActivity":"2026-09-05T11:00:00.000Z"},
                 {"id":"os-old","title":"Old","lastActivity":"2026-09-05T10:00:00.000Z"}]
                """
            )
        }
    }

    // MARK: - Rows

    func testARowReplacesItsSessionAndTheListKeepsRecencyOrder() throws {
        let row = try session(
            #"{"id":"os-old","title":"Old, renamed","lastActivity":"2026-09-05T13:00:00.000Z"}"#
        )

        let result = try apply([.row(row)], to: baseline)

        XCTAssertTrue(result.changed)
        XCTAssertEqual(result.sessions.map(\.id), ["os-old", "os-new", "os-mid"])
        XCTAssertEqual(result.sessions[0].title, "Old, renamed")
        XCTAssertTrue(result.removedIds.isEmpty)
    }

    func testAnUnknownRowJoinsTheListInRecencyOrder() throws {
        let row = try session(
            #"{"id":"os-other","title":"Someone else's","lastActivity":"2026-09-05T11:30:00.000Z"}"#
        )

        let result = try apply([.row(row)], to: baseline)

        XCTAssertEqual(result.sessions.map(\.id), ["os-new", "os-other", "os-mid", "os-old"])
    }

    func testAnIdenticalRowChangesNothing() throws {
        let list = try baseline

        let result = apply([.row(list[1])], to: list)

        XCTAssertFalse(result.changed)
        XCTAssertEqual(result.sessions, list)
    }

    /// Newest frame per session wins, and one batch is one pass: the caller
    /// keys pending frames by id, so a burst reaches here already reduced.
    func testABatchAppliesEveryFrameInOnePass() throws {
        let renamed = try session(
            #"{"id":"os-mid","title":"Mid, renamed","lastActivity":"2026-09-05T11:00:00.000Z"}"#
        )

        let result = try apply([.row(renamed), .removed("os-old")], to: baseline)

        XCTAssertEqual(result.sessions.map(\.id), ["os-new", "os-mid"])
        XCTAssertEqual(result.sessions[1].title, "Mid, renamed")
        XCTAssertEqual(result.removedIds, ["os-old"])
    }

    // MARK: - Removals and archive

    func testARemovalDropsTheRow() throws {
        let result = try apply([.removed("os-mid")], to: baseline)

        XCTAssertEqual(result.sessions.map(\.id), ["os-new", "os-old"])
        XCTAssertEqual(result.removedIds, ["os-mid"])
    }

    func testRemovingAnUnknownRowChangesNothing() throws {
        let result = try apply([.removed("os-elsewhere")], to: baseline)

        XCTAssertFalse(result.changed)
    }

    /// The server sends a removal for an archive, but a row that says
    /// `archived` must not stay in the live list either.
    func testAnArchivedRowLeavesTheLiveList() throws {
        let row = try session(#"{"id":"os-mid","archived":true}"#)

        let result = try apply([.row(row)], to: baseline)

        XCTAssertEqual(result.sessions.map(\.id), ["os-new", "os-old"])
        XCTAssertEqual(result.removedIds, ["os-mid"])
    }

    func testADeskRowNeverLists() throws {
        let row = try session(#"{"id":"os-desk","desk":true}"#)

        let result = try apply([.row(row)], to: baseline)

        XCTAssertFalse(result.changed)
    }

    // MARK: - Local overlays

    /// A row archived on this device is hidden until the server catches up;
    /// its own row arriving (the copy that predates the archive, or the one
    /// after a failed archive) must not bring it back early.
    func testALocallyArchivedRowStaysHidden() throws {
        let row = try session(
            #"{"id":"os-mid","title":"Mid","lastActivity":"2026-09-05T14:00:00.000Z"}"#
        )
        let list = try baseline.filter { $0.id != "os-mid" }

        let result = apply([.row(row)], to: list, hiding: ["os-mid"])

        XCTAssertFalse(result.changed)
        XCTAssertEqual(result.sessions.map(\.id), ["os-new", "os-old"])
    }

    /// A row restored on this device reads as live even when the server's
    /// snapshot still says archived, and a removal for it is not believed.
    func testALocallyRestoredRowReadsAsLive() throws {
        let stale = try session(
            #"{"id":"os-back","title":"Back","archived":true,"lastActivity":"2026-09-05T11:30:00.000Z"}"#
        )

        let result = try apply([.row(stale)], to: baseline, restoring: ["os-back"])

        XCTAssertEqual(result.sessions.map(\.id), ["os-new", "os-back", "os-mid", "os-old"])
        XCTAssertEqual(result.sessions[1].archived, false)

        let removal = try apply([.removed("os-back")], to: result.sessions, restoring: ["os-back"])
        XCTAssertFalse(removal.changed)
    }

    // MARK: - Pending creates

    func testAPendingCreateRetiresWhenItsOwnRowArrives() throws {
        let placeholder = try session(
            #"{"id":"os-real","title":"Starting","isOptimisticPlaceholder":true}"#
        )
        let list = try [placeholder] + baseline
        let row = try session(
            #"{"id":"os-real","title":"Started","lastActivity":"2026-09-05T13:00:00.000Z"}"#
        )

        let result = apply([.row(row)], to: list, optimistic: ["os-real"])

        XCTAssertEqual(result.retiredOptimisticIds, ["os-real"])
        XCTAssertEqual(result.sessions.map(\.id), ["os-real", "os-new", "os-mid", "os-old"])
        XCTAssertEqual(result.sessions[0].isOptimistic, false)
    }

    /// Other pending creates keep their place in front, whatever their date,
    /// and a removal for one is ignored: its row is local until the server
    /// publishes it.
    func testOtherPendingCreatesStayInFront() throws {
        let pending = try session(#"{"id":"pending-1","title":"Pending"}"#)
        let list = try [pending] + baseline
        let row = try session(
            #"{"id":"os-old","title":"Old, touched","lastActivity":"2026-09-05T15:00:00.000Z"}"#
        )

        let result = apply(
            [.row(row), .removed("pending-1")], to: list, optimistic: ["pending-1"]
        )

        XCTAssertEqual(result.sessions.map(\.id), ["pending-1", "os-old", "os-new", "os-mid"])
        XCTAssertTrue(result.retiredOptimisticIds.isEmpty)
    }

    // MARK: - Hidden rows

    /// A hidden row comes back when one of its sessions blocks on a question,
    /// exactly as the poll's pass reports it.
    func testABlockedRowResurfacesItsHide() throws {
        let row = try session(
            #"{"id":"os-mid","waitingForInput":true,"lastActivity":"2026-09-05T11:00:00.000Z"}"#
        )
        let keys = Set(SidebarRowKeys.candidateKeys(for: row))
        XCTAssertFalse(keys.isEmpty)

        let result = try apply([.row(row)], to: baseline, hidden: keys)

        XCTAssertEqual(Set(result.resurfacedHideKeys), keys)
    }

    // MARK: - Poll replay

    /// A poll's response was built before any frame applied while its
    /// request was out, so only those frames replay, oldest first.
    func testReplayPicksTheFramesAppliedAfterThePollStarted() throws {
        let mid = try session(#"{"id":"os-mid","title":"Mid, later"}"#)
        let old = try session(#"{"id":"os-old","title":"Old, later"}"#)
        let applied: [String: AppliedRowUpdate] = [
            "os-new": AppliedRowUpdate(revision: 3, update: .removed("os-new")),
            "os-old": AppliedRowUpdate(revision: 7, update: .row(old)),
            "os-mid": AppliedRowUpdate(revision: 5, update: .row(mid)),
        ]

        let replay = SessionsListViewModel.replay(applied, after: 3)

        XCTAssertEqual(replay.map(\.id), ["os-mid", "os-old"])
        XCTAssertTrue(SessionsListViewModel.replay(applied, after: 7).isEmpty)
    }

    /// The frames are newer than the response: a rename they carried must
    /// not be undone by the poll, and a removal they carried stays removed.
    func testAPollReplaysNewerFramesOverItsResponse() throws {
        let renamed = try session(
            #"{"id":"os-old","title":"Old, renamed","lastActivity":"2026-09-05T13:00:00.000Z"}"#
        )

        let polled = try SessionsListViewModel.polled(
            baseline,
            replaying: [.row(renamed), .removed("os-mid")],
            optimisticIds: [],
            hiding: [],
            restoring: []
        )

        XCTAssertEqual(polled.active.map(\.id), ["os-old", "os-new"])
        XCTAssertEqual(polled.active[0].title, "Old, renamed")
        XCTAssertTrue(polled.archived.isEmpty)
    }

    /// The replay reconciles the way the poll does: a row archived on this
    /// device stays hidden, and an archived row in the response still feeds
    /// the archived index untouched.
    func testAPollReplayKeepsTheLocalOverlays() throws {
        let hidden = try session(
            #"{"id":"os-new","title":"New, renamed","lastActivity":"2026-09-05T14:00:00.000Z"}"#
        )
        let response = try sessions(
            """
            [{"id":"os-new","title":"New","lastActivity":"2026-09-05T12:00:00.000Z"},
             {"id":"os-gone","title":"Gone","archived":true,"lastActivity":"2026-09-05T11:00:00.000Z"}]
            """
        )

        let polled = SessionsListViewModel.polled(
            response,
            replaying: [.row(hidden)],
            optimisticIds: [],
            hiding: ["os-new"],
            restoring: []
        )

        XCTAssertTrue(polled.active.isEmpty)
        XCTAssertEqual(polled.archived.map(\.id), ["os-gone"])
    }

    /// Nothing to replay is exactly the plain poll pass.
    func testAPollWithNothingToReplayIsThePreparedList() throws {
        let polled = try SessionsListViewModel.polled(
            baseline, replaying: [], optimisticIds: [], hiding: [], restoring: []
        )
        let prepared = try SessionsListViewModel.prepared(baseline, hiding: [], restoring: [])

        XCTAssertEqual(polled.active, prepared.active)
    }
}
