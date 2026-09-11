import XCTest
@testable import OS1

final class MentionRankingTests: XCTestCase {
    private let roster = ["Kent", "Michiel", "Kenji", "Jaap"]
    private let fullNames = [
        "Kent": "Kent de Bruin",
        "Michiel": "Michiel Roos",
        "Kenji": "Kenji Sato",
        "Jaap": "Jaap Visser"
    ]

    private func ranked(_ query: String, current: String = "Michiel") -> [String] {
        MentionRanking.people(roster, query: query, current: current) { fullNames[$0] ?? $0 }
    }

    func testAnEmptyQueryKeepsTheRosterOrderWithYouFirst() {
        XCTAssertEqual(ranked(""), ["Michiel", "Kent", "Kenji", "Jaap"])
    }

    func testScoreOutranksBeingTheSignedInPerson() {
        XCTAssertEqual(ranked("ken", current: "Michiel"), ["Kent", "Kenji"])
        // Equal scores: the signed-in person leads, then roster order.
        XCTAssertEqual(ranked("ken", current: "Kenji"), ["Kenji", "Kent"])
    }

    func testAFullNameAndATypoBothFind() {
        XCTAssertEqual(ranked("bruin"), ["Kent"])
        XCTAssertEqual(ranked("michel"), ["Michiel"])
        XCTAssertEqual(ranked("nobody"), [])
    }
}
