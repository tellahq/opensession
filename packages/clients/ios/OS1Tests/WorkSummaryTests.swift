import XCTest
@testable import OS1

final class WorkSummaryTests: XCTestCase {
    private func call(
        _ canonical: String,
        family: ToolFamily,
        summary: String = "",
        isPath: Bool = false,
        files: [String] = []
    ) -> ToolCallItem {
        ToolCallItem(
            id: UUID().uuidString,
            use: nil,
            result: nil,
            isLive: false,
            presentation: ToolPresentation(
                canonical: canonical,
                mcpServer: nil,
                name: canonical,
                family: family,
                summary: summary,
                summaryIsPath: isPath,
                lineStats: nil,
                touchedFiles: files.map { TouchedFile(path: $0, additions: 1, deletions: 0) }
            )
        )
    }

    func testClausesFollowTheOrderTheWorkHappenedIn() {
        let items = [
            call("Bash", family: .run, summary: "bun test"),
            call("Read", family: .file, summary: "src/a.ts", isPath: true),
            call("Bash", family: .run, summary: "git status"),
            call("Grep", family: .find, summary: "needle"),
        ]
        XCTAssertEqual(
            WorkSummary.title(items),
            "Ran 2 commands, read 1 file, ran 1 search"
        )
    }

    func testRepeatedPassesOverOneFileCountOnce() {
        let items = [
            call("Edit", family: .edit, summary: "a.swift", isPath: true, files: ["a.swift"]),
            call("Edit", family: .edit, summary: "a.swift", isPath: true, files: ["a.swift"]),
            call("Edit", family: .edit, summary: "b.swift", isPath: true, files: ["b.swift"]),
        ]
        XCTAssertEqual(WorkSummary.title(items), "Edited 2 files")
    }

    func testMcpAndUnknownToolsAreCalledTools() {
        let items = [
            call("list_issues", family: .mcp),
            call("Mystery", family: .other),
        ]
        XCTAssertEqual(WorkSummary.title(items), "Called 2 tools")
    }

    func testLooksAtOneBackgroundCommandAreOneCheck() {
        let items = [
            call("BashOutput", family: .run, summary: "bg1"),
            call("BashOutput", family: .run, summary: "bg1"),
        ]
        XCTAssertEqual(WorkSummary.title(items), "Checked on 1 command")
    }

    func testEmptyRunHasNoSentence() {
        XCTAssertEqual(WorkSummary.title([]), "")
    }
}
