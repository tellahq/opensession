import XCTest
@testable import OS1

/// `SessionViewModel.presentedConnectionState` is what the session screen
/// paints. It lags the transport by eight seconds of foreground time on a
/// drop and nothing else, so a Wi-Fi blip or a background round trip never
/// flashes the orange reconnect banner. These tests drive the grace period
/// with a manual clock, so nothing here waits on wall time.
@MainActor
final class ConnectionPresentationTests: XCTestCase {
    private var clock: ManualClock!
    private var sockets: [PresentationSocket] = []
    private var viewModel: SessionViewModel!

    override func setUp() {
        super.setUp()
        clock = ManualClock()
        sockets = []
        viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { [unowned self] in
                let socket = PresentationSocket()
                sockets.append(socket)
                return socket
            },
            clock: clock
        )
    }

    override func tearDown() {
        viewModel?.stop()
        viewModel = nil
        super.tearDown()
    }

    /// Open the session, land the handshake and a transcript, so both states
    /// read connected. The transcript matters: `connect()` rewrites a
    /// reconnect on an empty transcript as `.connecting`.
    private func connect(entries: [TranscriptEntry] = [TranscriptEntry(id: "e1", type: "assistant", content: "hi")]) {
        viewModel.start()
        viewModel.handle(.hello(bootId: "boot-1"))
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: entries, cursor: .empty))
        XCTAssertEqual(viewModel.connectionState, .connected)
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)
    }

    private func drop(_ reason: String? = "connection lost") async {
        sockets.last?.onClose?(reason)
        await settle()
    }

    /// Let tasks the view model spawned reach their next suspension point.
    private func settle() async {
        for _ in 0..<8 { await Task.yield() }
    }

    private func advance(by duration: Duration) async {
        clock.advance(by: duration)
        await settle()
    }

    func testGraceMatchesTheWebClient() {
        XCTAssertEqual(SessionViewModel.connectionPresentationGrace, .seconds(8))
    }

    func testRecoveryInsideTheGraceNeverPresentsReconnecting() async {
        connect()
        await drop()

        XCTAssertEqual(viewModel.connectionState, .reconnecting("connection lost"))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        await advance(by: .seconds(7))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "still inside the grace")

        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "recovery shows at once")

        await advance(by: .seconds(10))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "the old deadline was cancelled")
    }

    func testSustainedOutagePresentsReconnectingAfterTheGrace() async {
        connect()
        await drop()

        await advance(by: .seconds(7))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        await advance(by: .seconds(1))
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting("connection lost"))

        // Later retries and their failures repaint immediately: the banner is
        // already up, so there is nothing left to protect.
        await drop("timed out")
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting("timed out"))

        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)
    }

    func testBackgroundTimeDoesNotCountTowardTheGrace() async {
        connect()
        await drop()
        await advance(by: .seconds(5))

        viewModel.appDidEnterBackground()
        await advance(by: .seconds(60))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "nothing counts while away")

        // Returning reconnects straight away and starts a fresh grace.
        viewModel.appDidBecomeActive()
        await settle()
        XCTAssertEqual(viewModel.connectionState, .reconnecting(nil))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        await advance(by: .seconds(7))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "the five seconds before backgrounding were discarded")

        await advance(by: .seconds(1))
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil))
    }

    func testEmptyTranscriptChurnIsDeferredToo() async {
        connect(entries: [])
        viewModel.appDidEnterBackground()
        await drop()
        viewModel.appDidBecomeActive()
        await settle()
        XCTAssertEqual(viewModel.connectionState, .connecting, "an empty transcript reconnects as connecting")
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "still a drop from a presented connection")

        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        await drop()
        viewModel.appDidEnterBackground()
        viewModel.appDidBecomeActive()
        await advance(by: .seconds(8))
        XCTAssertEqual(viewModel.presentedConnectionState, .connecting, "the grace presents whatever the transport says")
    }

    func testDropWhileBackgroundedWaitsForTheForeground() async {
        connect()
        viewModel.appDidEnterBackground()
        await drop()
        await advance(by: .seconds(30))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        viewModel.appDidBecomeActive()
        await advance(by: .seconds(8))
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil))
    }

    func testPresentedOutageIsFoldedBackWhileBackgrounded() async {
        connect()
        await drop()
        await advance(by: .seconds(9))
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil))

        // Like the web client while hidden, the outage comes off screen.
        viewModel.appDidEnterBackground()
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        // Connectivity came back meanwhile: the foreground handshake must not
        // flash the banner it had before.
        viewModel.appDidBecomeActive()
        await settle()
        XCTAssertEqual(viewModel.connectionState, .reconnecting(nil))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "no flash through the handshake")
        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)
    }

    func testOutageThatOutlivesTheBackgroundGetsAFreshGrace() async {
        connect()
        await drop()
        await advance(by: .seconds(9))
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil))

        viewModel.appDidEnterBackground()
        viewModel.appDidBecomeActive()
        await settle()
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)

        await advance(by: .seconds(7))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "the earlier outage does not count")
        await advance(by: .seconds(1))
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil))
    }

    func testAnnouncedServerRestartKeepsItsBannerWhileBackgrounded() async {
        connect()
        viewModel.handle(.serverRestarting)
        await drop("server restarting")
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting("server restarting"))

        viewModel.appDidEnterBackground()
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting("server restarting"))
    }

    func testNeverConnectedReconnectIsNotFoldedBack() async {
        viewModel.start()
        await drop()
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil), "a drop before the handshake shows at once")

        // Nothing was ever on screen to fold back to.
        viewModel.appDidEnterBackground()
        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting(nil))
    }

    func testAnnouncedServerRestartPresentsImmediately() async {
        connect()
        viewModel.handle(.serverRestarting)
        await drop("server restarting")

        XCTAssertEqual(viewModel.presentedConnectionState, .reconnecting("server restarting"))

        viewModel.handle(.hello(bootId: "boot-2"))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected)
    }

    func testInitialConnectAndLoadFailurePresentImmediately() async {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("os1-presentation-tests-\(UUID().uuidString)", isDirectory: true)
        let outbox = Outbox(directory: directory, monitorNetwork: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let socket = PresentationSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket },
            outbox: outbox,
            conversationLoadTimeout: 0.01,
            clock: clock
        )
        defer { viewModel.stop() }

        viewModel.start()
        XCTAssertEqual(viewModel.presentedConnectionState, .connecting)

        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(viewModel.presentedConnectionState, .failed("Couldn't load conversation"))

        viewModel.retryConversationLoad()
        XCTAssertEqual(viewModel.presentedConnectionState, .connecting, "a retry clears the failure at once")
    }

    func testTeardownCancelsThePendingPresentation() async {
        connect()
        await drop()
        viewModel.stop()

        await advance(by: .seconds(20))
        XCTAssertEqual(viewModel.presentedConnectionState, .connected, "a stopped model never repaints")
        XCTAssertEqual(clock.pendingSleepers, 0, "the grace task was cancelled, not left sleeping")
    }
}

/// A `Clock` that only moves when a test says so.
final class ManualClock: Clock, @unchecked Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration

        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        let id: UUID
        let deadline: Instant
        let continuation: CheckedContinuation<Void, any Error>
    }

    private let lock = NSLock()
    private var current = Instant(offset: .zero)
    private var sleepers: [Sleeper] = []

    var now: Instant {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    var minimumResolution: Duration { .zero }

    var pendingSleepers: Int {
        lock.lock(); defer { lock.unlock() }
        return sleepers.count
    }

    func advance(by duration: Duration) {
        lock.lock()
        current = current.advanced(by: duration)
        let due = sleepers.filter { $0.deadline <= current }
        sleepers.removeAll { $0.deadline <= current }
        lock.unlock()
        for sleeper in due { sleeper.continuation.resume() }
    }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                lock.lock()
                if deadline <= current {
                    lock.unlock()
                    continuation.resume()
                    return
                }
                sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                lock.unlock()
            }
        } onCancel: {
            lock.lock()
            let cancelled = sleepers.filter { $0.id == id }
            sleepers.removeAll { $0.id == id }
            lock.unlock()
            for sleeper in cancelled { sleeper.continuation.resume(throwing: CancellationError()) }
        }
    }
}

/// The smallest socket that lets the view model connect, drop and rejoin.
private final class PresentationSocket: SessionSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    func setMutationRejectedHandler(_ handler: @escaping (String) -> Void) {}
    func connect() {}
    func disconnect() {}
    func watch(sessionId: String, resume: TranscriptResumeCursor?) {}
    func setAway(_ away: Bool) {}
    func setTyping(sessionId: String, typing: Bool) {}
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {}
    func loadHistory(sessionId: String, beforeSeq: Int, limit: Int?) {}
    func loadWholeHistory(sessionId: String) {}
    func prompt(
        sessionId: String, content: String, user: String,
        images: [String]?, effort: String?, fastMode: Bool?, busyMode: String?
    ) {}
    func steerQueued(sessionId: String, queueId: String) {}
    func deleteQueued(sessionId: String, queueId: String) {}
    func interruptQueued(sessionId: String, queueId: String) {}
    func takeQueued(sessionId: String, queueId: String) {}
    func takeSteered(sessionId: String, queueId: String) {}
    func reorderQueued(sessionId: String, order: [String]) {}
    func cancelWatchedRun() {}
    func answer(sessionId: String, questionId: String, answers: [String: String]?) {}
}
