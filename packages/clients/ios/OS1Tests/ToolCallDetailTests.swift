import XCTest
@testable import OS1

final class ToolCallDetailTests: XCTestCase {
    private func item() -> ToolCallItem {
        ToolCallItem(
            id: "call-1",
            use: nil,
            result: TranscriptEntry(
                id: "result-1",
                type: "tool_result",
                content: "preview",
                toolUseId: "call-1",
                contentClamped: true,
                contentLength: 4_000
            ),
            isLive: false,
            presentation: ToolPresentation(
                canonical: "Bash",
                mcpServer: nil,
                name: "Bash",
                family: .run,
                summary: "",
                summaryIsPath: false,
                lineStats: nil,
                touchedFiles: []
            )
        )
    }

    func testHydratedResultReplacesThePreviewAndDropsItsTruncatedLabel() {
        let preview = ToolDetail.make(item: item())
        XCTAssertEqual(preview.resultLabel, "Output (truncated)")
        XCTAssertEqual(preview.resultText, "preview")

        let hydrated = ToolDetail.make(
            item: item(),
            hydratedResultText: "complete result"
        )
        XCTAssertEqual(hydrated.resultLabel, "Output")
        XCTAssertEqual(hydrated.resultText, "complete result")
    }

    func testWriteContentBecomesALanguageAwareAdditionsDiff() {
        let detail = toolDetail(
            name: "Write",
            canonical: "Write",
            input: [
                "file_path": .string("src/NewView.tsx"),
                "content": .string("export function NewView() {\n  return <div />\n}"),
            ]
        )

        XCTAssertEqual(detail.inputKind, .additionDiff)
        XCTAssertEqual(detail.inputLabel, "Diff")
        XCTAssertEqual(detail.inputText, "export function NewView() {\n  return <div />\n}")
        XCTAssertEqual(detail.inputLanguage, "typescript")
    }

    func testEmptyWriteStillBecomesAnAdditionsDiff() {
        let detail = toolDetail(
            name: "Write",
            canonical: "Write",
            input: ["path": .string("empty.md"), "content": .string("")]
        )

        XCTAssertEqual(detail.inputKind, .additionDiff)
        XCTAssertEqual(detail.inputText, "")
        XCTAssertEqual(detail.inputLanguage, "markdown")
    }

    func testWriteSupportsContentAndPathVariants() {
        let detail = toolDetail(
            name: "write_file",
            canonical: "Write",
            input: [
                "filePath": .string("Sources/App.swift"),
                "contents": .string("let app = App()"),
            ]
        )

        XCTAssertEqual(detail.inputKind, .additionDiff)
        XCTAssertEqual(detail.inputText, "let app = App()")
        XCTAssertEqual(detail.inputLanguage, "swift")
    }

    func testMalformedWriteFallsBackToJson() {
        let detail = toolDetail(
            name: "Write",
            canonical: "Write",
            input: ["file_path": .string("README.md"), "content": .number(42)]
        )

        XCTAssertEqual(detail.inputKind, .json)
        XCTAssertTrue(detail.inputText.contains("README.md"))
    }

    func testEditReplacementSchemasRemainDiffs() {
        let snake = toolDetail(
            name: "Edit",
            canonical: "Edit",
            input: ["old_string": .string("old"), "new_string": .string("new")]
        )
        XCTAssertEqual(snake.inputKind, .diff)
        XCTAssertEqual(snake.inputText, "-old\n+new")

        let camel = toolDetail(
            name: "Edit",
            canonical: "Edit",
            input: ["oldString": .string("before"), "newString": .string("after")]
        )
        XCTAssertEqual(camel.inputKind, .diff)
        XCTAssertEqual(camel.inputText, "-before\n+after")

        let edits = toolDetail(
            name: "Edit",
            canonical: "Edit",
            input: ["edits": .array([
                .object(["oldText": .string("one"), "newText": .string("two")]),
                .object(["old_string": .string("three"), "new_string": .string("four")]),
            ])]
        )
        XCTAssertEqual(edits.inputKind, .diff)
        XCTAssertEqual(edits.inputText, "-one\n+two\n@@\n-three\n+four")
    }

    func testApplyPatchKeepsItsExistingDiffBody() {
        let patch = "*** Begin Patch\n*** Update File: a.swift\n-old\n+new\n*** End Patch"
        let detail = toolDetail(
            name: "apply_patch",
            canonical: "Edit",
            input: ["patch": .string(patch)]
        )

        XCTAssertEqual(detail.inputKind, .diff)
        XCTAssertEqual(detail.inputText, patch)
    }

    private func toolDetail(
        name: String,
        canonical: String,
        input: [String: JSONValue]
    ) -> ToolDetail {
        let use = TranscriptEntry(
            id: "use-1",
            type: "tool_use",
            content: "Using \(name)",
            toolName: name,
            toolInput: .object(input),
            toolUseId: "use-1"
        )
        return ToolDetail.make(item: ToolCallItem(
            id: "use-1",
            use: use,
            result: nil,
            isLive: false,
            presentation: ToolPresentation(
                canonical: canonical,
                mcpServer: nil,
                name: canonical,
                family: canonical == "Write" ? .file : .edit,
                summary: "",
                summaryIsPath: false,
                lineStats: nil,
                touchedFiles: []
            )
        ))
    }
}
