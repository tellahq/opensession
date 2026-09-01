import XCTest
@testable import OS1

final class SandboxOfferingTests: XCTestCase {
    private func status(_ json: String) throws -> InstanceSandboxStatus {
        try JSONDecoder().decode(InstanceSandboxStatus.self, from: Data(json.utf8))
    }

    /// The live instance: five connections, of which two are ready. The
    /// configured-provider list is deliberately ignored once connections
    /// exist — docker is configured and certified there, but its connection
    /// needs attention, so a session cannot start in it.
    func testReadyConnectionsWinOverConfiguredProviders() throws {
        let payload = try status("""
        {"enabled":true,"defaultProvider":"docker","killSwitch":false,
         "providers":[{"id":"docker","configured":true,"certified":true},
                      {"id":"daytona","configured":true,"certified":true},
                      {"id":"e2b","configured":false,"certified":false}],
         "connections":[{"provider":"docker","state":"needs_attention"},
                        {"provider":"daytona","state":"ready"},
                        {"provider":"box","state":"ready"},
                        {"provider":"modal","state":"not_configured"},
                        {"provider":"legacy","state":"disabled"}]}
        """)
        XCTAssertEqual(SandboxOffering.choices(payload), ["daytona", "box"])
    }

    func testFallsBackToConfiguredProvidersWithoutConnections() throws {
        let payload = try status("""
        {"enabled":true,"killSwitch":false,
         "providers":[{"id":"docker","configured":true,"certified":true},
                      {"id":"box","configured":true,"certified":false},
                      {"id":"modal","configured":false,"certified":true}],
         "connections":[]}
        """)
        XCTAssertEqual(SandboxOffering.choices(payload), ["docker"])
    }

    /// The case the chip must disappear for: an instance that only runs on the
    /// host. A picker whose only entry is "This machine" is not a choice.
    func testNoChoicesWhenNothingButTheHostIsOffered() throws {
        XCTAssertTrue(SandboxOffering.choices(nil).isEmpty)
        XCTAssertTrue(try SandboxOffering.choices(status(#"{"enabled":false}"#)).isEmpty)
        XCTAssertTrue(try SandboxOffering.choices(
            status(#"{"enabled":true,"killSwitch":true,"providers":[{"id":"docker","configured":true,"certified":true}]}"#)
        ).isEmpty)
        XCTAssertTrue(try SandboxOffering.choices(
            status(#"{"enabled":true,"providers":[{"id":"docker","configured":false,"certified":true}],"connections":[]}"#)
        ).isEmpty)
        XCTAssertTrue(try SandboxOffering.choices(
            status(#"{"enabled":true,"connections":[{"provider":"daytona","state":"disabled"}]}"#)
        ).isEmpty)
    }

    func testLabelsMatchTheServersOwnNames() {
        XCTAssertEqual(SandboxOffering.label(SandboxOffering.host), "This machine")
        XCTAssertEqual(SandboxOffering.label("daytona"), "Daytona")
        XCTAssertEqual(SandboxOffering.label("e2b"), "E2B")
        XCTAssertEqual(SandboxOffering.label("lambda-microvm"), "AWS Lambda MicroVM")
        // An id this build has never heard of still reads as something.
        XCTAssertEqual(SandboxOffering.label("nitro"), "nitro")
    }

    /// The host is sent explicitly, or the instance's own default would decide
    /// while the chip claimed otherwise.
    func testHostIsSentAsAnExplicitChoice() {
        XCTAssertEqual(SandboxOffering.createValue(SandboxOffering.host), "local")
        XCTAssertEqual(SandboxOffering.createValue("daytona"), "daytona")
    }

    func testDuplicateReadyConnectionsAreListedOnce() throws {
        let payload = try status("""
        {"enabled":true,"connections":[{"provider":"daytona","state":"ready"},
                                       {"provider":"daytona","state":"ready"}]}
        """)
        XCTAssertEqual(SandboxOffering.choices(payload), ["daytona"])
    }
}
