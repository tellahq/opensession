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

    /// Give a queued write a few turns of the main actor to reach the server.
    private func settle(until done: () -> Bool) async {
        for _ in 0..<20 where !done() { await Task.yield() }
    }

    func testASecondChoiceWaitsForTheFirstWriteAndTheServerEndsOnIt() async {
        let (slow, slowWrite) = gated()
        let first = NativePreferences.setDefaultModel("claude-opus-5", write: slowWrite)
        await Task.yield()
        XCTAssertEqual(slow.sent["default-model"], "claude-opus-5")

        let (next, nextWrite) = gated()
        let second = NativePreferences.setDefaultModel("claude-sonnet-5", write: nextWrite)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-sonnet-5")
        await Task.yield()
        // Queued behind the first: nothing sent until that one answers, so the
        // two cannot reach the server out of order.
        XCTAssertTrue(next.sent.isEmpty)

        // The first write's late answer does not repaint the newer choice.
        slow.release(["default-model": "claude-opus-5", "send-key": "mod-enter"])
        let firstApplied = await first.value
        XCTAssertTrue(firstApplied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-sonnet-5")
        XCTAssertEqual(UserDefaults.standard.string(forKey: markerKey), "mod-enter")

        await settle { !next.sent.isEmpty }
        XCTAssertEqual(next.sent["default-model"], "claude-sonnet-5")
        next.release(["default-model": "claude-sonnet-5", "send-key": "mod-enter"])
        let secondApplied = await second.value
        XCTAssertTrue(secondApplied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-sonnet-5")
    }

    func testThreeChoicesReachTheServerInSelectionOrder() async {
        let (slow, slowWrite) = gated()
        let first = NativePreferences.setDefaultModel("claude-opus-5", write: slowWrite)
        await Task.yield()

        let (middle, middleWrite) = gated()
        let second = NativePreferences.setDefaultModel("claude-sonnet-5", write: middleWrite)
        let (last, lastWrite) = gated()
        let third = NativePreferences.setDefaultModel("claude-haiku-5", write: lastWrite)

        slow.release(["default-model": "claude-opus-5"])
        _ = await first.value
        await settle { !middle.sent.isEmpty }
        XCTAssertEqual(middle.sent["default-model"], "claude-sonnet-5")
        XCTAssertTrue(last.sent.isEmpty)

        middle.release(["default-model": "claude-sonnet-5"])
        let secondApplied = await second.value
        XCTAssertTrue(secondApplied)
        await settle { !last.sent.isEmpty }
        XCTAssertEqual(last.sent["default-model"], "claude-haiku-5")

        last.release(["default-model": "claude-haiku-5"])
        let thirdApplied = await third.value
        XCTAssertTrue(thirdApplied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-haiku-5")
    }

    func testPreferencesPatchAndMenuChoiceShareTheWriteQueue() async {
        let (preferences, preferencesWrite) = gated()
        let first = NativePreferences.writeDefaultModel(
            "claude-sonnet-5",
            prefs: ["default-model": "claude-sonnet-5", "send-key": "mod-enter"],
            write: preferencesWrite
        )
        await Task.yield()
        XCTAssertEqual(preferences.sent["default-model"], "claude-sonnet-5")

        let (menu, menuWrite) = gated()
        let second = NativePreferences.setDefaultModel("claude-opus-5", write: menuWrite)
        await Task.yield()
        XCTAssertTrue(menu.sent.isEmpty)

        preferences.release(["default-model": "claude-sonnet-5", "send-key": "mod-enter"])
        let preferencesResponse = await first.value
        XCTAssertNotNil(preferencesResponse)
        await settle { !menu.sent.isEmpty }
        XCTAssertEqual(menu.sent["default-model"], "claude-opus-5")

        menu.release(["default-model": "claude-opus-5", "send-key": "mod-enter"])
        let menuApplied = await second.value
        XCTAssertTrue(menuApplied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "claude-opus-5")
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
