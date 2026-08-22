import XCTest
@testable import OS1

@MainActor
final class SessionPrSeriesTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testPrimaryComesBeforeAdditionalPullRequestsWithoutReorderingTheRest() throws {
        let value = try session(
            """
            {
              "id":"os-series",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prs":[
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"title":"Desktop shell","state":"OPEN","url":"https://github.com/tellahq/tella-mac/pull/73"},
                {"repo":"opensession","branch":"stack/follow-up","source":"linked","number":74,"title":"Follow-up","state":"MERGED","url":"https://github.com/tellahq/opensession/pull/74"},
                {"repo":"opensession","branch":"stack/foundation","source":"primary","number":72,"title":"Foundation","state":"OPEN","url":"https://github.com/tellahq/opensession/pull/72"}
              ]
            }
            """
        )

        let rows = SessionPrSeries.rows(for: value)

        XCTAssertEqual(rows.compactMap(\.number), [72, 73, 74])
        XCTAssertEqual(rows.map(\.title), ["Foundation", "Desktop shell", "Follow-up"])
        XCTAssertEqual(rows.map(\.state), ["Open", "Open", "Merged"])
        XCTAssertEqual(rows.map(\.isPrimary), [true, false, false])
    }

    func testEachAdditionalRowKeepsItsOwnRepoBranchAndUrlTarget() throws {
        let value = try session(
            """
            {
              "id":"os-targets",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prs":[
                {"repo":"opensession","branch":"stack/foundation","source":"primary","number":72,"state":"OPEN","url":"https://github.com/tellahq/opensession/pull/72"},
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"state":"OPEN","url":"https://github.com/tellahq/tella-mac/pull/73"},
                {"repo":"opensession","branch":"stack/follow-up","source":"linked","number":74,"state":"MERGED","url":"https://github.com/tellahq/opensession/pull/74"}
              ]
            }
            """
        )

        let rows = SessionPrSeries.rows(for: value)

        XCTAssertEqual(
            rows.map(\.target),
            [
                SessionPrTarget(repo: "opensession", branch: "stack/foundation"),
                SessionPrTarget(repo: "tella-mac", branch: "stack/desktop"),
                SessionPrTarget(repo: "opensession", branch: "stack/follow-up"),
            ]
        )
        XCTAssertEqual(
            rows.map(\.url?.absoluteString),
            [
                "https://github.com/tellahq/opensession/pull/72",
                "https://github.com/tellahq/tella-mac/pull/73",
                "https://github.com/tellahq/opensession/pull/74",
            ]
        )
    }

    func testRelatedPullRequestStillProvidesTheLeadingRowWithoutAPrimary() throws {
        let value = try session(
            """
            {
              "id":"os-related-only",
              "repo":"opensession",
              "branch":"no-primary-pr",
              "prs":[
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"title":"Desktop shell","state":"OPEN"}
              ]
            }
            """
        )

        let row = try XCTUnwrap(SessionPrSeries.rows(for: value).first)

        XCTAssertEqual(row.target, SessionPrTarget(repo: "tella-mac", branch: "stack/desktop"))
        XCTAssertEqual(row.number, 73)
        XCTAssertFalse(row.isPrimary)
    }

    func testUnresolvedRelatedPullRequestKeepsItsRepoAndBranchTarget() throws {
        let value = try session(
            """
            {
              "id":"os-unresolved",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prs":[
                {"repo":"opensession","branch":"stack/foundation","source":"primary","number":72,"state":"OPEN"},
                {"repo":"shared-infra","branch":"stack/deploy","source":"linked"}
              ]
            }
            """
        )

        let row = try XCTUnwrap(SessionPrSeries.rows(for: value).last)

        XCTAssertEqual(row.target, SessionPrTarget(repo: "shared-infra", branch: "stack/deploy"))
        XCTAssertNil(row.number)
        XCTAssertEqual(row.state, "Open")
        XCTAssertEqual(row.identityLabel, "shared-infra · stack/deploy")
    }

    func testDraftStateTakesPrecedenceOverChecksAndReview() throws {
        let value = try session(
            """
            {
              "id":"os-draft",
              "repo":"opensession",
              "branch":"stack/draft",
              "prs":[
                {"repo":"opensession","branch":"stack/draft","source":"primary","number":72,"state":"OPEN","isDraft":true,"reviewDecision":"CHANGES_REQUESTED","checks":{"total":2,"passed":0,"failed":1,"pending":1}}
              ]
            }
            """
        )

        XCTAssertEqual(SessionPrSeries.rows(for: value).first?.state, "Draft")
    }

    func testLegacyPrimaryPrecedesProjectedAdditionalPullRequests() throws {
        let value = try session(
            """
            {
              "id":"os-legacy",
              "repo":"opensession",
              "branch":"stack/foundation",
              "prNumber":72,
              "prState":"OPEN",
              "prUrl":"https://github.com/tellahq/opensession/pull/72",
              "prs":[
                {"repo":"tella-mac","branch":"stack/desktop","source":"attached","number":73,"title":"Desktop shell","state":"OPEN","url":"https://github.com/tellahq/tella-mac/pull/73"}
              ]
            }
            """
        )

        let rows = SessionPrSeries.rows(for: value)

        XCTAssertEqual(rows.compactMap(\.number), [72, 73])
        XCTAssertEqual(rows.first?.target, SessionPrTarget(repo: "opensession", branch: "stack/foundation"))
        XCTAssertEqual(rows.first?.isPrimary, true)
    }
}
