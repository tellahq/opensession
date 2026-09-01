import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Opaque equivalents of the native surfaces a sidebar row can be resting on.
/// A separator is painted over another avatar, so a translucent system fill
/// would reveal the photo rather than the row beneath it.
enum PresenceRowSurface {
    static func color(selected: Bool, hovered: Bool) -> Color {
        #if os(macOS)
        if selected {
            // AppKit does not add another hover wash to a selected sidebar row.
            return Color(nsColor: .selectedContentBackgroundColor)
        }
        return hovered ? OS1VisualStyle.hover : OS1VisualStyle.background
        #else
        let fill: UIColor?
        switch (selected, hovered) {
        case (true, _): fill = .tertiarySystemFill
        case (false, true): fill = .quaternarySystemFill
        case (false, false): fill = nil
        }
        return Color(uiColor: UIColor { traits in
            let background = UIColor.systemBackground.resolvedColor(with: traits)
            guard let fill else { return background }
            return composite(fill.resolvedColor(with: traits), over: background)
        })
        #endif
    }

    #if os(iOS)
    private static func composite(_ foreground: UIColor, over background: UIColor) -> UIColor {
        var foregroundComponents = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), a: CGFloat(0))
        var backgroundComponents = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), a: CGFloat(0))
        foreground.getRed(
            &foregroundComponents.r, green: &foregroundComponents.g,
            blue: &foregroundComponents.b, alpha: &foregroundComponents.a
        )
        background.getRed(
            &backgroundComponents.r, green: &backgroundComponents.g,
            blue: &backgroundComponents.b, alpha: &backgroundComponents.a
        )
        let alpha = foregroundComponents.a
        return UIColor(
            red: foregroundComponents.r * alpha + backgroundComponents.r * (1 - alpha),
            green: foregroundComponents.g * alpha + backgroundComponents.g * (1 - alpha),
            blue: foregroundComponents.b * alpha + backgroundComponents.b * (1 - alpha),
            alpha: 1
        )
    }
    #endif
}

/// Who else has this session open right now, as a Figma/Notion-style stack of
/// faces — the native half of the web viewer's header facepile, fed by the
/// server's `presence` frames.
///
/// Only OTHER people appear. The web pile includes you (rightmost) because a
/// desktop header has room to spare; a phone navigation bar does not, and your
/// own face there tells you nothing you didn't know.
struct PresenceFacepile: View {
    /// How overlapping faces are told apart.
    enum Separation {
        /// A full ring in the chrome's own colour. Only correct where the
        /// backdrop is known and still — a navigation bar.
        case ring
        /// A seam that paints ONLY over the face beneath, never around the
        /// pile. What a list row needs, where the backdrop moves under it.
        case seam
    }

    let viewers: [String]
    var size: CGFloat = 26
    /// Overlapped pile vs faces side by side.
    var stacked: Bool = true
    /// How the overlap is separated. Ignored when `stacked` is false.
    var separation: Separation = .ring
    /// The surface visible between overlapping faces. Navigation bars use the
    /// app background; moving list rows pass their resolved native surface.
    var separatorColor: Color = OS1VisualStyle.background

    /// Beyond this limit the pile stops being readable and the rest collapse
    /// into a count. Navigation bars keep the three-face default; the wider
    /// Feed row raises it to four to match the desktop sidebar.
    var maxFaces = 3

    /// A third of a face, the web's `-ml-1.5` against its 24px faces — enough
    /// overlap to read as a pile, short of hiding a face behind its neighbour.
    private var overlap: CGFloat { stacked ? size / 3 : -2 }

    /// A one-point cutout keeps overlapping photos distinct without making
    /// the separator heavier than the row it belongs to.
    private let seamWidth: CGFloat = 1

    var body: some View {
        if viewers.isEmpty {
            EmptyView()
        } else {
            HStack(spacing: -overlap) {
                ForEach(Array(shown.enumerated()), id: \.element) { index, viewer in
                    face(index: index) {
                        UserAvatar(person: viewer, size: size)
                    }
                    // Reading order is also depth order: the first (leftmost)
                    // person stays in front of every face that follows.
                    .zIndex(Double(shown.count - index + (overflow > 0 ? 1 : 0)))
                }
                if overflow > 0 {
                    face(index: shown.count) {
                        Text(verbatim: "+\(overflow)")
                            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .frame(width: size, height: size)
                            .background(SquircleCapsule().fill(OS1VisualStyle.hover))
                    }
                    .zIndex(0)
                }
            }
            // One label for the pile: VoiceOver reading three unlabelled
            // images as separate elements is noise, and the useful sentence is
            // who is here.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(label))
            #if os(macOS)
            .help(label)
            #endif
            .task(id: viewers) {
                await TeamDirectory.shared.ensureLoaded()
            }
        }
    }

    /// One face in the pile, separated from the one it overlaps.
    ///
    /// The ring is drawn as an overlay because it belongs to this face; the
    /// seam is drawn as a BACKGROUND offset left, so it is a copy of this
    /// face's own silhouette peeking out on the side that covers its
    /// neighbour — and nowhere else. A radial mask on the LOWER face was the
    /// web's first attempt and lost for a reason that holds here too: a
    /// circular hole bites a visible scoop out of the face beneath, while the
    /// seam follows the top face's own outline and leaves both whole.
    @ViewBuilder
    private func face(index: Int, @ViewBuilder content: () -> some View) -> some View {
        let separated = stacked && index > 0
        content()
            .background {
                if separated, separation == .seam {
                    SquircleCapsule()
                        // This is the surface showing through, not a frame
                        // around the picture.
                        .fill(separatorColor)
                        .frame(width: size, height: size)
                        .offset(x: -seamWidth)
                }
            }
            .overlay {
                if stacked, separation == .ring {
                    // Stroked and clipped rather than `strokeBorder`, which is
                    // an `InsettableShape` method this hand-drawn superellipse
                    // does not have: a centred stroke at twice the width leaves
                    // exactly the inside half once the outside is clipped away.
                    SquircleCapsule()
                        .stroke(separatorColor, lineWidth: 3)
                        .clipShape(SquircleCapsule())
                }
            }
    }

    private var shown: [String] {
        Array(viewers.prefix(maxFaces))
    }

    private var overflow: Int {
        max(0, viewers.count - maxFaces)
    }

    private var label: String {
        let names = viewers.map { TeamDirectory.shared.fullName(for: $0) }
        return "Also viewing: " + ListFormatter.localizedString(byJoining: names)
    }
}
