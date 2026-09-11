import XCTest
@testable import OS1

/// The Sandbox session actions the web shipped after creation and lifecycle:
/// moving a host session into a Sandbox (with the server's 428 warning) and
/// opening the Sandbox desktop through a one-viewer bearer link.
final class SessionSandboxTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func status(_ json: String) throws -> SessionSandboxStatus {
        try JSONDecoder().decode(SessionSandboxStatus.self, from: Data(json.utf8))
    }

    // MARK: Wire models

    func testSandboxStatusDecodesCanDesktop() throws {
        let awake = try status(
            #"{"enabled":true,"provider":"daytona","sandboxId":"sb-1","status":"running","lifecycle":"awake","canPause":true,"canResume":false,"canDesktop":true}"#
        )
        XCTAssertEqual(awake.canDesktop, true)
        XCTAssertEqual(awake.lifecycle, "awake")

        // A server that predates the field: the button simply stays away.
        let older = try status(#"{"enabled":true,"provider":"box","status":"running"}"#)
        XCTAssertNil(older.canDesktop)
    }

    func testDesktopLinkDecodesWithAndWithoutExpiry() throws {
        let bounded = try JSONDecoder().decode(
            SandboxDesktopLink.self,
            from: Data(#"{"url":"https://desktop.example/view?token=abc","expiresAt":1757500000000}"#.utf8)
        )
        XCTAssertEqual(bounded.webURL?.host, "desktop.example")
        XCTAssertEqual(bounded.expiresAt, 1_757_500_000_000)

        let open = try JSONDecoder().decode(
            SandboxDesktopLink.self,
            from: Data(#"{"url":"https://box.example/desktop/xyz"}"#.utf8)
        )
        XCTAssertNil(open.expiresAt)
        XCTAssertEqual(open.webURL?.absoluteString, "https://box.example/desktop/xyz")
    }

    /// The link is a bearer secret. Only a web URL is handed to the browser
    /// presentation, and nothing that prints the value can leak it.
    func testDesktopLinkIsOpenedOnlyAsWebAndNeverDescribed() {
        XCTAssertNil(SandboxDesktopLink(url: "vnc://sandbox:5900?token=abc", expiresAt: nil).webURL)
        XCTAssertNil(SandboxDesktopLink(url: "", expiresAt: nil).webURL)
        XCTAssertNil(SandboxDesktopLink(url: "not a url", expiresAt: nil).webURL)
        XCTAssertNotNil(SandboxDesktopLink(url: "http://10.0.0.5:6080/vnc.html?token=abc", expiresAt: nil).webURL)

        let link = SandboxDesktopLink(url: "https://desktop.example/view?token=secret", expiresAt: nil)
        XCTAssertFalse(link.description.contains("secret"))
        XCTAssertFalse("\(link)".contains("secret"))
    }

    // MARK: Eligibility

    func testHostCodeSessionWithRepoCanMove() throws {
        let host = try session(#"{"id":"s1","mode":"code","repo":"tella/opensession"}"#)
        XCTAssertTrue(SandboxMove.canMove(host))

        // A record that spells the host out as the `local` provider.
        let local = try session(
            #"{"id":"s2","mode":"code","repo":"tella/opensession","sandbox":{"provider":"local"}}"#
        )
        XCTAssertTrue(SandboxMove.canMove(local))
    }

    func testSessionsThatCannotMove() throws {
        let cases: [(String, String)] = [
            ("ask mode", #"{"id":"s","mode":"ask","repo":"tella/opensession"}"#),
            ("no mode", #"{"id":"s","repo":"tella/opensession"}"#),
            ("no repo", #"{"id":"s","mode":"code"}"#),
            ("empty repo", #"{"id":"s","mode":"code","repo":""}"#),
            ("automation flag", #"{"id":"s","mode":"code","repo":"r","automation":true}"#),
            ("automation name", #"{"id":"s","mode":"code","repo":"r","automation":"triage"}"#),
            (
                "runner",
                #"{"id":"s","mode":"code","repo":"r","runner":{"id":"rn-1","name":"studio","workspacePath":"/w"}}"#
            ),
            (
                "already in a Sandbox",
                #"{"id":"s","mode":"code","repo":"r","sandbox":{"provider":"daytona","sandboxId":"sb-1"}}"#
            ),
            (
                "move already recorded",
                #"{"id":"s","mode":"code","repo":"r","sandbox":{"provider":"box","lifecycle":"preparing"}}"#
            ),
        ]
        for (label, json) in cases {
            XCTAssertFalse(SandboxMove.canMove(try session(json)), label)
        }
    }

    func testMoveTargetsAreTheReadyProviders() throws {
        let payload = try JSONDecoder().decode(
            InstanceSandboxStatus.self,
            from: Data("""
            {"enabled":true,"killSwitch":false,
             "providers":[{"id":"daytona","configured":true,"certified":true}],
             "connections":[{"provider":"daytona","state":"ready"},
                            {"provider":"box","state":"ready"},
                            {"provider":"docker","state":"needs_attention"}]}
            """.utf8)
        )
        XCTAssertEqual(SandboxMove.providers(payload), ["daytona", "box"])
        XCTAssertEqual(SandboxMove.providers(nil), [])
        XCTAssertEqual(SandboxMove.label("daytona"), "Daytona")
        XCTAssertEqual(SandboxMove.label("box"), "Box")
    }

    // MARK: The 428 confirmation

    func testMutationErrorsKeepTheConfirmMeaningOf428() {
        let warning = Data(
            #"{"error":"This branch has 2 unpushed commits and 3 uncommitted files.","confirmRequired":true}"#.utf8
        )
        guard case .confirmRequired(let message) = OS1API.responseError(status: 428, body: warning) else {
            return XCTFail("428 must surface as confirmRequired")
        }
        XCTAssertEqual(message, "This branch has 2 unpushed commits and 3 uncommitted files.")

        guard case .server(let refusal) = OS1API.responseError(
            status: 409, body: Data(#"{"error":"Wait for the agent to finish before moving this session."}"#.utf8)
        ) else {
            return XCTFail("a server sentence stays a server error")
        }
        XCTAssertEqual(refusal, "Wait for the agent to finish before moving this session.")

        guard case .http(500) = OS1API.responseError(status: 500, body: Data()) else {
            return XCTFail("no body falls back to the status")
        }
        // A 428 without a sentence still asks, with the generic line.
        guard case .confirmRequired = OS1API.responseError(status: 428, body: Data("nope".utf8)) else {
            return XCTFail("428 without a body is still a confirm")
        }
    }

    func testUnconfirmedAttemptSurfacesTheWarningOnce() async throws {
        let moved = try status(#"{"enabled":true,"provider":"daytona","lifecycle":"preparing"}"#)
        var sentConfirms: [Bool] = []

        // First attempt: the server wants a person to accept the loss.
        let first = await SandboxMove.attempt(confirmed: false) { confirm in
            sentConfirms.append(confirm)
            throw OS1API.APIError.confirmRequired("Unpushed commits would stay here.")
        }
        XCTAssertEqual(first, .needsConfirmation("Unpushed commits would stay here."))

        // The confirmed retry carries `confirm` and moves.
        let second = await SandboxMove.attempt(confirmed: true) { confirm in
            sentConfirms.append(confirm)
            return moved
        }
        XCTAssertEqual(second, .moved(moved))
        XCTAssertEqual(sentConfirms, [false, true])
    }

    func testConfirmedRetryNeverAsksAgain() async {
        let outcome = await SandboxMove.attempt(confirmed: true) { _ in
            throw OS1API.APIError.confirmRequired("Still unpushed.")
        }
        XCTAssertEqual(outcome, .failed("Still unpushed."))
    }

    func testOtherErrorsFailWithTheServersSentence() async {
        let refused = await SandboxMove.attempt(confirmed: false) { _ in
            throw OS1API.APIError.server("Only code sessions with a repository can move to a Sandbox.")
        }
        XCTAssertEqual(
            refused, .failed("Only code sessions with a repository can move to a Sandbox.")
        )

        let plain = await SandboxMove.attempt(confirmed: false) { _ in
            throw OS1API.APIError.http(503)
        }
        XCTAssertEqual(plain, .failed("Server returned HTTP 503."))
    }

    func testNoConfirmOnTheSuccessfulFirstAttempt() async throws {
        let moved = try status(#"{"enabled":true,"provider":"box","lifecycle":"preparing","workspace":"volume"}"#)
        var sentConfirms: [Bool] = []
        let outcome = await SandboxMove.attempt(confirmed: false) { confirm in
            sentConfirms.append(confirm)
            return moved
        }
        XCTAssertEqual(outcome, .moved(moved))
        XCTAssertEqual(sentConfirms, [false])
    }
}
