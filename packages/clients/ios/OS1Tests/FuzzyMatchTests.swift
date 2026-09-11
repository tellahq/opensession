import XCTest
@testable import OS1

/// The same cases as the web client's `shared/fuzzy-match.test.ts`, so both
/// clients answer a query the same way.
final class FuzzyMatchTests: XCTestCase {
    func testRanksExactPrefixWordPrefixThenSubstring() {
        XCTAssertEqual(FuzzyMatch.score("release", in: "Release"), 100)
        XCTAssertEqual(FuzzyMatch.score("rel", in: "Release work"), 90)
        XCTAssertEqual(FuzzyMatch.score("work", in: "Release work"), 80)
        XCTAssertEqual(FuzzyMatch.score("lease", in: "Release work"), 70)
    }

    func testForgivesATypoInLongerTerms() {
        // A dropped letter.
        XCTAssertGreaterThan(FuzzyMatch.score("relase", in: "Release work"), 0)
        // A transposition costs one edit, not two.
        XCTAssertGreaterThan(FuzzyMatch.score("wrokspace", in: "Workspace cleanup"), 0)
        XCTAssertGreaterThan(FuzzyMatch.score("sidebra", in: "Fix the sidebar"), 0)
        XCTAssertGreaterThan(FuzzyMatch.score("billng audit", in: "Billing audit"), 0)
    }

    func testKeepsShortTermsStrict() {
        XCTAssertEqual(FuzzyMatch.score("cat", in: "cut"), 0)
        XCTAssertEqual(FuzzyMatch.score("api", in: "apple"), 0)
        XCTAssertEqual(FuzzyMatch.score("desk", in: "deploy"), 0)
    }

    func testMatchesAbbreviationsInsideOneWord() {
        XCTAssertEqual(FuzzyMatch.score("wksp", in: "workspace"), 20)
        // Not across words: letters have to come from one word.
        XCTAssertEqual(FuzzyMatch.score("rlw", in: "release work"), 0)
    }

    func testNeedsEveryTermToLandSomewhere() {
        XCTAssertEqual(FuzzyMatch.score("release billing", in: "Release work"), 0)
        XCTAssertGreaterThan(FuzzyMatch.score("work release", in: "Release work"), 0)
    }

    func testIgnoresCaseAndAccentsAndAnEmptyQueryMatchesAll() {
        XCTAssertEqual(FuzzyMatch.score("jaap", in: "Jääp"), 100)
        XCTAssertEqual(FuzzyMatch.score("CAFE", in: "Café deploy"), 90)
        XCTAssertEqual(FuzzyMatch.score("", in: "anything"), 1)
        XCTAssertEqual(FuzzyMatch.score("   ", in: "anything"), 1)
        XCTAssertEqual(FuzzyMatch.score("x", in: ""), 0)
    }

    func testBestTakesTheStrongestField() {
        XCTAssertEqual(FuzzyMatch.best("audit", in: [nil, "Billing", "audit/billing"]), 90)
        XCTAssertEqual(FuzzyMatch.best("nothing", in: ["a", nil]), 0)
    }

    func testNearMissScoresEditsThenAbbreviations() {
        let words = FuzzyMatch.words(of: "release work")
        XCTAssertEqual(FuzzyMatch.nearMiss("relase", in: words), 40)
        XCTAssertEqual(FuzzyMatch.nearMiss("rls", in: words), 20)
        XCTAssertEqual(FuzzyMatch.nearMiss("cat", in: words), 0)
    }
}
