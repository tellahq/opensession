import XCTest
@testable import OS1

/// A PR the host refuses to merge while nothing on it looks wrong: the
/// native mirror of the web's `deriveHeadline` / `deriveStatus` "blocked"
/// branch and the `autoMerge` field `parseAutoMerge` sends.
final class PrMergeBlockTests: XCTestCase {
    private func pr(_ json: String) -> PrDetails {
        try! JSONDecoder().decode(PrDetails.self, from: Data(json.utf8))
    }

    private let passing = #""checks":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]"#

    func testDecodesAutoMergeAsTheServerSendsIt() {
        let details = pr(#"""
        {"number":7,"state":"OPEN","mergeStateStatus":"BLOCKED","headRefOid":"abc123",
         "autoMerge":{"method":"squash","enabledBy":"ada","enabledAt":"2026-11-20T10:00:00Z"}}
        """#)
        XCTAssertEqual(details.autoMerge?.method, "squash")
        XCTAssertEqual(details.autoMerge?.enabledBy, "ada")
        XCTAssertEqual(details.headRefOid, "abc123")
    }

    func testNullAutoMergeMeansOff() {
        let details = pr(#"{"number":7,"state":"OPEN","autoMerge":null}"#)
        XCTAssertNil(details.autoMerge)
    }

    func testBlockedReadsBlocked() {
        let details = pr(#"{"number":7,"state":"OPEN","mergeStateStatus":"BLOCKED",\#(passing)}"#)
        XCTAssertEqual(details.mergeBlock, .blocked)
        XCTAssertEqual(details.mergeBlock?.headline, "Blocked")
        XCTAssertEqual(details.mergeBlock?.statusLine, "Merge blocked")
        XCTAssertEqual(details.mergeBlock?.isGreen, false)
    }

    func testBlockedOnAReviewSaysReviewRequired() {
        let details = pr(#"""
        {"number":7,"state":"OPEN","mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED",\#(passing)}
        """#)
        XCTAssertEqual(details.mergeBlock, .reviewRequired)
        XCTAssertEqual(details.mergeBlock?.headline, "Review required")
        XCTAssertEqual(details.mergeBlock?.statusLine, "Merge blocked")
        XCTAssertEqual(details.forceMergeBypasses, ["a required review"])
    }

    func testAutoMergeOnMergesWhenReady() {
        let details = pr(#"""
        {"number":7,"state":"OPEN","mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED",
         "autoMerge":{"method":"squash","enabledBy":"ada"},\#(passing)}
        """#)
        XCTAssertEqual(details.mergeBlock, .mergesWhenReady)
        XCTAssertEqual(details.mergeBlock?.headline, "Merges when ready")
        XCTAssertEqual(details.mergeBlock?.statusLine, "Merges when ready")
        XCTAssertEqual(details.mergeBlock?.isGreen, true)
    }

    func testEarlierCausesKeepTheirOwnLabels() {
        for json in [
            #"{"number":1,"state":"OPEN","isDraft":true,"mergeStateStatus":"BLOCKED"}"#,
            #"{"number":2,"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"BLOCKED"}"#,
            #"{"number":3,"state":"OPEN","reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"BLOCKED"}"#,
            #"{"number":4,"state":"OPEN","mergeStateStatus":"BLOCKED","checks":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"}]}"#,
            #"{"number":5,"state":"OPEN","mergeStateStatus":"BLOCKED","checks":[{"name":"ci","status":"IN_PROGRESS","conclusion":""}]}"#,
            #"{"number":6,"state":"MERGED","mergeStateStatus":"BLOCKED"}"#,
            #"{"number":8,"state":"OPEN","mergeStateStatus":"CLEAN"}"#,
            #"{"number":9,"state":"OPEN","mergeStateStatus":"UNSTABLE"}"#,
        ] {
            XCTAssertNil(pr(json).mergeBlock, json)
        }
    }

    func testCapabilitiesDefaultToSupported() {
        let open = pr(#"{"number":7,"state":"OPEN"}"#)
        XCTAssertTrue(open.canAutoMerge)
        XCTAssertTrue(open.canForceMerge)
        let limited = pr(#"{"number":7,"state":"OPEN","capabilities":{"autoMerge":false,"forceMerge":false}}"#)
        XCTAssertFalse(limited.canAutoMerge)
        XCTAssertFalse(limited.canForceMerge)
    }

    func testPlainBlockBypassesBranchProtection() {
        let details = pr(#"{"number":7,"state":"OPEN","mergeStateStatus":"BLOCKED"}"#)
        XCTAssertEqual(details.forceMergeBypasses, ["branch protection"])
    }
}
