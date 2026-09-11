import XCTest
@testable import OS1

/// A `user_map_changed` frame makes a store re-read its map while local
/// writes may still be pending or in flight, and while the 30-second tick's
/// own re-read may still be out. These pin the ordering rules: the frame is scoped
/// to the account's own user, a re-read never drops a local mutation the
/// server has not acknowledged yet, a slower, older re-read cannot
/// overwrite the newer one or a write confirmed since it began, and a
/// write's own response cannot overwrite a re-read begun after it.
@MainActor
final class UserMapSyncTests: XCTestCase {
    private func workspaces(_ json: String) throws -> [SidebarWorkspace] {
        SessionsListViewModel.sidebarWorkspaces(
            in: try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        )
    }

    // MARK: Scoping

    func testSameUserIgnoresCaseAndPadding() {
        XCTAssertTrue(UserMapSync.isSameUser("Kent", as: "kent"))
        XCTAssertTrue(UserMapSync.isSameUser("  kent ", as: "Kent"))
    }

    func testAnotherPersonsWriteIsNotOurs() {
        XCTAssertFalse(UserMapSync.isSameUser("Michiel", as: "Kent"))
        XCTAssertFalse(UserMapSync.isSameUser("", as: "Kent"))
        XCTAssertFalse(UserMapSync.isSameUser("", as: ""))
    }

    // MARK: Reconciliation

    func testLaneResyncKeepsAPendingClaimOverAnOlderServerMap() throws {
        let store = LaneStore()
        let rows = try workspaces(#"[{"id":"bks-1"}]"#)
        store.claim(rows.flatMap(\.sessions))

        // The other device's map predates this claim: it must survive.
        store.applyHydrated(["bks-2": "mine"], persist: false)

        XCTAssertEqual(store.claims, ["bks-1", "bks-2"])
    }

    func testLaneResyncAdoptsAClaimMadeElsewhere() {
        let store = LaneStore()
        store.applyHydrated([:], persist: false)

        store.applyHydrated(["bks-9": "mine"], persist: false)

        XCTAssertEqual(store.claims, ["bks-9"])
    }

    func testHideResyncKeepsAPendingRestoreOverAnOlderServerHide() throws {
        let store = HideStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.applyHydrated(["workspace:ws-1": "2026-09-01T00:00:00Z"], persist: false)
        store.clear(["workspace:ws-1"])

        // The re-read still carries the hide this device just lifted.
        store.applyHydrated(
            ["workspace:ws-1": "2026-09-01T00:00:00Z", "workspace:ws-2": "2026-09-02T00:00:00Z"],
            persist: false
        )

        XCTAssertFalse(store.isHidden(rows[0]))
        XCTAssertEqual(Array(store.hides.keys), ["workspace:ws-2"])
    }

    func testHideResyncKeepsAPendingHideTheServerHasNotSeen() throws {
        let store = HideStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.hide(rows[0])

        store.applyHydrated([:], persist: false)

        XCTAssertTrue(store.isHidden(rows[0]))
    }

    func testSnoozeResyncKeepsPendingSetAndRemove() throws {
        let store = WorkspaceSnoozeStore()
        let rows = try workspaces(
            #"[{"id":"bks-1","workspaceId":"ws-1"},{"id":"bks-2","workspaceId":"ws-2"}]"#
        )
        store.set(rows[0], until: WorkspaceSnooze.someDay)
        store.set(rows[1], until: nil)

        // The server still has ws-2 parked and has not heard about ws-1.
        store.applyHydrated(
            ["workspace:ws-2": WorkspaceSnooze.someDay, "workspace:ws-3": WorkspaceSnooze.someDay],
            persist: false
        )

        XCTAssertTrue(store.isSnoozed(rows[0]))
        XCTAssertFalse(store.isSnoozed(rows[1]))
        XCTAssertEqual(store.snoozes["workspace:ws-3"], WorkspaceSnooze.someDay)
    }

    func testSnoozeResyncAdoptsASnoozeMadeElsewhere() throws {
        let store = WorkspaceSnoozeStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.applyHydrated([:], persist: false)

        store.applyHydrated(["workspace:ws-1": WorkspaceSnooze.someDay], persist: false)

        XCTAssertTrue(store.isSnoozed(rows[0]))
    }

    // MARK: Ordering

    func testClockRetiresOlderTicketsAndTicketsFromBeforeAConfirmedWrite() {
        var clock = HydrationClock()
        let first = clock.begin()
        XCTAssertTrue(clock.isCurrent(first))

        let second = clock.begin()
        XCTAssertFalse(clock.isCurrent(first))
        XCTAssertTrue(clock.isCurrent(second))

        clock.confirmWrite()
        XCTAssertFalse(clock.isCurrent(second))
        let third = clock.begin()
        XCTAssertTrue(clock.isCurrent(third))
    }

    func testClockMarkSeesAGetBegunAfterItButNotAConfirmedWrite() {
        var clock = HydrationClock()
        let mark = clock.mark()
        XCTAssertFalse(clock.hasHydrationBegun(since: mark))

        clock.confirmWrite()
        XCTAssertFalse(clock.hasHydrationBegun(since: mark))

        _ = clock.begin()
        XCTAssertTrue(clock.hasHydrationBegun(since: mark))
    }

    /// The tick's GET read the map before the other client claimed bks-9;
    /// the frame's GET read it after. The tick's response lands last.
    func testLaneResyncIsNotOverwrittenByAnOlderGet() {
        let store = LaneStore()
        let tick = store.beginHydration()
        let frame = store.beginHydration()

        store.applyHydrated(["bks-9": "mine"], ticket: frame, persist: false)
        store.applyHydrated([:], ticket: tick, persist: false)

        XCTAssertEqual(store.claims, ["bks-9"])
    }

    /// A GET begun before this client's own write was confirmed may carry the
    /// pre-write map; the write's response is the fresher one.
    func testLaneGetFromBeforeAConfirmedWriteIsDropped() throws {
        let store = LaneStore()
        store.applyHydrated([:], persist: false)
        let tick = store.beginHydration()
        let rows = try workspaces(#"[{"id":"bks-1"}]"#)
        store.claim(rows.flatMap(\.sessions))
        store.applySaved(["bks-1": "mine"], acknowledging: ["bks-1": "mine"])

        store.applyHydrated([:], ticket: tick, persist: false)

        XCTAssertEqual(store.claims, ["bks-1"])
    }

    /// This Mac's PUT is answered slowly. Meanwhile another device claims
    /// bks-9 and the frame's GET brings it in. The PUT's snapshot predates
    /// that claim and must not replace it; the store re-reads instead.
    func testLaneSavedSnapshotDoesNotOverwriteANewerResync() throws {
        let store = LaneStore()
        store.applyHydrated([:], persist: false)
        let rows = try workspaces(#"[{"id":"bks-1"}]"#)
        store.claim(rows.flatMap(\.sessions))
        let put = store.hydrationMark()
        let frame = store.beginHydration()
        store.applyHydrated(["bks-1": "mine", "bks-9": "mine"], ticket: frame, persist: false)

        let applied = store.applySaved(["bks-1": "mine"], acknowledging: ["bks-1": "mine"], begunAt: put)

        XCTAssertFalse(applied)
        XCTAssertEqual(store.claims, ["bks-1", "bks-9"])
    }

    /// Same race with the frame's GET still in flight when the PUT answers:
    /// the snapshot is skipped, the acknowledgement retires that GET,
    /// and the acknowledged claim stays on screen meanwhile.
    func testLaneSavedSnapshotYieldsToAResyncStillInFlight() throws {
        let store = LaneStore()
        store.applyHydrated([:], persist: false)
        let rows = try workspaces(#"[{"id":"bks-1"}]"#)
        store.claim(rows.flatMap(\.sessions))
        let put = store.hydrationMark()
        let frame = store.beginHydration()

        let applied = store.applySaved(["bks-1": "mine"], acknowledging: ["bks-1": "mine"], begunAt: put)
        XCTAssertFalse(applied)
        XCTAssertEqual(store.claims, ["bks-1"])

        store.applyHydrated([:], ticket: frame, persist: false)
        XCTAssertEqual(store.claims, ["bks-1"])

        let fresh = store.beginHydration()
        store.applyHydrated(["bks-1": "mine", "bks-9": "mine"], ticket: fresh, persist: false)
        store.applyHydrated([:], ticket: frame, persist: false)

        XCTAssertEqual(store.claims, ["bks-1", "bks-9"])
    }

    /// With no re-read begun since the PUT started, its snapshot is the
    /// freshest map and lands as before.
    func testLaneSavedSnapshotAppliesWhenNothingBeganMeanwhile() throws {
        let store = LaneStore()
        store.applyHydrated([:], persist: false)
        let rows = try workspaces(#"[{"id":"bks-1"}]"#)
        store.claim(rows.flatMap(\.sessions))
        let put = store.hydrationMark()

        let applied = store.applySaved(
            ["bks-1": "mine", "remote": "review"],
            acknowledging: ["bks-1": "mine"],
            begunAt: put
        )

        XCTAssertTrue(applied)
        XCTAssertEqual(store.claims, ["bks-1", "remote"])
    }

    func testHideResyncIsNotOverwrittenByAnOlderGet() throws {
        let store = HideStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        let tick = store.beginHydration()
        let frame = store.beginHydration()

        store.applyHydrated(["workspace:ws-1": "2026-09-01T00:00:00Z"], ticket: frame, persist: false)
        store.applyHydrated([:], ticket: tick, persist: false)

        XCTAssertTrue(store.isHidden(rows[0]))
    }

    func testHideGetFromBeforeAConfirmedWriteIsDropped() throws {
        let store = HideStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.applyHydrated(["workspace:ws-1": "2026-09-01T00:00:00Z"], persist: false)
        let tick = store.beginHydration()
        store.clear(["workspace:ws-1"])
        store.applySaved([:], acknowledging: ["workspace:ws-1": .remove])

        // The stale GET still carries the hide this client just lifted.
        store.applyHydrated(["workspace:ws-1": "2026-09-01T00:00:00Z"], ticket: tick, persist: false)

        XCTAssertFalse(store.isHidden(rows[0]))
    }

    func testHideSavedSnapshotDoesNotOverwriteANewerResync() throws {
        let store = HideStore()
        let rows = try workspaces(
            #"[{"id":"bks-1","workspaceId":"ws-1"},{"id":"bks-2","workspaceId":"ws-2"}]"#
        )
        store.applyHydrated([:], persist: false)
        store.hide(rows[0])
        let mine = store.hides["workspace:ws-1"]!
        let put = store.hydrationMark()
        let frame = store.beginHydration()
        store.applyHydrated(
            ["workspace:ws-1": mine, "workspace:ws-2": "2026-09-02T00:00:00Z"],
            ticket: frame,
            persist: false
        )

        let applied = store.applySaved(
            ["workspace:ws-1": mine],
            acknowledging: ["workspace:ws-1": .set(mine)],
            begunAt: put
        )

        XCTAssertFalse(applied)
        XCTAssertTrue(store.isHidden(rows[0]))
        XCTAssertTrue(store.isHidden(rows[1]))
    }

    func testSnoozeSavedSnapshotDoesNotOverwriteANewerResync() throws {
        let store = WorkspaceSnoozeStore()
        let rows = try workspaces(
            #"[{"id":"bks-1","workspaceId":"ws-1"},{"id":"bks-2","workspaceId":"ws-2"}]"#
        )
        store.applyHydrated([:], persist: false)
        store.set(rows[0], until: WorkspaceSnooze.someDay)
        let put = store.hydrationMark()
        let frame = store.beginHydration()
        store.applyHydrated(
            ["workspace:ws-1": WorkspaceSnooze.someDay, "workspace:ws-2": WorkspaceSnooze.someDay],
            ticket: frame,
            persist: false
        )

        let applied = store.applySaved(
            ["workspace:ws-1": WorkspaceSnooze.someDay],
            acknowledging: ["workspace:ws-1": .set(WorkspaceSnooze.someDay)],
            begunAt: put
        )

        XCTAssertFalse(applied)
        XCTAssertTrue(store.isSnoozed(rows[0]))
        XCTAssertTrue(store.isSnoozed(rows[1]))
    }

    func testHideSkippedSnapshotKeepsANewerLocalRestore() throws {
        let store = HideStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.hide(rows[0])
        let mine = try XCTUnwrap(store.hides["workspace:ws-1"])
        let put = store.hydrationMark()
        let frame = store.beginHydration()
        store.clear(["workspace:ws-1"])

        XCTAssertFalse(store.applySaved(
            ["workspace:ws-1": mine],
            acknowledging: ["workspace:ws-1": .set(mine)],
            begunAt: put
        ))
        store.applyHydrated(["workspace:ws-1": mine], ticket: frame, persist: false)
        XCTAssertFalse(store.isHidden(rows[0]))

        let fresh = store.beginHydration()
        store.applyHydrated(["workspace:ws-1": mine], ticket: fresh, persist: false)
        XCTAssertFalse(store.isHidden(rows[0]))
    }

    func testSnoozeSkippedSnapshotAcknowledgesIntentAndRetiresOutstandingGet() throws {
        let store = WorkspaceSnoozeStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.set(rows[0], until: WorkspaceSnooze.someDay)
        let put = store.hydrationMark()
        let frame = store.beginHydration()

        XCTAssertFalse(store.applySaved(
            ["workspace:ws-1": WorkspaceSnooze.someDay],
            acknowledging: ["workspace:ws-1": .set(WorkspaceSnooze.someDay)],
            begunAt: put
        ))
        store.applyHydrated([:], ticket: frame, persist: false)
        XCTAssertTrue(store.isSnoozed(rows[0]))

        // Another client lifted the snooze. The acknowledged intent must not
        // be replayed over the post-write re-read.
        let fresh = store.beginHydration()
        store.applyHydrated([:], ticket: fresh, persist: false)
        XCTAssertFalse(store.isSnoozed(rows[0]))
    }

    func testSnoozeResyncIsNotOverwrittenByAnOlderGet() throws {
        let store = WorkspaceSnoozeStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        let tick = store.beginHydration()
        let frame = store.beginHydration()

        store.applyHydrated(["workspace:ws-1": WorkspaceSnooze.someDay], ticket: frame, persist: false)
        store.applyHydrated([:], ticket: tick, persist: false)

        XCTAssertTrue(store.isSnoozed(rows[0]))
    }

    func testSnoozeGetFromBeforeAConfirmedWriteIsDropped() throws {
        let store = WorkspaceSnoozeStore()
        let rows = try workspaces(#"[{"id":"bks-1","workspaceId":"ws-1"}]"#)
        store.applyHydrated([:], persist: false)
        let tick = store.beginHydration()
        store.set(rows[0], until: WorkspaceSnooze.someDay)
        store.applySaved(
            ["workspace:ws-1": WorkspaceSnooze.someDay],
            acknowledging: ["workspace:ws-1": .set(WorkspaceSnooze.someDay)]
        )

        store.applyHydrated([:], ticket: tick, persist: false)

        XCTAssertTrue(store.isSnoozed(rows[0]))
    }
}
