import XCTest
@testable import OS1

/// `SessionUsage.context`: what fills the prompt, the compaction point, and
/// how the native readouts present them (UsageMeter.tsx on the web).
final class ContextBreakdownTests: XCTestCase {
    private let en = Locale(identifier: "en_US")

    private func usage(_ json: String) throws -> SessionUsage {
        try JSONDecoder().decode(SessionUsage.self, from: Data(json.utf8))
    }

    func testDecodesTheBreakdown() throws {
        let decoded = try usage(
            #"{"contextTokens":120000,"contextWindow":1000000,"turns":3,"context":{"sections":[{"kind":"system-prompt","tokens":9000},{"kind":"tools","tokens":11000},{"kind":"messages","tokens":100000}],"compactAtTokens":400000,"compactions":2}}"#
        )
        XCTAssertEqual(decoded.context?.sections.count, 3)
        XCTAssertEqual(decoded.context?.sections.first, ContextSection(kind: "system-prompt", tokens: 9000))
        XCTAssertEqual(decoded.context?.compactAtTokens, 400_000)
        XCTAssertEqual(decoded.context?.compactions, 2)
        XCTAssertEqual(decoded.turns, 3)
    }

    /// Older servers send no breakdown, and a newer one may send a shape this
    /// build does not expect. Neither may cost the usage row itself.
    func testMissingOrMalformedBreakdownKeepsTheUsage() throws {
        XCTAssertNil(try usage(#"{"turns":1}"#).context)

        let malformed = try usage(#"{"turns":4,"costUsd":2.5,"context":"soon"}"#)
        XCTAssertNil(malformed.context)
        XCTAssertEqual(malformed.turns, 4)

        let bare = try usage(#"{"context":{}}"#)
        XCTAssertEqual(bare.context?.sections, [])
        XCTAssertNil(bare.context?.compactAtTokens)
        XCTAssertNil(bare.context?.compactions)
    }

    /// One bad section is dropped on its own; the rest still count.
    func testABadSectionDropsAloneButTheRestDecode() throws {
        let decoded = try usage(
            #"{"context":{"sections":[{"kind":"skills","tokens":500},{"kind":"tools"},{"tokens":3},{"kind":"messages","tokens":"many"},{"kind":"messages","tokens":2000}]}}"#
        )
        XCTAssertEqual(decoded.context?.sections, [
            ContextSection(kind: "skills", tokens: 500),
            ContextSection(kind: "messages", tokens: 2000),
        ])
    }

    func testSessionRowCarriesTheBreakdown() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"one","usage":{"turns":1,"context":{"sections":[{"kind":"messages","tokens":10}]}}}"#.utf8)
        )
        XCTAssertEqual(session.usage?.context?.sections.first?.tokens, 10)
    }

    /// Rows come in the web's order (the conversation first), empty parts
    /// are dropped, and any kind this build does not know folds into one
    /// "Other" row so the rows still add up to the total.
    func testRowsFollowTheWebOrderAndFoldUnknownKinds() {
        let breakdown = ContextBreakdown(sections: [
            ContextSection(kind: "tools", tokens: 4000),
            ContextSection(kind: "system-prompt", tokens: 2000),
            ContextSection(kind: "plugins", tokens: 300),
            ContextSection(kind: "messages", tokens: 13000),
            ContextSection(kind: "skills", tokens: 0),
            ContextSection(kind: "memory", tokens: 700),
            ContextSection(kind: "mcp-tools", tokens: 1000),
            ContextSection(kind: "summary", tokens: 3000),
            ContextSection(kind: "instructions", tokens: 1000),
        ])
        let rows = breakdown.rows
        XCTAssertEqual(rows.map(\.label), [
            "Messages", "Earlier summary", "System prompt", "Project instructions",
            "Tools", "MCP tools", "Other",
        ])
        XCTAssertEqual(rows.last?.tokens, 1000)
        XCTAssertEqual(rows.reduce(0) { $0 + $1.tokens }, 25000)
        XCTAssertEqual(ContextBreakdown.share(rows[0], of: rows), 52)
        XCTAssertEqual(ContextBreakdown.share(rows[2], of: rows), 8)
        XCTAssertEqual(ContextBreakdown().rows, [])
    }

    /// The gauge runs to the compaction point when it sits under the window;
    /// the warning still reads the window itself.
    func testFillRunsToTheCompactionPoint() {
        let compacting = SessionUsage(
            contextTokens: 300_000,
            contextWindow: 1_000_000,
            context: ContextBreakdown(compactAtTokens: 400_000)
        )
        let fill = compacting.contextFill
        XCTAssertEqual(fill.limit, 400_000)
        XCTAssertTrue(fill.compacts)
        XCTAssertEqual(fill.percent, 75)
        XCTAssertFalse(fill.isTight)
        XCTAssertEqual(compacting.contextLabel(locale: en), "300K / 400K (75%)")

        // A compaction point at or past the window changes nothing.
        let past = SessionUsage(
            contextTokens: 180_000,
            contextWindow: 200_000,
            context: ContextBreakdown(compactAtTokens: 250_000)
        )
        XCTAssertEqual(past.contextFill.limit, 200_000)
        XCTAssertFalse(past.contextFill.compacts)
        XCTAssertTrue(past.contextIsTight)
        XCTAssertEqual(past.contextLabel(locale: en), "180K / 200K (90%)")

        XCTAssertEqual(SessionUsage().contextFill.limit, 0)
        XCTAssertEqual(SessionUsage().contextFill.fraction, 0)
    }

    func testCompactionNote() {
        let both = SessionUsage(
            contextTokens: 10,
            contextWindow: 1_000_000,
            context: ContextBreakdown(compactAtTokens: 400_000, compactions: 2)
        )
        XCTAssertEqual(
            both.compactionNote(locale: en),
            "Compacts at 400K of a 1M window. Compacted 2 times."
        )
        let once = SessionUsage(
            contextWindow: 200_000,
            context: ContextBreakdown(compactAtTokens: 200_000, compactions: 1)
        )
        XCTAssertEqual(once.compactionNote(locale: en), "Compacted once.")
        XCTAssertNil(SessionUsage(contextWindow: 200_000).compactionNote(locale: en))
    }

    func testTotalTokensCountsEverythingSentAndReceived() {
        let usage = SessionUsage(
            inputTokens: 1, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 4000
        )
        XCTAssertEqual(usage.totalTokens, 4321)
    }
}
