import XCTest
@testable import OS1

/// State-machine tests for `SessionViewModel.handle`: the dedupe dance between
/// the ephemeral stream channel (stream_text / stream_tool_*) and the durable
/// transcript channel (transcript_append / resync transcript_init) is where
/// every "text renders twice" bug has lived — each case here pins one of them.
@MainActor
final class SessionViewModelTests: XCTestCase {
    private let serverA = SessionViewModelCache.Scope(serverURL: "server-a", token: "token-a")
    private let serverB = SessionViewModelCache.Scope(serverURL: "server-b", token: "token-b")
    private var savedLiveTyping: Bool?

    override func setUp() {
        super.setUp()
        savedLiveTyping = UserDefaults.standard.object(
            forKey: "os1.transcript.liveTyping"
        ) as? Bool
        UserDefaults.standard.set(true, forKey: "os1.transcript.liveTyping")
    }

    override func tearDown() {
        if let savedLiveTyping {
            UserDefaults.standard.set(savedLiveTyping, forKey: "os1.transcript.liveTyping")
        } else {
            UserDefaults.standard.removeObject(forKey: "os1.transcript.liveTyping")
        }
        super.tearDown()
    }

    private func makeViewModel() -> SessionViewModel {
        SessionViewModel(session: Session(id: "bks-1"))
    }

    func testServerHandoffUsesTheFastReconnectCadence() {
        XCTAssertEqual(SessionViewModel.reconnectDelay, .seconds(2))
        XCTAssertEqual(SessionViewModel.handoffReconnectDelay, .milliseconds(250))
    }

    private func entry(
        _ id: String, _ type: String, text: String? = nil, toolUseId: String? = nil
    ) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text, toolUseId: toolUseId)
    }

    func testSafetyPauseOverridesStaleRunningStateAndCanClear() {
        let safety = SessionSafetyState(
            status: "paused_for_safety",
            explanation: "This session was paused safely.",
            automaticReconciliationRunning: false,
            pausedAt: "2026-08-26T12:00:00Z",
            operation: "finishing the current turn",
            repairAvailable: false
        )
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1", isRunning: true, safety: safety)
        )

        XCTAssertFalse(viewModel.isRunning)
        XCTAssertEqual(viewModel.safety, safety)
        XCTAssertFalse(viewModel.canSend)

        viewModel.handle(.sessionStatus(
            sessionId: "bks-1", isRunning: true, safety: safety
        ))
        XCTAssertFalse(viewModel.isRunning, "safety must win over a stale running bit")

        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        XCTAssertNil(viewModel.safety)
        XCTAssertFalse(viewModel.isRunning)
    }

    func testInlineRunFailureTracksIdleFallbackWithoutDuplicatingStrongerState() {
        let error = Session.RunError(message: "Provider credits exhausted.")
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1", isRunning: false, lastRunError: error)
        )

        XCTAssertEqual(viewModel.inlineRunFailureMessage, "Provider credits exhausted.")

        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        XCTAssertNil(viewModel.inlineRunFailureMessage, "a new run replaces the stale failure")

        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        viewModel.updateSessionSnapshot(Session(id: "bks-1", isRunning: false))
        XCTAssertNil(viewModel.inlineRunFailureMessage, "the fallback clears with the field")

        let safety = SessionSafetyState(status: "paused_for_safety")
        viewModel.updateSessionSnapshot(Session(
            id: "bks-1", isRunning: false, safety: safety, lastRunError: error
        ))
        XCTAssertNil(viewModel.inlineRunFailureMessage, "safety owns its own alert")
    }

    func testInlineRunFailureDoesNotDuplicateDurableTranscriptNotice() {
        let message = "Provider credits exhausted."
        let viewModel = SessionViewModel(
            session: Session(
                id: "bks-1",
                isRunning: false,
                lastRunError: Session.RunError(message: message)
            )
        )

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("failure", "system", text: "⚠ Run failed: \(message)")],
            cursor: .empty
        ))

        XCTAssertNil(viewModel.inlineRunFailureMessage)
    }

    func testPageCacheReusesLoadedConversationAndRefreshesSessionSnapshot() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(for: Session(id: "bks-1", title: "Old"), scope: serverA)
        first.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "assistant", text: "Already loaded")],
            cursor: .empty
        ))

        let reopened = cache.viewModel(
            for: Session(id: "bks-1", title: "Updated"),
            scope: serverA
        )

        XCTAssertTrue(first === reopened)
        XCTAssertFalse(reopened.isLoadingConversation)
        XCTAssertEqual(reopened.entries.map(\.id), ["e1"])
        XCTAssertEqual(reopened.session.title, "Updated")
    }

    func testPageCacheEvictsLeastRecentlyUsedConversation() {
        let cache = SessionViewModelCache(capacity: 2)
        _ = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-2"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-3"), scope: serverA)

        XCTAssertEqual(cache.cachedSessionIds, ["bks-1", "bks-3"])
    }

    func testPageCacheDoesNotCrossServerScope() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        let otherServer = cache.viewModel(for: Session(id: "bks-1"), scope: serverB)

        XCTAssertFalse(first === otherServer)
        XCTAssertEqual(cache.cachedSessionIds, ["bks-1"])
    }

    func testCachedConversationReconcilesOperationalStateWhileStopped() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(
            for: Session(
                id: "bks-1", model: "old", effort: "low",
                fastMode: false, isRunning: true, queuedCount: 2
            ),
            scope: serverA
        )
        first.stop()

        let reopened = cache.viewModel(
            for: Session(
                id: "bks-1", model: "new", effort: "high",
                fastMode: true, isRunning: false, queuedCount: 0
            ),
            scope: serverA
        )

        XCTAssertFalse(reopened.isRunning)
        XCTAssertEqual(reopened.queuedCount, 0)
        XCTAssertEqual(reopened.model, "new")
        XCTAssertEqual(reopened.effort, "high")
        XCTAssertTrue(reopened.fastMode)
    }

    /// A client-side action (promoting to code mode) reads as a transcript
    /// line where it happened, not as a chip over the composer — and it goes
    /// away with the next resync rather than pretending to be durable.
    func testLocalNoticeReadsAsATranscriptLineAndClearsOnResync() {
        let viewModel = makeViewModel()
        let landed = [entry("e1", "assistant", text: "Had a look")]
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1", entries: landed, cursor: .empty
        ))

        viewModel.noteLocally("Switched to code mode")

        XCTAssertNil(viewModel.notice)
        guard case .message(let noticed)? = viewModel.displayBlocks.last else {
            return XCTFail("expected the notice to render as its own block")
        }
        XCTAssertEqual(noticed.notice?.title, "Switched to code mode")
        XCTAssertEqual(noticed.notice?.tone, NoticeTone.info.rawValue)

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1", entries: landed, cursor: .empty
        ))
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1"])
    }

    /// A server notice describes something that happened to the SESSION, so
    /// it joins the transcript in order, wearing its tone — the same place
    /// the web viewer puts these frames. The composer keeps only what is a
    /// word to the person who just tapped.
    func testServerNoticeJoinsTheTranscriptRatherThanTheComposer() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "assistant", text: "Had a look")],
            cursor: .empty
        ))

        viewModel.handle(.notice("App update paused. No action needed."))

        XCTAssertNil(viewModel.notice)
        guard case .message(let noticed)? = viewModel.displayBlocks.last else {
            return XCTFail("expected the notice to render as its own block")
        }
        XCTAssertEqual(noticed.notice?.title, "App update paused. No action needed.")
        XCTAssertEqual(noticed.notice?.tone, NoticeTone.warn.rawValue)
    }

    /// A socket dropping is not an event in the session's history, and it
    /// repeats on every reconnect — so it stays off the transcript.
    func testConnectionChurnStaysOutOfTheTranscript() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "assistant", text: "Had a look")],
            cursor: .empty
        ))

        viewModel.handle(.notice("Couldn't connect to the server"))

        XCTAssertEqual(viewModel.entries.map(\.id), ["e1"])
    }

    func testSlackComposerResolutionClearsTheMatchingRequestAndKeepsItsReceipt() {
        let viewModel = makeViewModel()
        let request = SlackComposeRequest(
            id: "slack-1", message: "Shipped", channel: "shipping", images: []
        )
        let receipt = SlackComposeReceipt(
            requestId: request.id,
            status: .sent,
            channel: .init(id: "C123", name: "shipping"),
            permalink: "https://tella.slack.com/archives/C123/p1700000000000000"
        )
        viewModel.handle(.slackComposer(sessionId: "bks-1", request: request))

        viewModel.handle(.slackComposerResolved(sessionId: "bks-1", receipt: receipt))

        XCTAssertNil(viewModel.pendingSlackComposer)
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)

        // Reconnect snapshots report that nothing is pending. They must not
        // erase the receipt the resolved event just made durable in the page.
        viewModel.handle(.slackComposer(sessionId: "bks-1", request: nil))
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)
    }

    func testNewSlackComposerReplacesAReceiptAndIgnoresAStaleResolution() {
        let viewModel = makeViewModel()
        let oldReceipt = SlackComposeReceipt(
            requestId: "slack-old", status: .cancelled, channel: nil, permalink: nil
        )
        viewModel.handle(.slackComposerResolved(sessionId: "bks-1", receipt: oldReceipt))

        let current = SlackComposeRequest(
            id: "slack-current", message: "Another update", channel: nil, images: []
        )
        viewModel.handle(.slackComposer(sessionId: "bks-1", request: current))
        XCTAssertNil(viewModel.slackComposeReceipt)

        viewModel.handle(.slackComposerResolved(sessionId: "bks-1", receipt: oldReceipt))
        XCTAssertEqual(viewModel.pendingSlackComposer, current)
        XCTAssertNil(viewModel.slackComposeReceipt)
    }

    func testSuccessfulComposerPostCanResolveLocallyBeforeTheSocketEcho() {
        let viewModel = makeViewModel()
        let request = SlackComposeRequest(
            id: "slack-local", message: "Shipped", channel: "shipping", images: []
        )
        let receipt = SlackComposeReceipt(
            requestId: request.id,
            status: .sent,
            channel: .init(id: "C123", name: "shipping"),
            permalink: "https://tella.slack.com/archives/C123/p1700000000000000"
        )
        viewModel.handle(.slackComposer(sessionId: "bks-1", request: request))

        viewModel.resolveSlackComposer(receipt)

        XCTAssertNil(viewModel.pendingSlackComposer)
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)
        // A reconnect snapshot captured before the POST settled must not
        // reopen the same sheet after its local receipt already landed.
        viewModel.handle(.slackComposer(sessionId: "bks-1", request: request))
        XCTAssertNil(viewModel.pendingSlackComposer)
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)
        // The broadcast may arrive after the HTTP response; applying it again
        // is idempotent rather than reviving or clearing anything.
        viewModel.handle(.slackComposerResolved(sessionId: "bks-1", receipt: receipt))
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)
    }

    func testDelayedOlderSlackReceiptCannotOverwriteTheLatestReceipt() {
        let viewModel = makeViewModel()
        let old = SlackComposeReceipt(
            requestId: "slack-old", status: .cancelled, channel: nil, permalink: nil
        )
        let currentRequest = SlackComposeRequest(
            id: "slack-current", message: "Current", channel: nil, images: []
        )
        let current = SlackComposeReceipt(
            requestId: currentRequest.id,
            status: .sent,
            channel: .init(id: "C123", name: "shipping"),
            permalink: "https://tella.slack.com/archives/C123/p1700000000000000"
        )
        viewModel.handle(.slackComposerResolved(sessionId: "bks-1", receipt: old))
        viewModel.handle(.slackComposer(sessionId: "bks-1", request: currentRequest))
        viewModel.resolveSlackComposer(current)

        viewModel.handle(.slackComposerResolved(sessionId: "bks-1", receipt: old))

        XCTAssertNil(viewModel.pendingSlackComposer)
        XCTAssertEqual(viewModel.slackComposeReceipt, current)
    }

    func testSlackReceiptUndoSendsItsTargetOnceAndClearsOnlyAfterSuccess() async {
        var calls: [(session: String, channel: String, ts: String)] = []
        var release: CheckedContinuation<Void, Error>?
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            slackComposerUndoer: { session, channel, ts in
                calls.append((session, channel, ts))
                try await withCheckedThrowingContinuation {
                    release = $0
                }
            }
        )
        let receipt = SlackComposeReceipt(
            requestId: "slack-undo",
            status: .sent,
            channel: .init(id: "C123", name: "shipping"),
            permalink: nil,
            ts: "1700000000.000000"
        )
        viewModel.resolveSlackComposer(receipt)

        let firstTap = Task { await viewModel.undoSlackComposeReceipt() }
        await Task.yield()
        XCTAssertEqual(viewModel.undoingSlackComposeReceiptId, receipt.id)
        XCTAssertEqual(calls.count, 1)

        await viewModel.undoSlackComposeReceipt()
        XCTAssertEqual(calls.count, 1, "a second tap must not issue another delete")
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)

        release?.resume()
        await firstTap.value
        XCTAssertNil(viewModel.slackComposeReceipt)
        XCTAssertNil(viewModel.undoingSlackComposeReceiptId)
        XCTAssertEqual(viewModel.notice, "Removed from Slack")
        XCTAssertEqual(calls.first?.session, "bks-1")
        XCTAssertEqual(calls.first?.channel, "C123")
        XCTAssertEqual(calls.first?.ts, "1700000000.000000")
    }

    func testFailedSlackReceiptUndoKeepsReceiptAndReportsTheError() async {
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            slackComposerUndoer: { _, _, _ in
                throw NSError(
                    domain: "SlackUndoTests",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Slack refused the delete"]
                )
            }
        )
        let receipt = SlackComposeReceipt(
            requestId: "slack-undo",
            status: .sent,
            channel: .init(id: "C123", name: "shipping"),
            permalink: nil,
            ts: "1700000000.000000"
        )
        viewModel.resolveSlackComposer(receipt)

        await viewModel.undoSlackComposeReceipt()

        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)
        XCTAssertNil(viewModel.undoingSlackComposeReceiptId)
        XCTAssertEqual(viewModel.notice, "Slack refused the delete")
    }

    func testSlackReceiptWithoutTimestampCannotBeUndone() async {
        var called = false
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            slackComposerUndoer: { _, _, _ in called = true }
        )
        let receipt = SlackComposeReceipt(
            requestId: "slack-old",
            status: .sent,
            channel: .init(id: "C123", name: "shipping"),
            permalink: nil
        )
        viewModel.resolveSlackComposer(receipt)

        await viewModel.undoSlackComposeReceipt()

        XCTAssertFalse(called)
        XCTAssertEqual(viewModel.slackComposeReceipt, receipt)
    }

    func testResyncDropsCachedPartialPrefixOfOffscreenCompletion() {
        let viewModel = makeViewModel()
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Partial repl", blockId: nil))
        viewModel.stop()
        viewModel.updateSessionSnapshot(Session(id: "bks-1", isRunning: false))

        var snapshot = [entry(
            "e1", "assistant", text: "Partial reply completed off-screen"
        )]
        snapshot += (2...20).map {
            entry("e\($0)", $0.isMultiple(of: 2) ? "user" : "assistant", text: "Later \($0)")
        }

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: snapshot,
            cursor: .empty
        ))

        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.count, 20)
    }

    func testActiveResyncKeepsLiveTextMatchingHistoricalPrefix() {
        let viewModel = makeViewModel()
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "I can help", blockId: nil))

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("old", "assistant", text: "I can help with the old task")],
            cursor: .empty
        ))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))

        XCTAssertEqual(viewModel.liveText, "I can help")
    }

    func testOverlappingViewOwnersKeepSocketAliveUntilLastRelease() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket }
        )
        let outgoing = UUID()
        let incoming = UUID()

        viewModel.start(owner: outgoing)
        viewModel.start(owner: incoming)
        viewModel.stop(owner: outgoing)

        XCTAssertEqual(socket.connectCount, 1)
        XCTAssertEqual(socket.disconnectCount, 0)

        viewModel.stop(owner: incoming)
        XCTAssertEqual(socket.disconnectCount, 1)
    }

    // MARK: - Presence

    /// The pile is other people: our own face carries no information in a
    /// navigation bar, and one person on two devices is still one person.
    func testPresenceDropsUsAndDeduplicatesDevices() {
        let viewModel = makeViewModel()
        // Built around whoever this test host is signed in as, so the
        // "not us" half holds on any machine.
        let me = ServerConfig.shared.userName
        viewModel.handle(.presence(
            sessionId: "bks-1", viewers: ["Zzz Tester", me, "Zzz Tester"]
        ))
        XCTAssertEqual(viewModel.otherViewers, ["Zzz Tester"])

        XCTAssertEqual(
            SessionViewModel.otherViewers(["Michiel", "Kent", "Michiel", "Grant"], me: "michiel"),
            ["Kent", "Grant"]
        )
        // Chat integrations send full names; the first token is the key the
        // server stamps sockets with.
        XCTAssertEqual(
            SessionViewModel.otherViewers(["Kent de Bruin", "kent"], me: "Michiel"),
            ["Kent de Bruin"]
        )
        XCTAssertTrue(SessionViewModel.otherViewers(["Michiel"], me: "Michiel").isEmpty)
    }

    func testTypingDropsUsAndUsesTheGroupCopy() {
        let viewModel = makeViewModel()
        let me = ServerConfig.shared.userName
        viewModel.handle(.typing(
            sessionId: "bks-1", users: [me, "Zzz Tester", "Zzz Tester", "Yyy Tester"]
        ))
        XCTAssertEqual(viewModel.otherTypingUsers, ["Zzz Tester", "Yyy Tester"])
        XCTAssertEqual(SessionViewModel.typingLabel(["Grant"]), "Grant is typing…")
        XCTAssertEqual(
            SessionViewModel.typingLabel(["Grant", "Kent"]),
            "Several people are typing…"
        )

        viewModel.handle(.typing(sessionId: "bks-2", users: ["Ada"]))
        XCTAssertEqual(viewModel.otherTypingUsers, ["Zzz Tester", "Yyy Tester"])
    }

    func testComposerTypingSendsStartAndStop() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))

        viewModel.userIsTyping(true)
        viewModel.userIsTyping(false)
        XCTAssertEqual(socket.typingFrames.map { $0.typing }, [true, false])
        XCTAssertEqual(socket.typingFrames.map { $0.sessionId }, ["bks-1", "bks-1"])
        viewModel.stop()
    }

    func testWorkflowUpdatesAreOwnedByTheMatchingSession() {
        let viewModel = makeViewModel()
        viewModel.handle(.workflowUpdate(
            sessionId: "bks-1",
            run: WorkflowRun(runId: "run-1", name: "Audit", status: .running)
        ))
        XCTAssertEqual(viewModel.workflowRuns.map(\.runId), ["run-1"])
        XCTAssertEqual(viewModel.workflowRuns.first?.status, .running)
        XCTAssertTrue(viewModel.workflowRunsLoaded)

        viewModel.handle(.workflowUpdate(
            sessionId: "bks-1",
            run: WorkflowRun(runId: "run-1", name: "Audit", status: .done)
        ))
        XCTAssertEqual(viewModel.workflowRuns.count, 1)
        XCTAssertEqual(viewModel.workflowRuns.first?.status, .done)

        viewModel.handle(.workflowUpdate(
            sessionId: "bks-2",
            run: WorkflowRun(runId: "run-2", name: "Other")
        ))
        XCTAssertEqual(viewModel.workflowRuns.map(\.runId), ["run-1"])
    }

    func testWorkflowEventWinsAgainstAnOlderRestResponse() async {
        var continuation: CheckedContinuation<[WorkflowRun], any Error>?
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            workflowLoader: { _ in
                try await withCheckedThrowingContinuation { continuation = $0 }
            }
        )
        let loading = Task { await viewModel.refreshWorkflowRuns() }
        while continuation == nil { await Task.yield() }

        viewModel.handle(.workflowUpdate(
            sessionId: "bks-1",
            run: WorkflowRun(runId: "run-1", name: "Audit", status: .done)
        ))
        continuation?.resume(returning: [
            WorkflowRun(runId: "run-1", name: "Audit", status: .running),
            WorkflowRun(runId: "run-older", name: "Older", status: .done),
        ])
        await loading.value

        XCTAssertEqual(viewModel.workflowRuns.map(\.runId), ["run-1", "run-older"])
        XCTAssertEqual(viewModel.workflowRuns.first?.status, .done)
    }

    func testPrRefreshEventsMatchEveryAssociatedBranch() async {
        var requested: [String] = []
        var session = Session(id: "bks-1")
        session.repo = "opensession"
        session.branch = "feature/native"
        session.attachedRepos = [
            AttachedRepo(repo: "tella-fusion", branch: "feature/attached", dir: "/tmp/a")
        ]
        session.prs = [
            SessionPrRef(repo: "gitops", branch: "feature/discovered")
        ]
        let viewModel = SessionViewModel(session: session, prLoader: { id in
            requested.append(id)
            return nil
        })

        viewModel.handle(.prUpdated(repo: "opensession", branch: "other"))
        viewModel.handle(.gitPushed(sessionId: "bks-2", repo: nil))
        await Task.yield()
        XCTAssertTrue(requested.isEmpty)

        for event in [
            ServerEvent.prUpdated(repo: "opensession", branch: "feature/native"),
            .prUpdated(repo: "tella-fusion", branch: "feature/attached"),
            .prUpdated(repo: "gitops", branch: "feature/discovered"),
            .gitPushed(sessionId: "bks-1", repo: "opensession"),
        ] {
            viewModel.handle(event)
            await Task.yield()
        }
        XCTAssertEqual(requested, ["bks-1", "bks-1", "bks-1", "bks-1"])
    }

    /// Presence for another session must not repaint this one's pile.
    func testPresenceForAnotherSessionIsIgnored() {
        let viewModel = makeViewModel()
        viewModel.handle(.presence(sessionId: "bks-2", viewers: ["Kent"]))
        XCTAssertTrue(viewModel.otherViewers.isEmpty)
    }

    /// Backgrounding keeps the watch (unread + notifications depend on it) and
    /// only takes our face off the session; coming back puts it on again.
    func testBackgroundingSendsAwayAndReturningClearsIt() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))

        viewModel.appDidEnterBackground()
        XCTAssertEqual(socket.awayFrames, [true])

        viewModel.appDidBecomeActive()
        XCTAssertEqual(socket.awayFrames, [true, false])
        XCTAssertEqual(socket.disconnectCount, 0, "away must not drop the watch")
        viewModel.stop()
    }

    func testReconnectWhileBackgroundedRestoresAwayBeforeWatching() async {
        let first = MockSocket()
        let replacement = MockSocket()
        var sockets = [first, replacement]
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { sockets.removeFirst() }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.appDidEnterBackground()

        first.onClose?("connection lost")
        try? await Task.sleep(for: .seconds(2.1))
        viewModel.handle(.hello(bootId: "boot-2"))

        XCTAssertEqual(replacement.awayFrames, [true])
        XCTAssertEqual(replacement.watched, ["bks-1"])
        viewModel.stop()
    }

    func testTranscriptInitPopulatesEntries() {
        let viewModel = makeViewModel()
        XCTAssertTrue(viewModel.isLoadingConversation)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "hi"),
            entry("e2", "assistant", text: "hello"),
        ], cursor: .empty))
        XCTAssertFalse(viewModel.isLoadingConversation)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
        XCTAssertEqual(viewModel.displayItems.map(\.id), ["e1", "e2"])
    }

    /// A session opened as a new tab in a workspace is created empty: it has a
    /// real server row and no run, so it opens on its (empty) conversation
    /// rather than the loading spinner. An id-only stub looks the same to
    /// `neverRan` but says nothing about the session, so it keeps waiting.
    func testServerRowThatNeverRanSkipsTheLoadingState() {
        let created = "2026-08-06T10:00:00.000Z"
        let empty = SessionViewModel(
            session: Session(id: "bks-new", createdAt: created, lastActivity: created)
        )
        XCTAssertFalse(empty.isLoadingConversation)
        XCTAssertTrue(makeViewModel().isLoadingConversation)
    }

    func testConversationLoadTimeoutShowsRetryableFailure() async {
        let socket = MockSocket()
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("os1-loader-tests-\(UUID().uuidString)", isDirectory: true)
        let outbox = Outbox(directory: directory, monitorNetwork: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket },
            outbox: outbox,
            conversationLoadTimeout: 0.01
        )

        viewModel.start()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertFalse(viewModel.isLoadingConversation)
        XCTAssertNotNil(viewModel.conversationLoadError)
        XCTAssertEqual(viewModel.connectionState, .failed("Couldn't load conversation"))

        viewModel.retryConversationLoad()
        XCTAssertTrue(viewModel.isLoadingConversation)
        XCTAssertNil(viewModel.conversationLoadError)
        XCTAssertEqual(socket.connectCount, 2)
        viewModel.stop()
    }

    func testEventsForOtherSessionsAreIgnored() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-other", entries: [entry("x", "user")], cursor: .empty))
        viewModel.handle(.streamStart(sessionId: "bks-other"))
        viewModel.handle(.streamText(sessionId: "bks-other", text: "nope", blockId: nil))
        XCTAssertTrue(viewModel.isLoadingConversation)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
    }

    func testStreamTextAccumulatesAndFlushesOnDone() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        XCTAssertTrue(viewModel.isStreaming)
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello ", blockId: nil))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "world", blockId: nil))
        // Chunks coalesce off-screen until a flush point (stream_done here).
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "Hello world")
    }

    func testAppendStripsLandedTextFromLiveBubble() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world", blockId: nil))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world")
        ]))
        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1"])
    }

    func testStreamTextArrivingAfterItsAppendIsDropped() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        // Durable entry beats the stream broadcast (1s file watcher won the race).
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "block A")
        ]))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "block A", blockId: nil))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "", "already-landed block must not re-enter the live bubble")
        XCTAssertEqual(viewModel.entries.count, 1)
    }

    func testNamedBlockLeavesTheBubbleWhenItsEntryLandsMidStream() {
        // The reply types out in pieces, so its entry can land while the block
        // is half-written. The block's id is on both, which is what cancels it.
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "The main ", blockId: "prt_1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "constraint ", blockId: "prt_1"))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("prt_1", "assistant", text: "The main constraint is decisive.")
        ]))
        XCTAssertEqual(viewModel.liveText, "")

        // Frames still in flight for that block are the entry's own words.
        viewModel.handle(.streamText(sessionId: "bks-1", text: "is decisive.", blockId: "prt_1"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertEqual(viewModel.entries.map(\.id), ["prt_1"])
    }

    func testHalfStreamedBlockLeavesTheBubbleWithoutAnId() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello ", blockId: nil))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world")
        ]))
        XCTAssertEqual(viewModel.liveText, "")
        viewModel.handle(.streamText(sessionId: "bks-1", text: "world", blockId: nil))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "")
    }

    /// The foreground-resync fix: a re-watch's transcript_init carries blocks
    /// that are still sitting in the live bubble — they must be stripped.
    func testResyncInitStripsAlreadyLandedLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world", blockId: nil))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        // Foreground re-watch → full resync containing the same block.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi"),
            entry("e1", "assistant", text: "Hello world"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.liveText, "", "resynced block would render twice")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1", "e1"])
    }

    func testResyncInitKeepsUnlandedTail() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world. And more", blockId: nil))
        // Resync landed only the first block; the tail is still live-only.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world.")
        ], cursor: .empty))
        XCTAssertTrue(viewModel.liveText.contains("And more"))
        XCTAssertFalse(viewModel.liveText.contains("Hello world."))
    }

    func testHistoryPrependsWithoutDuplicates() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [entry("e2", "user", text: "recent")], cursor: .empty))
        viewModel.handle(.transcriptHistory(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "older"),
            entry("e2", "user", text: "recent"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
    }

    // MARK: - Jump to the start

    /// One tap has to reach the first message: each page's arrival asks for
    /// the next, with fat pages so a long backlog is a handful of round trips.
    func testJumpToStartWalksSeqPagesUntilTheFirstMessage() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e900", "user", text: "recent")],
            cursor: HistoryCursor(
                truncated: true, startOffset: nil, rev: nil, firstSeq: 900
            )
        ))

        viewModel.jumpToStart()
        XCTAssertTrue(viewModel.jumpingToStart)
        viewModel.handle(.transcriptHistory(
            sessionId: "bks-1",
            entries: [entry("e500", "user", text: "middle")],
            cursor: HistoryCursor(
                truncated: true, startOffset: nil, rev: nil, firstSeq: 500
            )
        ))
        XCTAssertTrue(viewModel.jumpingToStart, "walk stops short of the start")
        viewModel.handle(.transcriptHistory(
            sessionId: "bks-1",
            entries: [entry("e1", "user", text: "first")],
            cursor: HistoryCursor(
                truncated: false, startOffset: nil, rev: nil, firstSeq: 1
            )
        ))

        XCTAssertEqual(socket.historyRequests, [
            .seq(900, limit: 400), .seq(500, limit: 400),
        ])
        XCTAssertFalse(viewModel.jumpingToStart)
        XCTAssertFalse(viewModel.canLoadEarlier)
        XCTAssertEqual(viewModel.jumpLandedSeq, 1, "the view scrolls to the start once")
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e500", "e900"])
    }

    /// A page that doesn't move the cursor means nothing more is coming —
    /// keep asking and the walk never ends.
    func testJumpToStartStopsWhenTheCursorStopsReceding() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e900", "user", text: "recent")],
            cursor: HistoryCursor(
                truncated: true, startOffset: nil, rev: nil, firstSeq: 900
            )
        ))

        viewModel.jumpToStart()
        for id in ["e500", "e499"] {
            viewModel.handle(.transcriptHistory(
                sessionId: "bks-1",
                entries: [entry(id, "user", text: "page")],
                cursor: HistoryCursor(
                    truncated: true, startOffset: nil, rev: nil, firstSeq: 500
                )
            ))
        }

        XCTAssertEqual(socket.historyRequests, [
            .seq(900, limit: 400), .seq(500, limit: 400),
        ])
        XCTAssertFalse(viewModel.jumpingToStart)
        XCTAssertTrue(viewModel.canLoadEarlier, "the control stays for a manual page")
    }

    /// Byte-window sessions can't walk a backlog; the cursor-less request is
    /// answered with the whole transcript in one init.
    func testJumpToStartAsksLegacySessionsForTheWholeTranscript() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e9", "user", text: "recent")],
            cursor: HistoryCursor(
                truncated: true, startOffset: 4096, rev: "rev-1", firstSeq: nil
            )
        ))

        viewModel.jumpToStart()
        XCTAssertEqual(socket.historyRequests, [.whole])

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "user", text: "first"), entry("e9", "user", text: "recent")],
            cursor: .empty
        ))
        XCTAssertFalse(viewModel.jumpingToStart)
        XCTAssertEqual(viewModel.jumpLandedSeq, 1)
    }

    /// A session served from the cross-engine merge answers with a tail,
    /// `truncated: true` and NO cursor of either kind (`startOffset: 0`, no
    /// firstSeq). Paging must fall back to the cursor-less whole-transcript
    /// request — clearing the control instead stranded the reader at the tail.
    func testLoadEarlierAsksForTheWholeTranscriptWithoutACursor() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e9", "user", text: "recent")],
            cursor: HistoryCursor(
                truncated: true, startOffset: 0, rev: nil, firstSeq: nil
            )
        ))
        XCTAssertTrue(viewModel.canLoadEarlier)

        viewModel.loadEarlier()
        XCTAssertEqual(socket.historyRequests, [.whole])
        XCTAssertTrue(viewModel.loadingEarlier)

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "user", text: "first"), entry("e9", "user", text: "recent")],
            cursor: .empty
        ))
        XCTAssertFalse(viewModel.loadingEarlier)
        XCTAssertFalse(viewModel.canLoadEarlier)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e9"])
    }

    func testRewatchResumesAfterLatestChangeAndKeepsPagedHistory() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        XCTAssertEqual(socket.watchResumes.count, 1)
        XCTAssertNil(socket.watchResumes[0])

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e900", "user", text: "recent")],
            cursor: HistoryCursor(
                truncated: true, firstSeq: 900, lastSeq: 1_000,
                lastChangeSeq: 1_200, v2: true
            )
        ))
        viewModel.handle(.transcriptHistory(
            sessionId: "bks-1",
            entries: [entry("e500", "user", text: "earlier")],
            cursor: HistoryCursor(truncated: true, firstSeq: 500, v2: true)
        ))
        viewModel.handle(.transcriptAppend(
            sessionId: "bks-1",
            entries: [entry("e1001", "assistant", text: "new")],
            cursor: HistoryCursor(
                truncated: false, lastSeq: 1_001, lastChangeSeq: 1_201, v2: true
            )
        ))

        // A replacement socket's hello re-watches using the durable watermark.
        // The server answers with transcript_append, not a tail transcript_init,
        // so the earlier page already on screen remains mounted.
        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(
            socket.watchResumes.last!,
            .seq(lastSeq: 1_001, lastChangeSeq: 1_201)
        )
        XCTAssertEqual(viewModel.entries.map(\.id), ["e500", "e900", "e1001"])
    }

    func testLegacyRewatchUsesTheLastByteCursor() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1", entries: [entry("e1", "user")],
            cursor: HistoryCursor(
                truncated: false, rev: "rev-1", endOffset: 4_096
            )
        ))
        viewModel.handle(.transcriptAppend(
            sessionId: "bks-1", entries: [entry("e2", "assistant")],
            cursor: HistoryCursor(
                truncated: false, rev: "rev-1", endOffset: 8_192
            )
        ))

        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(
            socket.watchResumes.last!,
            .offset(endOffset: 8_192, rev: "rev-1")
        )
    }

    /// A socket that dies mid-walk must not leave the control spinning on a
    /// request nobody will answer — nor scroll the reader to a start we never
    /// reached.
    func testDisconnectMidJumpClearsTheWalkWithoutLanding() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { socket }
        )
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e900", "user", text: "recent")],
            cursor: HistoryCursor(
                truncated: true, startOffset: nil, rev: nil, firstSeq: 900
            )
        ))
        viewModel.jumpToStart()

        socket.onClose?("Connection lost")

        XCTAssertFalse(viewModel.jumpingToStart)
        XCTAssertFalse(viewModel.loadingEarlier)
        XCTAssertEqual(viewModel.jumpLandedSeq, 0)
    }

    func testAppendUpsertsById() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [entry("e1", "assistant", text: "draft")]))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [entry("e1", "assistant", text: "final")]))
        XCTAssertEqual(viewModel.entries.count, 1)
        XCTAssertEqual(viewModel.entries[0].text, "final")
    }

    func testToolUseAndResultMergeIntoOneDisplayItem() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "tool_use", toolUseId: "tu-1"),
            entry("tr-tu-1", "tool_result", text: "ok", toolUseId: "tu-1"),
            entry("tr-orphan", "tool_result", text: "lost"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.displayItems.count, 2)
        guard case .toolCall(let use, let result, let isLive) = viewModel.displayItems[0] else {
            return XCTFail("expected merged tool call")
        }
        XCTAssertEqual(use.id, "e1")
        XCTAssertEqual(result?.text, "ok")
        XCTAssertFalse(isLive)
        guard case .entry(let orphan) = viewModel.displayItems[1] else {
            return XCTFail("orphan tool_result should render standalone")
        }
        XCTAssertEqual(orphan.id, "tr-orphan")
    }

    func testOnlyCurrentStreamToolCallIsLive() {
        let viewModel = makeViewModel()
        // An incomplete historical entry must not reopen just because it has no result.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("old-tool", "tool_use", toolUseId: "tu-old"),
        ], cursor: .empty))
        guard case .toolCall(_, _, let historicalIsLive) = viewModel.displayItems[0] else {
            return XCTFail("expected historical tool call")
        }
        XCTAssertFalse(historicalIsLive)

        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamEntry(
            sessionId: "bks-1",
            entry: entry("live-tool", "tool_use", toolUseId: "tu-live")
        ))
        guard case .toolCall(_, _, let liveIsLive) = viewModel.displayItems.last else {
            return XCTFail("expected live tool call")
        }
        XCTAssertTrue(liveIsLive)
    }

    /// A tool call graduates the preceding live text into an ordered
    /// ephemeral entry, so the turn reads text → tool instead of the text
    /// dangling in the bottom bubble below the tool row.
    func testToolCallGraduatesPrecedingLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Let me check.", blockId: nil))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-1", "tool_use", toolUseId: "tu-1")))
        XCTAssertEqual(viewModel.liveText, "", "text must leave the live bubble")
        XCTAssertEqual(viewModel.displayItems.count, 2)
        guard case .entry(let graduated) = viewModel.displayItems[0] else {
            return XCTFail("graduated text should render before the tool call")
        }
        XCTAssertEqual(graduated.text, "Let me check.")
        XCTAssertTrue(graduated.isAssistant)
        guard case .toolCall = viewModel.displayItems[1] else {
            return XCTFail("tool call should follow the graduated text")
        }
    }

    /// The durable copy of a graduated block replaces it without duplication.
    func testDurableAppendReplacesGraduatedLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Let me check.", blockId: nil))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-1", "tool_use", toolUseId: "tu-1")))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Let me check."),
            entry("srv-1", "tool_use", toolUseId: "tu-1"),
        ]))
        XCTAssertTrue(viewModel.liveEntries.isEmpty, "graduated copy must not linger next to the durable one")
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "srv-1"])
        XCTAssertEqual(viewModel.displayItems.count, 2)
    }

    func testStreamEntryGraduatesWhenDurableCopyLands() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-5", "tool_use", toolUseId: "tu-5")))
        XCTAssertEqual(viewModel.liveEntries.count, 1)
        // Durable copy arrives under a different entry id but the same toolUseId.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("srv-5", "tool_use", toolUseId: "tu-5")
        ]))
        XCTAssertTrue(viewModel.liveEntries.isEmpty, "ephemeral copy must not linger next to the durable one")
        XCTAssertEqual(viewModel.entries.map(\.id), ["srv-5"])
        XCTAssertEqual(viewModel.displayItems.count, 1)
    }

    func testRunStopPreservesLiveTextUntilAppendLands() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "tail text", blockId: nil))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        XCTAssertFalse(viewModel.isRunning)
        XCTAssertFalse(viewModel.isStreaming)
        // Wiping here would blink the reply out before transcript_append lands.
        XCTAssertEqual(viewModel.liveText, "tail text")
    }

    func testQueueUpdate() {
        let viewModel = makeViewModel()
        // Drive this one through the raw frame so it also pins the wire parse.
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"next","user":"jaap"}],
         "steered":[{"id":"s1","content":"steer"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["s1"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    /// The list count is only a pre-watch summary. Once the socket supplies
    /// detailed state, an empty queue must stay empty rather than falling back
    /// to the stale summary and showing a contradictory composer chip.
    func testDetailedQueueReplacesStaleSummaryCount() {
        let viewModel = SessionViewModel(session: Session(id: "bks-1", queuedCount: 2))
        XCTAssertEqual(viewModel.queuedCount, 2)

        viewModel.handle(.queueUpdate(sessionId: "bks-1", queued: [], steered: []))

        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
    }

    func testAskQuestionLifecycle() {
        let viewModel = makeViewModel()
        let question = AskQuestion(id: "ask-1", questions: [])
        viewModel.handle(.askQuestion(sessionId: "bks-1", question: question))
        XCTAssertEqual(viewModel.pendingQuestion?.id, "ask-1")
        viewModel.handle(.askResolved(sessionId: "bks-1", questionId: "ask-other"))
        XCTAssertNotNil(viewModel.pendingQuestion, "resolving a different question must not clear ours")
        viewModel.handle(.askResolved(sessionId: "bks-1", questionId: "ask-1"))
        XCTAssertNil(viewModel.pendingQuestion)
    }

    private func askedQuestion() -> AskQuestion {
        AskQuestion(id: "ask-1", questions: [
            AskQuestion.Question(
                question: "Which app?",
                header: "Target",
                options: [
                    AskQuestion.Option(label: "iOS", description: "The native app"),
                    AskQuestion.Option(label: "Web", description: nil),
                ],
                multiSelect: nil
            )
        ])
    }

    func testAnsweringLeavesAReceiptUntilTheRecordLands() {
        let viewModel = makeViewModel()
        let question = askedQuestion()
        var olderRecord = entry("older-ask-record", "system")
        olderRecord.ask = AnsweredAsk(question: question, answers: ["Which app?": "iOS"])
        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [olderRecord],
            cursor: .empty
        ))
        viewModel.handle(.askQuestion(sessionId: "bks-1", question: question))
        viewModel.answer(question: question, answers: ["Which app?": "iOS"])

        XCTAssertNil(viewModel.pendingQuestion)
        XCTAssertEqual(viewModel.sentAskAnswer?.id, "ask-1")
        let receipt = viewModel.sentAskAnswer?.ask.questions.first
        XCTAssertEqual(receipt?.answer, "iOS")
        XCTAssertEqual(receipt?.header, "Target")
        XCTAssertEqual(receipt?.options?.map(\.label), ["iOS", "Web"])

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [olderRecord],
            cursor: .empty
        ))
        XCTAssertNotNil(viewModel.sentAskAnswer)

        var record = entry("new-ask-record", "system")
        record.ask = AnsweredAsk(question: question, answers: ["Which app?": "iOS"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [record]))
        XCTAssertNil(viewModel.sentAskAnswer)
    }

    func testDismissedQuestionLeavesNoReceipt() {
        let viewModel = makeViewModel()
        let question = askedQuestion()
        viewModel.handle(.askQuestion(sessionId: "bks-1", question: question))
        viewModel.answer(question: question, answers: nil)
        XCTAssertNil(viewModel.sentAskAnswer)
    }

    func testNewQuestionClearsAnUnretiredReceipt() {
        let viewModel = makeViewModel()
        let question = askedQuestion()
        viewModel.handle(.askQuestion(sessionId: "bks-1", question: question))
        viewModel.answer(question: question, answers: ["Which app?": "iOS"])
        XCTAssertNotNil(viewModel.sentAskAnswer)

        viewModel.handle(.askQuestion(
            sessionId: "bks-1",
            question: AskQuestion(id: "ask-2", questions: [])
        ))
        XCTAssertNil(viewModel.sentAskAnswer)
    }

    /// A server notice used to pin itself over the composer. It joins the
    /// transcript now, so the composer stays empty — and an empty frame is
    /// the server clearing rather than an event, so nothing new lands.
    func testServerNoticeDoesNotPinItselfOverTheComposer() {
        let viewModel = makeViewModel()
        viewModel.handle(.notice("heads up"))
        XCTAssertNil(viewModel.notice)
        XCTAssertEqual(viewModel.entries.last?.notice?.title, "heads up")

        viewModel.handle(.notice(""))
        XCTAssertEqual(viewModel.entries.count, 1)
    }

    func testReplySuggestionFillsDraftWithoutSendingAndRetiresRow() {
        let viewModel = makeViewModel()
        let suggestions = [
            ReplySuggestion(label: "Fix both", text: "Fix both issues, then run the tests."),
            ReplySuggestion(label: "Only cache", text: "Fix only the stale cache read."),
        ]
        viewModel.handle(.replySuggestions(sessionId: "bks-1", suggestions: suggestions))
        XCTAssertEqual(viewModel.replySuggestions, suggestions)

        viewModel.draft = "Keep this context   \n"
        viewModel.pickReplySuggestion(suggestions[0])

        XCTAssertEqual(viewModel.draft, "Keep this context\nFix both issues, then run the tests.")
        XCTAssertTrue(viewModel.replySuggestions.isEmpty)
        XCTAssertEqual(viewModel.sendSeq, 0, "picking a suggestion must not send it")
    }

    func testReplySuggestionsClearFromServerAndWhenANewTurnStarts() {
        let viewModel = makeViewModel()
        let suggestions = [ReplySuggestion(label: "Ship it", text: "Ship the completed change.")]
        viewModel.handle(.replySuggestions(sessionId: "other", suggestions: suggestions))
        XCTAssertTrue(viewModel.replySuggestions.isEmpty)

        viewModel.handle(.replySuggestions(sessionId: "bks-1", suggestions: suggestions))
        viewModel.handle(.replySuggestions(sessionId: "bks-1", suggestions: []))
        XCTAssertTrue(viewModel.replySuggestions.isEmpty)

        viewModel.handle(.replySuggestions(sessionId: "bks-1", suggestions: suggestions))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        XCTAssertTrue(viewModel.replySuggestions.isEmpty)

        viewModel.handle(.replySuggestions(sessionId: "bks-1", suggestions: suggestions))
        viewModel.stop()
        XCTAssertTrue(viewModel.replySuggestions.isEmpty)
    }
}

/// `sendDraft` composer semantics. Sending is a two-step now: the draft goes
/// into the outbox (on disk, immediately) and the transcript bubble or queue
/// chip appears when the SERVER acknowledges it — which is also what says
/// where it landed. These pin down both halves: that nothing is lost when the
/// server can't be reached, and that an acknowledged message is shown exactly
/// once, in the right place.
@MainActor
final class SendDraftTests: XCTestCase {
    private var viewModel: SessionViewModel!
    private var socket: MockSocket!
    private var outbox: Outbox!
    private var outboxDirectory: URL!
    private var savedBusySend: String?
    private var savedUserName: String?

    /// Stub for the fake server's answer. nil = behave like the real one:
    /// queue a send that arrives mid-run, start a turn when idle.
    private var stubbedOutcome: OS1API.PromptDelivery?
    private var deliveries: [(item: Outbox.Item, images: [String])] = []

    override func setUp() async throws {
        // `sendDraft` reads the busy-send mode straight from UserDefaults, and
        // the test host shares its defaults domain with the real app — on a
        // machine where someone has set "steer" in Settings, every queue-chip
        // expectation below silently checked the wrong list. Pin it — and put
        // the person's own setting back afterwards, since this is their app's
        // real defaults domain.
        savedBusySend = UserDefaults.standard.string(forKey: "os1.composer.busySend")
        UserDefaults.standard.set("queue", forKey: "os1.composer.busySend")
        // Editing a queued message is only offered for one you wrote yourself,
        // and `MessageAttribution` deliberately refuses to match ServerConfig's
        // "ios" placeholder, which is a stand-in rather than a name. A box that has
        // never signed in holds exactly that, so the viewer check failed and
        // the edit silently did nothing: green on a developer's Mac, red on
        // every clean CI runner. Pin a real name, and put the person's own back.
        savedUserName = ServerConfig.shared.userName
        ServerConfig.shared.userName = "Tester"
        socket = MockSocket()
        // Its own scratch store: the real one is the person's undelivered mail.
        outboxDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("os1-outbox-tests-\(UUID().uuidString)", isDirectory: true)
        outbox = Outbox(directory: outboxDirectory, monitorNetwork: false)
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            if let stubbedOutcome = self.stubbedOutcome { return stubbedOutcome }
            return .delivered(
                status: self.viewModel.isRunning ? "queued" : "started",
                message: ""
            )
        }
        let mock = socket!
        viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { mock }, outbox: outbox
        )
        viewModel.start()
    }

    override func tearDown() async throws {
        viewModel?.stop()
        if let outboxDirectory {
            try? FileManager.default.removeItem(at: outboxDirectory)
        }
        if let savedBusySend {
            UserDefaults.standard.set(savedBusySend, forKey: "os1.composer.busySend")
        } else {
            UserDefaults.standard.removeObject(forKey: "os1.composer.busySend")
        }
        if let savedUserName { ServerConfig.shared.userName = savedUserName }
    }

    private func entry(_ id: String, _ type: String, text: String? = nil) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text)
    }

    private func markRunning() {
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
    }

    /// Type it, send it, and let the delivery round trip finish.
    private func send(_ text: String) async {
        viewModel.draft = text
        viewModel.sendDraft()
        await outbox.flushNow()
    }

    /// Signal is back: the app clears the backoff and retries (what
    /// `appDidBecomeActive` and the socket handshake do for real).
    private func comeBackOnline() async {
        stubbedOutcome = nil
        outbox.clearBackoff()
        await outbox.flushNow()
    }

    private var unsent: [Outbox.Item] { outbox.items(for: "bks-1") }

    // MARK: - Idle sends

    func testIdleSendEchoesOptimisticBubble() async {
        await send("hi there")
        XCTAssertEqual(viewModel.entries.count, 1)
        XCTAssertEqual(viewModel.entries[0].text, "hi there")
        XCTAssertTrue(viewModel.entries[0].isUser)
        XCTAssertEqual(viewModel.displayItems.count, 1)
        XCTAssertTrue(viewModel.queuedItems.isEmpty, "idle sends must not fabricate a queue chip")
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.draft, "")
        XCTAssertEqual(deliveries.map(\.item.content), ["hi there"])
        XCTAssertTrue(unsent.isEmpty, "a delivered message must leave the outbox")
    }

    func testSendPrependsSelectedTranscriptTextAndClearsIt() async {
        viewModel.quoteSelection.stage("First line\n\nSecond line")

        await send("What does this mean?")

        XCTAssertEqual(
            deliveries.map(\.item.content),
            ["> First line\n>\n> Second line\n\nWhat does this mean?"]
        )
        XCTAssertNil(viewModel.quoteSelection.text)
    }

    func testSelectedTextDoesNotEnableAnEmptySend() {
        viewModel.quoteSelection.stage("Context only")

        XCTAssertFalse(viewModel.canSend)
        viewModel.sendDraft()

        XCTAssertEqual(viewModel.quoteSelection.text, "Context only")
        XCTAssertTrue(unsent.isEmpty)
    }

    func testIdleEchoReplacedByServerCopyWithoutDuplication() async {
        await send("hi")
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"], "optimistic bubble must be replaced, not doubled")
    }

    /// The reported duplicate (2026-08-11): the server persists the user line
    /// at intake and broadcasts it BEFORE the POST that carried it answers, so
    /// the entry routinely beats its own delivery reply. Echoing anyway left
    /// the message on screen twice, permanently — nothing retires a bubble
    /// whose server copy landed before it existed.
    func testServerEntryArrivingBeforeDeliveryReplyIsNotEchoedTwice() async {
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            // The broadcast overtakes the reply still in flight.
            self.viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
                TranscriptEntry(id: "u1", type: "user", content: item.content)
            ]))
            return .delivered(status: "started", message: "")
        }
        await send("hi")
        XCTAssertEqual(
            viewModel.entries.map(\.id), ["u1"],
            "the server's own entry is the message — no second bubble beside it"
        )
    }

    /// Same race, attributed form: a message delivered through the queue drain
    /// lands as "[user] content".
    func testAttributedServerEntryBeforeReplyIsNotEchoedTwice() async {
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            self.viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
                TranscriptEntry(id: "u1", type: "user", content: "[jaap] \(item.content)")
            ]))
            return .delivered(status: "started", message: "")
        }
        await send("hi")
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// A resync snapshot can carry the entry just as an append can.
    func testResyncEntryBeforeDeliveryReplyIsNotEchoedTwice() async {
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            self.viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
                TranscriptEntry(id: "u1", type: "user", content: item.content)
            ], cursor: .empty))
            return .delivered(status: "started", message: "")
        }
        await send("hi")
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// The claim is one-to-one and never reaches backwards: sending the same
    /// text twice must still show the second one immediately, rather than
    /// claiming the first message's entry and blinking out until it lands.
    func testRepeatedIdenticalSendStillEchoes() async {
        await send("continue")
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
        await send("continue")
        XCTAssertEqual(
            viewModel.entries.map(\.text), ["continue", "continue"],
            "the second send has its own bubble"
        )
    }

    /// A send whose reply was lost is retried, and the server answers from its
    /// prompt receipt (`src/server/prompt-receipts.ts`) — minutes after the
    /// message's own entry landed. The replayed answer must not echo it again.
    func testRetriedSendAnsweredAfterItsEntryLandedIsNotEchoedTwice() async {
        stubbedOutcome = .unavailable("offline")
        await send("delivered but unanswered")
        XCTAssertEqual(unsent.count, 1)
        // The server actually took it the first time: the entry arrives while
        // the client still owes the message.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "delivered but unanswered")
        ]))
        await comeBackOnline()
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertEqual(
            viewModel.entries.map(\.id), ["u1"],
            "the receipt replay must claim the landed entry, not double it"
        )
    }

    func testWhitespaceOnlyDraftIsNotSent() async {
        await send("   \n  ")
        XCTAssertTrue(deliveries.isEmpty)
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
    }

    // MARK: - Offline sends (the message that used to disappear)

    /// The reported bug: sending with no connection cleared the composer,
    /// showed a bubble, and delivered nothing. Now the message is held —
    /// visibly — and goes out when the server is reachable again.
    func testOfflineSendIsHeldThenDeliveredWhenBackOnline() async {
        stubbedOutcome = .unavailable("offline")
        await send("written in a tunnel")

        XCTAssertEqual(viewModel.draft, "", "the composer accepted the message")
        XCTAssertEqual(unsent.map(\.content), ["written in a tunnel"])
        XCTAssertFalse(unsent[0].failed, "no connection is not a refusal")
        XCTAssertEqual(
            viewModel.entries.map(\.text), ["written in a tunnel"],
            "the durable outbox copy must stay visible in the conversation"
        )

        await comeBackOnline()
        XCTAssertTrue(unsent.isEmpty, "the held message went out")
        XCTAssertEqual(viewModel.entries.map(\.text), ["written in a tunnel"])
        XCTAssertEqual(deliveries.count, 2, "one failed attempt, then the delivery")
    }

    /// It has to survive the app dying, not just the socket: the queue is on
    /// disk, and a fresh Outbox over the same directory still owes the message.
    func testHeldMessageSurvivesRelaunch() async {
        stubbedOutcome = .unavailable("offline")
        await send("still owed")

        let relaunched = Outbox(directory: outboxDirectory, monitorNetwork: false)
        XCTAssertEqual(relaunched.items(for: "bks-1").map(\.content), ["still owed"])
        let reopened = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { self.socket }, outbox: relaunched
        )
        XCTAssertEqual(
            reopened.entries.map(\.text), ["still owed"],
            "reopening the chat must restore the original unsent message"
        )
    }

    /// Order is meaning: message 2 must never overtake message 1, so a
    /// session with a stuck head waits as a whole.
    func testHeldMessagesKeepTheirOrder() async {
        stubbedOutcome = .unavailable("offline")
        await send("first")
        await send("second")
        XCTAssertEqual(unsent.map(\.content), ["first", "second"])

        await comeBackOnline()
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.text), ["first", "second"])
    }

    /// Retrying is only safe because the server can recognise a repeat: every
    /// attempt carries the same client id.
    func testRetriesReuseTheSameClientId() async {
        stubbedOutcome = .unavailable("offline")
        await send("say it once")
        await comeBackOnline()
        XCTAssertEqual(deliveries.count, 2)
        XCTAssertEqual(
            deliveries[0].item.id, deliveries[1].item.id,
            "a retry must be recognisable as the same message, not a new one"
        )
    }

    /// A refusal is not a connection problem: it stops, says so, and waits for
    /// the person rather than retrying forever or silently vanishing.
    func testRefusedMessageIsKeptAndMarkedFailed() async {
        stubbedOutcome = .rejected("Session has no engine to resume yet.")
        await send("nope")
        XCTAssertEqual(unsent.map(\.content), ["nope"])
        XCTAssertTrue(unsent[0].failed)
        XCTAssertEqual(unsent[0].lastError, "Session has no engine to resume yet.")
        XCTAssertEqual(
            viewModel.entries.map(\.text), ["nope"],
            "a refusal must keep the original message in the conversation"
        )

        // Retry once the reason is gone.
        stubbedOutcome = nil
        outbox.retry(id: unsent[0].id)
        await outbox.flushNow()
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.text), ["nope"])
    }

    /// A terminal attachment/refusal belongs to that message. Keeping it for
    /// Edit/Delete/Retry must not make every later follow-up look queued forever.
    func testRefusedMessageDoesNotBlockLaterFollowUp() async {
        stubbedOutcome = .rejected("An attached image could not be prepared.")
        await send("broken attachment")
        let failedId = unsent.first?.id

        stubbedOutcome = nil
        await send("follow up")

        XCTAssertEqual(deliveries.map(\.item.content), ["broken attachment", "follow up"])
        XCTAssertEqual(unsent.map(\.id), [failedId].compactMap { $0 })
        XCTAssertTrue(unsent[0].failed)
    }

    func testFailureContinuationUsesWebPromptWithoutChangingDraft() async {
        stubbedOutcome = .unavailable("offline")
        viewModel.draft = "Keep this draft"
        viewModel.continueAfterFailure(noticeId: "failure-1")
        await outbox.flushNow()

        XCTAssertEqual(viewModel.draft, "Keep this draft")
        XCTAssertEqual(unsent.map(\.content), [SessionViewModel.continueAfterFailurePrompt])
        XCTAssertNil(deliveries.first?.item.effort)
        XCTAssertNil(deliveries.first?.item.fastMode)
        XCTAssertEqual(deliveries.map(\.item.busyMode), ["default"])
        XCTAssertEqual(deliveries.map(\.item.purpose), ["failure:failure-1"])
        XCTAssertEqual(viewModel.failureContinuationStatus(for: "failure-1"), .sending)
    }

    func testRejectedFailureContinuationShowsErrorAndRetriesSameItem() async {
        stubbedOutcome = .rejected("Session has no engine to resume yet.")
        viewModel.continueAfterFailure(noticeId: "failure-1")
        await outbox.flushNow()

        guard let original = unsent.first else {
            return XCTFail("the refused continuation should stay in the outbox")
        }
        XCTAssertEqual(
            viewModel.failureContinuationStatus(for: "failure-1"),
            .failed("Session has no engine to resume yet.")
        )

        stubbedOutcome = nil
        viewModel.continueAfterFailure(noticeId: "failure-1")
        await outbox.flushNow()

        XCTAssertEqual(deliveries.map(\.item.id), [original.id, original.id])
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertEqual(viewModel.entries.last?.text, SessionViewModel.continueAfterFailurePrompt)
        XCTAssertEqual(
            viewModel.failureContinuationStatus(for: "failure-1"),
            .sending,
            "an accepted continuation stays latched until its failure row is replaced"
        )
    }

    func testDeletingRejectedFailureContinuationReenablesAction() async {
        stubbedOutcome = .rejected("No engine")
        viewModel.continueAfterFailure(noticeId: "failure-1")
        await outbox.flushNow()

        guard let item = unsent.first else { return XCTFail("expected a refused item") }
        outbox.delete(id: item.id)

        XCTAssertEqual(viewModel.failureContinuationStatus(for: "failure-1"), .available)
    }

    /// Discarding is the one way a message leaves unsent — and it has to be
    /// the person's choice.
    func testDiscardingAnUnsentMessageRemovesIt() async {
        stubbedOutcome = .unavailable("offline")
        await send("never mind")
        viewModel.discardUnsent(unsent[0])
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertTrue(viewModel.entries.isEmpty)

        await comeBackOnline()
        XCTAssertTrue(deliveries.map(\.item.content).filter { $0 == "never mind" }.count == 1,
                      "a discarded message must not be delivered later")
    }

    /// One stuck conversation must not hold up the others.
    func testAnotherSessionsBacklogDoesNotBlockThisOne() async {
        stubbedOutcome = .unavailable("offline")
        outbox.enqueue(
            sessionId: "bks-other", content: "stuck elsewhere",
            busyMode: "queue", user: "jaap"
        )
        await outbox.flushNow()
        stubbedOutcome = nil
        outbox.clearBackoff()
        // Only this session's send is expected to land; the other one is
        // simply not blocked BY it.
        await send("mine")
        XCTAssertEqual(viewModel.entries.map(\.text), ["mine"])
    }

    // MARK: - Busy sends (the queue-chip path)

    func testBusySendShowsQueueChipNotTranscriptBubble() async {
        markRunning()
        await send("do this next")
        XCTAssertTrue(viewModel.entries.isEmpty, "a queued send must not enter the transcript")
        XCTAssertTrue(viewModel.displayItems.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.count, 1)
        XCTAssertEqual(viewModel.queuedItems[0].content, "do this next")
        XCTAssertEqual(viewModel.queuedItems[0].user, ServerConfig.shared.userName)
        XCTAssertTrue(viewModel.queuedItems[0].id.hasPrefix("local-queued-"))
        XCTAssertEqual(viewModel.queuedCount, 1)
        // The frame still goes out — queueing is the server's job.
        // The message still went out — queueing is the server's decision, and
        // its answer is what put the chip there.
        XCTAssertEqual(deliveries.map(\.item.content), ["do this next"])
        XCTAssertEqual(deliveries[0].item.busyMode, "queue")
    }

    func testCurrentSteerStaysInTranscriptAndReconcilesByDeliveryId() async throws {
        UserDefaults.standard.set("steer", forKey: "os1.composer.busySend")
        markRunning()
        stubbedOutcome = .delivered(status: "steered", message: "Sent to the session.")

        await send("look at this now")
        let deliveryId = try XCTUnwrap(deliveries.last?.item.id)
        XCTAssertEqual(viewModel.entries.map(\.text), ["look at this now"])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertTrue(viewModel.steeredItems.isEmpty)

        viewModel.handle(.queueUpdate(
            sessionId: "bks-1", queued: [], steered: [],
            pendingDeliveryIds: [deliveryId]
        ))
        viewModel.handle(.transcriptAppend(
            sessionId: "bks-1",
            entries: [entry(deliveryId, "user", text: "look at this now")]
        ))

        XCTAssertEqual(viewModel.entries.map(\.id), [deliveryId])
        XCTAssertEqual(viewModel.entries.map(\.text), ["look at this now"])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertTrue(viewModel.steeredItems.isEmpty)
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testBatchedTranscriptRetiresRepeatedQueuedMessagesBySourceId() async {
        markRunning()
        await send("again")
        await send("again")
        let sourceIds = deliveries.map { $0.item.id }
        XCTAssertEqual(viewModel.queuedItems.count, 2)

        viewModel.handle(.transcriptAppend(
            sessionId: "bks-1",
            entries: [TranscriptEntry(
                id: "batch-entry",
                type: "user",
                content: "normalized batch",
                sourceMessageIds: sourceIds
            )]
        ))

        XCTAssertEqual(viewModel.entries.map(\.id), ["batch-entry"])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertTrue(viewModel.steeredItems.isEmpty)
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testPromotedQueuedMessageMovesToTranscriptWithoutDeliveryChip() {
        viewModel.handle(.queueUpdate(
            sessionId: "bks-1",
            queued: [QueueItem(id: "q1", content: "send this now", user: "Tester")],
            steered: []
        ))

        viewModel.handle(.queueUpdate(
            sessionId: "bks-1", queued: [], steered: [],
            pendingDeliveryIds: ["q1"]
        ))

        XCTAssertEqual(viewModel.entries.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.entries.map(\.text), ["send this now"])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertTrue(viewModel.steeredItems.isEmpty)
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testTwoBusySendsStackTwoChips() async {
        markRunning()
        await send("first")
        await send("second")
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["first", "second"])
        XCTAssertEqual(viewModel.queuedCount, 2)
        XCTAssertTrue(viewModel.entries.isEmpty)
    }

    /// The socket usually beats the HTTP response: the server broadcasts the
    /// new queue while the delivery answer is still travelling. The optimistic
    /// chip must not double the entry that's already on screen.
    func testQueueUpdateArrivingBeforeTheDeliveryAnswerShowsOneChip() async {
        markRunning()
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            let json = #"""
            {"type":"queue_update","sessionId":"bks-1",
             "queued":[{"id":"q1","content":"do this next","user":"ios"}],
             "steered":[]}
            """#
            self.viewModel.handle(ServerEvent.parse(Data(json.utf8)))
            return .delivered(status: "queued", message: "")
        }
        await send("do this next")
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.queuedCount, 1)
        XCTAssertTrue(viewModel.entries.isEmpty)
    }

    func testServerQueueUpdateReplacesLocalChip() async {
        markRunning()
        await send("do this next")
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"], "server copy must replace the local chip, not join it")
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testQueuedMessageEntersTranscriptOnlyOnDelivery() async {
        markRunning()
        await send("do this next")
        // Run finishes, queue delivers: queue empties and the prompt lands as
        // a durable user entry — the thread shows it exactly once, in order.
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u9", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u9"])
        XCTAssertEqual(viewModel.displayItems.count, 1)
    }

    /// The race: the run ended in the gap, the server delivered the prompt
    /// straight to the engine, and no queue_update ever mentions it — the
    /// chip must retire when the durable user entry lands.
    func testBusySendDeliveredImmediatelyRetiresChip() async {
        markRunning()
        await send("do this next")
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    func testChipRetirementMatchesByContent() async {
        markRunning()
        await send("mine")
        // Someone else's prompt (web UI, another device) landing must not
        // retire our chip.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "someone else's")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["mine"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testServerChipsAreNeverRetiredByContentMatch() async {
        // A server-issued queue item (real id) with the same text as a landing
        // user entry must stay — only local optimistic chips retire this way.
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"repeat me","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "repeat me")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
    }

    func testBusySendCarriesImagesOnTheWire() async {
        markRunning()
        viewModel.attachedImages = [AttachedImage(id: "img1", jpegData: Data([1, 2, 3]))]
        await send("with pic")
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["with pic"])
        XCTAssertTrue(viewModel.attachedImages.isEmpty)
        XCTAssertEqual(deliveries.count, 1)
        XCTAssertEqual(deliveries[0].images.count, 1)
    }

    func testServerImagePreparationKeepsSupportedBytesAndConvertsOtherImages() throws {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        XCTAssertEqual(AttachedImage.serverDataURL(png), png)

        let olderHEIC = png.replacingOccurrences(of: "image/png", with: "image/heic")
        let converted = try XCTUnwrap(AttachedImage.serverDataURL(olderHEIC))
        XCTAssertTrue(converted.hasPrefix("data:image/jpeg;base64,"))
    }

    /// Images have to survive the wait too — they're kept beside the queue on
    /// disk, so an offline send with a screenshot still carries it later.
    func testHeldMessageKeepsItsImages() async {
        stubbedOutcome = .unavailable("offline")
        viewModel.attachedImages = [AttachedImage(id: "img1", jpegData: Data([1, 2, 3]))]
        await send("look at this")
        XCTAssertEqual(unsent.count, 1)

        await comeBackOnline()
        XCTAssertEqual(deliveries.last?.images.count, 1)
        XCTAssertEqual(viewModel.entries.last?.images?.count, 1)
    }

    func testDeleteQueuedRemovesChipAndSendsFrame() async {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"next","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.deleteQueued(viewModel.queuedItems[0])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(socket.deletedQueueIds, ["q1"])
    }

    /// The two server lists render as separate rows, so a chip claimed by
    /// both would show the same message twice, labelled "steering" AND
    /// "queued". The steer receipt is the further-along state and wins.
    func testChipInBothServerListsRendersOnlyAsSteered() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"both","user":"ios"},
                   {"id":"q2","content":"later","user":"ios"}],
         "steered":[{"id":"q1","content":"both","user":"ios"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q2"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    /// A dismissed steer receipt leaves the server queue without its message
    /// ever landing in the transcript — the exact shape the delivering-hold
    /// looks for. Without the optimistic removal it comes straight back as a
    /// ghost "Delivering…" row.
    func testDismissingSteerReceiptDoesNotResurrectItAsDelivering() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],
         "steered":[{"id":"s1","content":"while you're in there","user":"ios"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.dismissSteered(viewModel.steeredItems[0])
        XCTAssertTrue(viewModel.steeredItems.isEmpty)
        XCTAssertEqual(socket.deletedQueueIds, ["s1"])

        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testEditingQueuedMessageTakesItIntoTheNormalComposer() {
        queueTwo()
        viewModel.editQueuedInComposer(viewModel.queuedItems[0])
        XCTAssertEqual(socket.takenQueueIds, ["q1"])
        viewModel.handle(.queuedPromptTaken(
            sessionId: "bks-1", queueId: "q1", item: viewModel.queuedItems[0], message: nil
        ))
        XCTAssertEqual(viewModel.draft, "first")
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q2"])
    }

    func testEditingPendingSteerTakesItIntoTheNormalComposer() {
        let user = ServerConfig.shared.userName
        let json = """
        {"type":"queue_update","sessionId":"bks-1","queued":[],
         "steered":[{"id":"s1","content":"change this","user":"\(user)","editable":true}]}
        """
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        let item = viewModel.steeredItems[0]

        viewModel.editSteeredInComposer(item)
        XCTAssertEqual(socket.takenSteerIds, ["s1"])
        viewModel.handle(.queuedPromptTaken(
            sessionId: "bks-1", queueId: "s1", item: item, message: nil
        ))
        XCTAssertEqual(viewModel.draft, "change this")
        XCTAssertTrue(viewModel.steeredItems.isEmpty)
    }

    func testEditingSentMessageCopiesItIntoTheNormalComposer() {
        let entry = TranscriptEntry(
            id: "u1", type: "user", content: "fix the typo", images: [Self.pngURL]
        )
        viewModel.editSentMessageInComposer(entry)
        XCTAssertEqual(viewModel.draft, "fix the typo")
        XCTAssertEqual(viewModel.attachedImages.map(\.dataURL), [Self.pngURL])
    }

    func testEditingSentMessageDoesNotReplaceAnExistingDraft() {
        viewModel.draft = "keep this"
        viewModel.editSentMessageInComposer(
            TranscriptEntry(id: "u1", type: "user", content: "old message")
        )
        XCTAssertEqual(viewModel.draft, "keep this")
        XCTAssertEqual(viewModel.notice, "Send or clear your draft before editing a message.")
    }

    func testEditingQueuedMessageReturnsImagesToComposer() {
        queueWithImage()
        viewModel.editQueuedInComposer(viewModel.queuedItems[0])
        viewModel.handle(.queuedPromptTaken(
            sessionId: "bks-1", queueId: "q1", item: viewModel.queuedItems[0], message: nil
        ))
        XCTAssertEqual(viewModel.draft, "look at this")
        XCTAssertEqual(viewModel.attachedImages.map(\.dataURL), [Self.pngURL])
    }

    func testRefusedQueuedEditLeavesTheQueueAndDraftAlone() {
        queueTwo()
        viewModel.editQueuedInComposer(viewModel.queuedItems[0])
        viewModel.handle(.queuedPromptTaken(
            sessionId: "bks-1", queueId: "q1", item: nil, message: "Already sent"
        ))
        XCTAssertTrue(viewModel.draft.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1", "q2"])
        XCTAssertEqual(viewModel.notice, "Already sent")
    }

    private static let pngURL = "data:image/png;base64,iVBORw0KGgo="
    private static let jpegURL = "data:image/jpeg;base64,/9j/4AAQ"

    /// One server-known message waiting behind a run, carrying a screenshot.
    private func queueWithImage() {
        let user = ServerConfig.shared.userName
        let json = """
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"look at this","user":"\(user)",
                     "images":["\(Self.pngURL)"],"editable":true}],
         "steered":[]}
        """
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
    }

    /// A chip minted by the composer has an id the server has never seen, so
    /// the id-addressed actions have to wait for the real queue_update.
    func testLocalEchoChipIsNotEditableOrReorderable() async {
        markRunning()
        await send("do this next")
        let chip = viewModel.queuedItems[0]
        XCTAssertTrue(chip.isLocalEcho)
        XCTAssertFalse(viewModel.canReorder(chip))
        viewModel.editQueuedInComposer(chip)
        XCTAssertTrue(socket.takenQueueIds.isEmpty)
        XCTAssertEqual(viewModel.queuedItems[0].content, "do this next")
    }

    func testMovingQueuedMessageReordersLocallyAndOnTheServer() {
        queueTwo()
        viewModel.moveQueued(viewModel.queuedItems[1], by: -1)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q2", "q1"])
        XCTAssertEqual(socket.reorders, [["q2", "q1"]])
    }

    func testMovingPastTheEndsOfTheQueueDoesNothing() {
        queueTwo()
        viewModel.moveQueued(viewModel.queuedItems[0], by: -1)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1", "q2"])
        XCTAssertTrue(socket.reorders.isEmpty)
    }

    /// Two server-known messages waiting behind a run.
    private func queueTwo() {
        let user = ServerConfig.shared.userName
        let json = """
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"first","user":"\(user)","editable":true},
                   {"id":"q2","content":"then this","user":"\(user)","editable":true}],
         "steered":[]}
        """
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
    }

    // MARK: - Delivering hold state (the vanish-then-reappear bug)

    private func sendEmptyQueueUpdate() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
    }

    /// The core bug: the queue drain broadcasts the EMPTIED queue seconds
    /// before the delivered prompt lands via the ~1s file watcher. The chip
    /// must hold as "delivering" across that gap — the message is never
    /// absent from the UI.
    func testDrainedChipHoldsAsDeliveringUntilEchoLands() async {
        markRunning()
        await send("do this next")
        // Server registers the queued item (replaces the local chip).
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        // Run ends; the drain empties the queue BEFORE the transcript echo.
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["do this next"],
            "the message must stay visible while the echo is in flight"
        )
        // Echo lands: the delivering chip retires; exactly one copy remains.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u9", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u9"])
    }

    /// Race: a queue_update computed before our prompt reached the server
    /// (run ended in the gap; the prompt went straight to the engine) must
    /// not wipe the local chip — it holds as delivering until the entry lands.
    func testLocalChipSurvivesQueueUpdateThatOmitsIt() async {
        markRunning()
        await send("do this next")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["do this next"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// Steered/attributed deliveries land as "[user] content", and a
    /// multi-message drain joins the batch into ONE user entry — containment
    /// must retire every chip the entry covers (mirrors the server's own
    /// steer-receipt reconciliation).
    func testAttributedAndBatchedEchoRetiresDeliveringChips() async {
        markRunning()
        await send("first")
        await send("second")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["first", "second"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] first\n\n[jaap] second")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testDeliveringChipIgnoresUnrelatedUserEntry() async {
        markRunning()
        await send("mine")
        sendEmptyQueueUpdate()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "someone else's")
        ]))
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["mine"])
    }

    /// A queue_update that re-lists a delivering chip's message (the prompt
    /// arrived after the drain frame was computed and got queued after all)
    /// moves it back to a live queue chip instead of duplicating it.
    func testRequeuedMessageLeavesDeliveringState() async {
        markRunning()
        await send("do this next")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        let requeued = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(requeued.utf8)))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
    }

    /// A resync's transcript_init is a full snapshot — no upsert runs on it,
    /// so a delivering chip whose message it already contains (attributed
    /// form here) must retire there instead of lingering.
    func testResyncInitRetiresDeliveredChip() async {
        markRunning()
        await send("do this next")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ], cursor: .empty))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// Ghost protection: a chip whose echo never comes (deleted from another
    /// device, server restart) drops once the grace window passes — but not
    /// a moment before.
    func testDeliveringChipExpiresOnlyAfterGrace() async {
        markRunning()
        await send("gone")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.pruneExpiredDelivering(
            now: Date().addingTimeInterval(viewModel.deliveringGrace - 5)
        )
        XCTAssertEqual(viewModel.deliveringItems.count, 1, "still within the grace window")
        viewModel.pruneExpiredDelivering(
            now: Date().addingTimeInterval(viewModel.deliveringGrace + 5)
        )
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    /// A re-send of an identical message must not be retired against the OLD
    /// copy in history: the drain holds it as delivering until ITS echo
    /// lands. (The whole-history containment scan dropped it immediately and
    /// blinked the message out — the steering vanish-then-reappear.)
    func testRepeatedSendHoldsAsDeliveringDespiteIdenticalOldMessage() async {
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue"),
            entry("a1", "assistant", text: "done"),
        ], cursor: .empty))
        markRunning()
        await send("continue")
        sendEmptyQueueUpdate()
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["continue"],
            "the old identical message must not count as this chip's echo"
        )
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u2", "user", text: "continue")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1", "a1", "u2"])
    }

    /// Same protection on the resync path: a snapshot that re-lists only
    /// entries we already hold must not retire a delivering chip — only a
    /// NEW entry (an id we didn't know) counts as its echo.
    func testResyncInitKeepsDeliveringChipAgainstOldIdenticalMessage() async {
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ], cursor: .empty))
        markRunning()
        await send("continue")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["continue"],
            "an old identical entry in the snapshot is not this chip's echo"
        )
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue"),
            entry("u2", "user", text: "[jaap] continue"),
        ], cursor: .empty))
        XCTAssertTrue(
            viewModel.deliveringItems.isEmpty,
            "the snapshot carrying the NEW echo retires the chip"
        )
    }

    /// Echo-before-drain ordering: when the durable entry lands while the
    /// server still lists the chip as queued, the eventual drain drops the
    /// chip outright instead of resurrecting a delivered message as a
    /// "Delivering…" ghost.
    func testDrainDropsChipWhoseEchoAlreadyLanded() async {
        markRunning()
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"], "server chips retire only via queue_update")
        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
    }

    /// The steer flow end-to-end: steered receipt → drain → attributed echo.
    /// The message must be visible at every step.
    func testSteeredChipHoldsAcrossDrainUntilEchoLands() async {
        markRunning()
        let steered = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],
         "steered":[{"id":"s1","content":"go left","user":"jaap"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(steered.utf8)))
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["s1"])
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["go left"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] go left")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    // MARK: - Stale-busy sends (bubble ↔ queue reconciliation)

    /// A resync racing the ~1s persist of a just-delivered send must not wipe
    /// its optimistic bubble — the snapshot doesn't contain the message yet.
    func testResyncInitKeepsUnlandedOptimisticBubble() async {
        await send("hi there")
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u0", "user", text: "earlier message")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.entries.map(\.text), ["earlier message", "hi there"],
            "the unlanded bubble must survive the snapshot"
        )
        // The echo then replaces the preserved bubble without duplication.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi there")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u0", "u1"])
    }

    func testResyncInitRetiresLandedOptimisticBubble() async {
        await send("hi there")
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi there")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.entries.map(\.id), ["u1"],
            "a landed echo must replace the bubble, not join it"
        )
    }

    /// The stale-isRunning hole: the client thought the session idle (bubble
    /// echo), but the server was mid-run and QUEUED the prompt. The bubble
    /// converts to the server's queue chip — one representation, no thread
    /// copy for the next resync to wipe — and the message stays visible
    /// through drain and delivery.
    func testStaleBusySendConvertsBubbleToChipWhenServerQueuesIt() async {
        await send("do this next")
        XCTAssertEqual(viewModel.entries.map(\.text), ["do this next"])
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        XCTAssertTrue(viewModel.entries.isEmpty, "the queue chip now represents the message")
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        // A resync mid-queue has nothing to wipe — the chip carries on.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [], cursor: .empty))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        // Drain → delivering hold → attributed echo lands exactly once.
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["do this next"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }
}

/// Records every outgoing frame; never touches the network.
@MainActor
private final class MockSocket: SessionSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    struct PromptCall {
        let sessionId: String
        let content: String
        let user: String
        let images: [String]?
        let effort: String?
        let fastMode: Bool?
        let busyMode: String?
    }

    private(set) var connectCount = 0
    private(set) var disconnectCount = 0
    private(set) var watched: [String] = []
    private(set) var watchResumes: [TranscriptResumeCursor?] = []
    private(set) var prompts: [PromptCall] = []
    private(set) var steeredQueueIds: [String] = []
    private(set) var deletedQueueIds: [String] = []
    private(set) var takenQueueIds: [String] = []
    private(set) var takenSteerIds: [String] = []
    private(set) var reorders: [[String]] = []
    private(set) var awayFrames: [Bool] = []
    private(set) var typingFrames: [(sessionId: String, typing: Bool)] = []

    /// Every earlier-history request, in order — the backlog walk behind
    /// "jump to the start" is a sequence of these.
    enum HistoryRequest: Equatable {
        case seq(Int, limit: Int?)
        case offset(Int)
        case whole
    }
    private(set) var historyRequests: [HistoryRequest] = []

    func connect() { connectCount += 1 }
    func disconnect() { disconnectCount += 1 }
    func watch(sessionId: String, resume: TranscriptResumeCursor?) {
        watched.append(sessionId)
        watchResumes.append(resume)
    }
    func setAway(_ away: Bool) { awayFrames.append(away) }
    func setTyping(sessionId: String, typing: Bool) {
        typingFrames.append((sessionId, typing))
    }
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {
        historyRequests.append(.offset(beforeOffset))
    }
    func loadHistory(sessionId: String, beforeSeq: Int, limit: Int?) {
        historyRequests.append(.seq(beforeSeq, limit: limit))
    }
    func loadWholeHistory(sessionId: String) {
        historyRequests.append(.whole)
    }
    func prompt(
        sessionId: String, content: String, user: String,
        images: [String]?, effort: String?, fastMode: Bool?, busyMode: String?
    ) {
        prompts.append(PromptCall(
            sessionId: sessionId, content: content, user: user,
            images: images, effort: effort, fastMode: fastMode, busyMode: busyMode
        ))
    }
    func steerQueued(sessionId: String, queueId: String) { steeredQueueIds.append(queueId) }
    func deleteQueued(sessionId: String, queueId: String) { deletedQueueIds.append(queueId) }
    var interruptedQueueIds: [String] = []
    func interruptQueued(sessionId: String, queueId: String) { interruptedQueueIds.append(queueId) }
    func takeQueued(sessionId: String, queueId: String) { takenQueueIds.append(queueId) }
    func takeSteered(sessionId: String, queueId: String) { takenSteerIds.append(queueId) }
    func reorderQueued(sessionId: String, order: [String]) { reorders.append(order) }
    func cancelWatchedRun() {}
    func answer(sessionId: String, questionId: String, answers: [String: String]?) {}
}
