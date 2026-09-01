import XCTest
@testable import OS1

@MainActor
final class NewSessionRepositoryTests: XCTestCase {
    private func repos(_ json: String) throws -> [OS1API.RepoInfo] {
        try JSONDecoder().decode([OS1API.RepoInfo].self, from: Data(json.utf8))
    }

    private let fixture = """
    [
      {"id":"app","label":"App","default":true},
      {"id":"docs","label":"Docs"}
    ]
    """

    func testFreshComposerPrefersConfiguredRepository() throws {
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: try repos(fixture),
                preferred: "docs",
                explicit: nil
            ),
            "docs"
        )
    }

    func testNoPreferenceFallsBackToWorkspaceDefault() throws {
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: try repos(fixture),
                preferred: "",
                explicit: nil
            ),
            "app"
        )
    }

    func testRetiredOrRemovedPreferenceFallsBackSafely() throws {
        let available = try repos(fixture)
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: available,
                preferred: "auto",
                explicit: nil
            ),
            "app"
        )
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: available,
                preferred: "removed",
                explicit: nil
            ),
            "app"
        )
    }

    func testExplicitRepositoryScopeWinsOverPreference() throws {
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: try repos(fixture),
                preferred: "docs",
                explicit: "app"
            ),
            "app"
        )
    }

    func testExplicitNoRepositoryAndEmptyCatalogStayNoRepository() throws {
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: try repos(fixture),
                preferred: "docs",
                explicit: Session.noRepoID
            ),
            Session.noRepoID
        )
        XCTAssertEqual(
            NewSessionView.startingRepository(
                in: [],
                preferred: "docs",
                explicit: nil
            ),
            Session.noRepoID
        )
    }
}
