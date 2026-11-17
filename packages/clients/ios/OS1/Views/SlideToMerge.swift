import SwiftUI

/// A track with a thumb you drag to the end to commit, for an action that
/// should not happen on a stray tap: merging a pull request from the
/// overview page. Dragging past the end's threshold arms it (a haptic says
/// so); letting go there commits, anywhere short of it springs back.
///
/// The control does not own the work. `busy` is the caller saying the action
/// (or a confirmation it asked for) is still in flight: the thumb stays at
/// the end while it is, and returns to the start once it clears, so a failed
/// or cancelled merge leaves the control ready to slide again.
///
/// VoiceOver cannot drag, so the whole control is one button whose default
/// action commits.
struct SlideToMerge: View {
    let label: String
    var busyLabel = "Merging…"
    var tint: Color
    var busy: Bool
    let onCommit: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var armed = false
    @State private var shimmer = false

    private let height: CGFloat = 60
    private let inset: CGFloat = 5
    private let thumbWidth: CGFloat = 76
    /// How far along the track counts as "all the way".
    private let threshold: CGFloat = 0.82

    var body: some View {
        GeometryReader { proxy in
            let travel = max(1, proxy.size.width - thumbWidth - inset * 2)
            let progress = busy ? 1 : min(1, max(0, offset / travel))
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(OS1VisualStyle.text.opacity(0.06))
                // The part of the track the thumb has covered, so the drag
                // reads as filling something rather than moving a dot.
                Capsule()
                    .fill(tint.opacity(0.16))
                    .frame(width: thumbWidth + inset * 2 + travel * progress)
                    .opacity(min(1, Double(progress) * 6))
                trackLabel
                    .frame(maxWidth: .infinity)
                    .padding(.leading, thumbWidth + inset)
                    .opacity(busy ? 1 : Double(1 - progress * 1.6))
                thumb
                    .offset(x: inset + travel * progress)
                    .gesture(drag(travel: travel), including: busy ? .none : .all)
            }
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(busy ? busyLabel : label)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if !busy { onCommit() } }
        .onChange(of: busy) { _, isBusy in
            guard !isBusy else { return }
            withAnimation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.8)) {
                offset = 0
            }
            armed = false
        }
        .onAppear { shimmer = !reduceMotion }
    }

    private var thumb: some View {
        ZStack {
            Capsule().fill(tint)
            if busy {
                ProgressView().controlSize(.small).tint(.white)
            } else {
                Image(systemName: "arrow.right")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: thumbWidth, height: height - inset * 2)
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .contentShape(Capsule())
    }

    /// The label carries a slow light sweep, the platform's old hint that the
    /// thing beside it moves. Still under Reduce Motion.
    private var trackLabel: some View {
        let text = Text(busy ? busyLabel : label)
            .font(.body.weight(.medium))
            .lineLimit(1)
        return text
            .foregroundStyle(OS1VisualStyle.textDim)
            .overlay {
                if shimmer && !busy {
                    text
                        .foregroundStyle(OS1VisualStyle.text)
                        .mask {
                            GeometryReader { proxy in
                                LinearGradient(
                                    colors: [.clear, .white, .clear],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                                .frame(width: proxy.size.width * 0.5)
                                .offset(x: shimmerPhase ? proxy.size.width : -proxy.size.width * 0.5)
                            }
                        }
                        .onAppear {
                            withAnimation(.linear(duration: 2.2).repeatForever(autoreverses: false)) {
                                shimmerPhase = true
                            }
                        }
                }
            }
    }

    @State private var shimmerPhase = false

    private func drag(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                offset = min(travel, max(0, value.translation.width))
                let past = offset / travel >= threshold
                if past != armed {
                    armed = past
                    Haptics.play(past ? .armed : .released)
                }
            }
            .onEnded { _ in
                if offset / travel >= threshold {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.9)) {
                        offset = travel
                    }
                    onCommit()
                } else {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.75)) {
                        offset = 0
                    }
                }
                armed = false
            }
    }
}
