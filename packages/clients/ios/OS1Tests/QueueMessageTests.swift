import XCTest
@testable import OS1

/// The queue carries agent-to-agent deliveries alongside what people type.
/// Their sentinels are HTML comments, which the transcript's markdown
/// renderer swallows and a plain-text chip does not — these pin the stripping
/// so a queued worker report never shows up as `<!--os:worker-report-->`.
final class QueueMessageTests: XCTestCase {
    private func present(_ content: String, user: String? = "Alex")
        -> QueueMessagePresentation
    {
        QueueMessagePresentation(content: content, user: user)
    }

    func testOrdinaryMessageIsUntouched() {
        let message = present("rebase this on main please")
        XCTAssertNil(message.label)
        XCTAssertEqual(message.body, "rebase this on main please")
        XCTAssertFalse(message.isGitHub)
        XCTAssertFalse(message.isReviewHandoff)
        XCTAssertFalse(message.isSessionMessage)
    }

    /// The routing prefix is only stripped when a sentinel behind it proves
    /// the message is a delivery. A person is allowed to open a prompt with a
    /// bracket, and it must reach the chip intact.
    func testTypedMessageKeepsItsOwnBrackets() {
        XCTAssertEqual(present("[WIP] still drafting").body, "[WIP] still drafting")
        XCTAssertNil(present("[WIP] still drafting").label)
        XCTAssertEqual(present("[Kent] run the tests").body, "[Kent] run the tests")
    }

    func testWorkerReportIsLabelledAndStripped() {
        let message = present("[worker os-42] <!--os:worker-report-->\nInspection complete.")
        XCTAssertEqual(message.label, "Worker report")
        XCTAssertEqual(message.body, "Inspection complete.")
    }

    func testLegacyWorkerFailureIsLabelledAndStripped() {
        let message = present(
            "Server notice: worker task `bks-42` ended in error without reporting back."
        )
        XCTAssertEqual(message.label, "Worker report")
        XCTAssertEqual(
            message.body,
            "worker task `bks-42` ended in error without reporting back."
        )
    }

    func testStackedSentinelsAreAllStripped() {
        let message = present(
            "<!--os:worker-report:os-42--><!--os:workflow-notice:wf-1-->\n✅ Workflow finished"
        )
        XCTAssertEqual(message.label, "Worker report")
        XCTAssertEqual(message.body, "✅ Workflow finished")
    }

    func testWorkflowNoticeKeepsItsAttributionOutOfTheBody() {
        let message = present(
            "[Alex Rivera] <!--os:workflow-notice:wf-1-->\n✅ Workflow \"review\" finished"
        )
        XCTAssertEqual(message.label, "Workflow")
        XCTAssertEqual(message.body, "✅ Workflow \"review\" finished")
    }

    func testSessionNoticeIsLabelled() {
        let message = present("<!--os:session-notice-->\nHeads-up: the deploy is done.")
        XCTAssertEqual(message.label, "Message from another session")
        XCTAssertEqual(message.body, "Heads-up: the deploy is done.")
        XCTAssertTrue(message.isSessionMessage)
    }

    func testHistoricalAgentDeliveryIsLabelledWithoutSentinel() {
        let id = "os-01a01e56-a1fc-7000-bb91-bc99b916c4ad"
        let message = present("Please avoid overlapping edits.", user: "agent \(id)")
        XCTAssertEqual(message.label, "Message from another session")
        XCTAssertEqual(message.body, "Please avoid overlapping edits.")
        XCTAssertTrue(message.isSessionMessage)
    }

    func testHistoricalAttributedAgentDeliveryIsStripped() {
        let id = "bks-019fa49c-71bb-7000-85d4-c8cc61d0ca85"
        let message = present("[agent \(id)] Please reconcile these changes.")
        XCTAssertEqual(message.label, "Message from another session")
        XCTAssertEqual(message.body, "Please reconcile these changes.")
        XCTAssertTrue(message.isSessionMessage)
    }

    func testHumanReplyCreditsTheTeammate() {
        let message = present("💬 **Kent** answered your question\n\nShip it.")
        XCTAssertEqual(message.label, "Kent")
        XCTAssertEqual(message.body, "Ship it.")
    }

    func testGitHubDeliveryIsFlagged() {
        let message = present("PR #12 was reviewed", user: "GitHub")
        XCTAssertTrue(message.isGitHub)
        XCTAssertFalse(message.isReviewHandoff)
        XCTAssertEqual(message.label, "GitHub")
        XCTAssertEqual(message.body, "PR #12 was reviewed")
    }

    func testReviewHandoffExplainsWhyItIsWaiting() {
        let message = present(
            "<!--os:review-handoff-->\n🔍 This session's PR #42 has feedback",
            user: "GitHub"
        )
        XCTAssertTrue(message.isGitHub)
        XCTAssertTrue(message.isReviewHandoff)
        XCTAssertNil(message.label)
        XCTAssertEqual(message.body, "PR #42 review feedback · Runs after this turn")
    }
}
