import XCTest
@testable import OS1

/// The "My sessions" lens has to agree with the web sidebar's `focusWsRows`
/// rule (src/frontend/components/Sidebar.tsx), because both read the same
/// per-user lane store. It used to test only `startedBy`, which left a
/// workspace you claimed in the browser missing from the phone entirely.
@MainActor
final class PeopleLensTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    private func lens(claims: Set<String> = []) -> PeopleLens {
        PeopleLens(names: ["michiel westerbeek", "michiel", "happylinks"], claims: claims)
    }

    private func rows(_ list: [Session]) -> [SidebarWorkspace] {
        SessionsListViewModel.sidebarWorkspaces(in: list)
    }

    // ── A session on its own ────────────────────────────────────────────────

    func testSessionYouStartedIsYoursUnderEveryNameYouGoBy() throws {
        let list = try sessions(
            """
            [{"id":"os-1","startedBy":"Michiel"},
             {"id":"os-2","startedBy":"happylinks"},
             {"id":"os-3","startedBy":"Kent"}]
            """
        )

        XCTAssertEqual(list.map(lens().isMine), [true, true, false])
    }

    func testFullStarterNameMatchesRosterFirstName() throws {
        let session = try sessions(
            #"[{"id":"os-1","startedBy":"Kent de Bruin"}]"#
        )[0]
        let lens = PeopleLens(
            names: ["kent", "kentdebruin"],
            roster: ["kent": "Kent"],
            claims: []
        )

        XCTAssertTrue(lens.isMine(session))
    }

    func testCanonicalNameDoesNotUseArbitraryPrefixes() throws {
        let session = try sessions(
            #"[{"id":"os-1","startedBy":"Kentucky de Bruin"}]"#
        )[0]
        let lens = PeopleLens(
            names: ["kent", "kentdebruin"],
            roster: ["kent": "Kent", "kentucky": "Kentucky"],
            claims: []
        )

        XCTAssertFalse(lens.isMine(session))
    }

    func testAutomationRunIsNobodysUntilItIsClaimed() throws {
        let run = try sessions(
            #"[{"id":"os-1","startedBy":"Michiel (automation)","automation":"triage"}]"#
        )[0]

        XCTAssertFalse(lens().isMine(run))
        XCTAssertTrue(lens(claims: ["os-1"]).isMine(run))
    }

    // ── A row in the list ───────────────────────────────────────────────────

    func testClaimedWorkspaceIsYoursThoughNothingInItIsYours() throws {
        // The reported bug: a session opened by the machine identity, claimed
        // from the browser. Nothing about it says "Michiel" but the claim.
        let list = try sessions(
            #"[{"id":"os-1","workspaceId":"ws-1","startedBy":"Automation"}]"#
        )

        XCTAssertFalse(lens().owns(rows(list)[0]))
        XCTAssertTrue(lens(claims: ["os-1"]).owns(rows(list)[0]))
    }

    /// A claim covers the row it is ON, not its neighbours: claiming one
    /// session of a workspace is what makes that workspace yours, and a
    /// workspace you never claimed stays out however similar it looks.
    func testAClaimDoesNotSpreadToOtherRows() throws {
        let list = try sessions(
            """
            [{"id":"os-1","workspaceId":"ws-1","startedBy":"Automation"},
             {"id":"os-2","workspaceId":"ws-2","startedBy":"Automation"}]
            """
        )
        let claimed = lens(claims: ["os-1"])

        XCTAssertEqual(rows(list).map(claimed.owns), [true, false])
    }

    func testOneSessionOfYoursMakesTheWholeRowYours() throws {
        let list = try sessions(
            """
            [{"id":"os-1","workspaceId":"ws-1","startedBy":"Kent"},
             {"id":"os-2","workspaceId":"ws-1","startedBy":"Michiel"}]
            """
        )

        XCTAssertEqual(rows(list).count, 1)
        XCTAssertTrue(lens().owns(rows(list)[0]))
    }

    func testSomeoneElsesWorkspaceStaysOutOfYourList() throws {
        let list = try sessions(
            #"[{"id":"os-1","workspaceId":"ws-1","startedBy":"Kent"}]"#
        )

        XCTAssertFalse(lens().owns(rows(list)[0]))
    }

    /// The web's lens has a third clause — a workspace whose creator is you,
    /// with no session of yours in it. Left out on purpose: against the live
    /// list it tripled one person's sidebar, which is a product decision and
    /// not part of fixing a missing row. Pinned so adding it is deliberate.
    func testWorkspaceCreatorAloneDoesNotMakeARowYours() throws {
        let list = try sessions(
            #"[{"id":"os-1","workspaceId":"ws-1","startedBy":"Kent","createdBy":"Michiel"}]"#
        )

        XCTAssertFalse(lens().owns(rows(list)[0]))
    }

    // ── The store behind the claims ─────────────────────────────────────────

    func testLaneStoreKeepsTheClaimedIdsWhateverLaneTheyAreIn() {
        let store = LaneStore()

        store.applyHydrated(["os-1": "mine", "os-2": "pending", "os-3": "review"])

        XCTAssertTrue(store.hasHydrated)
        XCTAssertEqual(store.claims, ["os-1", "os-2", "os-3"])
    }
}
