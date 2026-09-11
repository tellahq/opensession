import SwiftUI

/// A ```compare fence: two stills as one before/after control. The before
/// still underneath, the after still clipped to the right of a divider, and
/// a drag or a tap anywhere moves the divider. Both stills load with the
/// session's credentials the way every transcript picture does.
struct CompareSliderView: View {
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
            Group {
                if let before, let after {
                    slider(before: before, after: after)
                } else if failed {
                    placeholder(symbol: "photo.badge.exclamationmark")
                } else {
                    placeholder(symbol: nil)
                }
            }
            .clipShape(BlockChrome.shape)
            .overlay {
                BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
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
            async let first = try? OS1API.conversationImage(source: spec.before, sessionId: resolvedSessionId)
            async let second = try? OS1API.conversationImage(source: spec.after, sessionId: resolvedSessionId)
            let (a, b) = await (first, second)
            before = a
            after = b
            failed = a == nil || b == nil
        }
    }

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
        .aspectRatio(aspectRatio(of: before), contentMode: .fit)
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
        let gallery = [
            PreviewImage(id: "before", source: .data(before), walkthroughLabel: .before),
            PreviewImage(id: "after", source: .data(after), walkthroughLabel: .after),
        ]
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
        #if os(iOS)
        .fullScreenCover(isPresented: $expanded) {
            FullScreenImagePreview(items: gallery, index: 0)
        }
        #else
        .sheet(isPresented: $expanded) {
            MacImagePreview(images: [before, after], index: 0)
        }
        #endif
    }

    private func set(_ value: CGFloat, animated: Bool) {
        let clamped = min(1, max(0, value))
        if animated, !reduceMotion {
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { position = clamped }
        } else {
            position = clamped
        }
    }

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
