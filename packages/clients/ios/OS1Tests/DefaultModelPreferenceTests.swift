import XCTest
@testable import OS1

/// The "Set as default" write shared by the new-session picker and the
/// session model menu: optimistic on this device, confirmed through the
/// account's `default-model` ui-pref, and reconciled without clobbering a
/// newer account or a newer local pick.
@MainActor
final class DefaultModelPreferenceTests: XCTestCase {
    private let modelKey = NativePreferences.defaultModelStorageKey
    private let repoKey = "os1.composer.defaultRepo"
    private var savedModel: String?
    private var savedRepo: String?
    private var savedUser = ""
    private var savedLogin = ""

    override func setUp() {
        super.setUp()
        let defaults = UserDefaults.standard
        savedModel = defaults.string(forKey: modelKey)
        savedRepo = defaults.string(forKey: repoKey)
        savedUser = ServerConfig.shared.userName
        savedLogin = ServerConfig.shared.githubLogin
        ServerConfig.shared.userName = "Account A"
        ServerConfig.shared.githubLogin = "account-a"
        defaults.removeObject(forKey: modelKey)
        defaults.set("repo-before", forKey: repoKey)
    }

    override func tearDown() {
        let defaults = UserDefaults.standard
        ServerConfig.shared.userName = savedUser
        ServerConfig.shared.githubLogin = savedLogin
        for (key, value) in [(modelKey, savedModel), (repoKey, savedRepo)] {
            if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
        }
        super.tearDown()
    }

    func testSetAsDefaultWritesTheWebKeyAfterUpdatingThisDevice() async {
        final class Box: @unchecked Sendable {
            var user = ""
            var prefs: [String: String?] = [:]
            var localAtWrite: String?
        }
        let box = Box()

        let applied = await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra") { context, prefs in
            box.user = context.user
            box.prefs = prefs
            box.localAtWrite = UserDefaults.standard.string(forKey: self.modelKey)
            return ["default-model": "pi/openai/gpt-6-astra", "default-repo": "repo-confirmed"]
        }

        XCTAssertTrue(applied)
        XCTAssertEqual(box.user, "Account A")
        XCTAssertEqual(box.prefs, ["default-model": "pi/openai/gpt-6-astra"])
        XCTAssertEqual(box.localAtWrite, "pi/openai/gpt-6-astra", "this device updates before the PUT leaves")
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "pi/openai/gpt-6-astra")
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: repoKey),
            "repo-confirmed",
            "the confirmed map is the whole preference set"
        )
    }

    func testNothingIsWrittenWhenTheModelIsAlreadyTheDefault() async {
        UserDefaults.standard.set("pi/openai/gpt-6-astra", forKey: modelKey)
        var writes = 0

        let applied = await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra") { _, _ in
            writes += 1
            return [:]
        }
        let appliedEmpty = await NativePreferences.setDefaultModel("") { _, _ in
            writes += 1
            return [:]
        }

        XCTAssertFalse(applied)
        XCTAssertFalse(appliedEmpty)
        XCTAssertEqual(writes, 0)
    }

    func testConfirmationForAnotherAccountIsDroppedAndTheActiveAccountRehydrates() async {
        var rehydrated = 0
        let applied = await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra") { _, _ in
            // The account switched while the PUT was out: its answer describes
            // Account A, and Account B's own hydration owns the cache now.
            self.switchToAccountB()
            return ["default-model": "pi/openai/gpt-6-astra", "default-repo": "repo-a"]
        } rehydrate: {
            rehydrated += 1
        }

        XCTAssertFalse(applied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: repoKey), "repo-before")
        XCTAssertEqual(rehydrated, 1, "Account B's hydration skipped during the write, so it runs again now")
    }

    func testAWriteQueuedForASwitchedAccountNeverLeavesAndTheActiveAccountRehydrates() async {
        let wire = Wire()
        var rehydrated = 0

        let first = Task { @MainActor in
            await NativePreferences.setDefaultModel(
                "pi/openai/gpt-5.6-sol",
                write: wire.write(holdingFirst: true)
            ) { rehydrated += 1 }
        }
        await wire.waitUntilHeld()
        let second = Task { @MainActor in
            await NativePreferences.setDefaultModel(
                "pi/openai/gpt-6-astra",
                write: wire.write()
            ) { rehydrated += 1 }
        }
        await wire.settle()
        // Account A's second pick is waiting behind the stalled first write
        // when the user switches to Account B.
        switchToAccountB()
        wire.release?.resume()

        let applied = await [first.value, second.value]

        XCTAssertEqual(applied, [false, false])
        XCTAssertEqual(
            wire.sent,
            ["pi/openai/gpt-5.6-sol"],
            "the queued PUT would carry A's user on B's connection, so it is skipped"
        )
        XCTAssertEqual(rehydrated, 1, "one rehydration, after the last pending write released the guard")
    }

    private func switchToAccountB() {
        ServerConfig.shared.userName = "Account B"
        ServerConfig.shared.githubLogin = "account-b"
    }

    /// A PUT that stalls until the test releases it, recording every write's
    /// model so the order the server would see them in can be asserted.
    @MainActor
    private final class Wire {
        var sent: [String] = []
        var release: CheckedContinuation<Void, Never>?

        func write(holdingFirst: Bool = false) -> (NativePreferences.Context, [String: String?]) async throws -> [String: String] {
            { [self] _, prefs in
                let model = prefs["default-model"].flatMap { $0 } ?? ""
                let isFirst = sent.isEmpty
                sent.append(model)
                if holdingFirst, isFirst {
                    await withCheckedContinuation { release = $0 }
                }
                return ["default-model": model]
            }
        }

        func waitUntilHeld() async {
            while release == nil { await Task.yield() }
        }

        func settle() async {
            for _ in 0..<50 { await Task.yield() }
        }
    }

    func testANewerPickWaitsForTheOlderWriteAndReachesTheServerLast() async {
        let wire = Wire()

        let first = Task { @MainActor in
            await NativePreferences.setDefaultModel("pi/openai/gpt-5.6-sol", write: wire.write(holdingFirst: true))
        }
        await wire.waitUntilHeld()
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "pi/openai/gpt-5.6-sol")

        let second = Task { @MainActor in
            await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra", write: wire.write())
        }
        await wire.settle()
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: modelKey),
            "pi/openai/gpt-6-astra",
            "this device shows the newer pick right away"
        )
        XCTAssertEqual(wire.sent, ["pi/openai/gpt-5.6-sol"], "the second PUT waits behind the first")

        wire.release?.resume()
        let firstApplied = await first.value
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: modelKey),
            "pi/openai/gpt-6-astra",
            "the older confirmation does not flip this device back"
        )
        let secondApplied = await second.value

        XCTAssertTrue(firstApplied, "the late answer still carries the rest of the map")
        XCTAssertTrue(secondApplied)
        XCTAssertEqual(
            wire.sent,
            ["pi/openai/gpt-5.6-sol", "pi/openai/gpt-6-astra"],
            "the server sees the newer pick last, so its last-write merge keeps it"
        )
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "pi/openai/gpt-6-astra")
    }

    func testAQueuedPickThatWasAlreadyReplacedNeverReachesTheServer() async {
        let wire = Wire()

        let first = Task { @MainActor in
            await NativePreferences.setDefaultModel("pi/openai/gpt-5.6-sol", write: wire.write(holdingFirst: true))
        }
        await wire.waitUntilHeld()
        let second = Task { @MainActor in
            await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra", write: wire.write())
        }
        let third = Task { @MainActor in
            await NativePreferences.setDefaultModel("pi/anthropic/claude-nova-6", write: wire.write())
        }
        await wire.settle()
        wire.release?.resume()

        let applied = await [first.value, second.value, third.value]

        XCTAssertEqual(applied, [true, false, true], "the replaced middle pick is skipped, not sent")
        XCTAssertEqual(wire.sent, ["pi/openai/gpt-5.6-sol", "pi/anthropic/claude-nova-6"])
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "pi/anthropic/claude-nova-6")
    }
}
