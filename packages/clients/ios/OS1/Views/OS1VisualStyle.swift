import SwiftUI
import ImageIO
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum OS1VisualStyle {
    // Use native semantic surfaces so the app follows its Settings appearance.
    #if os(iOS)
    static let background = Color(uiColor: .systemBackground)
    static let raised = Color(uiColor: .secondarySystemBackground)
    static let panel = Color(uiColor: .tertiarySystemBackground)
    static let hover = Color(uiColor: .quaternarySystemFill)
    static let border = Color(uiColor: .separator)
    /// The chat composer keeps a white edge in light appearance so its solid
    /// surface stays bright, then uses translucent white against the dark page.
    static let composerBorder = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.20)
            : UIColor(white: 1, alpha: 1)
    })
    static let text = Color(uiColor: .label)
    static let textDim = Color(uiColor: .secondaryLabel)
    static let textFaint = Color(uiColor: .tertiaryLabel)
    /// The note composer's hint is the faint label ink warmed 16% toward its
    /// yellow surface. A neutral hint reads blue-grey on that fill.
    static let notePlaceholder = Color(uiColor: UIColor { traits in
        let faint = UIColor.tertiaryLabel.resolvedColor(with: traits)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        faint.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return UIColor(
            red: red * 0.84 + 0.824 * 0.16,
            green: green * 0.84 + 0.600 * 0.16,
            blue: blue * 0.84 + 0.133 * 0.16,
            alpha: alpha
        )
    })
    /// Code surfaces mirror the PWA's GitHub-themed wells rather than using a
    /// permanently dark card in light appearance.
    ///
    /// The light value is NOT the web's #f6f8fa: that one is calibrated to sit
    /// nine steps under a WHITE page, and the transcript here runs on
    /// `chatCanvas` (#fafafa), where it landed four steps away and every
    /// expanded tool call read as a white slab with a hairline round it. This
    /// keeps the web's step, measured from the canvas the well actually sits
    /// on, so the well reads sunk in both clients.
    static let codeWell = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.051, green: 0.059, blue: 0.075, alpha: 1)
            : UIColor(red: 0.945, green: 0.953, blue: 0.961, alpha: 1)
    })
    static let codeWellBorder = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.06)
            : UIColor(red: 0.847, green: 0.871, blue: 0.894, alpha: 1)
    })
    static let codeWellText = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.714, green: 0.737, blue: 0.784, alpha: 1)
            : UIColor(red: 0.341, green: 0.376, blue: 0.416, alpha: 1)
    })
    static let codeWellGutter = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.337, green: 0.365, blue: 0.420, alpha: 1)
            : UIColor(red: 0.549, green: 0.584, blue: 0.624, alpha: 1)
    })
    /// A diff's added and removed lines, and its hunk headers, ON the well.
    /// The status palette below is one pair of values for both appearances,
    /// which is right for a dot on the chrome and wrong here: those are the
    /// web's DARK theme greens and blues, and on a light well they measure
    /// around 2:1. These are the light theme's own (--green/--red/--blue in
    /// base.css), so a diff reads the same in either appearance.
    static let codeWellAdd = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.247, green: 0.729, blue: 0.314, alpha: 1)
            : UIColor(red: 0.102, green: 0.498, blue: 0.216, alpha: 1)
    })
    static let codeWellRemove = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.973, green: 0.318, blue: 0.286, alpha: 1)
            : UIColor(red: 0.812, green: 0.133, blue: 0.180, alpha: 1)
    })
    static let codeWellHunk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.345, green: 0.651, blue: 1.0, alpha: 1)
            : UIColor(red: 0.035, green: 0.412, blue: 0.855, alpha: 1)
    })
    /// Markdown fences can sit on the canvas or inside a message bubble. A
    /// translucent light well stays one step below either surrounding surface.
    static let markdownCodeWell = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.047, green: 0.047, blue: 0.063, alpha: 1)
            : UIColor(white: 0, alpha: 0.055)
    })
    /// A run of inline code inside a sentence — the same 6% ink the web's
    /// `.markdown code` paints. Translucent rather than a surface from the
    /// ramp: a code run lands on the canvas, on a message bubble and inside a
    /// work fold, and one wash sits a fixed step below all three. `panel` was
    /// the surface here, and `.tertiarySystemBackground` is WHITE in light
    /// appearance — so the chip read as a lighter box punched into the prose
    /// instead of a tint on it.
    static let markdownInlineCode = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.06)
            : UIColor(white: 0, alpha: 0.06)
    })
    /// A turn footer's chips, and the same wash the web paints under its own.
    /// Ink rather than a surface for the reason above: `panel` is WHITE in
    /// light appearance, so a chip on the transcript canvas read as a pale
    /// box punched OUT of the page instead of a tint laid on it.
    ///
    /// The web's 3% is not the step here. On this canvas it lands ~8/255
    /// below the page, which `userMessage` below already found to be close to
    /// invisible on a phone in daylight; 5% lands at 12, and stays a hair
    /// lighter than inline code so the two surfaces keep the web's order.
    static let chipFill = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.05)
            : UIColor(white: 0, alpha: 0.05)
    })
    /// Body prose that is subordinate but still meant to be READ — the
    /// narration inside a work fold. Not `textDim`: `.secondaryLabel` is built
    /// for short labels, and at 17pt over the canvas it measures 3.4:1, under
    /// WCAG AA's 4.5:1 for body text, which is the wrong place to save
    /// contrast when that prose is the part of a turn worth reading. These
    /// neutrals measure ~6.4:1 and stay plainly below the answer's ~20:1, so
    /// the text still reads as context rather than conclusion.
    static let textNarration = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0.720, alpha: 1)
            : UIColor(white: 0.360, alpha: 1)
    })
    /// The transcript's canvas — the session screen behind the messages, and
    /// the washes that ramp into it. Its own colour rather than `background`
    /// because everything that floats on it in light mode is white: the
    /// composer, the nav-bar glass, the scroll-to-bottom pill. On
    /// `.systemBackground` (pure white) those can only show a shadow; a hair
    /// of grey under them is what makes them read as floating. Dark keeps
    /// `background` — there the composer is already lighter than the page, so
    /// there is nothing to fix and nothing moves.
    ///
    /// Deliberately neutral rather than `.secondarySystemBackground`: that one
    /// is #F2F2F7, whose blue cast reads cold beside the composer's near-white
    /// glass — the same reason `flapSurface` below is hand-rolled.
    static let chatCanvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? .systemBackground
            : UIColor(white: 0.980, alpha: 1)
    })
    /// The user's own bubble, on `chatCanvas`. The light value steps down with
    /// the canvas so the bubble keeps the separation it had on white; left at
    /// 0.949 it would sit ~8/255 off its background instead of ~13, which is
    /// close to invisible on a phone in daylight.
    static let userMessage = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0.192, alpha: 1)
            : UIColor(white: 0.925, alpha: 1)
    })
    /// The queue flap tucked behind the composer. Deliberately not `raised`:
    /// on iOS that resolves to `.secondarySystemBackground`, whose blue-grey
    /// cast reads cold beside the composer's near-white glass in light mode,
    /// and which sits within a couple of points of the page in dark mode, so
    /// the flap all but disappeared against it. A neutral instead — a shade
    /// under the composer on light, a shade over the page on dark, which is
    /// the only direction left when the page is already black.
    static let flapSurface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0.145, alpha: 1)
            : UIColor(white: 0.953, alpha: 1)
    })
    /// The OPEN session's tab pill. Pure white on light — a step ABOVE
    /// `chatCanvas`, which is the only direction left when the tab you are in
    /// has to out-read its siblings: tinting it instead (the old
    /// `quaternarySystemFill`) made the current tab the greyest thing in the
    /// strip. Dark can't use `background`, which IS the page there, so it
    /// lifts to a grey the same distance above the canvas.
    static let tabActive = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0.180, alpha: 1)
            : UIColor(white: 1.0, alpha: 1)
    })
    #else
    static let background = Color(nsColor: .windowBackgroundColor)
    static let raised = Color(nsColor: .underPageBackgroundColor)
    static let panel = Color(nsColor: .controlBackgroundColor)
    static let hover = Color(nsColor: .unemphasizedSelectedContentBackgroundColor)
    static let border = Color(nsColor: .separatorColor)
    static let text = Color(nsColor: .labelColor)
    static let textDim = Color(nsColor: .secondaryLabelColor)
    static let textFaint = Color(nsColor: .tertiaryLabelColor)
    static let notePlaceholder = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.525, green: 0.486, blue: 0.412, alpha: 1)
            : NSColor(red: 0.584, green: 0.553, blue: 0.486, alpha: 1)
    })
    static let codeWell = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.051, green: 0.059, blue: 0.075, alpha: 1)
            : NSColor(red: 0.965, green: 0.973, blue: 0.980, alpha: 1)
    })
    static let codeWellBorder = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.06)
            : NSColor(red: 0.847, green: 0.871, blue: 0.894, alpha: 1)
    })
    static let codeWellText = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.714, green: 0.737, blue: 0.784, alpha: 1)
            : NSColor(red: 0.341, green: 0.376, blue: 0.416, alpha: 1)
    })
    static let codeWellGutter = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.337, green: 0.365, blue: 0.420, alpha: 1)
            : NSColor(red: 0.549, green: 0.584, blue: 0.624, alpha: 1)
    })
    /// Diff ink on the well — see the iOS note for why these are their own
    /// per-appearance values rather than the status palette.
    static let codeWellAdd = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.247, green: 0.729, blue: 0.314, alpha: 1)
            : NSColor(red: 0.102, green: 0.498, blue: 0.216, alpha: 1)
    })
    static let codeWellRemove = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.973, green: 0.318, blue: 0.286, alpha: 1)
            : NSColor(red: 0.812, green: 0.133, blue: 0.180, alpha: 1)
    })
    static let codeWellHunk = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.345, green: 0.651, blue: 1.0, alpha: 1)
            : NSColor(red: 0.035, green: 0.412, blue: 0.855, alpha: 1)
    })
    static let markdownCodeWell = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.047, green: 0.047, blue: 0.063, alpha: 1)
            : NSColor(white: 0, alpha: 0.055)
    })
    /// Inline code's tint — see the iOS note for why it is translucent ink
    /// rather than a surface.
    static let markdownInlineCode = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.06)
            : NSColor(white: 0, alpha: 0.06)
    })
    /// A turn footer's chips — see the iOS note for why this is ink rather
    /// than a surface. The same alpha holds here: the Mac canvas is already a
    /// grey around #ECECEC, and 5% ink still reads on it.
    static let chipFill = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.05)
            : NSColor(white: 0, alpha: 0.05)
    })
    /// Subordinate body prose — see the iOS note for why this is its own
    /// neutral rather than `textDim`.
    static let textNarration = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 0.720, alpha: 1)
            : NSColor(white: 0.360, alpha: 1)
    })
    /// The Mac window background is already a grey the composer floats on, so
    /// the transcript needs no canvas of its own here — see the iOS note.
    static let chatCanvas = Color(nsColor: .windowBackgroundColor)
    /// Neutral gray, resolved per appearance. It does NOT follow iOS's light
    /// value down: `windowBackgroundColor` is itself around #ECECEC in light,
    /// so the bubble is the LIFTED surface on the Mac and has to stay above
    /// its background rather than step below it.
    static let userMessage = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 0.192, alpha: 1)
            : NSColor(white: 0.949, alpha: 1)
    })
    /// The queue flap behind the composer — same neutrals as iOS, so the two
    /// apps read as one product. See the iOS note above for why it isn't
    /// `raised`.
    static let flapSurface = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 0.145, alpha: 1)
            : NSColor(white: 0.953, alpha: 1)
    })
    /// The open session's tab pill — see the iOS note. Light lifts to white
    /// off the Mac's grey window background; dark lifts the same distance.
    static let tabActive = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 0.180, alpha: 1)
            : NSColor(white: 1.0, alpha: 1)
    })
    #endif
    /// The brand mark, and the app's one primary colour: whichever `AccentTheme`
    /// is selected in Settings › Appearance, resolved per appearance. It is a
    /// FILL colour — the send disc, active borders and selected surfaces — and
    /// deliberately not a text colour. Foreground icons use `accentInk`; inline
    /// affordances (links, fold toggles) take `link` instead.
    ///
    /// Computed rather than stored so a view that reads it inside `body` picks
    /// up a change to the setting immediately; see `AccentStore`.
    static var accent: Color { AccentStore.shared.theme.accent }
    /// The accent adapted for use as an icon or short label on the page.
    static var accentInk: Color { AccentStore.shared.theme.accentInk }
    /// What sits on top of an `accent` fill, so the glyph in the send disc
    /// stays legible in either appearance. Derived from the fill's luminance —
    /// see `AccentTheme.onAccent`.
    static var onAccent: Color { AccentStore.shared.theme.onAccent }
    /// The accent as a control's "on" state. Two accents cannot carry that job
    /// and borrow Sky for it; see `AccentTheme.controlFills`.
    static var accentControl: Color { AccentStore.shared.theme.accentControl }
    #if os(iOS)
    /// Links and other tappable words in running text.
    static let link = Color(uiColor: .link)
    /// The settings row icons. Neutral by design: the chrome is monochrome, and
    /// a hue on every row read as decoration rather than as meaning. Sitting a
    /// step darker on light / lighter on dark than `textDim` keeps the glyph
    /// column present without competing with the row title, which owns full
    /// label contrast.
    static let iconTint = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0.68, alpha: 1)
            : UIColor(white: 0.35, alpha: 1)
    })
    #else
    static let link = Color(nsColor: .linkColor)
    static let iconTint = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 0.68, alpha: 1)
            : NSColor(white: 0.35, alpha: 1)
    })
    #endif
    // One status palette on both platforms — the Mac previously used stock
    // Color.green/.yellow/… which rendered different hues than iOS.
    //
    // These are FILL colours: a dot, a status glyph, a wash, a stroke. For
    // the same five meanings said in WORDS, use the matching `*Ink` below.
    static let green = Color(red: 0.247, green: 0.725, blue: 0.314)
    static let yellow = Color(red: 0.824, green: 0.600, blue: 0.133)
    static let blue = Color(red: 0.345, green: 0.651, blue: 1.0)
    static let red = Color(red: 0.973, green: 0.318, blue: 0.286)
    static let purple = Color(red: 0.639, green: 0.443, blue: 0.969)
    // The wash a borrowed sidebar's heading wears: the web's `--blue-soft`,
    // which is the blue above at the alpha each theme mixes it for. Said as an
    // alpha rather than a mixed hex because the surface under it is the
    // system's own list background and moves with the appearance.
    #if os(iOS)
    static let blueSoft = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.345, green: 0.651, blue: 1.0, alpha: 0.13)
            : UIColor(red: 0.035, green: 0.412, blue: 0.855, alpha: 0.10)
    })
    #else
    static let blueSoft = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.345, green: 0.651, blue: 1.0, alpha: 0.13)
            : NSColor(red: 0.035, green: 0.412, blue: 0.855, alpha: 0.10)
    })
    #endif
    // The wash under the ask chip on an archived row: the web's `--green-soft`,
    // ported as a STEP from the surface rather than as its hex. The web mixes
    // its light green at 12% over a white page and its dark green at 14% over
    // #1c1c1c. An archived row here sits on white and on #1c1c1e, so the
    // surfaces nearly match, but the hue does not: light takes `greenInk`'s
    // green, the colour the chip's own word is written in, so the pill reads
    // as one colour, and that darker hue lands the web's luminance step below
    // white at 11% where the web's lighter one needed 12%. Dark keeps the
    // palette green at 13%, the web's step above its page measured from this
    // one. `AskChipContrastTests` measures the word over both.
    #if os(iOS)
    static let greenSoft = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.247, green: 0.725, blue: 0.314, alpha: 0.13)
            : UIColor(red: 0.098, green: 0.478, blue: 0.208, alpha: 0.11)
    })
    #else
    static let greenSoft = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.247, green: 0.725, blue: 0.314, alpha: 0.13)
            : NSColor(red: 0.098, green: 0.478, blue: 0.208, alpha: 0.11)
    })
    #endif
    // A check row that wants something, on the PR panel's grouped list.
    //
    // The web tints one summary chip by the worst status it can see. A phone
    // shows every check as its own row, and the question those rows hide is
    // which one broke: finding it means reading twenty 15pt glyphs down a
    // column of near-identical workflow names. So the rows that are NOT
    // passing take a wash and a passing row keeps the plain list surface. A
    // list painted green end to end answers nothing and leaves the single red
    // row harder to find than before.
    //
    // Translucent status ink rather than the web's `--red-soft` / `--yellow-soft`
    // hexes: those are mixed for `--bg-panel`, and a grouped row here is white
    // in light appearance and near-black in dark, so one wash has to sit a
    // fixed step over both surfaces instead of naming a colour. The alpha is
    // per appearance because the wash that reads on white disappears on black,
    // and yellow carries more of it than red at the same strength because it
    // is the lighter hue.
    #if os(iOS)
    static let checkRowFailure = Color(uiColor: UIColor { traits in
        UIColor(
            red: 0.973, green: 0.318, blue: 0.286,
            alpha: traits.userInterfaceStyle == .dark ? 0.22 : 0.12
        )
    })
    static let checkRowPending = Color(uiColor: UIColor { traits in
        UIColor(
            red: 0.824, green: 0.600, blue: 0.133,
            alpha: traits.userInterfaceStyle == .dark ? 0.24 : 0.16
        )
    })
    #else
    static let checkRowFailure = Color(nsColor: NSColor(name: nil) { appearance in
        NSColor(
            red: 0.973, green: 0.318, blue: 0.286,
            alpha: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? 0.22 : 0.12
        )
    })
    static let checkRowPending = Color(nsColor: NSColor(name: nil) { appearance in
        NSColor(
            red: 0.824, green: 0.600, blue: 0.133,
            alpha: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? 0.24 : 0.16
        )
    })
    #endif
    // The same five meanings as INK: what a status is called, rather than the
    // mark that stands for it.
    //
    // The palette above is one pair of values for both appearances, and those
    // values are the web's DARK theme (`--green` and friends in base.css). On
    // a dark page they measure 6:1 to 8:1. On this app's light surfaces they
    // measure about 2.5:1, under WCAG AA's 4.5:1 for body text and under even
    // the 3:1 large text gets. That is defensible for a dot, a glyph or a
    // wash: those are seen rather than read, and each one in this app sits
    // beside words that say the same thing. It is not defensible for the
    // words themselves, which is what these are for.
    //
    // Dark keeps the palette unchanged, so a status reads as one colour there.
    // Light starts from base.css's own light theme and takes three of the five
    // a step further. The web's values are calibrated against a white page,
    // and the surfaces these words land on here sit below it: the Mac's window
    // background, the transcript canvas, a note's own 10% wash, a grouped
    // list. Against the lowest of those, #ECECEC, the web's green, blue and
    // purple measure about 4.3:1 and its yellow 4.1:1. These hold 4.5:1 from
    // white down to that surface, which `StatusInkContrastTests` asserts.
    #if os(iOS)
    static let greenInk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.247, green: 0.725, blue: 0.314, alpha: 1)
            : UIColor(red: 0.098, green: 0.478, blue: 0.208, alpha: 1)
    })
    static let yellowInk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.824, green: 0.600, blue: 0.133, alpha: 1)
            : UIColor(red: 0.561, green: 0.373, blue: 0.0, alpha: 1)
    })
    static let blueInk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.345, green: 0.651, blue: 1.0, alpha: 1)
            : UIColor(red: 0.035, green: 0.400, blue: 0.835, alpha: 1)
    })
    static let redInk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.973, green: 0.318, blue: 0.286, alpha: 1)
            : UIColor(red: 0.812, green: 0.133, blue: 0.180, alpha: 1)
    })
    static let purpleInk = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.639, green: 0.443, blue: 0.969, alpha: 1)
            : UIColor(red: 0.490, green: 0.302, blue: 0.839, alpha: 1)
    })
    #else
    static let greenInk = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.247, green: 0.725, blue: 0.314, alpha: 1)
            : NSColor(red: 0.098, green: 0.478, blue: 0.208, alpha: 1)
    })
    static let yellowInk = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.824, green: 0.600, blue: 0.133, alpha: 1)
            : NSColor(red: 0.561, green: 0.373, blue: 0.0, alpha: 1)
    })
    static let blueInk = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.345, green: 0.651, blue: 1.0, alpha: 1)
            : NSColor(red: 0.035, green: 0.400, blue: 0.835, alpha: 1)
    })
    static let redInk = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.973, green: 0.318, blue: 0.286, alpha: 1)
            : NSColor(red: 0.812, green: 0.133, blue: 0.180, alpha: 1)
    })
    static let purpleInk = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.639, green: 0.443, blue: 0.969, alpha: 1)
            : NSColor(red: 0.490, green: 0.302, blue: 0.839, alpha: 1)
    })
    #endif
    /// A teammate's reply routed back into a session — the web's `#1f9e8a`.
    /// Not a status colour: it marks whose words these are, so it is warm
    /// rather than green-for-good.
    static let humanReply = Color(red: 0.122, green: 0.620, blue: 0.541)
    #if os(iOS)
    static let sessionMaxWidth: CGFloat = 780
    #else
    /// Keep 13pt desktop body copy near the comfortable 65-75 character range.
    static let sessionMaxWidth: CGFloat = 720
    #endif
}

/// The color a repo's letter tile wears.
///
/// The server assigns one per registered repo across the whole set, so no two
/// of them match — the tile can then stand in for a repo where there's no room
/// to name it, which is what the Inbox rows rely on. Those assignments arrive
/// with the repo list (`OS1API.repos()`); the palette and hash here are the
/// fallback for an id the server never listed, mirrored from
/// src/server/repo-tile-colors.ts. Keep the three copies (there, the web tile,
/// here) in step or one surface paints a repo a color the others don't.
@MainActor
@Observable
final class RepoTilePalette {
    static let shared = RepoTilePalette()

    static let colors: [UInt32] = [
        0xff31_56,  // rose
        0xe858_00,  // orange
        0xb37d_00,  // gold
        0x4e98_00,  // lime
        0x009a_69,  // jade
        0x0096_97,  // teal
        0x0090_c8,  // azure
        0x4d80_ff,  // blue
        0x946c_ff,  // violet
        0xd744_e2,  // magenta
    ]

    /// The letter every tile carries. It is the ceiling on the palette —
    /// these sit at a flat 3.6:1 against it — so colors and ink move
    /// together; see REPO_TILE_INK in src/server/repo-tile-colors.ts.
    static let ink = Color.white

    private var assigned: [String: UInt32] = [:]
    /// When each repo's icon last changed. Icons are cacheable and URLCache
    /// outlives a launch, so replacing one from Settings would otherwise keep
    /// painting the old picture until the stored copy went stale.
    private(set) var iconRevisions: [String: Int] = [:]

    /// Record what the server assigned. Repos it didn't color (an older
    /// server) keep the hashed fallback rather than losing their tile.
    func remember(_ repos: [OS1API.RepoInfo]) {
        for repo in repos {
            if let hex = repo.color, let rgb = Self.parse(hex) {
                assigned[repo.id] = rgb
            }
            if let rev = repo.iconRev {
                iconRevisions[repo.id] = Int(rev)
            } else {
                iconRevisions.removeValue(forKey: repo.id)
            }
        }
    }

    func rgb(for name: String) -> UInt32 {
        assigned[name] ?? Self.colors[Self.hashIndex(name)]
    }

    func color(for name: String) -> Color {
        Color(rgb: rgb(for: name))
    }

    /// What an icon is actually painted with: the color under a very slight
    /// vertical gradient, the way a modern app icon is lit. Mirrors
    /// `repoIconFill` on the web — 8% white at the top, 5% black at the
    /// bottom, which is as far as it can go before the white letter drops
    /// under 3:1 at the top edge. Blended in sRGB rather than oklab like the
    /// CSS: at this size the two are indistinguishable.
    static func fill(_ rgb: UInt32) -> LinearGradient {
        LinearGradient(
            colors: [Color(rgb: rgb, mixWhite: 0.08), Color(rgb: rgb, mixBlack: 0.05)],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    func fill(for name: String) -> LinearGradient { Self.fill(rgb(for: name)) }

    /// FNV-1a over the lowercased id, walked as UTF-16 so it matches the
    /// JavaScript original code unit for code unit.
    private static func hashIndex(_ name: String) -> Int {
        var hash: UInt32 = 0x811c_9dc5
        for unit in name.lowercased().utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return Int(hash % UInt32(colors.count))
    }

    static func parse(_ hex: String) -> UInt32? {
        var text = hex
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let rgb = UInt32(text, radix: 16) else { return nil }
        return rgb
    }
}

extension Color {
    /// A palette entry as a Color, optionally lifted toward white or dropped
    /// toward black — which is how the icon's gradient is built. Not private:
    /// the repo-icon editor paints the same swatches this tile does.
    init(rgb: UInt32, mixWhite: Double = 0, mixBlack: Double = 0) {
        let channel = { (shift: UInt32) -> Double in
            let value = Double((rgb >> shift) & 0xff) / 255
            return value * (1 - mixWhite - mixBlack) + mixWhite
        }
        self.init(.sRGB, red: channel(16), green: channel(8), blue: channel(0), opacity: 1)
    }
}

/// Compact repository identity used in repo headers and the conversation title.
/// Its stable single-letter swatch mirrors the web fallback tile.
struct RepoTile: View {
    let name: String
    var size: CGFloat = 18
    var round = false
    /// How much of the tile the artwork fills. 1 is right for a repo tile —
    /// the server crops every icon to its artwork and re-pads it to a fixed
    /// margin, so the breathing room is already in the image, and shrinking
    /// again here would leave art reading smaller than the lettered tiles
    /// beside it. The one caller that overrides it is the sessions-list
    /// Settings button, which reproduces the margin the app mark used to
    /// carry before the icons were trimmed.
    var artScale: CGFloat = 1

    static func label(for name: String) -> String {
        if name == Session.noRepoID { return "No repo" }
        return name == "backstage" ? "opensession" : name  // legacy id on older instances
    }

    static func usesBundledProductIcon(for name: String) -> Bool {
        name == "opensession" || name == "backstage"
    }

    private var letter: String {
        if name == "backstage" { return "O" }
        return String(name.prefix(1)).uppercased()
    }

    private var fill: LinearGradient { RepoTilePalette.shared.fill(for: name) }

    @MainActor
    private var iconURL: URL? { Self.iconURL(for: name) }

    @MainActor
    private var bundledProductIcon: Image? {
        guard Self.usesBundledProductIcon(for: name) else { return nil }
        #if os(macOS)
        return Image(nsImage: NSApplication.shared.applicationIconImage)
        #else
        return Image("AppIcon")
        #endif
    }

    @MainActor
    private var displayedIcon: Image? {
        if let iconURL,
           let image = RepoImageCache.shared.images[iconURL.absoluteString] {
            return image
        }
        return bundledProductIcon
    }

    /// Bumped when the icons behind /repo-icon are redrawn — keep it in step
    /// with ICON_VERSION in the web tile. The response is cacheable and
    /// URLCache survives an app update, so without a new URL a freshly
    /// installed build would keep painting the art the old one cached. 3
    /// dropped the owner/org-avatar fallback, so a repo that was wearing its
    /// org's mark had to stop asking for the copy on disk; 4 trims the empty
    /// margin around every icon, so the copies drawn small have to go.
    private static let iconVersion = 4

    @MainActor
    private static func iconURL(for name: String) -> URL? {
        if name == Session.noRepoID { return nil }
        var url = ServerConfig.shared.baseURL?
            .appendingPathComponent("repo-icon")
            .appendingPathComponent("\(name).png")
        var query = [URLQueryItem(name: "v", value: "\(iconVersion)")]
        // An icon replaced from Settings is a different picture at the same
        // path; its revision is what tells the cache that.
        if let rev = RepoTilePalette.shared.iconRevisions[name] {
            query.append(URLQueryItem(name: "r", value: "\(rev)"))
        }
        url?.append(queryItems: query)
        return url
    }

    /// The icon on its own, for the one place that can't host the tile: a menu
    /// row, whose label is handed to UIKit and survives only as an image.
    /// Reads the cache without touching it — a getter that started a load
    /// would be mutating observed state from inside a view's body — so pair it
    /// with `prefetchIcon` where the rows are known ahead of time.
    @MainActor
    static func cachedIcon(for name: String) -> Image? {
        guard let url = iconURL(for: name) else { return nil }
        return RepoImageCache.shared.images[url.absoluteString]
    }

    @MainActor
    static func prefetchIcon(for name: String) {
        guard let url = iconURL(for: name) else { return }
        RepoImageCache.shared.ensureLoaded(url)
    }

    /// What a menu row should draw for a repo. The whole tile is rasterized,
    /// art and lettered swatch alike, because a row's label is handed to
    /// UIKit where only an image survives: `cachedIcon` alone left the many
    /// repos with no icon uploaded showing an empty glyph slot beside the few
    /// wearing a mark. Rendering this same view rather than a second drawing
    /// of it keeps the menu from drifting from the tiles everywhere else.
    @MainActor
    static func menuIcon(for name: String) -> Image? {
        // Art and no art are different pictures at the same name, so the key
        // carries which one this is: a swatch cached before the icon loaded
        // would otherwise outlive it. Color too, since the palette is
        // assigned across the registered set and moves when one is added.
        let key = [
            name,
            "\(RepoTilePalette.shared.rgb(for: name))",
            cachedIcon(for: name) == nil ? "letter" : "art",
        ].joined(separator: "|")
        if let cached = menuIcons[key] { return cached }
        return render(name: name, key: key)
    }

    /// Rasterizing costs a render pass, so each mark is kept. A plain
    /// dictionary rather than observed state on purpose: a body that wrote to
    /// an `@Observable` here would invalidate itself.
    @MainActor private static var menuIcons: [String: Image] = [:]

    /// A menu row scales a large image DOWN into its glyph slot but draws a
    /// small one at its own size, so this size is what actually decides how
    /// big a repo mark reads there. The art used to arrive as a 192-point
    /// thumbnail and filled the slot at 30 points, a step heavier than the
    /// text beside it; 26 sits with the row instead. 3x keeps it crisp.
    private static let menuIconSide: CGFloat = 26

    @MainActor
    private static func render(name: String, key: String) -> Image? {
        let renderer = ImageRenderer(content: RepoTile(name: name, size: menuIconSide))
        renderer.scale = 3
        #if os(macOS)
        guard let rendered = renderer.nsImage else { return nil }
        rendered.isTemplate = false
        let image = Image(nsImage: rendered)
        #else
        // Original, not template: a menu tints a template image flat, which
        // would throw away the one thing the swatch carries.
        guard let rendered = renderer.uiImage?.withRenderingMode(.alwaysOriginal)
        else { return nil }
        let image = Image(uiImage: rendered)
        #endif
        menuIcons[key] = image
        return image
    }

    var body: some View {
        ZStack {
            // A letter swatch stands in while a repo's icon loads; Open Session
            // can use its bundled app mark immediately instead. Nothing stays
            // underneath the eventual image: transparent icon margins would
            // otherwise reveal the fallback as a colored border.
            if name == Session.noRepoID {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: size * 0.48, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(width: size, height: size)
                    .background(OS1VisualStyle.hover)
            } else if let image = displayedIcon {
                image
                    .resizable()
                    .scaledToFill()
                    // Fills the tile unless a caller says otherwise: the
                    // server already crops every icon to its artwork and
                    // re-pads it to a fixed margin (.repo-tile--img img on
                    // the web carries no inset either).
                    .scaleEffect(artScale)
            } else {
                Text(letter)
                    .font(.system(size: size * 0.6, weight: .bold, design: .rounded))
                    .foregroundStyle(RepoTilePalette.ink)
                    .frame(width: size, height: size)
                    .background(fill)
            }
        }
        .frame(width: size, height: size)
        .clipShape(
            RoundedRectangle(
                cornerRadius: round ? size / 2 : size * 0.28,
                style: .continuous
            )
        )
        .accessibilityLabel(Self.label(for: name))
        .task(id: iconURL?.absoluteString) {
            if let iconURL {
                RepoImageCache.shared.ensureLoaded(iconURL)
            }
        }
    }
}

/// Shared cache prevents scrolling a list from cancelling and restarting repo
/// image requests, which left recycled tiles on their colored fallback.
@MainActor
@Observable
final class RepoImageCache {
    static let shared = RepoImageCache()

    private(set) var images: [String: Image] = [:]
    private var loads: [String: Task<Void, Never>] = [:]
    /// URLs the server refused outright. An unregistered repo id 404s by
    /// design and its tile is meant to keep the letter swatch, so those stop
    /// asking; everything else is treated as worth another try.
    private var unavailable: Set<String> = []

    /// Owning the load rather than running it inside the caller's task is the
    /// point: `.task` is cancelled when a tile is recycled or its view
    /// rebuilt, and the request died with it. The sessions list wears one of
    /// these tiles as its Settings button, where the cancellation was
    /// systematic — its request went out alongside the first (multi-megabyte)
    /// sessions poll, and once that one attempt was lost nothing asked again,
    /// so the button had no icon for the rest of the launch.
    func ensureLoaded(_ url: URL) {
        let key = url.absoluteString
        guard images[key] == nil, loads[key] == nil, !unavailable.contains(key)
        else { return }
        loads[key] = Task { [weak self] in await self?.load(url, key: key) }
    }

    private func load(_ url: URL, key: String) async {
        defer { loads[key] = nil }

        var request = ServerConfig.shared.authorizedRequest(url)
        request.cachePolicy = .returnCacheDataElseLoad

        // URLCache's store is on disk, so every launch after the first paints
        // from it. Reading the store directly rather than through URLSession
        // keeps a relaunch off the network stack entirely — the same bytes
        // `.returnCacheDataElseLoad` would have handed back.
        if let cachedData = await Self.cachedData(request),
           let cached = await Self.decode(cachedData) {
            images[key] = cached
            // That read never expires, so a repo whose icon is redrawn on the
            // server would keep the old one for the life of the install. Look
            // for a newer one behind the paint — while the stored response is
            // fresh that costs no network at all, and once it goes stale the
            // tile updates itself.
            if let newer = await Self.changedBytes(url, since: cachedData),
               let redrawn = await Self.decode(newer) {
                images[key] = redrawn
            }
            return
        }

        // Long enough to outlast the sessions poll a cold launch competes
        // with, short enough that the tile settles while the person is still
        // looking at it.
        for delay in [0, 2, 8, 30] {
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse,
                   !(200..<300).contains(http.statusCode) {
                    if (400..<500).contains(http.statusCode),
                       http.statusCode != 408, http.statusCode != 429 {
                        unavailable.insert(key)
                        return
                    }
                    continue
                }
                guard let decoded = await Self.decode(data) else {
                    unavailable.insert(key)
                    return
                }
                images[key] = decoded
                return
            } catch {
                continue
            }
        }
    }

    private static func cachedData(_ request: URLRequest) async -> Data? {
        await Task.detached(priority: .userInitiated) {
            URLCache.shared.cachedResponse(for: request)?.data
        }.value
    }

    /// Re-fetches an icon that was painted from the disk cache, on the
    /// protocol's own cache policy, and hands back its bytes only when the
    /// server has a different image than the one already on screen.
    private static func changedBytes(_ url: URL, since cached: Data) async -> Data? {
        var request = ServerConfig.shared.authorizedRequest(url)
        request.cachePolicy = .useProtocolCachePolicy
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  data != cached
            else { return nil }
            return data
        } catch {
            return nil
        }
    }

    private static func decode(_ data: Data) async -> Image? {
        await detachedDecode { data }
    }

    /// Tiles top out at 52 points, so a full-size decode of a configured repo
    /// icon (the app's own 512×512 PNG) would hold ~1 MB of bitmap for an
    /// 18-point swatch. ImageIO downsamples while decoding, and — unlike
    /// `UIImage(data:)`, which defers the pixel work to render time — does it
    /// here, off the main actor.
    private static func detachedDecode(
        _ load: @escaping @Sendable () -> Data?
    ) async -> Image? {
        let thumbnail = await Task.detached(priority: .userInitiated) { () -> CGImage? in
            guard let data = load(),
                  let source = CGImageSourceCreateWithData(data as CFData, nil)
            else { return nil }
            return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: 192,
            ] as CFDictionary)
        }.value
        // Decorative: `RepoTile` carries the repository name as its label.
        return thumbnail.map { Image(decorative: $0, scale: 1) }
    }
}

/// Toggles read the accent's CONTROL form rather than the accent itself.
///
/// A switch is the one accent surface whose colour is a state rather than a
/// decoration: it has to say on or off at a glance. Honey and Black cannot do
/// that with their own fill (see `AccentTheme.controlFills`), so they borrow
/// Sky, and every other accent resolves through unchanged.
///
/// It is a style rather than a `.tint` at each call site because a style
/// travels through the environment: one modifier on the scene reaches all
/// twenty-six toggles in the app, and a new one is covered the day it is
/// written. `Toggle(configuration)` re-wraps the same control, and the inner
/// `.switch` is what stops it recursing back into this style.
struct AccentControlToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration)
            .toggleStyle(.switch)
            .tint(OS1VisualStyle.accentControl)
    }
}

extension View {
    /// Applied once per scene. The Mac's Settings window is its own scene, so
    /// it needs this as much as the main window does.
    func os1AccentToggles() -> some View {
        toggleStyle(AccentControlToggleStyle())
    }
}
