import XCTest
@testable import OS1

final class CommitDetailsTests: XCTestCase {
    private static let metadataOnly = """
        {
          "repo":"opensession",
          "sha":"4ed1ef09aa11bb22cc33dd44ee55ff6600778899",
          "shortSha":"4ed1ef09",
          "title":"Fix transcript references",
          "body":"Keep the parser conservative.",
          "author":"OS Robot",
          "person":null,
          "committedAt":"2026-08-17T10:20:30Z",
          "filesChanged":3,
          "additions":42,
          "deletions":7,
          "url":"https://github.com/tellahq/opensession/commit/4ed1ef09aa11bb22cc33dd44ee55ff6600778899",
          "onDefaultBranch":true,
          "defaultBranch":"main"
        }
        """

    func testDecodesMetadataOnlyResponse() throws {
        let details = try JSONDecoder().decode(
            CommitDetails.self, from: Data(Self.metadataOnly.utf8)
        )
        XCTAssertEqual(details.repo, "opensession")
        XCTAssertEqual(details.shortSha, "4ed1ef09")
        XCTAssertEqual(details.filesChanged, 3)
        XCTAssertTrue(details.onDefaultBranch)
        XCTAssertNotNil(details.committedDate)
        XCTAssertNil(details.rawPatch)
        XCTAssertNil(details.patchTruncated)
        XCTAssertEqual(details.changedFiles, [])
    }

    func testDecodesTheBoundedPatchAndSplitsItPerFile() throws {
        let patch = "diff --git a/one.txt b/one.txt\\n--- a/one.txt\\n+++ b/one.txt\\n"
            + "@@ -1 +1 @@\\n-a\\n+A\\n"
            + "diff --git a/two.txt b/two.txt\\n--- a/two.txt\\n+++ b/two.txt\\n"
            + "@@ -1 +1 @@\\n-b\\n+B\\n"
        let details = try JSONDecoder().decode(
            CommitDetails.self,
            from: Data(Self.withChanges(rawPatch: patch, truncated: true).utf8)
        )
        XCTAssertEqual(details.patchTruncated, true)
        XCTAssertEqual(details.changedFiles.map(\.path), ["one.txt", "two.txt"])
        XCTAssertTrue(details.changedFiles[1].patch.contains("+B"))
    }

    func testAnEmptyPatchMeansNoChangedFiles() throws {
        let details = try JSONDecoder().decode(
            CommitDetails.self,
            from: Data(Self.withChanges(rawPatch: "", truncated: nil).utf8)
        )
        XCTAssertEqual(details.rawPatch, "")
        XCTAssertEqual(details.changedFiles, [])
        XCTAssertNil(details.patchTruncated)
    }

    func testLookupPathCarriesTheRepoHint() throws {
        let path = CommitDetails.lookupPath(sha: "4ed1ef09", repo: "open session/test")
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "/api/commit")
        XCTAssertEqual(components.queryItems?.first { $0.name == "sha" }?.value, "4ed1ef09")
        XCTAssertEqual(
            components.queryItems?.first { $0.name == "repo" }?.value,
            "open session/test"
        )
        XCTAssertEqual(components.queryItems?.first { $0.name == "changes" }?.value, "1")
    }

    func testLookupPathWithoutRepoStillOptsIntoChanges() throws {
        let path = CommitDetails.lookupPath(sha: "4ed1ef09", repo: nil)
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.queryItems?.first { $0.name == "changes" }?.value, "1")
        XCTAssertNil(components.queryItems?.first { $0.name == "repo" })
    }

    private static func withChanges(rawPatch: String, truncated: Bool?) -> String {
        var extra = ",\"rawPatch\":\"\(rawPatch)\""
        if let truncated { extra += ",\"patchTruncated\":\(truncated)" }
        return metadataOnly.replacingOccurrences(
            of: "\"defaultBranch\":\"main\"",
            with: "\"defaultBranch\":\"main\"" + extra
        )
    }
}
