import XCTest
@testable import OS1

@MainActor
final class SessionForkTests: XCTestCase {
    func testTipCreatePayload() throws {
        let body = OS1API.createSessionBody(
            prompt: "Try another direction",
            repo: "opensession",
            mode: "ask",
            forkFrom: OS1API.ForkFrom(sourceId: "os-source"),
            user: "Ada"
        )
        let fork = try XCTUnwrap(body["forkFrom"] as? [String: String])
        XCTAssertEqual(fork, ["sourceId": "os-source"])
    }

    func testMessageCreatePayload() throws {
        let body = OS1API.createSessionBody(
            prompt: "Try another direction",
            repo: "opensession",
            mode: "ask",
            forkFrom: OS1API.ForkFrom(
                sourceId: "os-source",
                messageId: "msg-42"
            ),
            user: "Ada"
        )
        let fork = try XCTUnwrap(body["forkFrom"] as? [String: String])
        XCTAssertEqual(fork, [
            "sourceId": "os-source",
            "messageId": "msg-42",
        ])
    }

    func testEnterAndCancelForkMode() {
        var state = SessionForkState()
        state.enter(messageId: "msg-42")
        XCTAssertEqual(state.point, .message("msg-42"))

        state.cancel()
        XCTAssertNil(state.point)
        XCTAssertFalse(state.creating)
    }

    func testSuccessfulCreateReturnsNavigationDestinationAndClearsMode() throws {
        var state = SessionForkState()
        state.enter()
        let payload = try XCTUnwrap(state.begin(sourceId: "os-source"))
        XCTAssertEqual(payload, OS1API.ForkFrom(sourceId: "os-source"))
        XCTAssertTrue(state.creating)

        XCTAssertEqual(state.complete(sessionId: "os-fork"), "os-fork")
        XCTAssertNil(state.point)
        XCTAssertFalse(state.creating)
    }
}
