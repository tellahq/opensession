import XCTest
@testable import OS1

/// The session action cards: wire decoding of the frames and REST bodies, and
/// the per-session state that rehydrates, resolves and guards them. Placeholder
/// identities and secrets only.
@MainActor
final class SessionActionCardsTests: XCTestCase {
    private func parse(_ json: String) -> ServerEvent {
        ServerEvent.parse(Data(json.utf8))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func settle() async {
        for _ in 0..<12 { await Task.yield() }
    }

    // MARK: - Frames

    func testCredentialRegistrationFrameSaysWhetherARequestIsPending() {
        let open = parse(#"""
        {"type":"credential_registration_request","sessionId":"bks-1",
         "credentialRequest":{"id":"r1","service":"Acme","host":"api.example.test","owner":"alex","newField":1}}
        """#)
        guard case .credentialRegistrationRequest("bks-1", true) = open else {
            return XCTFail("expected a pending request, got \(open)")
        }
        for json in [
            #"{"type":"credential_registration_request","sessionId":"bks-1","credentialRequest":null}"#,
            #"{"type":"credential_registration_request","sessionId":"bks-1"}"#,
        ] {
            guard case .credentialRegistrationRequest("bks-1", false) = parse(json) else {
                return XCTFail("null or absent retires the card: \(json)")
            }
        }
        guard case .credentialRegistrationResolved("bks-1", "r1") = parse(
            #"{"type":"credential_registration_resolved","sessionId":"bks-1","requestId":"r1","status":"registered"}"#
        ) else { return XCTFail("expected resolved") }
    }

    func testKeychainAndForceMergeFrames() {
        guard case .keychainAsksChanged("bks-1") = parse(
            #"{"type":"keychain_asks_changed","sessionId":"bks-1"}"#
        ) else { return XCTFail("expected keychain change") }
        guard case .forceMergeRequest("bks-1", true) = parse(
            #"{"type":"force_merge_request","sessionId":"bks-1","forceMergeRequest":{"id":"m1"}}"#
        ) else { return XCTFail("expected pending force merge") }
        guard case .forceMergeRequest("bks-1", false) = parse(
            #"{"type":"force_merge_request","sessionId":"bks-1","forceMergeRequest":null}"#
        ) else { return XCTFail("expected retired force merge") }
        guard case .forceMergeResolved("bks-1", "m1") = parse(
            #"{"type":"force_merge_request_resolved","sessionId":"bks-1","requestId":"m1","status":"some_new_status"}"#
        ) else { return XCTFail("an unknown status still resolves") }
    }

    func testFramesWithoutASessionAreIgnored() {
        for type in [
            "credential_registration_request", "keychain_asks_changed",
            "force_merge_request", "script_runs",
        ] {
            guard case .ignored = parse(#"{"type":"\#(type)"}"#) else {
                return XCTFail("\(type) without a session must be ignored")
            }
        }
        guard case .ignored = parse(#"{"type":"credential_registration_resolved","sessionId":"bks-1"}"#) else {
            return XCTFail("a resolution names its request")
        }
    }

    func testScriptRunsFrameDropsOnlyTheMalformedRun() {
        let event = parse(#"""
        {"type":"script_runs","sessionId":"bks-1","runs":[
          {"id":"sr-1","sessionId":"bks-1","title":"Backfill","command":"bun run backfill",
           "state":"running","startedAt":"2026-10-01T10:00:00.000Z","deadline":"2026-10-01T12:00:00.000Z",
           "credentials":[{"grantId":"g1","service":"Acme","calls":40,"denied":2,"maxCalls":100,"env":["X"]}],
           "brandNewField":{"x":1}},
          {"title":"no id"},
          {"id":"sr-2","state":"some_future_state"}
        ]}
        """#)
        guard case .scriptRuns("bks-1", let runs) = event else { return XCTFail("expected runs") }
        XCTAssertEqual(runs.map(\.id), ["sr-1", "sr-2"])
        XCTAssertEqual(runs[0].credentials.first?.calls, 40)
        XCTAssertEqual(runs[0].credentials.first?.denied, 2)
        XCTAssertNotNil(runs[0].startedAt)
        XCTAssertEqual(runs[1].title, "Script")
        XCTAssertEqual(runs[1].outcome.text, "Lost track of it")
    }

    // MARK: - REST bodies

    func testRegistrationResponseDefaultsToNoPermission() throws {
        let body = try decode(CredentialRegistrationResponse.self, #"""
        {"request":{"id":"r1","service":"Acme","kind":"login","loginUrl":"https://example.test/login",
         "username":"tester","allowedMethods":["GET"],"allowedPathPrefixes":["/v1/"],"owner":"alex"}}
        """#)
        XCTAssertEqual(body.pending?.canAnswer, false, "absent canAnswer must never grant it")
        XCTAssertEqual(body.pending?.request.isLogin, true)
        XCTAssertEqual(body.pending?.request.limits, "GET · /v1/")
        XCTAssertNil(try decode(CredentialRegistrationResponse.self, #"{"request":null,"canAnswer":true}"#).pending)
        XCTAssertNil(try decode(CredentialRegistrationResponse.self, "{}").pending)
    }

    func testKeychainAskChoicesPutTheRequestedModeLast() throws {
        let body = try decode(SessionKeychainAsksResponse.self, #"""
        {"asks":[
          {"id":"a1","requestedBy":"alex","purpose":"Read invoices","requestedMode":"standing",
           "credentials":[{"service":"Acme","host":"api.example.test"}],"createdAt":"x"},
          {"id":"a2","requestedMode":"once","credentials":[]},
          {"id":"a3","requestedMode":"run","run":{"command":"bun sync.ts","maxCalls":500},"credentials":[]},
          {"id":"a4","requestedMode":"release","credentials":[{"service":"Portal","kind":"login","username":"tester","loginUrl":"https://example.test"}]},
          {"purpose":"missing id"}
        ]}
        """#)
        XCTAssertEqual(body.asks.map(\.id), ["a1", "a2", "a3", "a4"])
        XCTAssertEqual(body.asks[0].choices.map(\.decision), [.once, .standing])
        XCTAssertEqual(body.asks[1].choices.map(\.decision), [.standing, .once])
        XCTAssertEqual(body.asks[2].choices.map(\.decision), [.run])
        XCTAssertEqual(body.asks[3].choices.map(\.decision), [.release])
        XCTAssertEqual(body.asks[0].askedBy, "Asked by alex for 7 days")
        XCTAssertEqual(body.asks[1].askedBy, "Asked by A session for one call")
        XCTAssertTrue(body.asks[2].summary(agent: "Agent").contains("500 calls"))
    }

    func testForceMergeResponseAndBypassLabels() throws {
        let body = try decode(ForceMergeResponse.self, #"""
        {"request":{"id":"m1","ghRepo":"acme/app","number":12,"title":"Fix","base":"main","head":"fix",
          "headSha":"abc123","method":"squash","reason":"Hotfix","driver":"alex",
          "bypass":[{"kind":"check","name":"ci","state":"failing","required":true},
                    {"kind":"check","name":"lint","state":"pending","required":false},
                    {"kind":"review","detail":"1 approving review required"},
                    {"kind":"future"}]},
         "canConfirm":true}
        """#)
        let pending = try XCTUnwrap(body.pending)
        XCTAssertTrue(pending.canConfirm)
        XCTAssertEqual(pending.request.bypass.map(\.label), [
            "Check ci failing (required)",
            "Check lint still running",
            "1 approving review required",
            "future",
        ])
        XCTAssertEqual(
            try decode(ForceMergeResponse.self, #"{"request":{"id":"m1"}}"#).pending?.canConfirm,
            false
        )
    }

    func testScriptRunOutcomesAndVisibility() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        func run(_ id: String, _ state: String, ended: TimeInterval? = nil, code: Int? = nil) -> ScriptRun {
            ScriptRun(id: id, sessionId: "bks-1", title: id, state: state,
                      startedAt: start.addingTimeInterval(Double(id.count)),
                      endedAt: ended.map { start.addingTimeInterval($0) }, exitCode: code)
        }
        XCTAssertEqual(run("a", "exited", ended: 65, code: 0).outcome.text, "Finished after 1m 4s")
        XCTAssertEqual(run("a", "exited", ended: 5, code: 2).outcome.tone, .bad)
        XCTAssertEqual(run("a", "stopped", ended: 5).outcome.tone, .quiet)

        let runs = [
            run("running", "running"),
            run("old", "exited", ended: 0, code: 0),
            run("recent", "exited", ended: 10 * 60, code: 0),
        ]
        let now = start.addingTimeInterval(20 * 60)
        XCTAssertEqual(ScriptRun.visible(runs, at: now).map(\.id), ["recent", "running"])
        XCTAssertEqual(
            ScriptRun.nextExpiry(runs, after: now),
            start.addingTimeInterval(25 * 60)
        )
    }

    // MARK: - You should know

    func testYouShouldKnowNoteQuotesTitleAndExplanation() {
        let note = YouShouldKnowNote(
            title: "Heads-up \u{00b7} The cache key changed",
            explanation: "Old entries miss.\n\nClear them once."
        )
        XCTAssertEqual(note.tag, "Heads-up")
        XCTAssertEqual(note.line, "The cache key changed")
        XCTAssertEqual(note.chatText, """
        About this note from the side agent:

        > Heads-up \u{00b7} The cache key changed
        >
        > Old entries miss.
        >
        > Clear them once.


        """)
        let bare = YouShouldKnowNote(title: "Just a line", explanation: "")
        XCTAssertEqual(bare.tag, "You should know")
        XCTAssertEqual(bare.chatText, "About this note from the side agent:\n\n> You should know \u{00b7} Just a line\n\n")
    }

    func testAskAboutThisAppendsUnderTheDraft() {
        let viewModel = SessionViewModel(session: Session(id: "bks-1"), actionCards: makeModel(FakeClient()))
        viewModel.draft = "my own words  \n"
        viewModel.appendQuotedDraft("> quote\n\n")
        XCTAssertEqual(viewModel.draft, "my own words\n> quote\n\n")
        XCTAssertEqual(viewModel.composerFocusRequest, 1)

        viewModel.draft = "   "
        viewModel.appendQuotedDraft("> quote\n\n")
        XCTAssertEqual(viewModel.draft, "> quote\n\n")
    }

    func testRememberRollsBackOnFailureAndTurnOffHidesTheControl() async {
        let fake = FakeClient()
        fake.rememberFails = true
        let model = makeModel(fake)
        let note = YouShouldKnowNote(title: "Tag \u{00b7} Line", explanation: "")
        do {
            try await model.rememberYouShouldKnow(note)
            XCTFail("expected the failure to surface")
        } catch {}
        XCTAssertFalse(model.knownYouShouldKnow.contains("Line"))

        fake.rememberFails = false
        try? await model.rememberYouShouldKnow(note)
        try? await model.rememberYouShouldKnow(note)
        XCTAssertEqual(fake.remembered, [["placeholder-user", "Line"]], "remembered once")

        try? await model.turnOffYouShouldKnow()
        XCTAssertTrue(model.youShouldKnowOff)
        XCTAssertEqual(fake.enabledWrites, [false])
    }

    // MARK: - State

    func testRehydrateLoadsEveryCardWithTheServersPermissions() async {
        let fake = FakeClient()
        fake.registration = PendingCredentialRegistration(request: .init(id: "r1", service: "Acme"), canAnswer: false)
        fake.forceMerge = PendingForceMerge(request: Self.mergeRequest("m1"), canConfirm: false)
        fake.asks = [Self.ask("a1")]
        fake.runs = [ScriptRun(id: "sr-1", sessionId: "bks-1", title: "Job", state: "running", startedAt: .now)]
        let model = makeModel(fake)

        model.registrationFrame(pending: true)
        await settle()
        XCTAssertNil(model.registration, "frames before the session is on screen are ignored")

        model.rehydrate()
        await settle()
        XCTAssertEqual(model.registration?.canAnswer, false)
        XCTAssertEqual(model.forceMerge?.canConfirm, false)
        XCTAssertEqual(model.keychainAsks.map(\.id), ["a1"])
        XCTAssertEqual(model.visibleScriptRuns.map(\.id), ["sr-1"])
        XCTAssertTrue(model.hasCards)
        XCTAssertEqual(model.attentionKey, "r1,m1,a1")
    }

    func testReconnectClearsAndRereads() async {
        let fake = FakeClient()
        fake.registration = PendingCredentialRegistration(request: .init(id: "r1", service: "Acme"), canAnswer: true)
        let model = makeModel(fake)
        model.rehydrate()
        await settle()
        XCTAssertEqual(model.registration?.request.id, "r1")

        model.deactivate()
        XCTAssertNil(model.registration)
        XCTAssertFalse(model.hasCards)

        // Settled while the socket was away: the next handshake's read says so.
        fake.registration = nil
        model.rehydrate()
        await settle()
        XCTAssertNil(model.registration)
        XCTAssertEqual(fake.registrationReads, 2)
    }

    func testResolutionClearsOnlyTheMatchingRequestAndBlocksAStaleRead() async {
        let fake = FakeClient()
        fake.registration = PendingCredentialRegistration(request: .init(id: "r1", service: "Acme"), canAnswer: true)
        let model = makeModel(fake)
        model.rehydrate()
        await settle()

        model.registrationResolved(requestId: "other")
        XCTAssertEqual(model.registration?.request.id, "r1")

        // A read that started before the resolution answers with the old
        // request after it: it must not bring the card back.
        fake.holdRegistration = true
        model.registrationFrame(pending: true)
        await settle()
        model.registrationResolved(requestId: "r1")
        XCTAssertNil(model.registration)
        fake.releaseRegistration()
        await settle()
        XCTAssertNil(model.registration)

        // Even a fresh read that still lists the settled request.
        model.registrationFrame(pending: true)
        await settle()
        XCTAssertNil(model.registration)
    }

    func testAScriptFrameBeatsAnOlderListRead() async {
        let fake = FakeClient()
        fake.runs = [ScriptRun(id: "sr-old", sessionId: "bks-1", title: "Old", state: "running", startedAt: .now)]
        fake.holdScripts = true
        let model = makeModel(fake)
        model.rehydrate()
        await settle()
        model.scriptRunsFrame([ScriptRun(id: "sr-new", sessionId: "bks-1", title: "New", state: "running", startedAt: .now)])
        fake.releaseScripts()
        await settle()
        XCTAssertEqual(model.scriptRuns.map(\.id), ["sr-new"])
    }

    func testAnswersSettleTheirCards() async throws {
        let fake = FakeClient()
        fake.registration = PendingCredentialRegistration(request: .init(id: "r1", service: "Acme"), canAnswer: true)
        fake.forceMerge = PendingForceMerge(request: Self.mergeRequest("m1"), canConfirm: true)
        fake.asks = [Self.ask("a1"), Self.ask("a2")]
        fake.mergeOutcome = ForceMergeOutcome(status: "head_changed")
        let model = makeModel(fake)
        model.rehydrate()
        await settle()

        try await model.registerCredential(try XCTUnwrap(model.registration).request, secret: "placeholder-secret")
        XCTAssertEqual(fake.registered, [["bks-1", "r1", "placeholder-secret"]])
        XCTAssertNil(model.registration)

        fake.asks = [Self.ask("a2")]
        try await model.answer(Self.ask("a1"), decision: .standing)
        XCTAssertEqual(fake.answers, [["a1", "standing"]])
        XCTAssertEqual(model.keychainAsks.map(\.id), ["a2"])

        do {
            try await model.confirmForceMerge(Self.mergeRequest("m1"))
            XCTFail("a moved branch is not a merge")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The branch moved since the request, so nothing was merged.")
        }
        XCTAssertNil(model.forceMerge)
        XCTAssertEqual(fake.confirms, [["bks-1", "m1"]])
    }

    func testSessionViewModelRoutesOnlyItsOwnFramesAndRehydratesOnHello() async {
        let fake = FakeClient()
        fake.asks = [Self.ask("a1")]
        let model = makeModel(fake)
        let viewModel = SessionViewModel(session: Session(id: "bks-1"), actionCards: model)

        viewModel.handle(.hello(bootId: "boot-1"))
        await settle()
        XCTAssertEqual(model.keychainAsks.map(\.id), ["a1"])
        XCTAssertEqual(fake.asksReads, 1)

        viewModel.handle(.keychainAsksChanged(sessionId: "bks-other"))
        viewModel.handle(.scriptRuns(sessionId: "bks-other", runs: [
            ScriptRun(id: "sr-x", sessionId: "bks-other", title: "X", state: "running", startedAt: .now),
        ]))
        await settle()
        XCTAssertEqual(fake.asksReads, 1, "another session's frame must not trigger a read")
        XCTAssertTrue(model.scriptRuns.isEmpty)

        viewModel.handle(.keychainAsksChanged(sessionId: "bks-1"))
        await settle()
        XCTAssertEqual(fake.asksReads, 2)
    }

    // MARK: - Fixtures

    private func makeModel(_ fake: FakeClient) -> SessionActionCardsModel {
        SessionActionCardsModel(sessionId: "bks-1", client: fake.client, user: { "placeholder-user" })
    }

    private static func ask(_ id: String) -> SessionKeychainAsk {
        SessionKeychainAsk(id: id, requestedBy: "alex", purpose: "Read", requestedMode: "once",
                           credentials: [.init(service: "Acme", host: "api.example.test")])
    }

    private static func mergeRequest(_ id: String) -> ForceMergeRequest {
        ForceMergeRequest(id: id, ghRepo: "acme/app", number: 12, title: "Fix", base: "main",
                          head: "fix", headSha: "abc123", method: "squash", reason: "Hotfix",
                          bypass: [], driver: "alex")
    }
}

/// A scriptable stand-in for the server. Reads can be held open to order a
/// slow response after a newer frame.
@MainActor
private final class FakeClient {
    var registration: PendingCredentialRegistration?
    var forceMerge: PendingForceMerge?
    var asks: [SessionKeychainAsk] = []
    var runs: [ScriptRun] = []
    var mergeOutcome: ForceMergeOutcome?
    var rememberFails = false

    var holdRegistration = false
    var holdScripts = false
    private var registrationWaiters: [CheckedContinuation<Void, Never>] = []
    private var scriptWaiters: [CheckedContinuation<Void, Never>] = []

    private(set) var registrationReads = 0
    private(set) var asksReads = 0
    private(set) var registered: [[String]] = []
    private(set) var answers: [[String]] = []
    private(set) var confirms: [[String]] = []
    private(set) var remembered: [[String]] = []
    private(set) var enabledWrites: [Bool] = []

    func releaseRegistration() {
        holdRegistration = false
        registrationWaiters.forEach { $0.resume() }
        registrationWaiters = []
    }

    func releaseScripts() {
        holdScripts = false
        scriptWaiters.forEach { $0.resume() }
        scriptWaiters = []
    }

    var client: SessionActionsClient {
        SessionActionsClient(
            registration: { _ in
                self.registrationReads += 1
                let answer = self.registration
                if self.holdRegistration {
                    await withCheckedContinuation { self.registrationWaiters.append($0) }
                }
                return answer
            },
            registerCredential: { sessionId, requestId, secret in
                self.registered.append([sessionId, requestId, secret])
            },
            declineCredential: { _, _ in },
            keychainAsks: { _ in
                self.asksReads += 1
                return self.asks
            },
            answerKeychainAsk: { id, decision in self.answers.append([id, decision.rawValue]) },
            forceMerge: { _ in self.forceMerge },
            confirmForceMerge: { sessionId, requestId in
                self.confirms.append([sessionId, requestId])
                return self.mergeOutcome
            },
            cancelForceMerge: { _, _ in },
            scriptRuns: { _ in
                let answer = self.runs
                if self.holdScripts {
                    await withCheckedContinuation { self.scriptWaiters.append($0) }
                }
                return answer
            },
            scriptOutput: { _, _ in "" },
            stopScript: { _, _ in },
            rememberYouShouldKnow: { user, line in
                if self.rememberFails { throw OS1API.APIError.server("Failed to save") }
                self.remembered.append([user, line])
            },
            setYouShouldKnow: { _, enabled in
                self.enabledWrites.append(enabled)
                return enabled
            }
        )
    }
}
