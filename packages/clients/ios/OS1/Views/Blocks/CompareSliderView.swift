import SwiftUI

/// A ```compare fence: two stills, before and after. Both load with the
/// session's credentials the way every transcript picture does, and a tall
/// pair is capped in height so it never fills the screen.
///
/// On iOS the stills stack, Before over After, each under its own pill and
/// each a full-width tap into the gallery. A divider under a finger fought
/// the transcript's scroll and covered what it was dragged over, and the
/// stills it split were too small to compare anyway.
///
/// On the Mac they are one before/after control: the before still
/// underneath, the after still clipped to the right of a divider, and a drag
/// or a click anywhere moves the divider.
struct CompareSliderView: View {
    /// The tallest the box gets; a portrait pair shrinks in width to fit.
    private static let maxHeight: CGFloat = 400

    let spec: CompareSpec

    @Environment(\.transcriptSessionId) private var sessionId
    @Environment(\.openPanel) private var openPanel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var before: Data?
    @State private var after: Data?
    @State private var failed = false
    @State private var position: CGFloat = 0.5
    @State private var expanded = false

    private var resolvedSessionId: String { openPanel.sessionId ?? sessionId ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let before, let after {
                #if os(iOS)
                stacked(before: before, after: after)
                #else
                framed(slider(before: before, after: after))
                #endif
            } else if failed {
                framed(placeholder(symbol: "photo.badge.exclamationmark"))
            } else {
                framed(placeholder(symbol: nil))
            }
            if let caption = spec.caption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task(id: spec) {
            failed = false
            async let first = Self.load(spec.before, sessionId: resolvedSessionId)
            async let second = Self.load(spec.after, sessionId: resolvedSessionId)
            let (a, b) = await (first, second)
            before = a
            after = b
            failed = a == nil || b == nil
        }
    }

    private static func load(_ source: String, sessionId: String) async -> Data? {
        guard let raw = try? await OS1API.conversationImage(source: source, sessionId: sessionId)
        else { return nil }
        return await DisplayableImageData.prepare(raw)
    }

    private func framed(_ content: some View) -> some View {
        content
            .clipShape(BlockChrome.shape)
            .overlay {
                BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
            }
    }

    #if os(iOS)
    /// Before over After. The gallery holds both, so a still opened full
    /// screen pages to the other one.
    private func stacked(before: Data, after: Data) -> some View {
        let gallery = [
            PreviewImage(id: "before", source: .data(before), walkthroughLabel: .before),
            PreviewImage(id: "after", source: .data(after), walkthroughLabel: .after),
        ]
        return VStack(alignment: .leading, spacing: 14) {
            pane(.before, data: before, gallery: gallery, index: 0)
            pane(.after, data: after, gallery: gallery, index: 1)
        }
    }

    private func pane(
        _ side: PreviewImage.WalkthroughLabel,
        data: Data,
        gallery: [PreviewImage],
        index: Int
    ) -> some View {
        let tone = side == .before ? OS1VisualStyle.redInk : OS1VisualStyle.greenInk
        return VStack(alignment: .leading, spacing: 6) {
            Text(side.rawValue)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tone)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(tone.opacity(0.12), in: Capsule())
                .accessibilityAddTraits(.isHeader)
            framed(
                ExpandableDataImage(data: data, gallery: gallery, galleryIndex: index)
                    .modifier(CappedAspect(ratio: aspectRatio(of: data), maxHeight: Self.maxHeight))
            )
        }
    }
    #endif

    private func placeholder(symbol: String?) -> some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.fill.tertiary)
            .frame(height: 180)
            .overlay {
                if let symbol {
                    Image(systemName: symbol).foregroundStyle(.tertiary)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
    }

    #if os(macOS)
    private func slider(before: Data, after: Data) -> some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let split = width * position
            ZStack(alignment: .leading) {
                DataImage(data: before)
                DataImage(data: after)
                    .mask(alignment: .trailing) {
                        Rectangle().frame(width: max(0, width - split))
                    }
                Rectangle()
                    .fill(.white)
                    .frame(width: 2)
                    .shadow(color: .black.opacity(0.35), radius: 2)
                    .offset(x: split - 1)
                handle
                    .position(x: split, y: geometry.size.height / 2)
                label("Before", alignment: .topLeading)
                label("After", alignment: .topTrailing)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        set(value.location.x / max(width, 1), animated: false)
                    }
            )
        }
        .modifier(CappedAspect(ratio: aspectRatio(of: before), maxHeight: Self.maxHeight))
        .overlay(alignment: .bottomTrailing) { expandButton(before: before, after: after) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Before and after")
        .accessibilityValue("\(Int((position * 100).rounded())) percent before")
        .accessibilityAdjustableAction { direction in
            set(position + (direction == .increment ? 0.1 : -0.1), animated: true)
        }
    }

    private var handle: some View {
        Image(systemName: "chevron.left.chevron.right")
            .font(.caption.weight(.bold))
            .foregroundStyle(.black.opacity(0.8))
            .frame(width: 30, height: 30)
            .background(.white, in: Circle())
            .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
    }

    private func label(_ text: String, alignment: Alignment) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.black.opacity(0.55), in: Capsule())
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
            .allowsHitTesting(false)
    }

    @ViewBuilder
    private func expandButton(before: Data, after: Data) -> some View {
        Button {
            expanded = true
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(.black.opacity(0.55), in: Circle())
        }
        .buttonStyle(.plain)
        .padding(8)
        .accessibilityLabel("Expand")
        .help("Expand")
        .sheet(isPresented: $expanded) {
            MacImagePreview(images: [before, after], index: 0)
        }
    }

    private func set(_ value: CGFloat, animated: Bool) {
        let clamped = min(1, max(0, value))
        if animated, !reduceMotion {
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { position = clamped }
        } else {
            position = clamped
        }
    }
    #endif

    private func aspectRatio(of data: Data) -> CGFloat {
        #if os(iOS)
        let size = UIImage(data: data)?.size ?? CGSize(width: 16, height: 9)
        #else
        let size = NSImage(data: data)?.size ?? CGSize(width: 16, height: 9)
        #endif
        guard size.width > 0, size.height > 0 else { return 16 / 9 }
        return size.width / size.height
    }
}

/// Sizes its content to `ratio` across the offered width, unless that would
/// be taller than `maxHeight`: then the height is capped and the width
/// shrinks to keep the ratio. `.aspectRatio` plus `.frame(maxHeight:)` can't
/// do this inside a scroll view, which offers no height to clamp against.
private struct CappedAspect: ViewModifier {
    let ratio: CGFloat
    let maxHeight: CGFloat

    func body(content: Content) -> some View {
        CappedAspectLayout(ratio: ratio, maxHeight: maxHeight) { content }
    }

    private struct CappedAspectLayout: Layout {
        let ratio: CGFloat
        let maxHeight: CGFloat

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
            let width = proposal.width ?? maxHeight * ratio
            let height = width / ratio
            guard height > maxHeight else { return CGSize(width: width, height: height) }
            return CGSize(width: maxHeight * ratio, height: maxHeight)
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
            for subview in subviews {
                subview.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            }
        }
    }
}
