import XCTest
@testable import OS1

/// Mirrors the web's `reasoning-display.test.ts`: token-fragmented provider
/// summaries are rejoined into one sentence, and everything authored with real
/// structure keeps its whitespace.
final class ReasoningSummaryDisplayTests: XCTestCase {
    func testRepairsTokenFragmentedProviderReasoning() {
        let fragmented = [
            "The", "rule", "genuinely", "has", "only", "8", "inline", "bridges",
            "(", "first", "and", "last", ")", "+", "2", "multiline", "ones",
            "don", "'t", "match", "the", "literal", "pattern", ".",
        ].joined(separator: "\n\n")

        XCTAssertEqual(
            ReasoningSummaryDisplay.normalizeFragmented(fragmented),
            "The rule genuinely has only 8 inline bridges (first and last) + 2 multiline ones don't match the literal pattern."
        )
    }

    func testPreservesAuthoredMarkdownStructure() {
        let list = (1...12).map { "- Check item \($0)" }.joined(separator: "\n")
        let prose =
            "This is a deliberately wrapped line with enough words to read naturally.\n"
            + "It continues at a normal prose measure instead of splitting every token.\n\n"
            + "A second paragraph remains separate."
        let fenced =
            "Inspect this output:\n\n```text\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n```"
        let headings = (1...10).map { "## Step \($0)" }.joined(separator: "\n\n")

        XCTAssertEqual(ReasoningSummaryDisplay.normalizeFragmented(list), list)
        XCTAssertEqual(ReasoningSummaryDisplay.normalizeFragmented(prose), prose)
        XCTAssertEqual(ReasoningSummaryDisplay.normalizeFragmented(fenced), fenced)
        XCTAssertEqual(ReasoningSummaryDisplay.normalizeFragmented(headings), headings)
    }

    func testRepairFlowsIntoDurableBodyAndMatchesLiveTransform() {
        let fragmented = [
            "The", "rule", "has", "10", "specificity", "bridges", "but", "the",
            "formatter", "split", "them", "across", "many", "summary", "parts", ".",
        ].joined(separator: "\n\n")
        let repaired =
            "The rule has 10 specificity bridges but the formatter split them across many summary parts."

        // The durable row reads `ReasoningSummaryDisplay(...).body`; the live
        // stream calls `normalizeFragmented` directly. Both must agree.
        let display = ReasoningSummaryDisplay(fragmented)
        XCTAssertEqual(display.title, "")
        XCTAssertEqual(display.body, repaired)
        XCTAssertEqual(ReasoningSummaryDisplay.normalizeFragmented(fragmented), repaired)
        XCTAssertFalse(display.body.contains("\n"))
    }

    func testFragmentedHeadingStillSplitsTitleFromBody() {
        let fragmented = (["**Checking", "the", "build**"] + Array(repeating: "word", count: 12))
            .joined(separator: "\n\n")
        let display = ReasoningSummaryDisplay(fragmented)

        XCTAssertEqual(display.title, "Checking the build")
        XCTAssertEqual(display.body, Array(repeating: "word", count: 12).joined(separator: " "))
    }

    func testShortContentIsLeftAlone() {
        XCTAssertEqual(
            ReasoningSummaryDisplay.normalizeFragmented("One\n\nTwo\n\nThree"),
            "One\n\nTwo\n\nThree"
        )
        XCTAssertEqual(ReasoningSummaryDisplay.normalizeFragmented("  \n\n  "), "")
    }
}
