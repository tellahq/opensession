import SwiftUI

/// A PR review handoff and the work it triggered, folded like a worker.
///
/// A review round arrives as a pile of ordinary rows — the handoff notice, the
/// fix turns, the push, then the next handoff — which is the noisiest thing a
/// phone transcript can hold, and none of it is what the reader came for.
/// Closed, this row says what the loop concluded; opened, it shows the same
/// icon-led step rows as any other turn, with the verdict at the end. Mirrors
/// the web viewer's `ReviewLoopBlock`.
struct ReviewLoopView: View {
    let loop: ReviewLoop
    let sessionId: String
    var worktreeDir: String?
    let state: TurnFoldState
    /// Resolves each nested row's own detail state, which must survive the row
    /// scrolling out of the lazy stack.
    let expansionState: (String, Bool) -> TurnFoldState

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
            .accessibilityHint(state.expanded ? "Hide the review work" : "Show the review work")

            if state.expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(loop.blocks) { block in
                        // The handoff itself is what the header stands for;
                        // drawing it again inside would say the same thing
                        // twice, one indent apart.
                        if !isHandoff(block) {
                            row(for: block)
                        }
                    }
                    if let result = loop.result {
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
                isLive: loop.isLive,
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

    @ViewBuilder
    private var header: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                wrappedHeader
            } else {
                singleLineHeader
            }
        }
        #if os(iOS)
        .frame(minHeight: 44)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
    }

    private var singleLineHeader: some View {
        HStack(spacing: 6) {
            chevron

            title
                .fixedSize()

            // Opened, a settled loop trades its verdict for the round count:
            // the verdict then has its own row at the end of the work.
            detail
                .lineLimit(1)

            Spacer(minLength: 6)

            prNumberLabel
                .fixedSize()

            if loop.isLive {
                ProgressView()
                    .controlSize(.mini)
            }
        }
    }

    /// At an accessibility type size the title and the PR number are each
    /// close to a full line on their own, and an `HStack` of intrinsically
    /// sized text does not give way: it reports a width wider than the
    /// transcript, and a vertical `ScrollView` centres content it cannot fit,
    /// so this one row would drag every paragraph around it off both edges.
    /// The same answer as the turn fold above it: let the row wrap.
    private var wrappedHeader: some View {
        FlowLayout(spacing: 6) {
            // One subview, so the chevron is never stranded on a line of its
            // own above the words it points at.
            HStack(spacing: 6) {
                chevron
                title
            }
            .fixedSize()

            detail
                .fixedSize(horizontal: false, vertical: true)

            prNumberLabel
                .fixedSize()

            if loop.isLive {
                ProgressView()
                    .controlSize(.mini)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var chevron: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(OS1VisualStyle.textFaint)
            .rotationEffect(.degrees(state.expanded ? 0 : -90))
    }

    private var title: some View {
        Text("Review loop")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(OS1VisualStyle.textDim)
    }

    private var detail: some View {
        Text(visibleDetail)
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textFaint)
    }

    @ViewBuilder
    private var prNumberLabel: some View {
        if let prNumber = loop.prNumber {
            // Verbatim: interpolated into a LocalizedStringKey the number
            // runs through the device's locale and #5496 reads "PR #5.496"
            // (same trap as PrPanel's title).
            Text(verbatim: "PR #\(prNumber)")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
    }

    private var visibleDetail: String {
        state.expanded && loop.isSettled ? loop.roundsLabel : loop.detail
    }

    private func isHandoff(_ block: TranscriptBlock) -> Bool {
        guard case .message(let entry) = block else { return false }
        return entry.notice?.kind == "review-handoff"
    }

    private var accessibilityLabel: String {
        var parts = ["Review loop", loop.isLive ? "Working" : loop.detail]
        if let prNumber = loop.prNumber { parts.append("PR #\(prNumber)") }
        return parts.joined(separator: ", ")
    }
}

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

    private var facts: some View {
        Text(result.facts(rounds: rounds))
            .font(.caption2)
            .foregroundStyle(OS1VisualStyle.textFaint)
    }
}
