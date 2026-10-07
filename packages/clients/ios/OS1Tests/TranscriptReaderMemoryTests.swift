import XCTest
@testable import OS1

/// The reader anchor kept across session switches: which block it picks,
/// where it puts the reader back, and the bounded, scoped memory holding it.
@MainActor
final class TranscriptReaderMemoryTests: XCTestCase {
    private let rows: [String: TranscriptRowExtent] = [
        "a": .init(minY: 8, maxY: 400),
        "b": .init(minY: 410, maxY: 2_400),
        "c": .init(minY: 2_410, maxY: 2_600),
    ]

    func testAnchorIsTheBlockUnderTheVisibleTop() {
        XCTAssertEqual(
            TranscriptScroll.readerAnchor(visibleTop: 1_000, rows: rows),
            TranscriptReaderAnchor(blockId: "b", offset: 590)
        )
        XCTAssertEqual(
            TranscriptScroll.readerAnchor(visibleTop: 2_410, rows: rows),
            TranscriptReaderAnchor(blockId: "c", offset: 0)
        )
        // In the gap between rows the block above still owns the edge.
        XCTAssertEqual(TranscriptScroll.readerAnchor(visibleTop: 405, rows: rows)?.blockId, "a")
    }

    func testAboveEveryRowAnchorsTheFirstWithANegativeOffset() {
        XCTAssertEqual(
            TranscriptScroll.readerAnchor(visibleTop: 0, rows: rows),
            TranscriptReaderAnchor(blockId: "a", offset: -8)
        )
        XCTAssertNil(TranscriptScroll.readerAnchor(visibleTop: 100, rows: [:]))
    }

    func testRestoreFollowsTheBlockWhereverItSettles() {
        let anchor = TranscriptReaderAnchor(blockId: "b", offset: 590)
        // Rows above realized taller, or a page of history landed: the block
        // moved down 3,000pt and the passage goes with it.
        XCTAssertEqual(TranscriptScroll.restoredScrollY(for: anchor, rowMinY: 3_410), 4_000)
        XCTAssertEqual(
            TranscriptScroll.restoredScrollY(
                for: TranscriptReaderAnchor(blockId: "a", offset: -8), rowMinY: 8
            ),
            0
        )
        XCTAssertEqual(
            TranscriptScroll.restoredScrollY(
                for: TranscriptReaderAnchor(blockId: "a", offset: -20), rowMinY: 8
            ),
            0,
            "never above the content's top"
        )
    }

    func testRoundTripThroughTheTracker() {
        let tracker = TranscriptReaderTracker()
        for (id, row) in rows { tracker.record(id, row) }
        tracker.visibleTop = 1_234
        let anchor = try! XCTUnwrap(tracker.anchor)
        tracker.forget("b")
        XCTAssertEqual(tracker.anchor?.blockId, "a", "a row that left the stack is not an anchor")
        // After reopening with the block measured elsewhere.
        XCTAssertEqual(TranscriptScroll.restoredScrollY(for: anchor, rowMinY: 510), 1_334)
    }

    private let orgA = TranscriptReaderMemory.Scope(accountId: "acct-a", server: "https://a.example.test")
    private let orgB = TranscriptReaderMemory.Scope(accountId: "acct-b", server: "https://b.example.test")

    func testMemoryIsScopedToAccountServerAndSession() {
        let memory = TranscriptReaderMemory()
        let anchor = TranscriptReaderAnchor(blockId: "e1", offset: 12)
        memory.remember(anchor, sessionId: "bks-1", scope: orgA)
        XCTAssertEqual(memory.anchor(sessionId: "bks-1", scope: orgA), anchor)
        XCTAssertNil(memory.anchor(sessionId: "bks-1", scope: orgB))
        XCTAssertNil(memory.anchor(
            sessionId: "bks-1",
            scope: .init(accountId: "acct-a", server: "https://other.example.test")
        ))
        XCTAssertNil(memory.anchor(sessionId: "bks-2", scope: orgA))
    }

    func testLeavingAtTheLiveEdgeForgets() {
        let memory = TranscriptReaderMemory()
        memory.remember(.init(blockId: "e1", offset: 0), sessionId: "bks-1", scope: orgA)
        memory.remember(nil, sessionId: "bks-1", scope: orgA)
        XCTAssertNil(memory.anchor(sessionId: "bks-1", scope: orgA))
        XCTAssertEqual(memory.count, 0)
    }

    func testMemoryIsBoundedToTheMostRecentlyRemembered() {
        let memory = TranscriptReaderMemory(capacity: 3)
        for index in 1...3 {
            memory.remember(.init(blockId: "e\(index)", offset: 0), sessionId: "bks-\(index)", scope: orgA)
        }
        // Re-remembering refreshes recency.
        memory.remember(.init(blockId: "e1b", offset: 4), sessionId: "bks-1", scope: orgA)
        memory.remember(.init(blockId: "e4", offset: 0), sessionId: "bks-4", scope: orgA)
        XCTAssertEqual(memory.count, 3)
        XCTAssertNil(memory.anchor(sessionId: "bks-2", scope: orgA), "the oldest goes first")
        XCTAssertEqual(memory.anchor(sessionId: "bks-1", scope: orgA)?.blockId, "e1b")
        XCTAssertNotNil(memory.anchor(sessionId: "bks-3", scope: orgA))
        XCTAssertNotNil(memory.anchor(sessionId: "bks-4", scope: orgA))
        XCTAssertEqual(TranscriptReaderMemory.capacity, 200)
    }
}
