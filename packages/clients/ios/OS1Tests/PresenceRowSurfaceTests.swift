#if os(macOS)
import AppKit
import SwiftUI
import XCTest
@testable import OS1

final class PresenceRowSurfaceTests: XCTestCase {
    private func resolve(_ color: Color, appearance: NSAppearance.Name) -> NSColor {
        var resolved = NSColor.clear
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
            resolved = NSColor(color).usingColorSpace(.sRGB) ?? .clear
        }
        return resolved
    }

    private func assertMatches(
        _ color: Color,
        _ expected: NSColor,
        appearance: NSAppearance.Name,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let actual = resolve(color, appearance: appearance)
        var resolvedExpected = NSColor.clear
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance {
            resolvedExpected = expected.usingColorSpace(.sRGB) ?? .clear
        }
        XCTAssertEqual(actual.redComponent, resolvedExpected.redComponent, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actual.greenComponent, resolvedExpected.greenComponent, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actual.blueComponent, resolvedExpected.blueComponent, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actual.alphaComponent, 1, accuracy: 0.001, file: file, line: line)
    }

    func testFaceSeparatorTracksEveryNativeSidebarRowState() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            assertMatches(
                PresenceRowSurface.color(selected: false, hovered: false),
                .windowBackgroundColor,
                appearance: appearance
            )
            assertMatches(
                PresenceRowSurface.color(selected: false, hovered: true),
                .unemphasizedSelectedContentBackgroundColor,
                appearance: appearance
            )
            assertMatches(
                PresenceRowSurface.color(selected: true, hovered: false),
                .selectedContentBackgroundColor,
                appearance: appearance
            )
            assertMatches(
                PresenceRowSurface.color(selected: true, hovered: true),
                .selectedContentBackgroundColor,
                appearance: appearance
            )
        }
    }
}
#endif
