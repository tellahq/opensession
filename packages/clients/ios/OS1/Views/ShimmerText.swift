import SwiftUI

/// Text with a bright band sweeping across it: the transcript's sign that
/// something is still going (an active reasoning title, a running command),
/// in place of a spinner beside it. A small isolated animation subtree: its
/// timeline redraws only this text, never the row or lazy stack around it.
/// Reduce Motion does not instantiate a timeline and holds the brighter,
/// static endpoint instead.
///
/// Font, line limit and truncation come from the environment, so set them on
/// this view as on any `Text`.
struct ShimmerText: View {
    let text: Text
    var base: Color = OS1VisualStyle.textDim
    var highlight: Color = OS1VisualStyle.text

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ text: Text, base: Color = OS1VisualStyle.textDim, highlight: Color = OS1VisualStyle.text) {
        self.text = text
        self.base = base
        self.highlight = highlight
    }

    init(_ string: String, base: Color = OS1VisualStyle.textDim, highlight: Color = OS1VisualStyle.text) {
        self.init(Text(string), base: base, highlight: highlight)
    }

    var body: some View {
        if reduceMotion {
            text.foregroundStyle(highlight)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let cycle = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 1.8) / 1.8
                text
                    .foregroundStyle(base)
                    .overlay {
                        text
                            .foregroundStyle(highlight)
                            .mask {
                                GeometryReader { geometry in
                                    let width = max(36, geometry.size.width * 0.42)
                                    LinearGradient(
                                        colors: [.clear, .black, .clear],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                    .frame(width: width)
                                    .offset(x: (geometry.size.width + width) * cycle - width)
                                }
                            }
                    }
            }
        }
    }
}
