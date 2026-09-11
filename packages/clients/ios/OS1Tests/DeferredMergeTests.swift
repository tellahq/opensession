import XCTest
@testable import OS1

/// The five-second merge window, driven by a manual clock: nothing here waits
/// on wall time, and every tick is a step the test takes on purpose.
@MainActor
final class DeferredMergeTests: XCTestCase {
    private var clock: ManualClock!
    private var merge: DeferredMerge!
    private var sends = 0
    private var results: [Result<Void, any Error>] = []
    /// Holds one send open so the in-flight phase can be observed.
    private var release: CheckedContinuation<Void, Never>?

    override func setUp() {
        super.setUp()
        clock = ManualClock()
        merge = DeferredMerge(clock: clock)
        sends = 0
        results = []
    }

    override func tearDown() {
        merge?.cancel()
        merge = nil
        super.tearDown()
    }

    private struct SendFailed: Error {}

    @discardableResult
    private func schedule(
        window: Duration = DeferredMerge.undoWindow,
        failing: Bool = false
    ) -> Bool {
        merge.schedule(window: window) { [self] in
            sends += 1
            if failing { throw SendFailed() }
        } completion: { [self] result in
            results.append(result)
        }
    }

    /// Let the countdown task reach its next suspension point.
    private func settle() async {
        for _ in 0..<8 { await Task.yield() }
    }

    /// One second at a time: the countdown re-arms its sleep after each tick,
    /// so a single large jump would only land the first of them.
    private func tick(seconds: Int) async {
        for _ in 0..<seconds {
            await settle()
            clock.advance(by: .seconds(1))
            await settle()
        }
    }

    func testWindowMatchesTheWebClient() {
        XCTAssertEqual(DeferredMerge.undoWindow, .seconds(5))
    }

    func testHoldsTheRequestAndCountsTheSecondsDown() async {
        XCTAssertTrue(schedule())
        XCTAssertEqual(merge.phase, .scheduled)
        XCTAssertEqual(merge.secondsLeft, 5)
        XCTAssertEqual(sends, 0)

        await tick(seconds: 1)
        XCTAssertEqual(merge.secondsLeft, 4)
        await tick(seconds: 3)
        XCTAssertEqual(merge.secondsLeft, 1, "the digit never reads zero")
        XCTAssertEqual(merge.phase, .scheduled)
        XCTAssertEqual(sends, 0, "nothing goes out inside the window")

        await tick(seconds: 1)
        XCTAssertEqual(sends, 1)
        XCTAssertEqual(merge.phase, .idle, "settled once the request returned")
        XCTAssertNil(merge.secondsLeft)
        XCTAssertEqual(results.count, 1)
        if case .failure = results.first { XCTFail("the send succeeded") }
    }

    func testUndoInsideTheWindowNeverSends() async {
        schedule()
        await tick(seconds: 2)
        XCTAssertEqual(merge.secondsLeft, 3)

        XCTAssertTrue(merge.cancel())
        XCTAssertEqual(merge.phase, .idle)
        XCTAssertNil(merge.secondsLeft)
        XCTAssertFalse(merge.cancel(), "nothing left to take back")

        await tick(seconds: 10)
        XCTAssertEqual(sends, 0)
        XCTAssertTrue(results.isEmpty)
    }

    func testOneMergeAtATime() async {
        XCTAssertTrue(schedule())
        XCTAssertFalse(schedule(), "a second confirmation cannot queue a second send")

        await tick(seconds: 5)
        XCTAssertEqual(sends, 1)
    }

    func testAnUndoneScheduleCannotFireForItsReplacement() async {
        schedule()
        await tick(seconds: 4)
        merge.cancel()

        XCTAssertTrue(schedule(window: .seconds(2)))
        XCTAssertEqual(merge.secondsLeft, 2)
        await tick(seconds: 1)
        XCTAssertEqual(sends, 0, "the first schedule's last second must not send")
        await tick(seconds: 1)
        XCTAssertEqual(sends, 1)
    }

    func testCannotUndoOnceTheRequestIsOut() async {
        merge.schedule(window: .seconds(1)) { [self] in
            sends += 1
            await withCheckedContinuation { release = $0 }
        }
        await tick(seconds: 1)
        XCTAssertEqual(merge.phase, .running)
        XCTAssertEqual(sends, 1)

        XCTAssertFalse(merge.cancel(), "an in-flight request is not undoable")
        XCTAssertEqual(merge.phase, .running)
        XCTAssertFalse(schedule(), "and holds the slot until it settles")

        release?.resume()
        release = nil
        await settle()
        XCTAssertEqual(merge.phase, .idle)
        XCTAssertEqual(sends, 1)
    }

    func testAFailedSendReportsAndFreesTheSlot() async {
        schedule(window: .seconds(1), failing: true)
        await tick(seconds: 1)

        XCTAssertEqual(merge.phase, .idle)
        XCTAssertEqual(results.count, 1)
        guard case .failure(let error) = results.first else {
            return XCTFail("expected the send's failure")
        }
        XCTAssertTrue(error is SendFailed)
        XCTAssertTrue(schedule(), "a failed merge can be tried again")
    }
}
