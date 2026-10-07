import XCTest
@testable import OS1

/// Folders on people's own computers, as the native viewer shows them: wire
/// decoding of the frame and REST body, and the per-session snapshot state.
/// Placeholder people, devices and paths only.
@MainActor
final class LocalFoldersTests: XCTestCase {
    private func parse(_ json: String) -> ServerEvent {
        ServerEvent.parse(Data(json.utf8))
    }

    private func settle() async {
        for _ in 0..<12 { await Task.yield() }
    }

    private static func folder(
        _ key: String,
        name: String = "notes",
        owner: String = "Alex",
        readOnly: Bool = false,
        online: Bool = true
    ) -> LocalFolder {
        LocalFolder(
            key: key, folderId: key, name: name, readOnly: readOnly,
            deviceId: "dev-1", deviceLabel: "Alex's laptop", owner: owner, online: online
        )
    }

    // MARK: - Wire

    func testFrameDecodesEveryFieldAndDropsRowsWithoutAKey() {
        let event = parse(#"""
        {"type":"local_folders","sessionId":"bks-1","folders":[
          {"key":"dev-1:f1","id":"f1","name":"acme-notes","displayPath":"~/acme-notes",
           "readOnly":true,"deviceId":"dev-1","deviceLabel":"Alex's laptop",
           "owner":"Alex","online":false,"futureField":{"x":1}},
          {"id":"f2","name":"no key"},
          "not an object",
          {"key":"dev-1:f3"}
        ]}
        """#)
        guard case .localFolders("bks-1", let folders) = event else {
            return XCTFail("expected local folders, got \(event)")
        }
        XCTAssertEqual(folders.map(\.key), ["dev-1:f1", "dev-1:f3"])
        let first = folders[0]
        XCTAssertEqual(first.folderId, "f1")
        XCTAssertEqual(first.name, "acme-notes")
        XCTAssertEqual(first.displayPath, "~/acme-notes")
        XCTAssertTrue(first.readOnly)
        XCTAssertFalse(first.online)
        XCTAssertEqual(first.owner, "Alex")
        XCTAssertEqual(first.status, "Alex's laptop is offline")
        // A sparse row falls back to safe defaults.
        let sparse = folders[1]
        XCTAssertEqual(sparse.name, "Folder")
        XCTAssertEqual(sparse.deviceLabel, "Another computer")
        XCTAssertNil(sparse.displayPath)
        XCTAssertFalse(sparse.readOnly)
        XCTAssertTrue(sparse.online)
        XCTAssertEqual(sparse.status, "Another computer")
    }

    func testFrameWithoutASessionIsIgnoredAndAnEmptyListClears() {
        guard case .ignored = parse(#"{"type":"local_folders","folders":[]}"#) else {
            return XCTFail("a frame needs a session")
        }
        guard case .localFolders("bks-1", let folders) = parse(
            #"{"type":"local_folders","sessionId":"bks-1"}"#
        ), folders.isEmpty else { return XCTFail("absent folders reads as none") }
    }

    func testRestBodyIsTolerant() throws {
        let body = try JSONDecoder().decode(LocalFoldersResponse.self, from: Data(#"""
        {"folders":[{"key":"k1","name":"a","readOnly":"yes"},{"bad":true}],"extra":1}
        """#.utf8))
        XCTAssertEqual(body.folders.map(\.key), ["k1"])
        XCTAssertFalse(body.folders[0].readOnly, "a mistyped field falls back")
        XCTAssertTrue(try JSONDecoder().decode(LocalFoldersResponse.self, from: Data("{}".utf8)).folders.isEmpty)
    }

    func testStatusAndOwnership() {
        XCTAssertEqual(Self.folder("k", readOnly: true).status, "Read only")
        XCTAssertEqual(Self.folder("k").status, "Alex's laptop")
        XCTAssertEqual(Self.folder("k", readOnly: true, online: false).status, "Alex's laptop is offline")
        let folder = Self.folder("k", owner: "Alex")
        XCTAssertTrue(folder.isOwned(byName: "Alex Example", login: ""))
        XCTAssertTrue(folder.isOwned(byName: "alex", login: ""))
        XCTAssertTrue(Self.folder("k", owner: "alexgh").isOwned(byName: "Someone", login: "AlexGH"))
        XCTAssertFalse(folder.isOwned(byName: "Alexandra", login: ""), "no prefix matching")
        XCTAssertFalse(folder.isOwned(byName: "ios", login: ""))
        XCTAssertFalse(Self.folder("k", owner: "").isOwned(byName: "", login: ""))
        XCTAssertEqual(folder.ownerClaim(name: "Alex Example", login: "aex"), "Alex")
        XCTAssertEqual(Self.folder("k", owner: "alex example").ownerClaim(name: "Alex Example", login: ""), "Alex Example")
        XCTAssertNil(folder.ownerClaim(name: "Sam", login: "sam"))
    }

    // MARK: - State

    private final class FakeClient {
        var lists: [[LocalFolder]] = []
        var pending: [CheckedContinuation<[LocalFolder], Error>] = []
        var holdReads = false
        var reads = 0
        var disconnects: [[String]] = []
        var disconnectError: Error?

        var client: LocalFoldersClient {
            LocalFoldersClient(
                list: { [self] _ in
                    reads += 1
                    if holdReads {
                        return try await withCheckedThrowingContinuation { pending.append($0) }
                    }
                    return lists.isEmpty ? [] : lists.removeFirst()
                },
                disconnect: { [self] sessionId, key, user in
                    disconnects.append([sessionId, key, user])
                    if let disconnectError { throw disconnectError }
                }
            )
        }
    }

    private func makeModel(_ fake: FakeClient, viewer: String = "Alex Example") -> SessionLocalFoldersModel {
        SessionLocalFoldersModel(sessionId: "bks-1", client: fake.client, viewer: { (viewer, "") })
    }

    func testRehydrateReadsAndOnlyThisSessionsFramesApply() async {
        let fake = FakeClient()
        fake.lists = [[Self.folder("k1")]]
        let model = makeModel(fake)
        model.frame(sessionId: "bks-1", folders: [Self.folder("ignored")])
        XCTAssertTrue(model.folders.isEmpty, "inactive models take no frames")

        model.rehydrate()
        await settle()
        XCTAssertEqual(model.folders.map(\.key), ["k1"])

        model.frame(sessionId: "bks-other", folders: [Self.folder("x")])
        XCTAssertEqual(model.folders.map(\.key), ["k1"], "another session's list never lands here")

        model.frame(sessionId: "bks-1", folders: [Self.folder("k2"), Self.folder("k2")])
        XCTAssertEqual(model.folders.map(\.key), ["k2"])

        model.deactivate()
        XCTAssertTrue(model.folders.isEmpty)
    }

    func testAStaleReadNeverReplacesANewerFrame() async {
        let fake = FakeClient()
        fake.holdReads = true
        let model = makeModel(fake)
        model.rehydrate()
        await settle()
        XCTAssertEqual(fake.pending.count, 1)
        model.frame(sessionId: "bks-1", folders: [Self.folder("fresh")])
        fake.pending.removeFirst().resume(returning: [Self.folder("stale")])
        await settle()
        XCTAssertEqual(model.folders.map(\.key), ["fresh"])
    }

    func testReconnectReadsAgainAndLaterReadWins() async {
        let fake = FakeClient()
        fake.holdReads = true
        let model = makeModel(fake)
        model.rehydrate()
        model.rehydrate()
        await settle()
        XCTAssertEqual(fake.pending.count, 2)
        // The newer read answers first; the older one must not overwrite it.
        let older = fake.pending.removeFirst()
        fake.pending.removeFirst().resume(returning: [Self.folder("new", online: false)])
        await settle()
        older.resume(returning: [Self.folder("old")])
        await settle()
        XCTAssertEqual(model.folders.map(\.key), ["new"])
        XCTAssertFalse(model.folders[0].online)
    }

    func testAReadLandingAfterDeactivateIsDropped() async {
        let fake = FakeClient()
        fake.holdReads = true
        let model = makeModel(fake)
        model.rehydrate()
        await settle()
        model.deactivate()
        fake.pending.removeFirst().resume(returning: [Self.folder("late")])
        await settle()
        XCTAssertTrue(model.folders.isEmpty)
    }

    func testOwnerDisconnectsAndTheRowLeaves() async {
        let fake = FakeClient()
        fake.lists = [[Self.folder("k1"), Self.folder("k2", owner: "Sam")]]
        let model = makeModel(fake)
        model.rehydrate()
        await settle()
        XCTAssertTrue(model.canDisconnect(model.folders[0]))
        XCTAssertFalse(model.canDisconnect(model.folders[1]), "only the person who connected it")

        await model.disconnect(model.folders[0])
        // Claims the name form the owner was recorded under.
        XCTAssertEqual(fake.disconnects, [["bks-1", "k1", "Alex"]])
        XCTAssertEqual(model.folders.map(\.key), ["k2"])
        XCTAssertNil(model.error)
        XCTAssertTrue(model.disconnecting.isEmpty)
    }

    func testDeniedDisconnectKeepsTheRowAndShowsTheServersWords() async {
        let fake = FakeClient()
        fake.lists = [[Self.folder("k1")]]
        fake.disconnectError = OS1API.APIError.server(
            "Only the person who connected it can disconnect it"
        )
        let model = makeModel(fake)
        model.rehydrate()
        await settle()
        await model.disconnect(model.folders[0])
        XCTAssertEqual(model.folders.map(\.key), ["k1"])
        XCTAssertEqual(model.error, "Only the person who connected it can disconnect it")
        model.dismissError()
        XCTAssertNil(model.error)
    }

    func testSessionViewModelRoutesFramesAndRehydratesOnHello() async {
        let fake = FakeClient()
        fake.lists = [[Self.folder("k1")]]
        let model = makeModel(fake)
        let viewModel = SessionViewModel(session: Session(id: "bks-1"), localFolders: model)
        viewModel.handle(.hello(bootId: "boot-1"))
        await settle()
        XCTAssertEqual(model.folders.map(\.key), ["k1"])
        XCTAssertEqual(fake.reads, 1)

        viewModel.handle(.localFolders(sessionId: "bks-other", folders: []))
        XCTAssertEqual(model.folders.map(\.key), ["k1"])
        viewModel.handle(.localFolders(sessionId: "bks-1", folders: []))
        XCTAssertTrue(model.folders.isEmpty)

        // A reconnect re-reads, since frames sent meanwhile are gone.
        fake.lists = [[Self.folder("k3")]]
        viewModel.handle(.hello(bootId: "boot-2"))
        await settle()
        XCTAssertEqual(fake.reads, 2)
        XCTAssertEqual(model.folders.map(\.key), ["k3"])
    }
}
