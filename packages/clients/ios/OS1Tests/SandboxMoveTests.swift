import XCTest
@testable import OS1

final class SandboxMoveTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func status(_ json: String) throws -> InstanceSandboxStatus {
        try JSONDecoder().decode(InstanceSandboxStatus.self, from: Data(json.utf8))
    }

    /// The server's own refusals (routes/sandbox.ts `sandboxAttachRefusal`),
    /// one each, so the app never offers a move that would answer 409.
    func testHostCodeSessionWithRepoCanMove() throws {
        let host = try session(#"{"id":"bks-1","mode":"code","repo":"opensession"}"#)
        XCTAssertNil(SandboxMove.refusal(host))
        XCTAssertTrue(SandboxMove.canMove(host))
    }

    func testMaterializedSandboxRefuses() throws {
        let moved = try session(
            #"{"id":"bks-1","mode":"code","repo":"opensession","sandbox":{"provider":"daytona","sandboxId":"sb-1"}}"#
        )
        XCTAssertEqual(SandboxMove.refusal(moved), .inSandbox)
    }

    /// A recorded provider without an id is a move still preparing (or one
    /// that failed). The server would take a second move and provision twice,
    /// so the offer ends as soon as any provider is recorded, as on the web;
    /// a failed Sandbox is retried from the Sandbox section.
    func testPreparingOrFailedSandboxRefuses() throws {
        let preparing = try session(
            #"{"id":"bks-1","mode":"code","repo":"opensession","sandbox":{"provider":"daytona","lifecycle":"preparing"}}"#
        )
        XCTAssertEqual(SandboxMove.refusal(preparing), .inSandbox)
        let failed = try session(
            #"{"id":"bks-1","mode":"code","repo":"opensession","sandbox":{"provider":"box","lifecycle":"needs_attention"}}"#
        )
        XCTAssertEqual(SandboxMove.refusal(failed), .inSandbox)
        let local = try session(
            #"{"id":"bks-1","mode":"code","repo":"opensession","sandbox":{"provider":"local","sandboxId":"x"}}"#
        )
        XCTAssertNil(SandboxMove.refusal(local))
    }

    func testRunnerRefuses() throws {
        let runner = try session(
            #"{"id":"bks-1","mode":"code","repo":"opensession","runner":{"id":"mac-1","name":"Mac","workspacePath":"/w"}}"#
        )
        XCTAssertEqual(SandboxMove.refusal(runner), .runner)
    }

    func testAutomationRefusesByFlagNameOrId() throws {
        XCTAssertEqual(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"code","repo":"r","automation":true}"#)),
            .automation
        )
        XCTAssertEqual(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"code","repo":"r","automation":"triage"}"#)),
            .automation
        )
        XCTAssertEqual(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"code","repo":"r","automationId":"plain-triage"}"#)),
            .automation
        )
        XCTAssertNil(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"code","repo":"r","automation":false}"#))
        )
    }

    func testAskAndRepoLessSessionsRefuse() throws {
        XCTAssertEqual(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"ask","repo":"r"}"#)),
            .notCode
        )
        XCTAssertEqual(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"code"}"#)),
            .noRepo
        )
        XCTAssertEqual(
            SandboxMove.refusal(try session(#"{"id":"bks-1","mode":"code","repo":"r","repoLess":true}"#)),
            .noRepo
        )
    }

    /// The composer's choices minus the host: a move is always away from
    /// this machine.
    func testChoicesAreTheReadyConnections() throws {
        let payload = try status("""
        {"enabled":true,"killSwitch":false,
         "providers":[{"id":"docker","configured":true,"certified":true}],
         "connections":[{"provider":"docker","state":"needs_attention"},
                        {"provider":"daytona","state":"ready"},
                        {"provider":"box","state":"ready"}]}
        """)
        XCTAssertEqual(SandboxMove.choices(payload), ["daytona", "box"])
        XCTAssertEqual(SandboxMove.choices(nil), [])
    }

    /// The attach route's 428 is an answer, not a failure: the server's own
    /// sentence about the unpushed work reaches the confirmation as written.
    @MainActor
    func testConfirmRequiredCarriesTheServersSentence() async throws {
        let body = Data(
            #"{"error":"This machine has 2 uncommitted files. The Sandbox clones the branch from origin, so push first, or move anyway and leave them here.","confirmRequired":true}"#.utf8
        )
        let outcome = try await OS1API.sandboxAttachOutcome(status: 428, data: body)
        guard case .confirmRequired(let message) = outcome else {
            return XCTFail("expected confirmRequired, got \(outcome)")
        }
        XCTAssertTrue(message.hasPrefix("This machine has 2 uncommitted files."))
    }

    @MainActor
    func testMovedDecodesThePreparingSandbox() async throws {
        let body = Data(
            #"{"enabled":true,"provider":"daytona","workspace":"volume","status":"gone","lifecycle":"preparing","materialized":false}"#.utf8
        )
        let outcome = try await OS1API.sandboxAttachOutcome(status: 200, data: body)
        guard case .moved(let status) = outcome else {
            return XCTFail("expected moved, got \(outcome)")
        }
        XCTAssertEqual(status.provider, "daytona")
        XCTAssertEqual(status.lifecycle, "preparing")
        XCTAssertNil(status.sandboxId)
    }

    @MainActor
    func testRefusalSurfacesTheServersMessage() async {
        let body = Data(#"{"error":"Wait for the agent to finish before moving this session."}"#.utf8)
        do {
            _ = try await OS1API.sandboxAttachOutcome(status: 409, data: body)
            XCTFail("expected a thrown refusal")
        } catch {
            XCTAssertEqual(
                error.localizedDescription,
                "Wait for the agent to finish before moving this session."
            )
        }
    }
}
