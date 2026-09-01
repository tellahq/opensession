import XCTest
@testable import OS1

/// The editorial calls behind the long-press preview's fact strip: which
/// facts appear, in which words, and which are dropped for saying something
/// the strip already said.
final class SessionRowPreviewTests: XCTestCase {
    private func session(
        state: String? = "OPEN",
        mergeable: String? = nil,
        draft: Bool? = nil,
        decision: String? = nil,
        checks: PrChecksSummary? = nil,
        osReview: OsReviewSummary? = nil,
        requested: [String]? = nil
    ) -> Session {
        var session = Session(id: "os-test")
        session.prNumber = 128
        session.prState = state
        session.prMergeable = mergeable
        session.prIsDraft = draft
        session.prReviewDecision = decision
        session.prChecks = checks
        session.prOsReview = osReview
        session.prReviewRequested = requested
        return session
    }

    private func texts(_ session: Session) -> [String] {
        PrPreviewFacts.all(for: session).map(\.text)
    }

    // MARK: - The strip as a whole

    func testNoPullRequestHasNoFacts() {
        var bare = Session(id: "os-test")
        bare.title = "A session with no PR"
        XCTAssertTrue(PrPreviewFacts.all(for: bare).isEmpty)
    }

    func testReadyPullRequestLeadsWithStateThenItsEvidence() {
        let facts = PrPreviewFacts.all(
            for: session(checks: PrChecksSummary(total: 6, passed: 6, failed: 0, pending: 0))
        )
        XCTAssertEqual(facts.map(\.text), ["Ready to merge", "all 6 passing"])
        XCTAssertEqual(facts.map(\.tone), [.green, .green])
    }

    func testStateWordingMatchesTheMenuItemUnderIt() {
        // The preview and the action below it read off the same enum, so they
        // can never disagree about what this PR needs next.
        let conflicted = session(mergeable: "CONFLICTING")
        XCTAssertEqual(
            texts(conflicted).first,
            conflicted.pullRequestContextState?.label
        )
        XCTAssertEqual(PrPreviewFacts.all(for: conflicted).first?.tone, .red)
    }

    // MARK: - Checks

    func testFailingStateDoesNotAlsoSpellOutTheFailingChecks() {
        // "Checks failed · 2 failing" spends the strip saying one thing twice.
        let facts = texts(
            session(checks: PrChecksSummary(total: 6, passed: 4, failed: 2, pending: 0))
        )
        XCTAssertEqual(facts, ["Checks failed"])
    }

    func testRunningStateDoesNotAlsoSpellOutTheRunningChecks() {
        let facts = texts(
            session(checks: PrChecksSummary(total: 6, passed: 3, failed: 0, pending: 3))
        )
        XCTAssertEqual(facts, ["3 checks running"])
    }

    func testChecksSurviveUnderAStateThatCannotSayThem() {
        // A draft's state says nothing about CI, so the rollup still earns
        // its place.
        let facts = texts(
            session(
                draft: true,
                checks: PrChecksSummary(total: 4, passed: 4, failed: 0, pending: 0)
            )
        )
        XCTAssertEqual(facts, ["Draft pull request", "all 4 passing"])
    }

    func testNoChecksAtAllAddsNothing() {
        XCTAssertEqual(texts(session(checks: nil)), ["Ready to merge"])
        XCTAssertEqual(
            texts(session(checks: PrChecksSummary(total: 0, passed: 0, failed: 0, pending: 0))),
            ["Ready to merge"]
        )
    }

    // MARK: - Human review

    func testApprovalIsSaidBecauseTheStateCannotSayIt() {
        XCTAssertEqual(texts(session(decision: "APPROVED")), ["Ready to merge", "approved"])
    }

    func testChangesRequestedIsNotRepeatedAfterTheState() {
        XCTAssertEqual(texts(session(decision: "CHANGES_REQUESTED")), ["Changes requested"])
    }

    func testReviewRequiredIsDroppedRatherThanSaidOnEveryStrip() {
        XCTAssertEqual(texts(session(decision: "REVIEW_REQUIRED")), ["Ready to merge"])
    }

    // MARK: - Automated review

    func testScoreLeadsTheCompactReviewReading() {
        XCTAssertEqual(
            PrPreviewFacts.osReviewFact(
                OsReviewSummary(verdict: "approve", confidence: 4)
            ),
            PrPreviewFact(text: "4/5 · approved", tone: .green)
        )
    }

    func testVerdictStillReadsWithoutAScore() {
        XCTAssertEqual(
            PrPreviewFacts.osReviewFact(OsReviewSummary(verdict: "comment")),
            PrPreviewFact(text: "commented", tone: .dim)
        )
        XCTAssertEqual(
            PrPreviewFacts.osReviewFact(OsReviewSummary(verdict: "request_changes")),
            PrPreviewFact(text: "changes requested", tone: .red)
        )
    }

    func testBlockingAndStaleContextFollowTheScoreAndVerdict() {
        XCTAssertEqual(
            PrPreviewFacts.osReviewFact(
                OsReviewSummary(
                    verdict: "request_changes",
                    confidence: 2,
                    blocking: 1,
                    stale: true
                )
            ),
            PrPreviewFact(
                text: "2/5 · changes requested · 1 blocking · stale",
                tone: .faint
            )
        )
    }

    func testVerdictlessReviewAddsNothing() {
        XCTAssertNil(PrPreviewFacts.osReviewFact(OsReviewSummary(confidence: 3)))
    }

    // MARK: - Reviewers

    func testWaitingOnUpToTwoPeopleNamesThem() {
        XCTAssertEqual(
            PrPreviewFacts.reviewersFact(["kent", "michiel"], state: .ready),
            PrPreviewFact(text: "awaiting kent, michiel", tone: .dim)
        )
    }

    func testLongerReviewerListCountsTheRestInsteadOfTruncatingAName() {
        XCTAssertEqual(
            PrPreviewFacts.reviewersFact(["kent", "michiel", "grant", "jo"], state: .ready),
            PrPreviewFact(text: "awaiting kent, michiel +2", tone: .dim)
        )
    }

    func testNobodyIsAwaitedOnAFinishedPullRequest() {
        XCTAssertNil(PrPreviewFacts.reviewersFact(["kent"], state: .merged))
        XCTAssertNil(PrPreviewFacts.reviewersFact(["kent"], state: .closed))
        XCTAssertNil(PrPreviewFacts.reviewersFact([], state: .ready))
        XCTAssertNil(PrPreviewFacts.reviewersFact(nil, state: .ready))
    }

    // MARK: - Finished pull requests

    func testMergedSaysOnlyWhatStillMatters() {
        let facts = texts(
            session(
                state: "MERGED",
                decision: "APPROVED",
                checks: PrChecksSummary(total: 6, passed: 6, failed: 0, pending: 0),
                requested: ["kent"]
            )
        )
        XCTAssertEqual(facts, ["Merged"])
        XCTAssertEqual(PrPreviewFacts.all(for: session(state: "MERGED")).first?.tone, .purple)
    }

    // MARK: - Decoding

    func testDiffSizeDecodesOffTheSessionsList() throws {
        let json = """
        {"id":"os-1","prNumber":7,"prAdditions":142,"prDeletions":38,
         "prChangedFiles":9,"prReviewRequested":["kent"]}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.prAdditions, 142)
        XCTAssertEqual(session.prDeletions, 38)
        XCTAssertEqual(session.prChangedFiles, 9)
        XCTAssertEqual(session.prReviewRequested, ["kent"])
    }

    func testOlderServerWithoutDiffFieldsStillDecodes() throws {
        let json = #"{"id":"os-1","prNumber":7}"#
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertNil(session.prAdditions)
        XCTAssertNil(session.prDeletions)
        XCTAssertNil(session.prReviewRequested)
    }
}
