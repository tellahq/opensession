import XCTest
@testable import OS1

final class RunnerStatusTests: XCTestCase {
    func testInstanceStateMapsToOneVocabulary() {
        XCTAssertEqual(RunnerStatus(state: "online"), .ready)
        XCTAssertEqual(RunnerStatus(state: "busy"), .busy)
        XCTAssertEqual(RunnerStatus(state: "maintenance"), .maintenance)
        XCTAssertEqual(RunnerStatus(state: "offline"), .offline)
    }

    /// A machine the server won't describe is not one to call available.
    func testUnknownInstanceStateIsNotCalledReady() {
        XCTAssertEqual(RunnerStatus(state: nil), .offline)
        XCTAssertEqual(RunnerStatus(state: "something-new"), .offline)
    }

    /// The words a session's Runner card has always shown, now shared with the
    /// settings list. Preparing is the fallback, as on the web badge.
    func testSessionLifecycleKeepsTheShippedLabels() {
        XCTAssertEqual(RunnerStatus(lifecycle: "awake").label, "Ready")
        XCTAssertEqual(RunnerStatus(lifecycle: "offline").label, "Offline")
        XCTAssertEqual(RunnerStatus(lifecycle: "needs_attention").label, "Needs attention")
        XCTAssertEqual(RunnerStatus(lifecycle: "preparing").label, "Preparing")
        XCTAssertEqual(RunnerStatus(lifecycle: nil).label, "Preparing")
        XCTAssertEqual(RunnerStatus(lifecycle: "awake").icon, "checkmark.circle")
        XCTAssertEqual(RunnerStatus(lifecycle: "needs_attention").icon, "exclamationmark.triangle")
    }

    /// A real `GET /api/runners` payload from a live instance.
    func testDecodesInstanceRunnerList() throws {
        let json = """
        {"runners":[
          {"id":"runner-1","name":"runner-ws-test","platform":"linux","arch":"x64",
           "createdAt":"2026-08-13T05:54:49.245Z","capabilities":{"platform":"linux","toolchains":[],"tags":[]},
           "permissions":{"commands":true,"fullSessions":false,"terminals":false,"portals":false},
           "allowedUsers":[],"allowedRepos":["opensession"],"workspaceRoots":["/srv/opensession"],
           "workspaceRetention":"delete","lastSeenAt":"2026-08-13T05:54:49.247Z","state":"offline"},
          {"id":"runner-2","name":"cubes-mac-mini","platform":"darwin","arch":"arm64",
           "label":"Office Mac mini for iOS builds",
           "capabilities":{"platform":"darwin","toolchains":["xcode","swift"],"tags":[]},
           "resources":{"cpuCores":10,"memoryGb":16,"freeDiskGb":47.2,"gpu":{"kind":"apple","model":"Apple M4","metal":false}},
           "workspaceRoots":[],"lastSeenAt":"2026-08-13T15:35:11.067Z","state":"online"}
        ]}
        """
        let response = try JSONDecoder().decode(
            WorkspaceRunnersResponse.self,
            from: Data(json.utf8)
        )
        let runners = try XCTUnwrap(response.runners)
        XCTAssertEqual(runners.count, 2)

        XCTAssertEqual(runners[0].displayName, "runner-ws-test")
        XCTAssertEqual(runners[0].status, .offline)
        XCTAssertEqual(runners[0].workspaceRoots, ["/srv/opensession"])

        // The operator's label wins over the machine's own name.
        XCTAssertEqual(runners[1].displayName, "Office Mac mini for iOS builds")
        XCTAssertEqual(runners[1].status, .ready)
        XCTAssertEqual(runners[1].hardwareSummary, "macOS · arm64 · 10 cores · 16 GB · Apple M4")
        XCTAssertEqual(runners[1].workspaceRoots, [])
    }

    /// Fields the server may add later must not break an older build, and a
    /// machine that reported no hardware gets no half-empty line.
    func testDecodesMinimalRunnerAndIgnoresUnknownFields() throws {
        let runner = try JSONDecoder().decode(
            WorkspaceRunner.self,
            from: Data(#"{"id":"runner-3","name":"box","somethingNew":{"a":1}}"#.utf8)
        )
        XCTAssertEqual(runner.displayName, "box")
        XCTAssertEqual(runner.hardwareSummary, "")
        XCTAssertNil(runner.workloadSummary)
        XCTAssertEqual(runner.status, .offline)
    }

    func testWorkloadPrefersTheOperationOverTheSessionId() throws {
        let runner = try JSONDecoder().decode(
            WorkspaceRunner.self,
            from: Data(#"{"id":"r","name":"n","workload":{"sessionId":"os-1","operation":"xcodebuild"}}"#.utf8)
        )
        XCTAssertEqual(runner.workloadSummary, "xcodebuild")
    }
}
