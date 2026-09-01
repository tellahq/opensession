import XCTest
@testable import OS1

/// The three list rules this app shares with the web sidebar: which spawned
/// workers earn a row, what grouping an unconfigured list starts on, and who
/// the Archived screen's Owner lens offers.
final class SessionsListLensTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    // MARK: - Spawned workers

    func testSpawnedWorkerStaysOutOfTheListUntilItNeedsSomeone() throws {
        let all = try sessions(
            """
            [{"id":"os-plain"},
             {"id":"os-worker","spawnedBy":"os-plain"},
             {"id":"os-blocked","spawnedBy":"os-plain","waitingForInput":true},
             {"id":"os-claimed","spawnedBy":"os-plain"}]
            """
        )

        XCTAssertEqual(
            SessionsListViewModel.listedSessions(in: all, claimed: []).map(\.id),
            ["os-plain", "os-blocked"]
        )
        // Claiming one is the other way in — the same per-user triage that
        // pulls an automation's run into your list.
        XCTAssertEqual(
            SessionsListViewModel.listedSessions(in: all, claimed: ["os-claimed"]).map(\.id),
            ["os-plain", "os-blocked", "os-claimed"]
        )
    }

    func testAWorkerGetsNoRowButKeepsItsSession() throws {
        // The rule is applied while BUILDING rows, so a `@session:` link in a
        // transcript can still open the worker the run spawned.
        let all = try sessions(
            """
            [{"id":"os-parent","workspaceId":"ws-1"},
             {"id":"os-worker","workspaceId":"ws-2","spawnedBy":"os-parent"}]
            """
        )
        let prepared = SessionsListViewModel.prepared(all, hiding: [], restoring: [])

        XCTAssertEqual(prepared.active.map(\.id).sorted(), ["os-parent", "os-worker"])
        let rows = SessionsListViewModel.sidebarWorkspaces(
            in: SessionsListViewModel.listedSessions(in: prepared.active, claimed: [])
        )
        XCTAssertEqual(rows.map(\.id), ["workspace:ws-1"])
    }

    // MARK: - Default grouping

    func testGroupingAxesHaveIndependentDefaults() {
        XCTAssertEqual(SidebarGroupBy.fallback(repoCount: 1), .inbox)
        XCTAssertEqual(SidebarGroupBy.fallback(repoCount: 4), .inbox)
        XCTAssertFalse(SidebarGroupBy.defaultGroupsByProject(repoCount: 1))
        XCTAssertTrue(SidebarGroupBy.defaultGroupsByProject(repoCount: 4))
        XCTAssertTrue(
            SidebarGroupBy.defaultGroupsByProject(repoCount: RepoCount.unknown)
        )
    }

    func testEveryGroupingThisAppEverStoredKeepsBothAxes() {
        XCTAssertEqual(SidebarGroupBy.stored("none"), .inbox)
        XCTAssertEqual(SidebarGroupBy.stored("settled"), .inbox)
        XCTAssertEqual(SidebarGroupBy.stored("inbox"), .inbox)
        XCTAssertEqual(SidebarGroupBy.stored("recent"), .activity)
        XCTAssertEqual(SidebarGroupBy.stored("repo"), .inbox)
        XCTAssertEqual(SidebarGroupBy.stored("repo-inbox"), .activity)
        XCTAssertEqual(SidebarGroupBy.stored("repo-status"), .status)
        XCTAssertEqual(SidebarGroupBy.stored("status"), .status)
        XCTAssertTrue(SidebarGroupBy.legacyGroupsByProject("repo") == true)
        XCTAssertTrue(SidebarGroupBy.legacyGroupsByProject("repo-inbox") == true)
        XCTAssertTrue(SidebarGroupBy.legacyGroupsByProject("repo-status") == true)
        XCTAssertFalse(SidebarGroupBy.legacyGroupsByProject("inbox") == true)
        XCTAssertNil(SidebarGroupBy.stored(""))
        XCTAssertNil(SidebarGroupBy.stored("repo-something-new"))
    }

    // MARK: - The person lens

    func testTheTwoLensValuesThisAppWroteBeforeReadAsTheirNewSpelling() {
        XCTAssertEqual(SidebarPersonLens.stored("mine"), SidebarPersonLens.me)
        XCTAssertEqual(SidebarPersonLens.stored("all"), SidebarPersonLens.everyone)
        XCTAssertEqual(SidebarPersonLens.stored(""), SidebarPersonLens.me)
        // A person key is already what it means.
        XCTAssertEqual(SidebarPersonLens.stored("Kent"), "kent")
    }

    /// One teammate reaches us as "Kent", "Kent de Bruin" and "kentdebruin"
    /// depending on where the name came from, so all three answer to one
    /// option — the web's `ownerMatchesPerson` rule.
    func testOnePersonAnswersToEverySpellingOfTheirName() {
        XCTAssertTrue(SidebarPersonLens.nameMatches("Kent de Bruin", key: "kent"))
        XCTAssertTrue(SidebarPersonLens.nameMatches("Kent", key: "kent de bruin"))
        XCTAssertFalse(SidebarPersonLens.nameMatches("Michiel", key: "kent"))
        XCTAssertFalse(SidebarPersonLens.nameMatches("", key: "kent"))
    }

    // MARK: - Auto-created rows

    @MainActor
    func testAgentsOwnWorkspaceIsAutoCreatedUntilAPersonJoinsIt() throws {
        let machine = try sessions(
            #"[{"id":"os-1","workspaceId":"ws-1","startedBy":"Automation"}]"#
        )
        let shared = try sessions(
            """
            [{"id":"os-1","workspaceId":"ws-1","startedBy":"Automation"},
             {"id":"os-2","workspaceId":"ws-1","startedBy":"Kent"}]
            """
        )

        let machineRow = SessionsListViewModel.sidebarWorkspaces(in: machine)[0]
        XCTAssertTrue(AutoCreatedOrigin.wasAutoCreated(machineRow))
        // Once a person joins it is shared work, not machine clutter: hiding
        // the row would hide that person's session too.
        let sharedRow = SessionsListViewModel.sidebarWorkspaces(in: shared)[0]
        XCTAssertFalse(AutoCreatedOrigin.wasAutoCreated(sharedRow))
    }

    @MainActor
    func testAnAutomationsRunIsNotAnAutoCreatedRow() throws {
        // An automation is a job somebody configured, and its runs carry that
        // name. These are one-off workspaces an agent opened for itself.
        let run = try sessions(
            #"[{"id":"os-1","workspaceId":"ws-1","startedBy":"Automation","automation":"nightly-triage"}]"#
        )
        let row = SessionsListViewModel.sidebarWorkspaces(in: run)[0]

        XCTAssertFalse(AutoCreatedOrigin.wasAutoCreated(row))
    }

    // MARK: - Team activity

    func testTeamActivityUsesDirectoryOwnersAndRecentWindow() throws {
        let now = try XCTUnwrap(Session.parseISO("2026-08-24T12:00:00Z"))
        let rows = try sessions(
            """
            [{"id":"recent","startedBy":"Michiel Westerbeek","ran":true,"lastActivity":"2026-08-24T11:45:00Z"},
             {"id":"old","startedBy":"Michiel","ran":true,"lastActivity":"2026-08-24T11:44:59Z"},
             {"id":"running","startedBy":"Jeroen","isRunning":true,"lastActivity":"2020-01-01T00:00:00Z"},
             {"id":"draft","startedBy":"Jeroen","ran":false,"lastActivity":"2026-08-24T11:59:00Z"},
             {"id":"worker","startedBy":"worker os-123","isRunning":true},
             {"id":"mine","startedBy":"kentdebruin","isRunning":true}]
            """
        )
        let members = [
            TeamActivity.Member(name: "Kent", aliases: ["Kent", "Kent de Bruin", "kentdebruin"]),
            TeamActivity.Member(name: "Michiel", aliases: ["Michiel", "Michiel Westerbeek"]),
            TeamActivity.Member(name: "Jeroen")
        ]

        let groups = TeamActivity.groups(
            sessions: rows, members: members, currentUser: "Kent", now: now
        )

        XCTAssertEqual(groups.map(\.label), ["Michiel", "Jeroen"])
        XCTAssertEqual(groups[0].activeSessions.map(\.id), ["recent"])
        XCTAssertEqual(groups[0].allSessions.map(\.id), ["recent", "old"])
        XCTAssertEqual(groups[1].activeSessions.map(\.id), ["running"])
    }

    func testTeamActivityFilesAutomationsUnderOwnerOrAgent() throws {
        let rows = try sessions(
            """
            [{"id":"owned","automation":"Daily report","isRunning":true},
             {"id":"agent","automation":"PR review","isRunning":true},
             {"id":"mine","automation":"My job","isRunning":true}]
            """
        )
        let members = [TeamActivity.Member(name: "Kent"), TeamActivity.Member(name: "Michiel")]

        let groups = TeamActivity.groups(
            sessions: rows,
            members: members,
            currentUser: "Kent",
            automationOwners: ["Daily report": "Michiel", "My job": "Kent"]
        )

        XCTAssertEqual(groups.map(\.label), ["Michiel", "Agent"])
        XCTAssertEqual(groups.flatMap(\.activeSessions).map(\.id), ["owned", "agent"])
    }

    // MARK: - Workspace deletion

    func testWorkspaceDeletionStateTracksSuccessAndFailure() {
        var state = WorkspaceDeletionState()
        state.begin("ws-1")
        XCTAssertEqual(state.deletingWorkspaceId, "ws-1")
        XCTAssertNil(state.failure)

        state.fail("ws-1", message: "Nope")
        XCTAssertNil(state.deletingWorkspaceId)
        XCTAssertEqual(state.failure, .init(workspaceId: "ws-1", message: "Nope"))

        state.begin("ws-2")
        state.succeed("ws-2")
        XCTAssertEqual(state, WorkspaceDeletionState())
    }

    // MARK: - Archived owners

    private let roster = ["kent": "Kent", "michiel": "Michiel"]

    func testOwnerOptionsMergeBothSpellingsOfOnePerson() throws {
        let archive = try sessions(
            """
            [{"id":"a","startedBy":"Kent"},
             {"id":"b","startedBy":"Kent de Bruin"},
             {"id":"c","startedBy":"Michiel"},
             {"id":"d","startedBy":"worker os-019fe"},
             {"id":"e","startedBy":"Kent","automation":"nightly-triage"}]
            """
        )

        let owners = ArchivedOwners.options(in: archive, roster: roster, excluding: "")
        // One option per person, busiest first — never one per spelling, and
        // never the session ids the archive is otherwise full of.
        XCTAssertEqual(owners.map(\.label), ["Kent", "Michiel"])
        XCTAssertEqual(owners.map(\.key), ["kent", "michiel"])

        // Both spellings answer to the same option; an automation's run is
        // nobody's, however it was signed.
        XCTAssertTrue(ArchivedOwners.session(archive[0], hasOwner: "kent", roster: roster))
        XCTAssertTrue(ArchivedOwners.session(archive[1], hasOwner: "kent", roster: roster))
        XCTAssertFalse(ArchivedOwners.session(archive[4], hasOwner: "kent", roster: roster))
    }

    func testTheSignedInPersonIsNotOfferedAsATeammate() throws {
        let archive = try sessions(
            """
            [{"id":"a","startedBy":"Kent de Bruin"},{"id":"b","startedBy":"Michiel"}]
            """
        )

        XCTAssertEqual(
            ArchivedOwners.options(in: archive, roster: roster, excluding: "kent").map(\.label),
            ["Michiel"]
        )
    }

    func testSomeoneOutsideTheRosterStillFiltersUnderTheirRawName() throws {
        let archive = try sessions(#"[{"id":"a","startedBy":"Ada"}]"#)

        XCTAssertEqual(ArchivedOwners.ownerKey(of: archive[0], roster: roster), "ada")
        XCTAssertTrue(ArchivedOwners.session(archive[0], hasOwner: "ada", roster: roster))
        // …but is not offered as an option: an unfiltered list is mostly
        // spawned workers and integration senders.
        XCTAssertTrue(ArchivedOwners.options(in: archive, roster: roster, excluding: "").isEmpty)
    }
}
