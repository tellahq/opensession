import SwiftUI
import XCTest
@testable import OS1

/// The review's second axis as the native app decodes and words it: merge
/// risk arrives beside the 1-5 quality score and must never be mistaken for
/// it, on screen or under VoiceOver.
final class MergeRiskTests: XCTestCase {
    private func review(_ json: String) throws -> OsReviewSummary {
        try JSONDecoder().decode(OsReviewSummary.self, from: Data(json.utf8))
    }

    // MARK: - Decoding

    func testRiskFieldsDecodeBesideTheQualityScore() throws {
        let review = try review("""
        {"verdict":"approve","confidence":5,"risk":"high","recovery":"days",
         "riskFactors":["schema_migration","no_tests"],"findings":0,"blocking":0,
         "stale":false,"at":"2026-09-11T08:00:00Z"}
        """)
        XCTAssertEqual(review.confidence, 5)
        XCTAssertEqual(review.risk, .high)
        XCTAssertEqual(review.recovery, .days)
        XCTAssertEqual(review.riskFactors, ["schema_migration", "no_tests"])
        XCTAssertEqual(review.stale, false)
    }

    func testOlderServerWithoutRiskStillDecodes() throws {
        let review = try review(#"{"verdict":"comment","confidence":3,"findings":1,"blocking":0}"#)
        XCTAssertEqual(review.confidence, 3)
        XCTAssertNil(review.risk)
        XCTAssertNil(review.recovery)
        XCTAssertNil(review.riskFactors)
    }

    func testUnknownRiskWordsCostOnlyTheirOwnField() throws {
        // A level or recovery time this build does not know drops to nil;
        // the score, verdict and the session row around it all survive.
        let review = try review("""
        {"verdict":"approve","confidence":4,"risk":"critical","recovery":"weeks",
         "riskFactors":"schema_migration","findings":0,"blocking":0}
        """)
        XCTAssertEqual(review.verdict, "approve")
        XCTAssertEqual(review.confidence, 4)
        XCTAssertNil(review.risk)
        XCTAssertNil(review.recovery)
        XCTAssertNil(review.riskFactors)
    }

    func testRiskRidesTheSessionRow() throws {
        let json = """
        {"id":"os-1","prNumber":7,"prState":"OPEN",
         "prOsReview":{"verdict":"approve","confidence":5,"risk":"medium","recovery":"hours"}}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.prOsReview?.risk, .medium)
        XCTAssertEqual(session.prOsReview?.recovery, .hours)
    }

    // MARK: - Words

    func testFactorIdsReadAsTheServersLabels() {
        XCTAssertEqual(MergeRiskFactor.label("schema_migration"), "schema migration")
        XCTAssertEqual(MergeRiskFactor.label("dns_or_infra"), "DNS or infra")
        XCTAssertEqual(MergeRiskFactor.label("ci_or_deploy"), "CI or deploy")
        XCTAssertEqual(MergeRiskFactor.label("public_api_contract"), "public API contract")
    }

    func testAFactorThisBuildDoesNotKnowStillReadsAsWords() {
        XCTAssertEqual(MergeRiskFactor.label("feature_flag_default"), "feature flag default")
    }

    func testRecoveryTimesAreSaidAsRecovery() {
        XCTAssertEqual(RecoveryTime.minutes.label, "minutes to recover")
        XCTAssertEqual(RecoveryTime.irreversible.label, "not recoverable")
    }

    func testTheCompactPhraseAndTheRowWordAgree() {
        XCTAssertEqual(MergeRisk.high.label, "high risk")
        XCTAssertEqual(MergeRisk.high.word, "High")
    }

    // MARK: - Colour

    func testEachLevelTakesItsOwnStatusInk() {
        XCTAssertEqual(MergeRisk.high.tone(stale: false), .red)
        XCTAssertEqual(MergeRisk.medium.tone(stale: false), .yellow)
        XCTAssertEqual(MergeRisk.low.tone(stale: false), .dim)
    }

    func testAStaleRiskGoesFaintWhateverItsLevel() {
        for risk in MergeRisk.allCases {
            XCTAssertEqual(risk.tone(stale: true), .faint, "\(risk)")
        }
    }

    // MARK: - VoiceOver

    func testVoiceOverNamesTheAxis() {
        XCTAssertEqual(MergeRisk.high.accessibilityLabel, "merge risk high")
    }

    func testTheLoopVerdictSpeaksQualityAndRiskApart() throws {
        var session = Session(id: "bks-1")
        session.prNumber = 1
        session.prState = "OPEN"
        session.prChecks = PrChecksSummary(total: 3, passed: 3, failed: 0, pending: 0)
        session.prOsReview = OsReviewSummary(
            verdict: "approve", confidence: 5, risk: .high, findings: 0, blocking: 0, stale: false
        )
        let result = try XCTUnwrap(ReviewLoopResult(session: session))
        XCTAssertEqual(result.status, .passed, "risk is advisory and never moves the verdict")
        XCTAssertEqual(result.facts(rounds: 1), "1 round · 5/5 · high risk · 3 checks passed")
        XCTAssertEqual(
            result.accessibilityFacts(rounds: 1),
            "1 round, quality 5 of 5, merge risk high, 3 checks passed"
        )
    }

    // MARK: - The PR status card

    func testTheStatusCardKeepsQualityAndRiskOnTheirOwnRows() {
        let quality = PrPanelView.agentQualityValue(score: 5, stale: false)
        let risk = PrPanelView.agentRiskValue(risk: .high, stale: false)
        XCTAssertEqual(quality.value, "5/5")
        XCTAssertEqual(risk.value, "High")
        XCTAssertEqual(risk.tint, OS1VisualStyle.redInk)
    }

    func testTheStatusCardSaysWhenTheReadingIsBehindTheBranch() {
        let quality = PrPanelView.agentQualityValue(score: 5, stale: true)
        let risk = PrPanelView.agentRiskValue(risk: .high, stale: true)
        XCTAssertEqual(quality.value, "5/5 · new commits since")
        XCTAssertEqual(risk.value, "High · new commits since")
        XCTAssertEqual(risk.tint, OS1VisualStyle.textFaint)
    }
}
