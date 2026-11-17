import SwiftUI

/// A PR review handoff and the work it triggered, folded like a worker.
///
/// A review round arrives as a pile of ordinary rows — the handoff notice, the
/// fix turns, the push, then the next handoff — which is the noisiest thing a
/// phone transcript can hold, and none of it is what the reader came for.
/// Closed, this row says what the loop concluded: GitHub's live verdict while
/// the PR is open, or the durable outcome the settle notice recorded ("Review
/// passed", "Over to humans") once it is merged and the live verdict is gone.
/// Opened, it shows the same icon-led step rows as any other turn, with the
/// verdict at the end. Mirrors the web viewer's `ReviewLoopBlock`.
///
/// The same row folds a check-back phase (`ReviewLoop.Kind.checkBack`): turns
/// the agent started itself, from a background wait or its own scheduled
/// check-back. Closed it reads "Checked back 3 times ›"; the last turn's answer
/// stays outside as the report. Mirrors the web's `CheckBackBlock`.
struct ReviewLoopView: View {
    let loop: ReviewLoop
    let sessionId: String
    var worktreeDir: String?
    let state: TurnFoldState
    /// Resolves each nested row's own detail state, which must survive the row
    /// scrolling out of the lazy stack.
    let expansionState: (String, Bool) -> TurnFoldState
    /// The loop is the work fold, so only the Tool calls preference is left
    /// to answer inside it.
    var activity = TurnActivity.standard

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.22, extraBounce: 0)) {
                    state.toggle()
                }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityHint(accessibilityHint)

            if state.expanded {
                VStack(alignment: .leading, spacing: 8) {
                    LoopWorkRows(
                        loop: loop,
                        sessionId: sessionId,
                        worktreeDir: worktreeDir,
                        expansionState: expansionState,
                        activity: activity
                    )
                    if let result = loop.result, result.status != .pending {
                        ReviewLoopResultRow(result: result, rounds: loop.rounds)
                    }
                }
                .padding(.leading, 6)
                .padding(.top, 8)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One quiet gray line, like the turn fold above it: "Checked back
    /// 3 times ›" or "Review passed ›". The PR number stays in
    /// the accessibility label; the session already names its PR. The text is
    /// free to wrap, so an accessibility type size never widens the row past
    /// the transcript.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(headerText)
                .font(.subheadline)
                .multilineTextAlignment(.leading)
            chevron
            if loop.isLive {
                ProgressView()
                    .controlSize(.mini)
                    .padding(.leading, 2)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(OS1VisualStyle.textDim)
        #if os(iOS)
        .frame(minHeight: 44)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .rotationEffect(.degrees(state.expanded ? 90 : 0))
    }

    private var headerText: String {
        if isCheckBack {
            return loop.isLive ? "Checking back" : "Checked back \(loop.detail)"
        }
        if loop.isLive { return "Reviewing" }
        // Opened, a settled loop trades its verdict for the round count: the
        // verdict then has its own row at the end of the work.
        if state.expanded && loop.isSettled { return reviewedIn }
        switch loop.result?.status {
        case .passed: return "Review passed"
        case .failed: return "Review needs changes"
        case .pending: return "Reviewing"
        case nil:
            switch loop.settled {
            case .passed: return "Review passed"
            case .capped: return "Review handed over"
            default: return reviewedIn
            }
        }
    }

    private var reviewedIn: String { "Reviewed in \(loop.roundsLabel)" }

    private var isCheckBack: Bool { loop.kind == .checkBack }

    private var titleText: String { isCheckBack ? "Checked back" : "Review loop" }

    private var accessibilityHint: String {
        let work = isCheckBack ? "check-back work" : "review work"
        return state.expanded ? "Hide the \(work)" : "Show the \(work)"
    }

    private var accessibilityLabel: String {
        var parts = [titleText, loop.isLive ? "Working" : loop.detail]
        if let prNumber = loop.prNumber { parts.append("PR #\(prNumber)") }
        return parts.joined(separator: ", ")
    }
}

/// The rows inside a review or check-back fold, shared with the status row
/// that takes in a check-back fold (`ProgressStatusRow`).
struct LoopWorkRows: View {
    let loop: ReviewLoop
    let sessionId: String
    var worktreeDir: String?
    let expansionState: (String, Bool) -> TurnFoldState
    var activity = TurnActivity.standard

    var body: some View {
        ForEach(loop.blocks) { block in
            // The handoff itself is what the header stands for; drawing it
            // again inside would say the same thing twice, one indent apart.
            // The settle notice stays: it is the loop's own last word, and the
            // verdict row below only exists while GitHub still has one. Wait
            // boundaries are structural, never a row.
            if !isHandoff(block), !isTurnBoundary(block) {
                row(for: block)
            }
        }
    }

    /// Review work uses the turn's own step rows, without a second worker
    /// disclosure inside this one.
    @ViewBuilder
    private func row(for block: TranscriptBlock) -> some View {
        switch block {
        case .work(let turn):
            TurnStepsView(
                items: turn.items,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                // Only the loop's newest work can still be running.
                isLive: loop.isLive && block.id == loop.blocks.last?.id,
                rendersToolCallsInPlace: activity.rendersToolCallsInPlace,
                expansionState: expansionState
            )
        case .tool(let item):
            ToolCallRow(
                item: item,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: expansionState(item.id, item.hasFeaturedMedia)
            )
        case .footer(let footer):
            TurnFooterView(footer: footer, sessionId: sessionId)
        case .message(let entry):
            if let notice = entry.notice {
                NoticeRow(
                    entry: entry,
                    notice: notice,
                    state: expansionState("notice-\(entry.id)", false)
                )
            } else if entry.isReasoning == true {
                ReasoningSummaryRow(entry: entry)
            } else {
                // A plain prompt can never be in here — one ends the loop —
                // so anything left is the agent's own prose.
                AssistantMessage(
                    entry: entry,
                    sessionId: sessionId,
                    state: expansionState("body-\(entry.id)", false)
                )
            }
        // Notes and walkthroughs are never grouped into a loop, and a loop
        // never nests.
        default:
            EmptyView()
        }
    }

    private func isTurnBoundary(_ block: TranscriptBlock) -> Bool {
        guard case .message(let entry) = block else { return false }
        return entry.turnBoundary == true
    }

    private func isHandoff(_ block: TranscriptBlock) -> Bool {
        guard case .message(let entry) = block else { return false }
        return entry.notice?.kind == "review-handoff"
    }
}

#if DEBUG
/// The verdict row over a fixture review, for the native screenshot harness.
struct ReviewLoopResultFixture: View {
    let review: OsReviewSummary

    var body: some View {
        var session = Session(id: "screenshot-session")
        session.prNumber = 128
        session.prState = "OPEN"
        session.prChecks = PrChecksSummary(total: 3, passed: 3, failed: 0, pending: 0)
        session.prOsReview = review
        return Group {
            if let result = ReviewLoopResult(session: session) {
                ReviewLoopResultRow(result: result, rounds: 2)
            }
        }
    }
}
#endif

/// What the loop concluded, once GitHub has settled: the result first, the
/// numbers behind it as meta.
private struct ReviewLoopResultRow: View {
    let result: ReviewLoopResult
    let rounds: Int

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var passed: Bool { result.status == .passed }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // Same reason as the loop's own header: a verdict and its
                // numbers, both intrinsically sized, are wider than the
                // transcript once the type is this large.
                FlowLayout(spacing: 7) {
                    HStack(spacing: 7) {
                        verdictMark
                        verdictLabel
                    }
                    .fixedSize()

                    facts
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 7) {
                    verdictMark
                    verdictLabel
                        .fixedSize()
                    facts
                        .lineLimit(1)
                    Spacer(minLength: 4)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(passed ? "Review passed" : "Review failed")
        .accessibilityValue(result.accessibilityFacts(rounds: rounds))
    }

    private var verdictMark: some View {
        Image(systemName: passed ? "checkmark.circle" : "xmark.circle")
            .font(.system(size: 12))
            .foregroundStyle(passed ? OS1VisualStyle.textFaint : OS1VisualStyle.red)
            .frame(width: 15)
    }

    private var verdictLabel: some View {
        Text(passed ? "Ready to merge" : "Needs changes")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(OS1VisualStyle.textDim)
    }

    /// The facts are one faint run, except the risk word, which takes its
    /// level's own ink: it is the one fact here that is advice about landing
    /// rather than a count, and a verdict that reads "Ready to merge" still
    /// deserves a red "high risk" beside it.
    private var facts: some View {
        result.factList(rounds: rounds)
            .enumerated()
            .map { index, part in
                let text = Text(index == 0 ? part : " · \(part)")
                guard let risk = result.risk, part == risk.label else { return text }
                return Text(index == 0 ? "" : " · ")
                    + Text(part).foregroundStyle(risk.tone(stale: false).color)
            }
            .reduce(Text(""), +)
            .font(.caption2)
            .foregroundStyle(OS1VisualStyle.textFaint)
    }
}
