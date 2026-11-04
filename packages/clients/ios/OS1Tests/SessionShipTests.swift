import XCTest
@testable import OS1

final class SessionShipTests: XCTestCase {
    private func decode(_ json: String) throws -> SessionShipInfo {
        try JSONDecoder().decode(SessionShipInfo.self, from: Data(json.utf8))
    }

    func testUnavailableCarriesNothingElse() throws {
        let info = try decode(#"{"available":false}"#)
        XCTAssertFalse(info.available)
        XCTAssertNil(info.info)
    }

    func testPullRequestModeDecodesButtonsAndDestination() throws {
        let info = try decode(#"""
        {"available":true,"repo":"acme","target":"main","checkout":"worktree",
         "mode":"pull-request","requested":"pull-request","reason":"repository",
         "buttons":[{"id":"ship","label":"Create PR","prompt":"Create a pull request.","primary":true},
                    {"id":"changelog","label":"Write changelog","prompt":"Write it."}],
         "ships":[],"archiveShipped":false}
        """#)
        let details = try XCTUnwrap(info.info)
        XCTAssertTrue(info.available)
        XCTAssertFalse(details.isDirect)
        XCTAssertEqual(details.buttons.map(\.label), ["Create PR", "Write changelog"])
        XCTAssertEqual(details.buttons.map(\.primary), [true, false])
        XCTAssertNil(details.latestShip)
        XCTAssertEqual(details.destination, "Opens a pull request")
    }

    func testOpenPrAndForcedReasonReadAsAnUpdate() throws {
        let info = try decode(#"""
        {"available":true,"repo":"acme","target":"main","checkout":"worktree",
         "mode":"pull-request","requested":"direct","reason":"open-pr",
         "openPr":{"number":42},"buttons":[{"id":"ship","label":"Update PR","prompt":"p","primary":true}],"ships":[]}
        """#)
        XCTAssertEqual(info.info?.destination, "Updates PR #42, since this branch already has a PR")
    }

    func testDirectModeDecodesTheLatestShip() throws {
        let info = try decode(#"""
        {"available":true,"repo":"acme","target":"main","checkout":"worktree",
         "mode":"direct","requested":"direct","reason":"repository",
         "buttons":[{"id":"ship","label":"Ship","prompt":"Ship it.","primary":true}],
         "ships":[
           {"repo":"acme","branch":"b","target":"main","sha":"1111111aaa","commits":["x"],"pushedAt":"2026-11-03T10:00:00Z","shippedAt":"2026-11-03T10:01:00Z"},
           {"repo":"acme","branch":"b","target":"main","sha":"2222222bbb","previousSha":"1111111aaa","commits":["y","z"],"pushedAt":"2026-11-04T10:00:00.123Z"}
         ]}
        """#)
        let details = try XCTUnwrap(info.info)
        XCTAssertTrue(details.isDirect)
        XCTAssertEqual(details.destination, "Pushes to main")
        let latest = try XCTUnwrap(details.latestShip)
        XCTAssertEqual(latest.shortSha, "2222222")
        XCTAssertEqual(latest.commits.count, 2)
        XCTAssertFalse(latest.isShipped)
        XCTAssertNotNil(details.ships.first?.shippedDate)
    }

    func testSharedCheckoutNamesTheCheckout() throws {
        let info = try decode(#"""
        {"available":true,"repo":"acme","target":"main","checkout":"shared","mode":"direct"}
        """#)
        XCTAssertEqual(info.info?.destination, "Pushes to main from this checkout")
        XCTAssertEqual(info.info?.buttons, [])
    }
}
