import XCTest
@testable import OS1

/// A `user_map_changed` frame makes a store re-read its map while local
/// writes may still be pending or in flight. These pin two things: the frame
/// is scoped to the account's own user, and a re-read never drops a local
/// mutation the server has not acknowledged yet.
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
}
