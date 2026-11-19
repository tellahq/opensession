#if os(iOS)
import SwiftUI

/// Keeps the phone sidebar's pinned band heading (a repo, Pinned, a lane when
/// the list is not grouped by project) drawn until its band's last row is gone.
///
/// The list pins section headers itself, but from iOS 26 it draws a pinned
/// header see-through, so the band's rows show through it while they scroll
/// past, and once the next band starts pushing it the list fades it out within
/// about 15pt. The band's last rows are still on screen then: the heading
/// vanished and left its workspaces behind with nothing to say whose they
/// were. Neither the transparency nor the fade can be set from SwiftUI.
///
/// So the list keeps its own headers, which still take the taps and drags, and
/// an opaque copy of whichever one sits at the pin line is laid over it with
/// hit testing off. The copy follows the real header's frame, so it is pushed
/// off by the next band's heading like the web sidebar's sticky band heading,
/// and never fades.
@MainActor
@Observable
final class StickyBandTracker {
    struct Heading: Equatable {
        let title: String
        let count: Int
        let repo: String?
        let collapseKey: String
    }

    struct Pinned: Equatable {
        let heading: Heading
        /// The whole header, insets included, in the overlay's coordinates.
        let frame: CGRect
    }

    /// The header at the top of the list, if one is there.
    private(set) var pinned: Pinned?

    @ObservationIgnored private var headers: [String: (heading: Heading, frame: CGRect)] = [:]
    /// The list's top edge in global coordinates, which is also where it pins
    /// its headers: the list lays out inside the safe area and scrolls under
    /// the bars with a matching inset.
    @ObservationIgnored private var line: CGFloat = 0

    func header(_ heading: Heading, frame: CGRect) {
        headers[heading.collapseKey] = (heading, frame)
        update()
    }

    func headerDisappeared(_ key: String) {
        headers[key] = nil
        update()
    }

    func overlay(top: CGFloat) {
        line = top
        update()
    }

    private func update() {
        // The pinned header sits at the line, a pushed one above it, and the
        // next band's below it: the lowest one not below the line is the one
        // at the top. Half a point of slack for rounding.
        var top: (heading: Heading, frame: CGRect)?
        for entry in headers.values where entry.frame.minY <= line + 0.5 {
            if top.map({ entry.frame.minY > $0.frame.minY }) ?? true { top = entry }
        }
        let next = top.flatMap { top -> Pinned? in
            // Entirely above the line: pushed off already.
            guard top.frame.maxY > line + 0.5 else { return nil }
            return Pinned(heading: top.heading, frame: top.frame.offsetBy(dx: 0, dy: -line))
        }
        if pinned != next { pinned = next }
    }
}

extension View {
    /// Reports a band heading to the tracker that draws its sticky copy.
    /// `insets` are the header's list row insets, so the tracker gets the
    /// header's whole frame rather than its content's.
    func stickyBandHeader(
        _ heading: StickyBandTracker.Heading,
        insets: EdgeInsets,
        tracker: StickyBandTracker
    ) -> some View {
        onGeometryChange(for: CGRect.self) { proxy in
            let content = proxy.frame(in: .global)
            return CGRect(
                x: content.minX - insets.leading,
                y: content.minY - insets.top,
                width: content.width + insets.leading + insets.trailing,
                height: content.height + insets.top + insets.bottom
            )
        } action: { frame in
            tracker.header(heading, frame: frame)
        }
        .onDisappear { tracker.headerDisappeared(heading.collapseKey) }
    }
}

/// The copy of the pinned band heading, laid over the top of the list.
///
/// Only this view reads the tracker, so a scroll redraws it and nothing else.
struct StickyBandOverlay<Content: View>: View {
    let tracker: StickyBandTracker
    let insets: EdgeInsets
    @ViewBuilder let heading: (StickyBandTracker.Heading) -> Content

    /// The strip above the pin line, below the bar's own edge effect. The
    /// copy's backing fades in over it, so the row scrolling up behind the
    /// copy is not cut off sharp at the line, and a pushed copy's label fades
    /// out across it rather than sliding crisp under the bar.
    private let fade: CGFloat = 20

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if let pinned = tracker.pinned {
                // Opaque, so neither the rows scrolling under the copy nor the
                // fading header it covers show through. It may slide up under
                // the bar, where only the bar draws over it.
                VStack(spacing: 0) {
                    LinearGradient(
                        colors: [OS1VisualStyle.background.opacity(0), OS1VisualStyle.background],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: fade)
                    OS1VisualStyle.background.frame(height: pinned.frame.height)
                }
                .frame(width: pinned.frame.width)
                .offset(x: pinned.frame.minX, y: pinned.frame.minY)
                Color.clear
                    .overlay(alignment: .topLeading) {
                        heading(pinned.heading)
                            .padding(insets)
                            .frame(width: pinned.frame.width, height: pinned.frame.height)
                            .offset(x: pinned.frame.minX, y: pinned.frame.minY + fade)
                    }
                    .mask {
                        VStack(spacing: 0) {
                            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                                .frame(height: fade)
                            Color.black
                        }
                    }
            }
        }
        // Drawn from `fade` above the list's top edge, laid out at it: the
        // frame measured below is still the list's, and so the pin line.
        .padding(.top, -fade)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: {
            tracker.overlay(top: $0)
        }
        .allowsHitTesting(false)
        // The list's own header is the one VoiceOver reads.
        .accessibilityHidden(true)
    }
}
#endif
