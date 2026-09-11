import XCTest
@testable import OS1

final class CommandPaletteTests: XCTestCase {
    private func command(_ id: String, _ title: String, keywords: [String] = [])
        -> CommandPaletteEntry {
        CommandPaletteEntry(id: id, title: title, keywords: keywords, kind: .command)
    }

    private func session(
        _ id: String,
        _ title: String,
        keywords: [String] = [],
        minutesAgo: Int = 0
    ) -> CommandPaletteEntry {
        CommandPaletteEntry(
            id: id,
            title: title,
            keywords: keywords,
            kind: .session,
            recency: Date(timeIntervalSince1970: 1_800_000_000 - Double(minutesAgo) * 60)
        )
    }

    private func ids(
        _ entries: [CommandPaletteEntry], _ query: String, limit: Int = 40
    ) -> [String] {
        CommandPaletteRanking.results(entries, query: query, sessionLimit: limit)
            .map(\.id)
    }

    func testEmptyQueryKeepsCommandsInOrderAndSessionsByRecency() {
        let entries = [
            command("new", "New session"),
            command("desk", "Open the Desk"),
            session("old", "An older conversation", minutesAgo: 900),
            session("fresh", "Just now", minutesAgo: 1)
        ]
        XCTAssertEqual(ids(entries, ""), ["new", "desk", "fresh", "old"])
        XCTAssertEqual(ids(entries, "   "), ["new", "desk", "fresh", "old"])
    }

    func testEveryTokenHasToMatch() {
        let entries = [session("a", "Fix the sidebar hover wash")]
        XCTAssertEqual(ids(entries, "sidebar hover"), ["a"])
        XCTAssertEqual(ids(entries, "sidebar composer"), [])
    }

    func testATokenCanMatchAcrossTitleAndKeywords() {
        let entries = [session("a", "Fix the hover wash", keywords: ["tella-fusion"])]
        XCTAssertEqual(ids(entries, "hover fusion"), ["a"])
    }

    func testTitleStartBeatsAWordInsideBeatsAKeyword() {
        let entries = [
            session("keyword", "Something else", keywords: ["archive"]),
            session("inside", "Rewrite the archive sweep"),
            session("prefix", "Archive the stale rows")
        ]
        XCTAssertEqual(ids(entries, "archive"), ["prefix", "inside", "keyword"])
    }

    func testAWordBoundaryBeatsAMatchInsideAWord() {
        let entries = [
            session("inner", "Unarchived rows keep their lane"),
            session("boundary", "Sweep the archive index")
        ]
        XCTAssertEqual(ids(entries, "archive"), ["boundary", "inner"])
    }

    func testCommandsRankAboveSessionsEvenOnAWeakerMatch() {
        let entries = [
            session("session", "Archived rows that need a sweep"),
            command("archived", "Archived sessions", keywords: ["closed"])
        ]
        XCTAssertEqual(ids(entries, "archived"), ["archived", "session"])
    }

    func testMatchingIgnoresCaseAndAccents() {
        let entries = [session("a", "Café deploy checklist")]
        XCTAssertEqual(ids(entries, "CAFE"), ["a"])
        XCTAssertEqual(ids(entries, "café"), ["a"])
    }

    func testASessionIsFoundByItsRepoOrBranch() {
        let entries = [
            session(
                "a",
                "Stop the composer repainting",
                keywords: ["opensession", "fix-composer-repaint", "Michiel"]
            )
        ]
        XCTAssertEqual(ids(entries, "opensession"), ["a"])
        XCTAssertEqual(ids(entries, "repaint michiel"), ["a"])
    }

    func testTheSessionLimitNeverDropsACommand() {
        var entries = [command("new", "New session")]
        for index in 0..<60 {
            entries.append(session("s\(index)", "Session \(index)", minutesAgo: index))
        }
        let results = ids(entries, "", limit: 5)
        XCTAssertEqual(results.count, 6)
        XCTAssertEqual(results.first, "new")
        // The five kept sessions are the five most recent, newest first.
        XCTAssertEqual(Array(results.dropFirst()), ["s0", "s1", "s2", "s3", "s4"])
    }

    func testTranscriptOnlyMatchRanksAfterMetadataMatch() {
        let entries = [
            session("content", "Unrelated recent session", minutesAgo: 1),
            session("metadata", "Fix transcript search", minutesAgo: 20),
            command("new", "New session")
        ]
        let results = CommandPaletteRanking.results(
            entries,
            query: "transcript",
            contentMatches: ["content"]
        )
        XCTAssertEqual(results.map(\.id), ["metadata", "content"])
    }

    func testTranscriptMatchDoesNotAdmitACommand() {
        let entries = [command("command", "Unrelated command")]
        XCTAssertTrue(CommandPaletteRanking.results(
            entries,
            query: "needle",
            contentMatches: ["command"]
        ).isEmpty)
    }

    func testATypoStillFindsTheRow() {
        let entries = [
            session("release", "Release notes"),
            command("workspace", "New session in this workspace")
        ]
        XCTAssertEqual(ids(entries, "relase"), ["release"])
        XCTAssertEqual(ids(entries, "wrokspace"), ["workspace"])
    }

    func testAnExactTitleOutranksATypoOutranksAKeyword() {
        let entries = [
            session("keyword", "Something else", keywords: ["release"]),
            session("typo", "Relase notes"),
            session("exact", "Release notes")
        ]
        XCTAssertEqual(ids(entries, "release"), ["exact", "typo", "keyword"])
    }

    func testShortTermsStayStrict() {
        XCTAssertEqual(ids([session("a", "Cut the rows")], "cat"), [])
    }

    func testNoMatchesReturnsNothingRatherThanEverything() {
        let entries = [command("new", "New session"), session("a", "A conversation")]
        XCTAssertEqual(ids(entries, "zzzz"), [])
    }
}
