import XCTest
@testable import OS1

final class SidebarSearchTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testATypoStillFindsTheSession() throws {
        let release = try session(#"{"id":"os-1","title":"Release checklist","branch":"cut-release"}"#)
        XCTAssertTrue(SidebarSearch.matches(release, workspaceName: nil, query: "relase"))
        XCTAssertTrue(SidebarSearch.matches(release, workspaceName: nil, query: "checklsit"))
        XCTAssertTrue(SidebarSearch.matches(release, workspaceName: nil, query: "RELEASE"))
        XCTAssertFalse(SidebarSearch.matches(release, workspaceName: nil, query: "billing"))
    }

    func testAShortTermStaysExact() throws {
        let cut = try session(#"{"id":"os-1","title":"Cut the timeline"}"#)
        XCTAssertFalse(SidebarSearch.matches(cut, workspaceName: nil, query: "cat"))
        XCTAssertTrue(SidebarSearch.matches(cut, workspaceName: nil, query: "cut"))
    }

    func testTheWorkspaceNameCountsForItsSessions() throws {
        let tab = try session(#"{"id":"os-1","title":"Fix the flaky test","workspaceId":"ws-1"}"#)
        XCTAssertTrue(SidebarSearch.matches(tab, workspaceName: "Billing audit", query: "billing"))
        XCTAssertTrue(SidebarSearch.matches(tab, workspaceName: "Billing audit", query: "billng"))
        XCTAssertFalse(SidebarSearch.matches(tab, workspaceName: nil, query: "billing"))
    }

    func testTheNameTheSessionCarriesStandsInForTheMap() throws {
        let tab = try session(
            #"{"id":"os-1","title":"Fix","workspaceId":"ws-1","workspaceName":"Billing audit"}"#
        )
        XCTAssertEqual(SidebarSearch.name(of: tab, in: [:]), "Billing audit")
        XCTAssertEqual(SidebarSearch.name(of: tab, in: ["ws-1": "Renamed"]), "Renamed")
    }

    func testAnIdMatchesOnlyAsWritten() throws {
        let row = try session(#"{"id":"os-01a08a1d-e2c0","title":"Daily review"}"#)
        XCTAssertTrue(SidebarSearch.matches(row, workspaceName: nil, query: "01a08a1d"))
        XCTAssertFalse(SidebarSearch.matches(row, workspaceName: nil, query: "01a08a1x"))
    }

    func testAnEmptyQueryMatchesEverything() throws {
        let row = try session(#"{"id":"os-1"}"#)
        XCTAssertTrue(SidebarSearch.matches(row, workspaceName: nil, query: ""))
        XCTAssertTrue(SidebarSearch.matches(row, workspaceName: nil, query: "  "))
    }

    func testAWorkspaceRowAnswersThroughItsTitleOrAnySession() throws {
        let main = try session(#"{"id":"os-1","title":"Wire the toggle","workspaceId":"ws-1"}"#)
        let sibling = try session(#"{"id":"os-2","title":"Write the docs","workspaceId":"ws-1"}"#)
        let row = SidebarWorkspace(
            id: "workspace:ws-1",
            title: "Release checklist",
            sessions: [main, sibling],
            mainSession: main
        )
        XCTAssertTrue(SidebarSearch.matches(row, workspaceNames: [:], query: "relase"))
        XCTAssertTrue(SidebarSearch.matches(row, workspaceNames: [:], query: "dosc"))
        XCTAssertFalse(SidebarSearch.matches(row, workspaceNames: [:], query: "billing"))
    }
}
