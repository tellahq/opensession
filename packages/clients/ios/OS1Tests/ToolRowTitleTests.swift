import XCTest
@testable import OS1

final class ToolRowTitleTests: XCTestCase {
    private func title(_ name: String, _ input: [String: JSONValue]) -> ToolRowTitle {
        ToolPresentation.make(toolName: name, input: .object(input)).rowTitle
    }

    func testShellCallIsItsCommand() {
        XCTAssertEqual(
            title("Bash", ["command": .string("systemctl --user stop proof.service")]).title,
            "systemctl --user stop proof.service"
        )
    }

    func testFileCallsNameTheFileWithAVerb() {
        XCTAssertEqual(
            title("Read", ["file_path": .string("src/views/ToolCallRow.swift")]).title,
            "Read ToolCallRow.swift"
        )
        XCTAssertEqual(
            title("Edit", [
                "file_path": .string("src/a.swift"),
                "old_string": .string("a"),
                "new_string": .string("b"),
            ]).title,
            "Edited a.swift"
        )
    }

    func testOpenSessionCallReadsAsItsActionWithoutArguments() {
        let row = title("mcp__oc__opensession-walkthrough__publish_walkthrough", [
            "summary": .string("Built-in background proof"),
        ])
        XCTAssertEqual(row.title, "Publish walkthrough")
        XCTAssertNil(row.detail)
    }

    func testAnotherServiceKeepsItsName() {
        XCTAssertEqual(
            title("mcp__oc__linear__list_issues", ["team": .string("ENG")]).title,
            "Linear · List issues"
        )
    }

    func testGrepNamesItsPattern() {
        XCTAssertEqual(
            title("Grep", ["pattern": .string("needle"), "path": .string("src/a")]).title,
            "Searched for “needle”"
        )
    }
}
