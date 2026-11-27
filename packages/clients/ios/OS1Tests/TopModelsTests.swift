import XCTest
@testable import OS1

final class TopModelsTests: XCTestCase {
    private func option(_ id: String, group: String? = nil) -> ModelOption {
        ModelOption(id: id, group: group)
    }

    func testDecodeOrderDropsBlanksAndRepeats() {
        XCTAssertEqual(
            TopModels.decodeOrder(" gpt-6.2-sol, ,claude-opus-5-5,gpt-6.2-sol,,claude-fable-5-2 "),
            ["gpt-6.2-sol", "claude-opus-5-5", "claude-fable-5-2"]
        )
        XCTAssertEqual(TopModels.decodeOrder(""), [])
        XCTAssertEqual(TopModels.decodeOrder(nil), [])
        XCTAssertEqual(TopModels.decodeOrder(",,"), [])
    }

    func testNormalizedKeepsTheWebShape() {
        XCTAssertEqual(TopModels.normalized("a, b,a,"), "a,b")
        XCTAssertEqual(TopModels.normalized(""), "")
        XCTAssertNil(TopModels.normalized(nil))
    }

    private let catalog = [
        "pi/anthropic/claude-haiku-5-5",
        "pi/anthropic/claude-sonnet-5-5",
        "pi/anthropic/claude-opus-5-5",
        "pi/anthropic/claude-fable-5-2",
        "pi/openai/gpt-6.2-sol",
        "pi/openai/gpt-6.2-astra",
        "pi/openai/gpt-6.1-terra",
        "pi/xai/grok-5",
    ]

    func testCuratedFiveInCuratedOrder() {
        let split = TopModels.split(catalog.map { option($0) })
        XCTAssertEqual(split.top.map { TopModels.tail($0.id) }, TopModels.curatedTails)
        XCTAssertEqual(
            split.more.map(\.id),
            ["pi/anthropic/claude-haiku-5-5", "pi/openai/gpt-6.1-terra", "pi/xai/grok-5"]
        )
    }

    func testSavedOrderReordersButNeverChangesWhichFive() {
        let split = TopModels.split(
            catalog.map { option($0) },
            order: ["gpt-6.2-sol", "claude-haiku-5-5", "claude-opus-5-5"]
        )
        XCTAssertEqual(
            split.top.map { TopModels.tail($0.id) },
            ["gpt-6.2-sol", "claude-opus-5-5", "claude-fable-5-2", "claude-sonnet-5-5", "gpt-6.2-astra"]
        )
        XCTAssertTrue(split.more.contains { $0.id == "pi/anthropic/claude-haiku-5-5" })
    }

    func testMissingCuratedModelsFillFromTheCatalog() {
        let split = TopModels.split(
            ["pi/anthropic/claude-haiku-5-5", "pi/anthropic/claude-opus-5-5", "pi/xai/grok-5"]
                .map { option($0) }
        )
        XCTAssertEqual(
            split.top.map(\.id),
            ["pi/anthropic/claude-opus-5-5", "pi/anthropic/claude-haiku-5-5", "pi/xai/grok-5"]
        )
        XCTAssertTrue(split.more.isEmpty)
    }

    func testMoreModelsGroupByProviderInTheWebOrder() {
        let groups = TopModels.providerGroups([
            option("pi/xai/grok-5"),
            option("pi/openai/gpt-6.1-terra"),
            option("dial/opus-fable", group: "dial"),
            option("pi/anthropic/claude-haiku-5-5"),
            option("claude-mythos-5-2"),
        ])
        XCTAssertEqual(groups.map(\.label), ["Anthropic", "OpenAI", "xAI", "Dial"])
        XCTAssertEqual(
            groups[0].options.map(\.id),
            ["pi/anthropic/claude-haiku-5-5", "claude-mythos-5-2"]
        )
    }

    func testRecentPickTakesTheLastCuratedSlot() {
        let split = TopModels.split(
            (catalog + ["pi/google/gemini-4-neon"]).map { option($0) },
            recent: ["gemini-4-neon"]
        )
        XCTAssertEqual(
            split.top.map { TopModels.tail($0.id) },
            ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.2-astra", "gemini-4-neon"]
        )
        XCTAssertTrue(split.more.contains { $0.id == "pi/openai/gpt-6.2-sol" })
    }

    func testRecentPicksReplaceTheCuratedFiveInAStableOrder() {
        let recent = ["grok-5", "claude-haiku-5-5", "gpt-6.1-terra", "claude-opus-5-5", "gpt-6.2-sol", "claude-fable-5-2"]
        let split = TopModels.split(catalog.map { option($0) }, recent: recent)
        XCTAssertEqual(
            split.top.map { TopModels.tail($0.id) },
            ["claude-opus-5-5", "gpt-6.2-sol", "claude-haiku-5-5", "gpt-6.1-terra", "grok-5"]
        )
        let again = TopModels.split(
            catalog.map { option($0) }, recent: TopModels.addRecent(recent, "pi/xai/grok-5")
        )
        XCTAssertEqual(again.top.map(\.id), split.top.map(\.id))
    }

    func testDecodeRecentReadsTheWebShape() {
        XCTAssertEqual(
            TopModels.decodeRecent(#"["pi/google/gemini-4-neon","gemini-4-neon",3,"","gpt-6.2-sol"]"#),
            ["gemini-4-neon", "gpt-6.2-sol"]
        )
        XCTAssertNil(TopModels.decodeRecent("{}"))
        XCTAssertNil(TopModels.decodeRecent(nil))
        XCTAssertEqual(TopModels.normalizedRecent("[]"), "[]")
        XCTAssertEqual(TopModels.addRecent(["a", "b", "c"], "pi/x/c"), ["c", "a", "b"])
    }
}
