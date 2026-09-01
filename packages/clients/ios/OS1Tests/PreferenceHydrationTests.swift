import XCTest
@testable import OS1

@MainActor
final class PreferenceHydrationTests: XCTestCase {
    func testDefaultRepositoryPreferenceNormalizesRetiredAuto() {
        XCTAssertNil(NativePreferences.normalizedDefaultRepository(nil))
        XCTAssertEqual(NativePreferences.normalizedDefaultRepository(""), "")
        XCTAssertEqual(NativePreferences.normalizedDefaultRepository("auto"), "")
        XCTAssertEqual(NativePreferences.normalizedDefaultRepository("repo-docs"), "repo-docs")
    }

    func testSessionCheckoutMapKeepsOnlyValidRepositoryChoices() {
        let raw = """
        {"docs":"worktree","app":"checkout","future":"remote","blank":"","": "checkout"}
        """

        let normalized = NativePreferences.validatedSessionCheckouts(raw)
        XCTAssertEqual(normalized, "{\"app\":\"checkout\",\"docs\":\"worktree\"}")
        XCTAssertEqual(
            NativePreferences.sessionCheckoutMode(for: "app", in: normalized),
            "checkout"
        )
        XCTAssertEqual(
            NativePreferences.sessionCheckoutMode(for: "docs", in: normalized),
            "worktree"
        )
        XCTAssertEqual(
            NativePreferences.sessionCheckoutMode(for: "future", in: normalized),
            "default"
        )
    }

    func testSessionCheckoutMapUsesTheAllRepositoriesDefault() {
        let raw = """
        {"*":"worktree","app":"checkout"}
        """

        XCTAssertEqual(
            NativePreferences.sessionCheckoutMode(for: "app", in: raw),
            "checkout"
        )
        XCTAssertEqual(
            NativePreferences.sessionCheckoutMode(for: "docs", in: raw),
            "worktree"
        )
    }

    func testMalformedSessionCheckoutMapSafelyUsesDefault() {
        for raw in [nil, "not json", "[]", "null"] as [String?] {
            XCTAssertEqual(
                NativePreferences.sessionCheckoutMode(for: "app", in: raw),
                "default"
            )
        }
    }

    func testSettingSessionCheckoutMatchesWebMapShape() {
        var raw = NativePreferences.settingSessionCheckout(
            "worktree",
            for: "docs",
            in: nil
        )
        raw = NativePreferences.settingSessionCheckout("checkout", for: "app", in: raw)
        XCTAssertEqual(raw, "{\"app\":\"checkout\",\"docs\":\"worktree\"}")
        XCTAssertEqual(
            NativePreferences.settingSessionCheckout("default", for: "docs", in: raw),
            "{\"app\":\"checkout\"}"
        )
        XCTAssertEqual(
            NativePreferences.settingSessionCheckout(
                "worktree",
                for: "docs",
                in: "{\"*\":\"worktree\"}"
            ),
            "{\"*\":\"worktree\"}"
        )
    }

    func testReplySuggestionsPreferenceUsesWebValues() {
        XCTAssertEqual(NativePreferences.replySuggestionsEnabled("on"), true)
        XCTAssertEqual(NativePreferences.replySuggestionsEnabled("off"), false)
        XCTAssertNil(NativePreferences.replySuggestionsEnabled(nil))
        XCTAssertNil(NativePreferences.replySuggestionsEnabled("future-value"))
    }

    func testNextChatButtonPreferenceUsesWebValues() {
        XCTAssertEqual(NativePreferences.nextChatButtonEnabled("on"), true)
        XCTAssertEqual(NativePreferences.nextChatButtonEnabled("off"), false)
        XCTAssertNil(NativePreferences.nextChatButtonEnabled(nil))
        XCTAssertNil(NativePreferences.nextChatButtonEnabled("future-value"))
    }

    /// The same "on"/"off" shape the web writes for `live-typing`. An unset
    /// value is nil rather than false, so hydration leaves this device's
    /// cached answer alone instead of snapping it to a choice nobody made.
    func testLiveTypingPreferenceUsesWebValues() {
        XCTAssertEqual(NativePreferences.liveTypingEnabled("on"), true)
        XCTAssertEqual(NativePreferences.liveTypingEnabled("off"), false)
        XCTAssertNil(NativePreferences.liveTypingEnabled(nil))
        XCTAssertNil(NativePreferences.liveTypingEnabled("future-value"))
    }

    /// Default off: an account that has never touched the switch reads the
    /// same on the phone as in the browser.
    func testLiveTypingDefaultsOff() {
        let defaults = UserDefaults.standard
        let key = "os1.transcript.liveTyping"
        let previous = defaults.object(forKey: key) as? Bool
        defer {
            if let previous { defaults.set(previous, forKey: key) }
            else { defaults.removeObject(forKey: key) }
        }

        defaults.removeObject(forKey: key)
        XCTAssertFalse(NativePreferences.liveTypingIsOn)
        defaults.set(true, forKey: key)
        XCTAssertTrue(NativePreferences.liveTypingIsOn)
    }

    func testReadBeforeHydrationWinsOverOlderRemoteMark() {
        let store = ReadsStore()
        let session = Session(
            id: "bks-1",
            lastActivity: "2026-08-11T12:00:00.000Z"
        )

        store.markRead(session)
        store.applyHydrated(
            ["bks-1": "2026-08-11T11:00:00.000Z", "bks-2": "remote"],
            persist: false
        )

        XCTAssertTrue(store.hasHydrated)
        XCTAssertEqual(store.reads["bks-1"], "2026-08-11T12:00:00.000Z")
        XCTAssertEqual(store.reads["bks-2"], "remote")
    }

    func testUnreadIsUnknownUntilReadsHydrate() {
        let store = ReadsStore()
        let session = Session(
            id: "bks-1",
            lastActivity: "2026-08-11T12:00:00.000Z"
        )

        store.markUnread(session)
        XCTAssertFalse(store.isUnread(session))

        store.applyHydrated([:], persist: false)
        XCTAssertTrue(store.isUnread(session))
    }

    func testSpawnedWorkerDoesNotMakeWorkspaceUnread() {
        let store = ReadsStore()
        let parent = Session(id: "parent")
        var worker = Session(id: "worker")
        worker.spawnedBy = parent.id
        worker.lastActivity = "2026-08-11T12:00:00.000Z"

        store.applyHydrated(["worker": "1970-01-01T00:00:00.000Z"], persist: false)

        XCTAssertFalse(store.isUnread([parent, worker]))
    }

    func testPinBeforeHydrationIsReplayedOverRemotePins() {
        let store = PinStore()
        let workspace = SidebarWorkspace(
            id: "session:bks-local",
            title: "Local",
            sessions: [Session(id: "bks-local")],
            mainSession: Session(id: "bks-local")
        )

        store.toggle(workspace)
        store.applyHydrated(["bks-remote"], persist: false)

        XCTAssertTrue(store.hasHydrated)
        XCTAssertEqual(store.pins, ["bks-local", "bks-remote"])
    }

    func testHideBeforeHydrationIsReplayedOverRemoteMap() {
        let store = HideStore()
        let workspace = SidebarWorkspace(
            id: "session:bks-local",
            title: "Local",
            sessions: [Session(id: "bks-local")],
            mainSession: Session(id: "bks-local")
        )

        store.hide(workspace)
        store.applyHydrated(
            ["bks-local": "remote", "bks-remote": "remote"],
            persist: false
        )

        XCTAssertTrue(store.hasHydrated)
        XCTAssertNotEqual(store.hides["bks-local"], "remote")
        XCTAssertEqual(store.hides["bks-remote"], "remote")
    }
}
