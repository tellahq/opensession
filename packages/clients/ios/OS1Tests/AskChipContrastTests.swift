#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import OS1

/// The ask chip on an archived row, measured rather than eyeballed.
///
/// `OS1VisualStyle.greenSoft` is a translucent wash, so what the chip's word
/// actually sits on is the wash composited over the row. This pins two
/// promises: the word clears body-text contrast on that composite in both
/// appearances, and the wash is a visible step from the row rather than a
/// tint only a diff would notice. The surfaces are what an archived row
/// paints: white in light, and #1C1C1E in dark.
final class AskChipContrastTests: XCTestCase {
    private func luminance(_ color: NSColor) -> CGFloat {
        guard let srgb = color.usingColorSpace(.sRGB) else {
            XCTFail("colour is not representable in sRGB")
            return 0
        }
        func channel(_ value: CGFloat) -> CGFloat {
            value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(srgb.redComponent)
            + 0.7152 * channel(srgb.greenComponent)
            + 0.0722 * channel(srgb.blueComponent)
    }

    private func ratio(_ a: NSColor, _ b: NSColor) -> CGFloat {
        let (first, second) = (luminance(a), luminance(b))
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }

    private func resolve(_ color: Color, _ appearance: NSAppearance.Name) -> NSColor {
        var resolved = NSColor.clear
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
            resolved = NSColor(color).usingColorSpace(.sRGB) ?? .clear
        }
        return resolved
    }

    /// The wash laid over a surface, the way the row draws it.
    private func composite(_ wash: NSColor, over surface: NSColor) -> NSColor {
        let alpha = wash.alphaComponent
        func mix(_ top: CGFloat, _ bottom: CGFloat) -> CGFloat {
            alpha * top + (1 - alpha) * bottom
        }
        return NSColor(
            srgbRed: mix(wash.redComponent, surface.redComponent),
            green: mix(wash.greenComponent, surface.greenComponent),
            blue: mix(wash.blueComponent, surface.blueComponent),
            alpha: 1
        )
    }

    private func gray(_ white: CGFloat) -> NSColor {
        NSColor(srgbRed: white, green: white, blue: white, alpha: 1)
    }

    private let lightRow = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    private let darkRow = NSColor(
        srgbRed: 28.0 / 255.0, green: 28.0 / 255.0, blue: 30.0 / 255.0, alpha: 1
    )

    func testTheAskWordClearsBodyTextContrastOnItsChip() {
        for (name, appearance, row) in [
            ("light", NSAppearance.Name.aqua, lightRow),
            ("dark", NSAppearance.Name.darkAqua, darkRow),
        ] {
            let chip = composite(resolve(OS1VisualStyle.greenSoft, appearance), over: row)
            let measured = ratio(resolve(OS1VisualStyle.greenInk, appearance), chip)
            XCTAssertGreaterThanOrEqual(
                measured, 4.5,
                "ask reads \(String(format: "%.2f", measured)):1 on its chip in \(name)"
            )
        }
    }

    /// The web's step: its light wash lands ~0.14 below white in luminance
    /// and its dark wash ~0.015 above its page. Under those the pill is a
    /// tint a diff would catch and an eye would not.
    func testTheWashIsAVisibleStepFromTheRow() {
        let light = composite(resolve(OS1VisualStyle.greenSoft, .aqua), over: lightRow)
        XCTAssertGreaterThanOrEqual(luminance(lightRow) - luminance(light), 0.12)

        let dark = composite(resolve(OS1VisualStyle.greenSoft, .darkAqua), over: darkRow)
        XCTAssertGreaterThanOrEqual(luminance(dark) - luminance(darkRow), 0.012)
    }

    /// Light takes the ink's own hue rather than the palette's, so the pill
    /// reads as one colour: the wash's channels stand in the same order and
    /// proportion as the word's.
    func testTheLightWashSharesTheInksHue() {
        let wash = resolve(OS1VisualStyle.greenSoft, .aqua)
        let ink = resolve(OS1VisualStyle.greenInk, .aqua)
        XCTAssertEqual(wash.redComponent, ink.redComponent, accuracy: 0.01)
        XCTAssertEqual(wash.greenComponent, ink.greenComponent, accuracy: 0.01)
        XCTAssertEqual(wash.blueComponent, ink.blueComponent, accuracy: 0.01)
    }
}
#endif
