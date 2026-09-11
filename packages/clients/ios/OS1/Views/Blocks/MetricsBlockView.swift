import SwiftUI

/// A ```metrics fence as a row of cards: the value big and tabular, the
/// label under it, the delta beside the value coloured by its direction.
struct MetricsBlockView: View {
    let metrics: [Metric]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                card(metric)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Metrics")
    }

    private func card(_ metric: Metric) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(metric.value)
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let unit = metric.unit {
                    Text(unit)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                if let delta = metric.delta {
                    Text(delta)
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(color(for: metric.trend))
                        .padding(.leading, 2)
                }
            }
            Text(metric.label)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minWidth: 120, alignment: .leading)
        .background(OS1VisualStyle.markdownCodeWell, in: BlockChrome.shape)
        .overlay {
            BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(metric.label)
        .accessibilityValue(
            [metric.value, metric.unit, metric.delta].compactMap { $0 }.joined(separator: " ")
        )
    }

    private func color(for trend: Metric.Trend) -> Color {
        switch trend {
        case .up: OS1VisualStyle.greenInk
        case .down: OS1VisualStyle.redInk
        case .flat: OS1VisualStyle.textDim
        }
    }
}
