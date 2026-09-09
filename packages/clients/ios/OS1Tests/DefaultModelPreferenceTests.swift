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

    func testConfirmationForAnotherAccountIsDropped() async {
        let applied = await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra") { _, _ in
            // The account switched while the PUT was out: its answer describes
            // Account A, and Account B's own hydration owns the cache now.
            ServerConfig.shared.userName = "Account B"
            ServerConfig.shared.githubLogin = "account-b"
            return ["default-model": "pi/openai/gpt-6-astra", "default-repo": "repo-a"]
        }

        XCTAssertFalse(applied)
        XCTAssertEqual(UserDefaults.standard.string(forKey: repoKey), "repo-before")
    }

    func testNewerLocalPickOutlivesAnOlderConfirmation() async {
        final class Gate: @unchecked Sendable { var release: CheckedContinuation<Void, Never>? }
        let gate = Gate()

        let first = Task { @MainActor in
            await NativePreferences.setDefaultModel("pi/openai/gpt-5.6-sol") { _, _ in
                await withCheckedContinuation { gate.release = $0 }
                return ["default-model": "pi/openai/gpt-5.6-sol"]
            }
        }
        while gate.release == nil { await Task.yield() }
        XCTAssertEqual(UserDefaults.standard.string(forKey: modelKey), "pi/openai/gpt-5.6-sol")

        let second = await NativePreferences.setDefaultModel("pi/openai/gpt-6-astra") { _, prefs in
            var confirmed: [String: String] = [:]
            for (key, value) in prefs { confirmed[key] = value }
            return confirmed
        }
        XCTAssertTrue(second)

        gate.release?.resume()
        let firstApplied = await first.value

        XCTAssertTrue(firstApplied, "the late answer still carries the rest of the map")
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: modelKey),
            "pi/openai/gpt-6-astra",
            "the pick made while the first write was out is the one that stays"
        )
    }
}
