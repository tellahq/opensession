import SwiftUI

/// One agent-reported status per task, updated in place across automated
/// turns: "CI: Running", later "Deployment: Running" on the same row. Opened,
/// it shows the earlier updates and the check-back work behind them. Styled
/// like the work folds around it: the status, a trailing chevron, then a
/// spinner while a check-back runs. Mirrors the web's `ProgressStatusRow`.
///
/// This is the agent's own claim, never a verdict inferred from a turn
/// ending, so the row only says what the message said.
struct ProgressStatusRow: View {
    let group: ProgressGroup
    /// The check-back fold this row took in, if any.
    var work: ReviewLoop?
    var sessionId = ""
    var worktreeDir: String?
    /// Held outside the lazy stack so an opened row survives scrolling.
    let state: TurnFoldState
    var expansionState: (String, Bool) -> TurnFoldState = { _, open in TurnFoldState(expanded: open) }
    var activity = TurnActivity.standard

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The icon column. Scaled with the icon's own font so a large Dynamic
    /// Type checkmark never crowds the topic beside it.
    @ScaledMetric(relativeTo: .footnote) private var iconWidth: CGFloat = 16
    /// The gap between the icon column and its text, in every line.
    private static let iconSpacing: CGFloat = 6

    private var history: [(id: String, update: ProgressUpdate)] { group.history }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if history.isEmpty, work == nil {
                status.touchTargetHeight()
            } else {
                Button(action: toggle) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        status
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .rotationEffect(.degrees(state.expanded ? 90 : 0))
                            .accessibilityHidden(true)
                        if work?.isLive == true {
                            ProgressView()
                                .controlSize(.mini)
                                .padding(.leading, 2)
                                .accessibilityLabel("Check-back in progress")
                        }
                        Spacer(minLength: 0)
                    }
                    // The whole 44pt band toggles, not just the text's line.
                    .touchTargetHeight()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(state.expanded ? "Hide \(hiddenParts)" : "Show \(hiddenParts)")
                .accessibilityValue(state.expanded ? "Expanded" : "Collapsed")
            }

            if state.expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !history.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(history, id: \.id) { item in
                                HStack(alignment: .firstTextBaseline, spacing: Self.iconSpacing) {
                                    icon(item.update, tint: OS1VisualStyle.textFaint)
                                    Text(historyText(item.update))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        // Under the status text, clear of its icon.
                        .padding(.leading, iconWidth + Self.iconSpacing)
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Earlier updates")
                    }
                    if let work {
                        LoopWorkRows(
                            loop: work,
                            sessionId: sessionId,
                            worktreeDir: worktreeDir,
                            expansionState: expansionState,
                            activity: activity
                        )
                    }
                }
                .padding(.leading, 6)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var hiddenParts: String {
        work == nil ? "earlier updates" : "the work and earlier updates"
    }

    /// Same topic reads as a step of the latest; a different one says what
    /// that step was about.
    private func historyText(_ update: ProgressUpdate) -> String {
        update.topic.lowercased() == group.latest.topic.lowercased() ? update.text : update.label
    }

    /// The icon sits on the first line's baseline, so a status that wraps
    /// keeps its glyph beside the topic rather than centred on the block.
    private var status: some View {
        HStack(alignment: .firstTextBaseline, spacing: Self.iconSpacing) {
            icon(
                group.latest,
                tint: group.latest.state == .done
                    ? OS1VisualStyle.greenInk
                    : OS1VisualStyle.textDim
            )
            Text("\(Text(group.latest.topic).fontWeight(.medium).foregroundStyle(OS1VisualStyle.text))\(Text(": \(group.latest.text)").foregroundStyle(OS1VisualStyle.textDim))")
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.subheadline)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(group.latest.label)
        .accessibilityAddTraits(.updatesFrequently)
    }

    /// One column width so the topic and every history line share one text
    /// edge. The width scales with Dynamic Type alongside the glyph.
    private func icon(_ update: ProgressUpdate, tint: Color) -> some View {
        Image(systemName: update.symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: iconWidth)
            .accessibilityHidden(true)
    }

    private func toggle() {
        if reduceMotion {
            state.toggle()
        } else {
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { state.toggle() }
        }
    }
}

private extension View {
    /// The platform's minimum touch target on iOS; the Mac keeps the row's
    /// own height.
    @ViewBuilder
    func touchTargetHeight() -> some View {
        #if os(iOS)
        frame(minHeight: 44, alignment: .leading)
        #else
        self
        #endif
    }
}
