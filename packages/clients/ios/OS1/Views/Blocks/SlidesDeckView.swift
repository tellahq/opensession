import SwiftUI

/// A ```slides fence as a deck in a 16:9 well: one slide at a time, arrows,
/// dots, a counter, arrow keys when the deck has focus, and a swipe on the
/// phone. Each slide is ordinary markdown through `MarkdownBody` in the
/// surrounding body's context, so a PR number or a session file links
/// inside the deck the way it does outside; nested fences stay plain. The
/// expand button opens the deck larger, on the current slide.
struct SlidesDeckView: View {
    let slides: [String]
    var dimmed = false

    @State private var index = 0
    @State private var expanded = false
    @State private var dragOffset: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        BlockWell(label: "Slides", symbol: "rectangle.on.rectangle") {
            BlockControl(symbol: "arrow.up.left.and.arrow.down.right", accessibilityLabel: "Expand") {
                expanded = true
            }
        } content: {
            SlideDeck(slides: slides, index: $index, dimmed: dimmed, compact: true)
        }
        .accessibilityLabel("Slides")
        #if os(iOS)
        .fullScreenCover(isPresented: $expanded) {
            ExpandedDeck(slides: slides, index: $index, dimmed: dimmed)
        }
        #else
        .sheet(isPresented: $expanded) {
            ExpandedDeck(slides: slides, index: $index, dimmed: dimmed)
                .frame(minWidth: 760, idealWidth: 960, minHeight: 520, idealHeight: 640)
        }
        #endif
    }
}

private struct ExpandedDeck: View {
    let slides: [String]
    @Binding var index: Int
    let dimmed: Bool

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Slides")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()
            SlideDeck(slides: slides, index: $index, dimmed: dimmed, compact: false)
                .padding(.horizontal)
                .padding(.bottom)
        }
        .background(OS1VisualStyle.background)
    }
}

private struct SlideDeck: View {
    let slides: [String]
    @Binding var index: Int
    let dimmed: Bool
    /// In the transcript the well is fixed 16:9; expanded it takes the room.
    let compact: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            slide
                .focusable()
                .focused($focused)
                .focusEffectDisabled()
                .onKeyPress(.leftArrow) { step(-1); return .handled }
                .onKeyPress(.rightArrow) { step(1); return .handled }
                #if os(iOS)
                .gesture(
                    DragGesture(minimumDistance: 24)
                        .onEnded { value in
                            guard abs(value.translation.width) > abs(value.translation.height) else { return }
                            step(value.translation.width < 0 ? 1 : -1)
                        }
                )
                #endif
            controls
        }
    }

    private var slide: some View {
        ScrollView {
            MarkdownBody(slides[index], dimmed: dimmed, richBlocks: false)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .id(index)
        .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading)))
        .modifier(WellShape(compact: compact))
        .background(OS1VisualStyle.background.opacity(0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Slide \(index + 1) of \(slides.count)")
    }

    private var controls: some View {
        HStack(spacing: 10) {
            BlockControl(symbol: "chevron.left", accessibilityLabel: "Previous slide") { step(-1) }
                .disabled(index == 0)
                .opacity(index == 0 ? 0.4 : 1)
            HStack(spacing: 5) {
                ForEach(0..<slides.count, id: \.self) { dot in
                    Circle()
                        .fill(dot == index ? OS1VisualStyle.accentInk : OS1VisualStyle.textFaint.opacity(0.5))
                        .frame(width: 6, height: 6)
                        .onTapGesture { go(to: dot) }
                }
            }
            .accessibilityHidden(true)
            Text("\(index + 1) / \(slides.count)")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(OS1VisualStyle.textDim)
            BlockControl(symbol: "chevron.right", accessibilityLabel: "Next slide") { step(1) }
                .disabled(index == slides.count - 1)
                .opacity(index == slides.count - 1 ? 0.4 : 1)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 34)
        .overlay(alignment: .top) {
            Rectangle().fill(OS1VisualStyle.border.opacity(0.6)).frame(height: 0.5)
        }
    }

    private func step(_ delta: Int) {
        go(to: index + delta)
    }

    private func go(to target: Int) {
        let clamped = min(slides.count - 1, max(0, target))
        guard clamped != index else { return }
        if reduceMotion {
            index = clamped
        } else {
            withAnimation(.snappy(duration: 0.25, extraBounce: 0)) { index = clamped }
        }
    }
}

private struct WellShape: ViewModifier {
    let compact: Bool

    func body(content: Content) -> some View {
        if compact {
            content.aspectRatio(16 / 9, contentMode: .fit)
        } else {
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
