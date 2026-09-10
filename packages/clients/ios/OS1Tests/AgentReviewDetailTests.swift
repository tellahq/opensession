import XCTest
@testable import OS1

/// The workspace agent row's second line: quality leads, merge risk is said
/// beside it in its own ink, and the state closes the line.
final class AgentReviewDetailTests: XCTestCase {
    private func detail(
        score: Int? = 4,
        risk: OsReviewSummary.Risk? = nil,
        stale: Bool = false,
        active: Bool = false,
        state: String = "No findings"
    ) -> AgentReviewDetail {
        AgentReviewDetail.compose(score: score, risk: risk, stale: stale, active: active, state: state)
    }

    func testRiskSitsBetweenScoreAndState() {
        let line = detail(risk: .high)
        XCTAssertEqual(line.text, "4/5 · high risk · No findings")
        XCTAssertEqual(
            line.segments,
            [
                .init(text: "4/5 · ", ink: .row),
                .init(text: "high risk", ink: .red),
                .init(text: " · ", ink: .row),
                .init(text: "No findings", ink: .row),
            ]
        )
    }

    func testEachLevelTakesItsOwnInkAndNeverTheRows() {
        XCTAssertEqual(AgentReviewDetail.ink(for: .high, stale: false), .red)
        XCTAssertEqual(AgentReviewDetail.ink(for: .medium, stale: false), .yellow)
        XCTAssertEqual(AgentReviewDetail.ink(for: .low, stale: false), .dim)
        XCTAssertEqual(detail(risk: .medium).text, "4/5 · medium risk · No findings")
        XCTAssertEqual(detail(risk: .low).text, "4/5 · low risk · No findings")
    }

    func testAbsentRiskReadsAsBefore() {
        let line = detail()
        XCTAssertEqual(line.text, "4/5 · No findings")
        XCTAssertTrue(line.segments.allSatisfy { $0.ink == .row })
    }

    func testStaleRiskGoesFaintAndTheStateStillSaysWhy() {
        let line = detail(score: 3, risk: .high, stale: true, state: "New commits since review")
        XCTAssertEqual(line.text, "3/5 · high risk · New commits since review")
        XCTAssertEqual(line.segments[1], .init(text: "high risk", ink: .faint))
        for level in OsReviewSummary.Risk.allCases {
            XCTAssertEqual(AgentReviewDetail.ink(for: level, stale: true), .faint)
        }
    }

    func testRiskWithoutAScoreStartsTheLine() {
        XCTAssertEqual(detail(score: nil, risk: .medium).text, "medium risk · No findings")
    }

    func testRunningPassSaysOnlyThatItIsRunning() {
        let line = detail(risk: .high, active: true, state: "Reviewing…")
        XCTAssertEqual(line.segments, [.init(text: "Reviewing…", ink: .row)])
    }
}
