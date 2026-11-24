#if os(iOS)
import SwiftUI
import UIKit

extension View {
    /// Pinch the picture where it sits: it lifts off the transcript, follows
    /// your fingers, and springs back when you let go. A tap still opens the
    /// full-screen viewer — this is the quick look that doesn't take you
    /// anywhere.
    ///
    /// Attach it to a view whose bounds are exactly the drawn image, since the
    /// gate and the lifted copy both use those bounds.
    func pinchToPeek(_ data: Data, cornerRadius: CGFloat = 12) -> some View {
        overlay(PinchPeek(data: data, cornerRadius: cornerRadius))
    }
}

/// Pinch-to-peek, on UIKit recognizers rather than SwiftUI's `MagnifyGesture`.
///
/// The obvious implementation — pinch presents the full-screen viewer — is
/// what this replaces: a presentation takes the presenting hierarchy out of
/// the window and cancels the touch sequence with it, so the pinch that opened
/// the viewer can never drive it. The image has to zoom where it already is.
///
/// Two UIKit facts shape the rest. The recognizer cannot live on this
/// overlay: the overlay hit-tests through (otherwise it would eat the tap and
/// the scroll), and UIKit only feeds a touch to recognizers on the hit-tested
/// view and its ancestors — which this view isn't, since SwiftUI draws the
/// whole transcript into one hosting view. So the recognizer goes on the
/// enclosing `UIScrollView`, which sees every touch anyway, and a bounds gate
/// decides whether a given pinch belongs to THIS image. And a scroll view's
/// pan takes any number of fingers, so two fingers scroll the transcript
/// unless scrolling is switched off for the duration.
private struct PinchPeek: UIViewRepresentable {
    let data: Data
    let cornerRadius: CGFloat

    func makeUIView(context: Context) -> PassthroughView {
        let view = PassthroughView()
        view.onWindowChange = { [weak coordinator = context.coordinator] in
            coordinator?.hostWindowChanged()
        }
        context.coordinator.host = view
        return view
    }

    func updateUIView(_ view: PassthroughView, context: Context) {
        context.coordinator.data = data
        context.coordinator.cornerRadius = cornerRadius
    }

    static func dismantleUIView(_ view: PassthroughView, coordinator: Coordinator) {
        coordinator.detach()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(data: data, cornerRadius: cornerRadius)
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var data: Data
        var cornerRadius: CGFloat
        weak var host: PassthroughView?

        private weak var attachedTo: UIView?
        private var pinch: UIPinchGestureRecognizer?

        private var lifted: UIImageView?
        private var backdrop: UIView?
        private var startCentroid: CGPoint = .zero
        private weak var frozenScrollView: UIScrollView?

        /// Generous, because the gesture is transient and the images are
        /// mostly dense UI screenshots: the whole point is to read one.
        private static let maxScale: CGFloat = 6

        init(data: Data, cornerRadius: CGFloat) {
            self.data = data
            self.cornerRadius = cornerRadius
        }

        // MARK: Attaching

        /// Rows are recycled and SwiftUI rebuilds representables, so this runs
        /// both ways: attach on entering a window, and — crucially — detach on
        /// leaving one, or the scroll view accumulates a dead recognizer for
        /// every image ever scrolled past.
        func hostWindowChanged() {
            guard host?.window != nil else {
                detach()
                return
            }
            // The superview chain isn't always complete in the same runloop
            // turn the view joins the window.
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }

        private func attach() {
            guard let host, host.window != nil else { return }
            let target = enclosingScrollView(of: host) ?? host.window
            guard let target else { return }
            if attachedTo === target, pinch != nil { return }
            detach()

            let recognizer = UIPinchGestureRecognizer(
                target: self,
                action: #selector(handlePinch(_:))
            )
            recognizer.delegate = self
            // Left at the default `cancelsTouchesInView`: once the peek
            // begins, SwiftUI's gesture system loses the touches, so letting
            // go can't also register as a tap and open the viewer.
            target.addGestureRecognizer(recognizer)
            pinch = recognizer
            attachedTo = target
        }

        func detach() {
            if let pinch, let attachedTo { attachedTo.removeGestureRecognizer(pinch) }
            pinch = nil
            attachedTo = nil
            cleanUp(animated: false)
        }

        private func enclosingScrollView(of view: UIView) -> UIScrollView? {
            var next = view.superview
            while let current = next {
                if let scrollView = current as? UIScrollView { return scrollView }
                next = current.superview
            }
            return nil
        }

        // MARK: Gating

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let host, host.window != nil,
                  gesture.numberOfTouches == 2,
                  host.bounds.width > 0, host.bounds.height > 0
            else { return false }
            // The point BETWEEN the fingers, not the fingers themselves. A
            // pinch is only recognised once the touches have travelled, and on
            // a thumbnail they are usually outside it by then — gating on them
            // refuses the gesture at exactly the moment it gets going. The
            // midpoint also keeps one image per pinch: every visible thumbnail
            // has its own recognizer on the same scroll view, and only the one
            // the fingers are centred on can claim it.
            return host.bounds.contains(gesture.location(in: host))
        }

        func gestureRecognizer(
            _ gesture: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }

        /// Letting go of a peek must not also count as a tap that opens the
        /// full-screen viewer. `cancelsTouchesInView` doesn't cover this:
        /// SwiftUI drives its Button from its own recognizer on the hosting
        /// view, and cancelling the view's touches leaves that recognizer
        /// tracking happily. Making it wait for this pinch to fail does.
        ///
        /// The scroll view's own recognizers are exempt: a pan that had to
        /// wait for a pinch to fail would make every scroll start late.
        ///
        /// So is the navigation stack's swipe back. A one-finger touch never
        /// fails a pinch until it lifts, so a back swipe made to wait for this
        /// one could not begin at all, and every session with a picture or
        /// diagram on screen lost its way back to the list.
        func gestureRecognizer(
            _ gesture: UIGestureRecognizer,
            shouldBeRequiredToFailBy other: UIGestureRecognizer
        ) -> Bool {
            other.view !== attachedTo && !isBackSwipe(other)
        }

        private func isBackSwipe(_ other: UIGestureRecognizer) -> Bool {
            var responder: UIResponder? = host
            while let current = responder {
                if let navigation = current as? UINavigationController {
                    return other === navigation.interactivePopGestureRecognizer
                        || other === navigation.interactiveContentPopGestureRecognizer
                }
                responder = current.next
            }
            return false
        }

        // MARK: The peek

        @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
            switch gesture.state {
            case .began:
                begin(gesture)
            case .changed:
                update(gesture)
            default:
                end(gesture)
            }
        }

        private func begin(_ gesture: UIPinchGestureRecognizer) {
            guard let host, let window = host.window,
                  // Decoded here rather than per body pass: the peek is rare,
                  // the transcript redraws constantly.
                  let image = UIImage(data: data)
            else { return }
            cleanUp(animated: false)

            let frame = host.convert(host.bounds, to: nil)
            let centroid = gesture.location(in: window)

            let backdrop = UIView(frame: window.bounds)
            backdrop.backgroundColor = .black
            backdrop.alpha = 0
            backdrop.isUserInteractionEnabled = false

            let lifted = UIImageView(image: image)
            // Matches how the thumbnail itself is drawn (`DataImage` fills and
            // the caller clips), so nothing jumps at the moment it lifts.
            lifted.contentMode = .scaleAspectFill
            lifted.clipsToBounds = true
            lifted.layer.cornerRadius = cornerRadius
            lifted.layer.cornerCurve = .continuous
            lifted.isUserInteractionEnabled = false
            // Zoom around the point between the fingers, not the middle of the
            // picture. Setting the frame afterwards re-derives the position.
            lifted.layer.anchorPoint = CGPoint(
                x: frame.width > 0 ? min(max((centroid.x - frame.minX) / frame.width, 0), 1) : 0.5,
                y: frame.height > 0 ? min(max((centroid.y - frame.minY) / frame.height, 0), 1) : 0.5
            )
            lifted.frame = frame

            window.addSubview(backdrop)
            window.addSubview(lifted)

            self.backdrop = backdrop
            self.lifted = lifted
            startCentroid = centroid

            if let scrollView = enclosingScrollView(of: host) {
                // Switching scrolling off stops touch tracking but not an
                // in-flight deceleration, and this transcript is often still
                // gliding when a pinch lands on it.
                scrollView.setContentOffset(scrollView.contentOffset, animated: false)
                scrollView.isScrollEnabled = false
                frozenScrollView = scrollView
            }
        }

        private func update(_ gesture: UIPinchGestureRecognizer) {
            guard let lifted, let window = host?.window else { return }
            // SwiftUI re-evaluates the transcript's body constantly while a
            // session streams, and can re-assert its own scroll state.
            frozenScrollView?.isScrollEnabled = false

            let scale = resisted(gesture.scale)
            let centroid = gesture.location(in: window)
            lifted.transform = CGAffineTransform(
                translationX: centroid.x - startCentroid.x,
                y: centroid.y - startCentroid.y
            ).scaledBy(x: scale, y: scale)
            backdrop?.alpha = min(0.72, max(0, (scale - 1) * 0.6))
        }

        private func end(_ gesture: UIPinchGestureRecognizer) {
            cleanUp(animated: true)
        }

        /// Beyond the limits the pinch keeps responding, just reluctantly —
        /// the same give the full-screen viewer has at its zoom limits.
        private func resisted(_ scale: CGFloat) -> CGFloat {
            if scale < 1 { return 1 - (1 - scale) * 0.35 }
            if scale <= Self.maxScale { return scale }
            return Self.maxScale + (scale - Self.maxScale) * 0.15
        }

        private func cleanUp(animated: Bool) {
            frozenScrollView?.isScrollEnabled = true
            frozenScrollView = nil

            guard let lifted, let backdrop else {
                self.lifted?.removeFromSuperview()
                self.backdrop?.removeFromSuperview()
                self.lifted = nil
                self.backdrop = nil
                return
            }
            self.lifted = nil
            self.backdrop = nil

            guard animated else {
                lifted.removeFromSuperview()
                backdrop.removeFromSuperview()
                return
            }

            // Where the thumbnail is NOW: a streaming transcript scrolls
            // itself, so the rectangle it lifted from can be stale. With the
            // row gone entirely there is nothing to fly back to.
            let destination: CGRect? = if let host, host.window != nil {
                host.convert(host.bounds, to: nil)
            } else {
                nil
            }
            UIView.animate(springDuration: 0.34, bounce: 0.12) {
                lifted.transform = .identity
                if let destination {
                    lifted.frame = destination
                } else {
                    lifted.alpha = 0
                }
                backdrop.alpha = 0
            } completion: { _ in
                lifted.removeFromSuperview()
                backdrop.removeFromSuperview()
            }
        }
    }
}

/// Sits over the image but takes no touches: taps still reach the button
/// underneath and drags still reach the transcript's scroll view. It exists
/// only to know where the image is, and when it comes and goes.
private final class PassthroughView: UIView {
    var onWindowChange: (() -> Void)?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onWindowChange?()
    }
}
#endif
