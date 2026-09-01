import CoreGraphics

/// The transcript's "is the reader at the latest message?" test, kept out of
/// the view so it can be checked against real numbers instead of by eye.
///
/// It got this treatment after being wrong in a way no reading caught: the
/// obvious spelling, `contentOffset.y + containerSize.height`, silently
/// measures a full inset-height short of the bottom, because `containerSize`
/// excludes the scroll view's content insets while the offset and content size
/// include them. On an iPhone that is 257pt against an 80pt tolerance, so the
/// answer was "not pinned" for a reader sitting on the newest message — and
/// the return pill sat parked over the last line for months.
enum TranscriptScroll {
    /// Geometry of the transcript scroll view, in the fields `ScrollGeometry`
    /// hands over.
    struct Geometry: Equatable {
        /// Bottom edge of the visible region, in content coordinates.
        var visibleMaxY: CGFloat
        var contentHeight: CGFloat
        var insetBottom: CGFloat
        /// The unobstructed visible height (`containerSize.height`). Only
        /// needed to recognize a transcript that doesn't scroll at all;
        /// zero — unknown — simply never claims that.
        var containerHeight: CGFloat = 0
    }

    struct FollowState: Equatable {
        var pinned: Bool
        var readerMovedTowardHistory: Bool
    }

    /// How far the visible bottom edge is from as far down as the view goes.
    /// Zero at a dragged-to-the-end bottom; positive above it.
    static func distanceFromBottom(_ geometry: Geometry) -> CGFloat {
        geometry.contentHeight + geometry.insetBottom - geometry.visibleMaxY
    }

    /// Where the reader is, measured from the END of the transcript.
    ///
    /// This is the coordinate a page of earlier history does not move: its
    /// rows land above everything on screen, so the distance from the content's
    /// end is the same before and after, while the offset from the TOP has
    /// grown by the whole page.
    static func distanceFromEnd(offset: CGFloat, contentHeight: CGFloat) -> CGFloat {
        contentHeight - offset
    }

    /// What to hand `ScrollPosition.scrollTo(y:)` to put the reader back where
    /// a prepend found them.
    ///
    /// The inverse of `distanceFromEnd`, plus the top inset, and both halves
    /// are load-bearing. It is a function rather than one line at the call
    /// site because the restore re-runs as the prepended rows settle:
    /// markdown parses asynchronously and the lazy stack realizes rows as it
    /// goes, so `contentHeight` keeps climbing for a beat after the page
    /// arrives and the answer has to be recomputed against the newest one.
    ///
    /// The inset is the trap. `scrollTo(y:)` measures from the top of the
    /// content AREA, while `contentOffset` — what `distanceFromEnd` is built
    /// from — starts one top inset above it. Without the term every restore
    /// lands short by the height of the navigation bar; measured on an iPhone
    /// 17 Pro, exactly 116pt, on every tick.
    static func restoredScrollY(
        distanceFromEnd: CGFloat,
        contentHeight: CGFloat,
        insetTop: CGFloat,
        minimumContentHeight: CGFloat = 0
    ) -> CGFloat? {
        guard contentHeight >= minimumContentHeight else { return nil }
        let y = contentHeight - distanceFromEnd + insetTop
        // A LazyVStack can briefly report less content than it had before the
        // prepend while it re-realizes rows. There is no valid position above
        // zero, so wait for the next measurement instead of clamping to top.
        return y >= 0 ? y : nil
    }

    /// Whether new output should follow the reader down.
    ///
    /// `tolerance` has to clear the transcript's trailing padding: scrolling to
    /// the bottom aligns the LAST BLOCK's bottom edge with the visible bottom,
    /// which deliberately leaves the composer's scrim run-up below the fold —
    /// so even "as far down as this view ever scrolls itself" sits that far
    /// from the content's end.
    static func isNearBottom(_ geometry: Geometry, tolerance: CGFloat) -> Bool {
        // A transcript that fits the screen has no bottom to be away from —
        // and since the content stack is floored at one viewport, a short one
        // measures as exactly that, which the distance test alone reads as a
        // full inset-height short of the end.
        if geometry.contentHeight <= geometry.containerHeight { return true }
        return distanceFromBottom(geometry) <= tolerance
    }

    /// Whether a measured tail-height change should be followed immediately.
    /// A settling hold covers programmatic navigation whose intermediate
    /// geometry frame briefly falls outside the bottom tolerance.
    static func shouldFollowContentGrowth(
        previousContentHeight: CGFloat,
        contentHeight: CGFloat,
        readerMovedTowardHistory: Bool,
        wasFollowing: Bool,
        holdingAtLatest: Bool,
        readerScrollActive: Bool
    ) -> Bool {
        contentHeight > previousContentHeight
            && !readerMovedTowardHistory
            && (wasFollowing || (holdingAtLatest && !readerScrollActive))
    }

    /// Keep an upward reader gesture authoritative even when it remains inside
    /// the near-bottom tolerance. Layout-driven scroll updates must not re-arm
    /// following until the reader moves back toward the latest message.
    static func followState(
        previousOffset: CGFloat,
        offset: CGFloat,
        previousContentHeight: CGFloat,
        contentHeight: CGFloat,
        previousDistanceFromBottom: CGFloat,
        isNearBottom: Bool,
        readerGestureActive: Bool,
        layoutChanged: Bool,
        readerMovedTowardHistory: Bool
    ) -> FollowState {
        var movedTowardHistory = readerMovedTowardHistory
        if readerGestureActive, !layoutChanged {
            let offsetDelta = offset - previousOffset
            let contentDelta = contentHeight - previousContentHeight
            // Tail growth may move the offset down by the same amount; tail
            // shrinkage may clamp it up. Remove those automatic components
            // before interpreting movement as the reader's.
            let towardHistory = offsetDelta - min(contentDelta, 0)
            let towardLatest = offsetDelta - max(contentDelta, 0)
            if towardHistory < -0.5, previousDistanceFromBottom >= 0 {
                movedTowardHistory = true
            } else if towardLatest > 0.5, isNearBottom {
                movedTowardHistory = false
            }
        }
        return FollowState(
            pinned: isNearBottom && !movedTowardHistory,
            readerMovedTowardHistory: movedTowardHistory
        )
    }
}

/// The two numbers the prepend restore works from, as one `Equatable` value so
/// `onScrollGeometryChange` reports them together — the restore needs the pair
/// as it was BEFORE the page landed, and two observers would not agree on that.
struct TranscriptGeometry: Equatable {
    var offset: CGFloat
    var contentHeight: CGFloat
    /// The top inset the navigation bar takes, for `restoredScrollY`.
    var insetTop: CGFloat
    var visibleMaxY: CGFloat
    var insetBottom: CGFloat
    var containerHeight: CGFloat
}
