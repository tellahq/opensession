import XCTest
@testable import OS1

/// The one "Set as default" write both model menus share: the conversation's
/// and the New session composer's. It updates this device first, then the
/// account's `default-model` ui-pref, and reconciles what the server sends
/// back without stepping on a newer choice or another account.
@MainActor
final class DefaultModelPreferenceTests: XCTestCase {
    private let modelKey = NativePreferences.defaultModelStorageKey
    private let markerKey = "os1.composer.sendKey"
    private var savedModel: String?
    private var savedMarker: String?
    private var savedUserName = ""

    /// A write the test releases by hand, so a confirmation can land after
    /// the world moved on.
    private final class Gate {
        var continuation: CheckedContinuation<[String: String], Error>?
        var sent: [String: String?] = [:]
        func release(_ prefs: [String: String]) { continuation?.resume(returning: prefs) }
        func fail() {
            continuation?.resume(throwing: URLError(.notConnectedToInternet))
        }
    }

    private func gated() -> (Gate, NativePreferences.UiPrefsWrite) {
        let gate = Gate()
        let write: NativePreferences.UiPrefsWrite = { _, prefs in
            gate.sent = prefs
            return try await withCheckedThrowingContinuation { gate.continuation = $0 }
        }
        return (gate, write)
    }

    override func setUp() {
        let defaults = UserDefaults.standard
        savedModel = defaults.string(forKey: modelKey)
        savedMarker = defaults.string(forKey: markerKey)
        savedUserName = ServerConfig.shared.userName
        ServerConfig.shared.userName = "Tester"
        defaults.set("", forKey: modelKey)
        defaults.set("enter", forKey: markerKey)
        // Pin the identity so the first apply below is not a "new account"
        // reset that would blank the key under test.
        _ = NativePreferences.apply([:], for: NativePreferences.context())
    }

    override func tearDown() {
        let defaults = UserDefaults.standard
        for (key, value) in [(modelKey, savedModel), (markerKey, savedMarker)] {
            if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
        }
        ServerConfig.shared.userName = savedUserName
    }

    func testSetUpdatesThisDeviceFirstThenWritesTheAccountPref() async {
        let (gate, write) = gated()

        let task = NativePreferences.setDefaultModel("claude-opus-5", write: write)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-opus-5")

        await Task.yield()
        XCTAssertEqual(gate.sent["default-model"], "claude-opus-5")
        gate.release(["default-model": "claude-opus-5", "send-key": "mod-enter"])

        let applied = await task.value
        XCTAssertTrue(applied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-opus-5")
        // The rest of the confirmed map lands too: it is the whole account map.
        XCTAssertEqual(UserDefaults.standard.string(forKey: markerKey), "mod-enter")
    }

    func testConfirmationWithoutTheKeyKeepsTheChoice() async {
        let task = NativePreferences.setDefaultModel("claude-sonnet-5") { _, _ in [:] }
        let applied = await task.value
        XCTAssertTrue(applied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-sonnet-5")
    }

    func testFailedWriteLeavesTheOptimisticChoiceAlone() async {
        let (gate, write) = gated()
        let task = NativePreferences.setDefaultModel("claude-opus-5", write: write)
        await Task.yield()
        gate.fail()

        let applied = await task.value
        XCTAssertFalse(applied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-opus-5")
        XCTAssertEqual(UserDefaults.standard.string(forKey: markerKey), "enter")
    }

    func testLateConfirmationDoesNotRepaintANewerChoice() async {
        let (slow, slowWrite) = gated()
        let first = NativePreferences.setDefaultModel("claude-opus-5", write: slowWrite)
        await Task.yield()

        let second = NativePreferences.setDefaultModel("claude-sonnet-5") { _, prefs in
            let sent = prefs["default-model"].flatMap { $0 } ?? ""
            return ["default-model": sent]
        }
        let secondApplied = await second.value
        XCTAssertTrue(secondApplied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-sonnet-5")

        // The first write's answer arrives after the second already landed.
        slow.release(["default-model": "claude-opus-5", "send-key": "mod-enter"])
        let firstApplied = await first.value
        XCTAssertTrue(firstApplied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-sonnet-5")
        XCTAssertEqual(UserDefaults.standard.string(forKey: markerKey), "mod-enter")
    }

    func testConfirmationForAnotherAccountIsDropped() async {
        let (gate, write) = gated()
        let task = NativePreferences.setDefaultModel("claude-opus-5", write: write)
        await Task.yield()

        ServerConfig.shared.userName = "Someone Else"
        gate.release(["default-model": "claude-opus-5", "send-key": "mod-enter"])

        let applied = await task.value
        XCTAssertFalse(applied)
        // Nothing from the old account's map reaches the new one; its own
        // hydrate decides what this device shows next.
        XCTAssertEqual(UserDefaults.standard.string(forKey: markerKey), "enter")
    }

    // MARK: Reset

    private func catalog(_ json: String) throws -> ModelCatalog {
        try JSONDecoder().decode(ModelCatalog.self, from: Data(json.utf8))
    }

    func testResetLandsOnTheWorkspaceDefaultAtItsOwnEffort() throws {
        let catalog = try catalog(
            """
            {"models":[
              {"id":"claude-opus-5","efforts":["low","medium","high"]},
              {"id":"gpt-6-astra","efforts":["xhigh"]}
            ],"default":"claude-opus-5"}
            """
        )
        let selection = NewSessionView.defaultSelection(in: catalog)
        XCTAssertEqual(selection.model, "claude-opus-5")
        XCTAssertEqual(selection.effort, "high")
    }

    func testResetEffortFollowsTheDefaultModelNotTheCurrentOne() throws {
        let catalog = try catalog(
            """
            {"models":[
              {"id":"gpt-6-astra","efforts":["medium","xhigh"]},
              {"id":"dial/opus-fable","group":"dial"}
            ],"default":"gpt-6-astra"}
            """
        )
        XCTAssertEqual(NewSessionView.defaultSelection(in: catalog).effort, "medium")

        let preset = try self.catalog(
            """
            {"models":[{"id":"dial/opus-fable","group":"dial"}],"default":"dial/opus-fable"}
            """
        )
        let selection = NewSessionView.defaultSelection(in: preset)
        XCTAssertEqual(selection.model, "dial/opus-fable")
        XCTAssertEqual(selection.effort, "")
    }
}
