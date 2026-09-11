import XCTest
@testable import OS1

final class PeopleMentionRankingTests: XCTestCase {
    private let roster = ["Michiel", "Kent", "Johnny", "Jaap"]
    private let fullNames = [
        "Michiel": "Michiel Vos", "Kent": "Kent de Bruin", "Johnny": "Johnny Vuong", "Jaap": "Jääp Kok"
    ]

    private func names(_ query: String, current: String = "") -> [String] {
        PeopleMentionRanking.names(
            roster,
            query: query,
            fullName: { fullNames[$0] ?? "" },
            current: current
        )
    }

    func testAnEmptyQueryKeepsTheDirectoryOrderWithYouFirst() {
        XCTAssertEqual(names(""), roster)
        XCTAssertEqual(names("", current: "kent"), ["Kent", "Michiel", "Johnny", "Jaap"])
    }

    func testAPrefixOrAFullNameFindsAPerson() {
        XCTAssertEqual(names("ke"), ["Kent"])
        XCTAssertEqual(names("bruin"), ["Kent"])
    }

    func testATypoStillFindsAPerson() {
        XCTAssertEqual(names("michel"), ["Michiel"])
        XCTAssertEqual(names("jhonny"), ["Johnny"])
    }

    func testACloserMatchRanksFirstButYouStayOnTop() {
        let roster = ["Jon", "Johnny", "John"]
        let ranked = PeopleMentionRanking.names(
            roster, query: "john", fullName: { _ in "" }, current: ""
        )
        XCTAssertEqual(ranked, ["John", "Johnny", "Jon"])
        let mine = PeopleMentionRanking.names(
            roster, query: "john", fullName: { _ in "" }, current: "jon"
        )
        XCTAssertEqual(mine, ["Jon", "John", "Johnny"])
    }

    func testAccentsDoNotMatterAndShortTermsStayStrict() {
        XCTAssertEqual(names("jaap"), ["Jaap"])
        XCTAssertEqual(names("kan"), [])
    }
}
