import SwiftUI
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The app's primary colour, as data.
///
/// Every accent surface reads `OS1VisualStyle.accent` / `.accentInk` /
/// `.onAccent`, and those read the case selected here — filled controls, system
/// tint, and active glyphs. Changing the whole app's primary colour is therefore
/// one value, and adding a colour starts with one line in `fills`: a name, and
/// the two hexes it wears in light and dark.
///
/// What sits ON the accent is deliberately NOT part of that table. Jewel tones
/// take white ink and honey takes black. The contrast test guards that rule,
/// so replacing either hex cannot ship an illegible glyph.
///
/// The cases are a walk around the hue wheel from the blues. `lime` is the id
/// Honey is stored under and `pink` the one Orchid is stored under: the raw
/// value is persisted per device, so it outlives the colour it was named for.
/// Renaming a case resets everyone who chose it, so migrate in `AccentStore`.
enum AccentTheme: String, CaseIterable, Identifiable, Sendable {
    case sky
    case indigo
    case coral
    case orange
    case lime
    case green
    case mono

    static let `default` = AccentTheme.sky

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sky: "Sky"
        case .indigo: "Indigo"
        case .coral: "Coral"
        case .orange: "Tangerine"
        case .lime: "Honey"
        case .green: "Clover"
        case .mono: "Black"
        }
    }

    /// Each fill runs at 92% of the chroma its hue can physically reach in sRGB
    /// at its lightness, which keeps the palette vivid without clipping. The
    /// share is flat across the wheel; the results are not. Sky tops out below
    /// Indigo and Coral, so the cool end reads calmer than the warm one.
    ///
    /// Honey keeps one value in both appearances: yellow only exists at high
    /// lightness, so a value deep enough to separate from a white page still
    /// reads as gold on a dark one. Black has no hue at all and inverts with
    /// the page, which is why it is the only fill whose glyph changes.
    var fills: (light: UInt32, dark: UInt32) {
        switch self {
        case .sky: (0x1C_7D_B4, 0x24_95_D6)
        case .indigo: (0x35_6D_F3, 0x53_86_F6)
        case .coral: (0xDD_23_3A, 0xF7_36_48)
        case .orange: (0xC6_52_1A, 0xEB_62_21)
        case .lime: (0xEE_C7_5C, 0xEE_C7_5C)
        case .green: (0x1D_88_42, 0x24_A3_51)
        case .mono: (0x00_00_00, 0xFF_FF_FF)
        }
    }

    /// The fill a control uses to say "on": a switch track, a checkbox box.
    ///
    /// Every accent resolves straight through to its own fill except the two
    /// that cannot carry that job. Honey is 1.3:1 against a white page and its
    /// glyph is the 1.62:1 that only works at the size of an arrow in a disc,
    /// so a yellow track reads as neither on nor off in either appearance.
    /// Black's fill inverts with the page, so in dark mode it is a white track
    /// with a white knob, and the ink ramp has nowhere left to deepen into.
    /// Both borrow Sky, which is where the web's --accent-control lands too.
    var controlFills: (light: UInt32, dark: UInt32) {
        let borrowed = AccentTheme.sky.fills.dark
        return switch self {
        case .lime: (borrowed, borrowed)
        // Light mode's own black plate reads perfectly well; only the white one
        // has to give way.
        case .mono: (fills.light, borrowed)
        default: fills
        }
    }

    /// `controlFills`, resolved per appearance. This is what a Toggle is
    /// tinted with; `accent` stays the colour of everything else.
    var accentControl: Color {
        Color(platformColor: AccentTheme.dynamic(
            light: AccentTheme.platformColor(controlFills.light),
            dark: AccentTheme.platformColor(controlFills.dark)
        ))
    }

    /// The fill itself, resolved per appearance.
    var accent: Color {
        Color(platformColor: AccentTheme.dynamic(
            light: AccentTheme.platformColor(fills.light),
            dark: AccentTheme.platformColor(fills.dark)
        ))
    }

    /// The accent as foreground ink on the page. Honey's fill is a plate
    /// colour, and as a label or icon it has to clear text contrast, so it
    /// deepens on light surfaces.
    var accentInk: Color {
        guard self == .lime else { return accent }
        return Color(platformColor: AccentTheme.dynamic(
            light: AccentTheme.platformColor(0x8D_71_10),
            dark: AccentTheme.platformColor(fills.dark)
        ))
    }

    /// Your own message bubble: the fill softened into the surface it
    /// replaces, so your turns are easy to spot in a long chat. Opaque, so the
    /// body text keeps its contrast. 12% into white in light; 22% into the
    /// dark bubble grey, because a thinner wash disappears on a dark page.
    /// Same mix as the web's --bubble-user.
    var userBubble: Color {
        Color(platformColor: AccentTheme.dynamic(
            light: AccentTheme.platformColor(
                AccentTheme.blend(fills.light, toward: 0xFF_FF_FF, by: 0.88)
            ),
            dark: AccentTheme.platformColor(
                AccentTheme.blend(fills.dark, toward: 0x31_31_31, by: 0.78)
            )
        ))
    }

    /// The picker presentation: barely lifted at the top-left and shaded at
    /// the bottom-right. Both stops derive from `fills`, so replacing a palette
    /// hex still changes the whole swatch in one place.
    var gradient: LinearGradient {
        let highlight = Color(platformColor: AccentTheme.dynamic(
            light: AccentTheme.platformColor(
                AccentTheme.blend(fills.light, toward: 0xFF_FF_FF, by: 0.03)
            ),
            dark: AccentTheme.platformColor(
                AccentTheme.blend(fills.dark, toward: 0xFF_FF_FF, by: 0.03)
            )
        ))
        let shade = Color(platformColor: AccentTheme.dynamic(
            light: AccentTheme.platformColor(
                AccentTheme.blend(fills.light, toward: 0x00_00_00, by: 0.06)
            ),
            dark: AccentTheme.platformColor(
                AccentTheme.blend(fills.dark, toward: 0x00_00_00, by: 0.06)
            )
        ))
        return LinearGradient(
            colors: [highlight, shade],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    /// What sits on top of the fill: the glyph in the send disc and every other
    /// prominent accent control. Every accent takes white, including Honey,
    /// whose 1.62:1 is the palette's one deliberate low-contrast pairing and
    /// only ever carries a glyph. Black inverts with the page instead.
    var onAccent: Color {
        guard self == .mono else { return .white }
        return Color(platformColor: AccentTheme.dynamic(light: .white, dark: .black))
    }

    /// A flat, appearance-independent swatch — for anywhere the two values have
    /// to be shown side by side rather than resolved.
    func swatch(dark: Bool) -> Color {
        Color(platformColor: AccentTheme.platformColor(dark ? fills.dark : fills.light))
    }

    /// Whether this accent's fixed glyph is white. Together with
    /// `glyphContrast` this lets the test suite reject replacement colours too
    /// pale to carry the palette's chosen ink.
    func glyphIsWhite(dark: Bool) -> Bool { self != .mono || !dark }

    /// How much contrast the derived glyph gets on this fill.
    func glyphContrast(dark: Bool) -> Double {
        let fill = AccentTheme.luminance(dark ? fills.dark : fills.light)
        let glyph = glyphIsWhite(dark: dark) ? 1.0 : 0.0
        return (max(fill, glyph) + 0.05) / (min(fill, glyph) + 0.05)
    }

    // ── Colour maths ──────────────────────────────────────────────────────

    private static func platformColor(_ hex: UInt32) -> PlatformColor {
        PlatformColor(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            alpha: 1
        )
    }

    private static func blend(_ hex: UInt32, toward target: UInt32, by amount: Double) -> UInt32 {
        let mixed = [16, 8, 0].map { shift -> UInt32 in
            let source = Double((hex >> shift) & 0xFF)
            let destination = Double((target >> shift) & 0xFF)
            return UInt32((source + (destination - source) * amount).rounded()) << shift
        }
        return mixed.reduce(0, |)
    }

    /// WCAG relative luminance.
    private static func luminance(_ hex: UInt32) -> Double {
        let channels = [(hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF]
            .map { component -> Double in
                let c = Double(component) / 255
                return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }

    private static func dynamic(light: PlatformColor, dark: PlatformColor) -> PlatformColor {
        #if os(macOS)
        NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        }
        #else
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        }
        #endif
    }
}

#if os(macOS)
typealias PlatformColor = NSColor
#else
typealias PlatformColor = UIColor
#endif

extension Color {
    init(platformColor: PlatformColor) {
        #if os(macOS)
        self.init(nsColor: platformColor)
        #else
        self.init(uiColor: platformColor)
        #endif
    }
}

/// The selected accent, and the reason `OS1VisualStyle.accent` is a computed
/// property rather than the `static let` it used to be: a view that reads the
/// accent inside its `body` reads `theme` through it, so Observation registers
/// the dependency and every accent surface in the app repaints the moment the
/// picker changes — no relaunch, no notification plumbing, no environment key
/// threaded through a hundred views.
@Observable
final class AccentStore {
    static let shared = AccentStore()

    /// Shares the `os1.appearance.*` namespace with the light/dark setting it
    /// sits beside. The device still owns the selection; publishing its value
    /// lets generated session cards use the same colour.
    static let defaultsKey = "os1.appearance.accent"
    private static let prefKey = "accent"

    @ObservationIgnored private let defaults: UserDefaults

    var theme: AccentTheme {
        didSet {
            guard theme != oldValue else { return }
            defaults.set(theme.rawValue, forKey: Self.defaultsKey)
            Self.publish(theme)
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: Self.defaultsKey) ?? ""
        // Preserve selections across palette replacements rather than silently
        // resetting someone to the default accent.
        let normalized = switch stored {
        case "blue": AccentTheme.sky.rawValue
        case "gold": AccentTheme.lime.rawValue
        case "purple": AccentTheme.coral.rawValue
        case "pink": AccentTheme.coral.rawValue
        case "brown": AccentTheme.orange.rawValue
        case "teal": AccentTheme.sky.rawValue
        default: stored
        }
        theme = AccentTheme(rawValue: normalized) ?? .default
        if normalized != stored {
            defaults.set(normalized, forKey: Self.defaultsKey)
        }
        Self.publish(theme)
    }

    private static func publish(_ theme: AccentTheme) {
        let user = ServerConfig.shared.userName
        Task {
            _ = try? await SettingsAPI.updateUiPrefs(
                user: user,
                prefs: [prefKey: theme.rawValue]
            )
        }
    }
}
