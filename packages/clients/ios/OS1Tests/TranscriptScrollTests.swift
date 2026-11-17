import XCTest
@testable import OS1

/// The "am I at the latest message?" test, against numbers a real iPhone
/// reported. This is the arithmetic that decides whether new output follows
/// the reader down and whether the return pill is showing, and it was wrong
/// for months in a way that reading the code did not reveal — so the fixtures
/// here are measurements, not invented values.
final class TranscriptScrollTests: XCTestCase {
    /// iPhone 17 Pro, an OS1 session at rest at the bottom (logged from a
    /// running build): a 4454pt transcript, 874pt of visible height, 116/141pt
    /// content insets, resting 49pt above the content's end because
    /// `scrollToBottom` aligns the last BLOCK, leaving the trailing padding
    /// below the fold.
    private let atRest = TranscriptScroll.Geometry(
        visibleMaxY: 4546,
        contentHeight: 4454,
        insetBottom: 141
    )

    /// The tolerance the view uses on iOS: the composer's scrim run-up plus
    /// slack (OS1VisualStyle.composerScrimRunUp + 60).
    private let tolerance: CGFloat = 100

    func testTheRestingBottomCountsAsPinned() {
        XCTAssertEqual(TranscriptScroll.distanceFromBottom(atRest), 49)
        XCTAssertTrue(TranscriptScroll.isNearBottom(atRest, tolerance: tolerance))
    }

    func testTheOldContainerSizeSpellingWouldHaveMissedIt() {
        // What the predicate used to compute: contentOffset + containerSize,
        // where containerSize excludes both insets. Same scroll position,
        // 257pt of phantom distance — past any sane tolerance. Pinned here to
        // document the trap, since the two spellings look equivalent.
        let contentOffsetY: CGFloat = 3672
        let containerHeight: CGFloat = 617 // 874 visible − 116 − 141
        let asMeasuredBefore = atRest.contentHeight + atRest.insetBottom
            - (contentOffsetY + containerHeight)
        XCTAssertEqual(asMeasuredBefore, 306)
        XCTAssertFalse(asMeasuredBefore <= tolerance)
    }

    func testScrollingUpReleasesThePin() {
        var scrolledUp = atRest
        scrolledUp.visibleMaxY -= 400
        XCTAssertFalse(TranscriptScroll.isNearBottom(scrolledUp, tolerance: tolerance))
    }

    func testSmallUpwardGestureReleasesPinInsideTolerance() {
        var moved = atRest
        moved.visibleMaxY -= 20
        let nearBottom = TranscriptScroll.isNearBottom(moved, tolerance: 76)
        XCTAssertTrue(nearBottom)
        let state = TranscriptScroll.followState(
            previousOffset: 1_000,
            offset: 980,
            previousContentHeight: atRest.contentHeight,
            contentHeight: atRest.contentHeight,
            previousDistanceFromBottom: 49,
            isNearBottom: nearBottom,
            readerGestureActive: true,
            layoutChanged: false,
            readerMovedTowardHistory: false
        )
        XCTAssertFalse(state.pinned)
        XCTAssertTrue(state.readerMovedTowardHistory)
    }

    func testLayoutUpdateCannotUndoUpwardReaderIntent() {
        let state = TranscriptScroll.followState(
            previousOffset: 980,
            offset: 1_010,
            previousContentHeight: atRest.contentHeight,
            contentHeight: atRest.contentHeight + 30,
            previousDistanceFromBottom: 69,
            isNearBottom: true,
            readerGestureActive: true,
            layoutChanged: false,
            readerMovedTowardHistory: true
        )
        XCTAssertFalse(state.pinned)
        XCTAssertTrue(state.readerMovedTowardHistory)
    }

    func testMovingBackToLatestRearmsFollowing() {
        let state = TranscriptScroll.followState(
            previousOffset: 980,
            offset: 1_000,
            previousContentHeight: atRest.contentHeight,
            contentHeight: atRest.contentHeight,
            previousDistanceFromBottom: 69,
            isNearBottom: true,
            readerGestureActive: true,
            layoutChanged: false,
            readerMovedTowardHistory: true
        )
        XCTAssertTrue(state.pinned)
        XCTAssertFalse(state.readerMovedTowardHistory)
    }

    func testRubberBandSnapBackDoesNotReleaseThePin() {
        let state = TranscriptScroll.followState(
            previousOffset: 1_020,
            offset: 1_000,
            previousContentHeight: atRest.contentHeight,
            contentHeight: atRest.contentHeight,
            previousDistanceFromBottom: -20,
            isNearBottom: true,
            readerGestureActive: true,
            layoutChanged: false,
            readerMovedTowardHistory: true
        )
        XCTAssertFalse(state.pinned)
        XCTAssertTrue(state.readerMovedTowardHistory)
        XCTAssertTrue(
            TranscriptScroll.isNearBottom(atRest, tolerance: 56),
            "the idle phase must recognize the real resting bottom and rearm"
        )
    }

    func testLayoutMovementWithoutAGestureCannotRearmFollowing() {
        let state = TranscriptScroll.followState(
            previousOffset: 980,
            offset: 1_000,
            previousContentHeight: atRest.contentHeight,
            contentHeight: atRest.contentHeight,
            previousDistanceFromBottom: 69,
            isNearBottom: true,
            readerGestureActive: false,
            layoutChanged: false,
            readerMovedTowardHistory: true
        )
        XCTAssertFalse(state.pinned)
        XCTAssertTrue(state.readerMovedTowardHistory)
    }

    func testSubmittedAnswerKeepsFollowingWhenTheResponseReplacesItsReceipt() {
        // Reproduction: answering from halfway up starts an animated scroll to
        // the optimistic answer receipt. An intermediate animation frame is
        // still outside the bottom tolerance, so geometry temporarily drops
        // the pin before the resumed run appends its first response row.
        let interruptedScroll = TranscriptScroll.followState(
            previousOffset: 1_000,
            offset: 1_600,
            previousContentHeight: 4_000,
            contentHeight: 4_000,
            previousDistanceFromBottom: 2_000,
            isNearBottom: false,
            readerGestureActive: false,
            layoutChanged: false,
            readerMovedTowardHistory: false
        )
        XCTAssertFalse(interruptedScroll.pinned)

        XCTAssertFalse(TranscriptScroll.shouldFollowContentGrowth(
            previousContentHeight: 4_000,
            contentHeight: 4_240,
            readerMovedTowardHistory: interruptedScroll.readerMovedTowardHistory,
            wasFollowing: interruptedScroll.pinned,
            holdingAtLatest: false,
            readerScrollActive: false
        ))
        // Answer submission arms the same settling hold as an ordinary send.
        // That hold makes the response's first measured height change reclaim
        // the bottom even though the animation's intermediate frame lost it.
        XCTAssertTrue(TranscriptScroll.shouldFollowContentGrowth(
            previousContentHeight: 4_000,
            contentHeight: 4_240,
            readerMovedTowardHistory: interruptedScroll.readerMovedTowardHistory,
            wasFollowing: interruptedScroll.pinned,
            holdingAtLatest: true,
            readerScrollActive: false
        ))
    }

    func testInsetLayoutCannotRearmFollowingDuringAGesture() {
        let state = TranscriptScroll.followState(
            previousOffset: 980,
            offset: 1_020,
            previousContentHeight: atRest.contentHeight,
            contentHeight: atRest.contentHeight,
            previousDistanceFromBottom: 69,
            isNearBottom: true,
            readerGestureActive: true,
            layoutChanged: true,
            readerMovedTowardHistory: true
        )
        XCTAssertFalse(state.pinned)
        XCTAssertTrue(state.readerMovedTowardHistory)
    }

    func testDraggingPastTheEndStaysPinned() {
        // Rubber-banding puts the visible edge beyond the content; a negative
        // distance is still "at the bottom", not a wrap-around.
        var overscrolled = atRest
        overscrolled.visibleMaxY += 120
        XCTAssertTrue(TranscriptScroll.isNearBottom(overscrolled, tolerance: tolerance))
    }

    func testAShortTranscriptIsAlwaysPinned() {
        // Content shorter than the viewport: nothing to scroll, so output must
        // keep following.
        let short = TranscriptScroll.Geometry(
            visibleMaxY: 874, contentHeight: 300, insetBottom: 141
        )
        XCTAssertTrue(TranscriptScroll.isNearBottom(short, tolerance: tolerance))
    }

    func testATranscriptFlooredToOneViewportIsPinned() {
        // A new session reads from the top because the content stack is never
        // shorter than the viewport — so a two-message transcript measures as
        // exactly one screenful and rests a full inset-height from the "end",
        // which the distance test alone calls scrolled away. It isn't: there
        // is nowhere to scroll, so the return pill must stay hidden and new
        // output must keep following.
        let floored = TranscriptScroll.Geometry(
            visibleMaxY: 758, contentHeight: 617, insetBottom: 141,
            containerHeight: 617
        )
        XCTAssertEqual(TranscriptScroll.distanceFromBottom(floored), 0)
        XCTAssertTrue(TranscriptScroll.isNearBottom(floored, tolerance: tolerance))
    }

    func testTheFloorNeverSwallowsARealScrollPosition() {
        // The short-circuit reads a HEIGHT, not a position: a long transcript
        // scrolled up is still scrolled up.
        var scrolledUp = atRest
        scrolledUp.containerHeight = 617
        scrolledUp.visibleMaxY -= 400
        XCTAssertFalse(TranscriptScroll.isNearBottom(scrolledUp, tolerance: tolerance))
    }
}

/// A page of history landing above the reader: the held row's bottom edge
/// says how far the reader has to move with it.
final class TranscriptPrependHoldTests: XCTestCase {
    func testTheReaderMovesWithEachNewLayoutOfTheirRow() {
        var hold = TranscriptPrependHold(blockId: "b", maxY: 900, measured: true)
        XCTAssertEqual(hold.moved(toMaxY: 900), nil, "the same report is not a move")
        XCTAssertEqual(hold.moved(toMaxY: 2_300), 1_400, "the page laid out above it")
        XCTAssertEqual(hold.moved(toMaxY: 2_260), -40, "the page's rows realized smaller")
        XCTAssertEqual(hold.moved(toMaxY: 2_260), nil)
    }

    func testABlockThePageFormedIsMeasuredAgainstWhereItsOldSelfEnded() {
        // A turn split across the page boundary comes back as a new block:
        // its first report counts even when it matches the old bottom edge's
        // value, and only the difference from that edge moves the reader.
        var hold = TranscriptPrependHold(blockId: "merged", maxY: 4_000, measured: false)
        XCTAssertEqual(hold.moved(toMaxY: 4_000.25), nil, "sub-point noise is not a move")
        XCTAssertEqual(hold.moved(toMaxY: 6_000), 1_999.75, "older entries joined it above the reader")
    }
}

/// Fold state has to outlive its row: inside a `LazyVStack` a row's `@State`
/// dies when it scrolls out of the realization window, which is why this lives
/// on the view model. These pin the rules that make a fold feel stable.
@MainActor
final class FoldStateTests: XCTestCase {
    private func turn(_ id: String, live: Bool = false, tools: Int = 3) -> WorkTurn {
        WorkTurn(
            id: id,
            anchorId: id,
            items: [],
            isLive: live,
            duration: nil,
            families: [.run],
            toolCount: tools,
            failureCount: 0,
            touchedFiles: [],
            lineStats: ToolLineStats(),
            hasMedia: false,
            featuredMedia: TranscriptMedia(),
            livePreview: nil,
            hasNarration: false
        )
    }

    func testAFoldYouOpenedStaysOpenAcrossRebuilds() {
        let store = FoldStateStore()
        let state = store.fold(for: turn("t1"), preference: TurnActivity(work: .folded))
        state.toggle()
        XCTAssertTrue(state.expanded)
        // The display pass rebuilds blocks constantly (every 1s append).
        XCTAssertTrue(
            store.fold(for: turn("t1"), preference: TurnActivity(work: .folded)).expanded
        )
    }

    func testASettledFoldNeverReopensItself() {
        // A turn above the reader changing height on its own is how a
        // transcript loses your place, so only the live tail re-derives.
        let store = FoldStateStore()
        let settled = store.fold(for: turn("t1"), preference: TurnActivity(work: .folded))
        XCTAssertFalse(settled.expanded)
        _ = store.fold(for: turn("t1"), preference: TurnActivity(work: .open))
        XCTAssertFalse(settled.expanded)
    }

    func testTheLiveTurnFollowsThePreferenceUntilYouTouchIt() {
        let store = FoldStateStore()
        let live = store.fold(
            for: turn("t1", live: true),
            preference: TurnActivity(work: .folded)
        )
        XCTAssertFalse(live.expanded)
        _ = store.fold(for: turn("t1", live: true), preference: TurnActivity(work: .open))
        XCTAssertTrue(live.expanded, "a live fold may still adopt a new default")

        live.toggle()
        XCTAssertFalse(live.expanded)
        _ = store.fold(for: turn("t1", live: true), preference: TurnActivity(work: .open))
        XCTAssertFalse(live.expanded, "once you decide, the default stops winning")
    }

    func testTheLiveTailFoldsOnceItSettles() {
        // Open while it works, folded the moment it finishes, even when the
        // turn keeps its id across the settle.
        let store = FoldStateStore()
        let preference = TurnActivity(work: .running)
        var live = turn("t1", live: true)
        live.hasNarration = true
        let state = store.fold(for: live, preference: preference)
        XCTAssertTrue(state.expanded, "open while the turn works")

        var settled = live
        settled.isLive = false
        _ = store.fold(for: settled, preference: preference)
        XCTAssertFalse(state.expanded, "folds as it settles")

        state.toggle()
        _ = store.fold(for: settled, preference: preference)
        XCTAssertTrue(state.expanded, "reopened by hand, it stays open")
    }

    func testAFoldYouTouchedWhileLiveKeepsYourChoiceWhenItSettles() {
        let store = FoldStateStore()
        let preference = TurnActivity(work: .folded)
        var live = turn("t1", live: true)
        live.hasNarration = true
        let state = store.fold(for: live, preference: preference)
        state.toggle()
        XCTAssertTrue(state.expanded)

        var settled = live
        settled.isLive = false
        _ = store.fold(for: settled, preference: preference)
        XCTAssertTrue(state.expanded, "a fold you opened yourself stays open")
    }

    func testATurnFoldAndItsFirstToolCallFoldSeparately() {
        // A turn takes its first item's id, which for a tool-led turn is
        // also that tool row's id. The two must not share one state.
        let store = FoldStateStore()
        let fold = store.fold(for: turn("tool-u1"), preference: TurnActivity(work: .open))
        let tool = store.expansion(id: "tool-u1", defaultExpanded: false)
        XCTAssertTrue(fold.expanded, "Open keeps the work open")
        XCTAssertFalse(tool.expanded, "opening the work leaves its first call closed")
        tool.toggle()
        XCTAssertTrue(tool.expanded)
        XCTAssertTrue(fold.expanded, "opening a call leaves the work as it was")
        tool.toggle()
        XCTAssertTrue(fold.expanded, "closing a call does not close the work")
    }

    func testNestedExpansionFollowsItsDefaultUntilYouTouchIt() {
        let store = FoldStateStore()
        let state = store.expansion(id: "run-t1", defaultExpanded: false)
        XCTAssertFalse(state.expanded)

        _ = store.expansion(id: "run-t1", defaultExpanded: true)
        XCTAssertTrue(state.expanded, "Always expanded should apply without remounting")

        state.toggle()
        XCTAssertFalse(state.expanded)
        _ = store.expansion(id: "run-t1", defaultExpanded: true)
        XCTAssertFalse(state.expanded, "a manual nested toggle still wins")
    }

    func testFoldedPreferenceKeepsSettledTurnsClosed() {
        var toolOnly = turn("t1", tools: 4)
        toolOnly.failureCount = 1
        XCTAssertFalse(
            toolOnly.defaultExpanded(preference: TurnActivity(work: .folded)),
            "the one tool-only summary should stay closed until opened"
        )

        var narrated = turn("t2", tools: 4)
        narrated.items = [
            .message(TranscriptEntry(id: "note", type: "assistant", content: "Checking.")),
        ]
        narrated.hasNarration = true
        narrated.failureCount = 1
        XCTAssertFalse(narrated.defaultExpanded(preference: TurnActivity(work: .folded)))

        XCTAssertTrue(narrated.defaultExpanded(preference: TurnActivity(work: .open)))
    }
}
