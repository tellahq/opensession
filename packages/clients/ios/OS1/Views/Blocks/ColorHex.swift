import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

extension OS1VisualStyle {
    /// A token resolved for one appearance as `#rrggbb`, which is what a web
    /// view's stylesheet can paint with and a dynamic colour is not.
    static func hex(of color: Color, dark: Bool) -> String {
        var (r, g, b): (CGFloat, CGFloat, CGFloat) = (0, 0, 0)
        #if os(iOS)
        let resolved = UIColor(color).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        )
        var a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        #else
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        var resolved = NSColor(color)
        appearance?.performAsCurrentDrawingAppearance {
            resolved = resolved.usingColorSpace(.sRGB) ?? resolved
        }
        r = resolved.redComponent
        g = resolved.greenComponent
        b = resolved.blueComponent
        #endif
        func channel(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", channel(r), channel(g), channel(b))
    }
}
