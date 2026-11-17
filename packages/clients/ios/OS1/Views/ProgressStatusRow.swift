import SwiftUI

/// One agent-reported status, updated in place across automated turns:
/// "CI: Running", later "CI: All checks passed" on the same row. Earlier
/// updates open below it. Mirrors the web's `ProgressStatusRow`.
///
/// This is the agent's own claim, never a verdict inferred from a turn
/// ending, so the row only says what the message said.
struct ProgressStatusRow: View {
    let group: ProgressGroup
    /// Held outside the lazy stack so an opened history survives scrolling.
    let state: TurnFoldState

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The icon column. Scaled with the icon's own font so a large Dynamic
    /// Type checkmark never crowds the topic beside it.
    @ScaledMetric(relativeTo: .footnote) private var iconWidth: CGFloat = 16
    /// The gap between the icon column and its text, in every line.
    private static let iconSpacing: CGFloat = 6

    private var history: [(id: String, update: ProgressUpdate)] { group.history }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if history.isEmpty {
                status.touchTargetHeight()
            } else {
                Button(action: toggle) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        status
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.down")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .rotationEffect(.degrees(state.expanded ? 180 : 0))
                            .accessibilityHidden(true)
                    }
                    // The whole 44pt band toggles, not just the text's line.
                    .touchTargetHeight()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(state.expanded ? "Hide earlier updates" : "Show earlier updates")
                .accessibilityValue(state.expanded ? "Expanded" : "Collapsed")
            }

            if state.expanded, !history.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(history, id: \.id) { item in
                        HStack(alignment: .firstTextBaseline, spacing: Self.iconSpacing) {
                            icon(item.update, tint: OS1VisualStyle.textFaint)
                            Text(item.update.text)
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
                .accessibilityLabel("\(group.latest.topic) update history")
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
