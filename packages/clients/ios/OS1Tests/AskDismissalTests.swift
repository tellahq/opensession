import XCTest
@testable import OS1

/// The question card's X: one send per card, and a dismissal is an explicit
/// JSON null on the wire.
final class AskDismissalTests: XCTestCase {
    func testDismissalSerializesAnExplicitNull() throws {
        let frame = OS1Socket.answerFrame(sessionId: "s1", questionId: "q1", answers: nil)
        let data = try JSONSerialization.data(withJSONObject: frame)
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(decoded["type"] as? String, "answer_question")
        XCTAssertEqual(decoded["questionId"] as? String, "q1")
        XCTAssertTrue(decoded.keys.contains("answers"), "null, not an omitted key")
        XCTAssertTrue(decoded["answers"] is NSNull)
    }

    func testAnswerSerializesTheMapping() throws {
        let frame = OS1Socket.answerFrame(sessionId: "s1", questionId: "q1", answers: ["Which?": "iOS"])
        let data = try JSONSerialization.data(withJSONObject: frame)
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(decoded["answers"] as? [String: String], ["Which?": "iOS"])
    }

    func testDismissalBlocksALaterChoice() {
        var submission = AskSubmission.idle
        XCTAssertTrue(submission.begin(.dismissed))
        XCTAssertFalse(submission.begin(.dismissed), "a second tap on the X sends nothing")
        XCTAssertFalse(submission.begin(.chosen("iOS")))
        XCTAssertEqual(submission, .dismissed)
        XCTAssertNil(submission.chosen)
    }

    func testChoiceBlocksALaterDismissal() {
        var submission = AskSubmission.idle
        XCTAssertFalse(submission.isInFlight)
        XCTAssertTrue(submission.begin(.chosen("iOS")))
        XCTAssertFalse(submission.begin(.dismissed))
        XCTAssertFalse(submission.begin(.chosen("Web")))
        XCTAssertEqual(submission.chosen, "iOS")
        XCTAssertTrue(submission.isInFlight)
    }
}
