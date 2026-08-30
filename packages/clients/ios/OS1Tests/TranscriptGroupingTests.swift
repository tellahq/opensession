import XCTest
@testable import OS1

/// The transcript's reading rhythm: question → [folded work] → answer → meta.
/// These pin the fold boundaries, since getting them wrong either hides the
/// answer or shows every tool call raw.
@MainActor
final class TranscriptGroupingTests: XCTestCase {
    private var viewModel: SessionViewModel!

    /// No socket: these exercise the display pass, which is driven purely by
    /// the frames handed to `handle`.
    override func setUp() async throws {
        viewModel = SessionViewModel(session: Session(id: "bks-1"))
    }

    private func append(_ entries: [TranscriptEntry]) {
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: entries))
    }

    private func toolUse(
        _ id: String,
        name: String,
        input: [String: JSONValue] = [:]
    ) -> TranscriptEntry {
        TranscriptEntry(
            id: id,
            type: "tool_use",
            content: "Using \(name)",
            toolName: name,
            toolInput: .object(input),
            toolUseId: id
        )
    }

    private func toolResult(_ useId: String, text: String) -> TranscriptEntry {
        TranscriptEntry(
            id: "tr-\(useId)",
            type: "tool_result",
            content: text,
            toolUseId: useId
        )
    }

    // MARK: - Fold boundaries

    func testToolCallsFoldAndTheFinalAnswerEscapes() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "fix it"),
            TranscriptEntry(id: "a1", type: "assistant", content: "Looking."),
            toolUse("t1", name: "Bash", input: ["command": .string("bun test")]),
            toolResult("t1", text: "ok"),
            TranscriptEntry(
                id: "a2",
                type: "assistant",
                content: "Fixed.",
                timestamp: "2026-01-01T00:00:10Z"
            ),
        ])

        let blocks = viewModel.displayBlocks
        XCTAssertEqual(blocks.count, 3, "prompt, fold, answer — the footer needs timestamps")
        guard case .message(let prompt) = blocks[0] else {
            return XCTFail("first block should be the prompt")
        }
        XCTAssertEqual(prompt.id, "u1")

        guard case .work(let turn) = blocks[1] else {
            return XCTFail("the tool call and its narration should fold")
        }
        XCTAssertEqual(turn.toolCount, 1)
        XCTAssertEqual(turn.families, [.run])
        XCTAssertEqual(turn.items.count, 2, "narration folds with the tool call")

        guard case .message(let answer) = blocks[2] else {
            return XCTFail("the final answer must escape the fold")
        }
        XCTAssertEqual(answer.id, "a2")
    }

    func testBackgroundWakeKeepsEarlierOutputVisible() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "ship it"),
            toolUse("t1", name: "Bash"),
            TranscriptEntry(
                id: "status",
                type: "assistant",
                content: "Implemented. Deployment is running."
            ),
            TranscriptEntry(
                id: "wake",
                type: "user",
                content: "",
                turnBoundary: true
            ),
            toolUse("t2", name: "Bash"),
            TranscriptEntry(id: "final", type: "assistant", content: "Deployment verified."),
        ])

        let messageIDs = viewModel.displayBlocks.compactMap { block -> String? in
            guard case .message(let entry) = block else { return nil }
            return entry.id
        }
        XCTAssertEqual(messageIDs, ["u1", "status", "final"])
        XCTAssertEqual(
            viewModel.displayBlocks.filter {
                if case .work = $0 { return true }
                return false
            }.count,
            2
        )
        XCTAssertFalse(viewModel.displayBlocks.contains { $0.id == "wake" })
    }

    func testTurnWithoutToolsDoesNotFold() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "hi"),
            TranscriptEntry(id: "a1", type: "assistant", content: "hello"),
        ])
        XCTAssertEqual(viewModel.displayBlocks.count, 2)
        for block in viewModel.displayBlocks {
            if case .work = block { XCTFail("nothing to hide, so nothing should fold") }
        }
    }

    func testTranscriptEntryDecodesVideos() throws {
        let data = Data(#"{"id":"a1","type":"assistant","videos":["/media?path=demo.mp4"]}"#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)
        XCTAssertEqual(entry.videos, ["/media?path=demo.mp4"])
        XCTAssertEqual(entry.media.label, "1 video")
    }

    func testTranscriptEntryDecodesSourceMessageIds() throws {
        let data = Data(
            #"{"id":"batch","type":"user","sourceMessageIds":["one","two"]}"#.utf8
        )
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)
        XCTAssertEqual(entry.sourceMessageIds, ["one", "two"])
    }

    func testTranscriptEntryDecodesTurnBoundary() throws {
        let data = Data(
            #"{"id":"wake","type":"user","content":"","turnBoundary":true}"#.utf8
        )
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)
        XCTAssertEqual(entry.turnBoundary, true)
    }

    func testTranscriptEntryTolerantlyDecodesReasoningFlag() throws {
        let marked = try JSONDecoder().decode(
            TranscriptEntry.self,
            from: Data(
                #"{"id":"r1","type":"assistant","content":"Thinking","isReasoning":true,"futureField":{"x":1}}"#.utf8
            )
        )
        let older = try JSONDecoder().decode(
            TranscriptEntry.self,
            from: Data(#"{"id":"a1","type":"assistant","content":"Done"}"#.utf8)
        )

        XCTAssertEqual(marked.isReasoning, true)
        XCTAssertNil(older.isReasoning)
    }

    func testReasoningStaysInterleavedWithWorkAndOutsideFinalAnswer() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "check it"),
            TranscriptEntry(
                id: "r1", type: "assistant",
                content: "**Checking deployment status**\n\nThe release is moving.",
                isReasoning: true
            ),
            toolUse("t1", name: "Bash"),
            TranscriptEntry(id: "a1", type: "assistant", content: "Deployed."),
        ])

        guard case .work(let turn) = viewModel.displayBlocks[1] else {
            return XCTFail("reasoning and the tool should remain one work turn")
        }
        XCTAssertEqual(turn.items.map(\.id), ["r1", "tool-t1"])
        guard case .message(let reasoning) = turn.items[0] else {
            return XCTFail("the reasoning should keep its chronological position")
        }
        XCTAssertEqual(reasoning.isReasoning, true)
        guard case .message(let answer) = viewModel.displayBlocks[2] else {
            return XCTFail("the final answer should retain answer hierarchy")
        }
        XCTAssertEqual(answer.id, "a1")

        let display = ReasoningSummaryDisplay(reasoning.text)
        XCTAssertEqual(display.title, "Checking deployment status")
        XCTAssertEqual(display.body, "The release is moving.")
        XCTAssertEqual(display.activityTitle(isActive: true), "Checking deployment status")
        XCTAssertEqual(display.activityTitle(isActive: false), "Checking deployment status")
    }

    func testLiveProseReasoningGetsThinkingLabelButDurableProseStaysUnlabelled() {
        let display = ReasoningSummaryDisplay("I should inspect the current state first.")

        XCTAssertEqual(display.activityTitle(isActive: true), "Thinking")
        XCTAssertNil(display.activityTitle(isActive: false))
        XCTAssertEqual(display.body, "I should inspect the current state first.")
    }

    func testReasoningOrderSurvivesLiveAndDurableGrouping() {
        let entries = [
            TranscriptEntry(id: "u1", type: "user", content: "check it"),
            TranscriptEntry(
                id: "r1", type: "assistant", content: "**Reading logs**", isReasoning: true
            ),
            toolUse("t1", name: "Bash"),
            TranscriptEntry(
                id: "r2", type: "assistant", content: "Still comparing results.",
                isReasoning: true
            ),
        ]
        let items = TranscriptGrouping.displayItems(from: entries)
        let live = TranscriptGrouping.blocks(from: items, live: true, worktreeDir: nil)
        let durable = TranscriptGrouping.blocks(from: items, live: false, worktreeDir: nil)

        guard case .work(let liveTurn) = live[1],
              case .work(let durableTurn) = durable[1] else {
            return XCTFail("expected matching work turns")
        }
        XCTAssertEqual(liveTurn.items.map(\.id), ["r1", "tool-t1", "r2"])
        XCTAssertEqual(durableTurn.items.map(\.id), liveTurn.items.map(\.id))
    }

    func testLegacyBoldIntermediateSummaryIsNormalizedButBoldFinalIsNot() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "check it"),
            TranscriptEntry(
                id: "legacy", type: "assistant",
                content: "**Verifying the release**"
            ),
            toolUse("t1", name: "Bash"),
            TranscriptEntry(id: "final", type: "assistant", content: "**Done**"),
        ])

        guard case .work(let turn) = viewModel.displayBlocks[1],
              case .message(let reasoning) = turn.items.first else {
            return XCTFail("expected one work turn with reasoning")
        }
        XCTAssertEqual(reasoning.id, "legacy")
        XCTAssertEqual(reasoning.isReasoning, true)
        guard case .message(let answer) = viewModel.displayBlocks[2] else {
            return XCTFail("a bold final row is still the answer")
        }
        XCTAssertNil(answer.isReasoning)
    }

    func testLegacyHeadingBeforeTrailingToolsIsReasoning() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "check it"),
            toolUse("t1", name: "Bash"),
            TranscriptEntry(
                id: "legacy", type: "assistant", content: "**Still checking**"
            ),
            toolUse("t2", name: "Read"),
        ])

        guard case .work(let turn) = viewModel.displayBlocks[1],
              case .message(let reasoning) = turn.items[1] else {
            return XCTFail("expected the heading between its tools")
        }
        XCTAssertEqual(turn.items.map(\.id), ["tool-t1", "legacy", "tool-t2"])
        XCTAssertEqual(reasoning.isReasoning, true)
        XCTAssertFalse(viewModel.displayBlocks.contains { block in
            if case .message(let entry) = block { return entry.id == "legacy" }
            if case .footer(let footer) = block { return footer.entryId == "legacy" }
            return false
        })
    }

    func testTrailingExplicitReasoningNeverBecomesTheFinalAnswer() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "check it"),
            toolUse("t1", name: "Bash"),
            TranscriptEntry(
                id: "r1", type: "assistant",
                content: "**Still checking**", isReasoning: true
            ),
        ])

        guard case .work(let turn) = viewModel.displayBlocks[1],
              case .message(let reasoning) = turn.items.last else {
            return XCTFail("expected reasoning at the end of the work turn")
        }
        XCTAssertEqual(reasoning.id, "r1")
        XCTAssertFalse(viewModel.displayBlocks.contains { block in
            if case .message(let entry) = block { return entry.id == "r1" }
            if case .footer(let footer) = block { return footer.entryId == "r1" }
            return false
        })
    }

    func testFoldProjectsOnlyExplicitlyFeaturedMediaAndDeduplicatesIt() {
        var first = toolResult("t1", text: "captured")
        first.images = ["/media?path=incidental.png", "/media?path=after.png"]
        first.videos = ["/media?path=demo.mp4"]
        first.featuredMedia = ["/media?path=after.png", "/media?path=demo.mp4"]
        var second = toolResult("t2", text: "captured again")
        second.videos = ["/media?path=demo.mp4"]
        second.featuredMedia = ["/media?path=demo.mp4"]

        append([
            TranscriptEntry(id: "u1", type: "user", content: "show it"),
            toolUse("t1", name: "Bash"),
            first,
            toolUse("t2", name: "Bash"),
            second,
            TranscriptEntry(id: "a1", type: "assistant", content: "Here it is."),
        ])

        guard case .work(let turn) = viewModel.displayBlocks[1] else {
            return XCTFail("the tool calls should fold")
        }
        XCTAssertEqual(turn.featuredMedia.images, ["/media?path=after.png"])
        XCTAssertEqual(turn.featuredMedia.videos, ["/media?path=demo.mp4"])
        XCTAssertEqual(turn.featuredMedia.label, "2 media")
        XCTAssertTrue(turn.items.compactMap { item -> ToolCallItem? in
            if case .tool(let tool) = item { return tool }
            return nil
        }.allSatisfy(\.hasFeaturedMedia))
    }

    func testOnlyFinalErrorNoticeOffersFailureContinuation() {
        let errorNotice = EntryNotice(
            kind: "system", title: "Run failed", tone: "error",
            body: nil, link: nil, ask: nil, icon: nil
        )
        append([
            TranscriptEntry(
                id: "failed", type: "system", content: "Run failed",
                notice: errorNotice
            )
        ])
        viewModel.updateSessionSnapshot(Session(id: "bks-1", source: "opensession"))
        XCTAssertEqual(viewModel.failureContinuationEntryId(catalog: nil), "failed")

        append([TranscriptEntry(id: "later", type: "assistant", content: "Recovered")])
        XCTAssertNil(viewModel.failureContinuationEntryId(catalog: nil))
    }

    func testWarningsRunningSessionsAndExternalSessionsWithoutAnEngineCannotContinueFailure() {
        func notice(_ tone: String) -> TranscriptEntry {
            TranscriptEntry(
                id: tone, type: "system", content: "Stopped",
                notice: EntryNotice(
                    kind: "system", title: "Stopped", tone: tone,
                    body: nil, link: nil, ask: nil, icon: nil
                )
            )
        }

        append([notice("warn")])
        viewModel.updateSessionSnapshot(Session(id: "bks-1", source: "opensession"))
        XCTAssertNil(viewModel.failureContinuationEntryId(catalog: nil))

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1", entries: [notice("error")], cursor: .empty
        ))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        XCTAssertNil(viewModel.failureContinuationEntryId(catalog: nil))

        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        viewModel.updateSessionSnapshot(Session(id: "bks-1", source: "slack"))
        XCTAssertNil(viewModel.failureContinuationEntryId(catalog: nil))

        viewModel.updateSessionSnapshot(Session(
            id: "bks-1", ran: true, source: "slack"
        ))
        XCTAssertEqual(viewModel.failureContinuationEntryId(catalog: nil), "error")

        viewModel.updateSessionSnapshot(Session(id: "bks-1", source: "slack", model: "alias"))
        let codexCatalog = ModelCatalog(
            models: [ModelOption(
                id: "alias", label: nil, provider: "codex", group: nil,
                description: nil, efforts: nil, fastModeSupported: nil
            )],
            defaultModel: "alias"
        )
        XCTAssertEqual(viewModel.failureContinuationEntryId(catalog: codexCatalog), "error")

        viewModel.updateSessionSnapshot(Session(id: "bks-1", source: "slack", model: nil))
        XCTAssertEqual(viewModel.failureContinuationEntryId(catalog: codexCatalog), "error")
    }

    func testTurnStillRunningFoldsEntirelyAndSkipsItsFooter() {
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        append([
            TranscriptEntry(id: "u1", type: "user", content: "go"),
            TranscriptEntry(id: "a1", type: "assistant", content: "On it."),
            toolUse("t1", name: "Read", input: ["file_path": .string("/tmp/x.swift")]),
        ])

        let blocks = viewModel.displayBlocks
        XCTAssertEqual(blocks.count, 2, "a turn that ended mid-tools folds whole")
        guard case .work(let turn) = blocks[1] else {
            return XCTFail("expected a fold")
        }
        XCTAssertTrue(turn.isLive)
        XCTAssertTrue(turn.hasNarration)
        XCTAssertTrue(turn.defaultExpanded(preference: .standard))
        XCTAssertFalse(
            turn.rendersToolCallsInPlace(preference: .standard),
            "tool runs around narration keep their own grouped step rows"
        )
        XCTAssertNotNil(turn.livePreview, "a collapsed live fold must say what it is doing")
        for block in blocks {
            if case .footer = block { XCTFail("a running turn has no settled duration") }
        }
    }

    func testToolOnlyLiveTurnUsesOneClosedSummaryUntilOpened() {
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        append([
            TranscriptEntry(id: "u1", type: "user", content: "go"),
            toolUse("t1", name: "Edit", input: [
                "file_path": .string("/tmp/x.swift"),
                "old_string": .string("old"),
                "new_string": .string("one\ntwo"),
            ]),
        ])

        guard case .work(let turn) = viewModel.displayBlocks[1] else {
            return XCTFail("expected a work fold")
        }
        XCTAssertFalse(turn.hasNarration)
        XCTAssertFalse(turn.defaultExpanded(preference: .standard))
        XCTAssertTrue(
            turn.rendersToolCallsInPlace(preference: .standard),
            "opening the only summary must reveal calls without another step row"
        )
        XCTAssertEqual(turn.lineStats, ToolLineStats(additions: 2, deletions: 1))
    }

    func testFooterCarriesDurationModelAndTouchedFiles() {
        append([
            TranscriptEntry(
                id: "u1",
                type: "user",
                content: "edit",
                timestamp: "2026-01-01T00:00:00Z"
            ),
            toolUse("t1", name: "Edit", input: [
                "file_path": .string("/repo/src/App.tsx"),
                "old_string": .string("a\nb"),
                "new_string": .string("a\nb\nc"),
            ]),
            toolResult("t1", text: "ok"),
            TranscriptEntry(
                id: "a1",
                type: "assistant",
                content: "Done.",
                timestamp: "2026-01-01T00:00:12Z",
                model: "pi/anthropic/claude-sonnet-5"
            ),
        ])

        let footers = viewModel.displayBlocks.compactMap { block -> TurnFooter? in
            if case .footer(let footer) = block { return footer }
            return nil
        }
        XCTAssertEqual(footers.count, 1)
        XCTAssertEqual(footers[0].files.map(\.basename), ["App.tsx"])
        XCTAssertEqual(footers[0].model, "pi/anthropic/claude-sonnet-5")
        XCTAssertEqual(TranscriptFormat.modelLabel(footers[0].model ?? ""), "Sonnet 5")
    }

    /// The fold is shut by default, so a scratch file written inside it is
    /// invisible unless the footer names it — and a file rewritten twice is
    /// still one thing to open.
    func testFooterNamesTheScratchFilesTheTurnWroteOnce() {
        append([
            TranscriptEntry(
                id: "u1",
                type: "user",
                content: "chart it",
                timestamp: "2026-01-01T00:00:00Z"
            ),
            toolUse("t1", name: "opensession-assets_write_asset", input: [
                "path": .string("chart.html"),
            ]),
            toolResult("t1", text: "ok"),
            toolUse("t2", name: "opensession-assets_write_asset", input: [
                "path": .string("chart.html"),
            ]),
            toolResult("t2", text: "ok"),
            toolUse("t3", name: "opensession-assets_write_asset", input: [
                "path": .string("data/points.json"),
            ]),
            toolResult("t3", text: "ok"),
            TranscriptEntry(
                id: "a1",
                type: "assistant",
                content: "Charted.",
                timestamp: "2026-01-01T00:00:12Z"
            ),
        ])

        let footers = viewModel.displayBlocks.compactMap { block -> TurnFooter? in
            if case .footer(let footer) = block { return footer }
            return nil
        }
        XCTAssertEqual(footers.count, 1)
        XCTAssertEqual(footers[0].assets, ["chart.html", "data/points.json"])
    }

    /// A Task row without a way into the worker is a dead end, so the id has
    /// to be found however the engine happened to report it.
    func testSubagentIdIsFoundFromTheResultField() {
        var result = toolResult("t1", text: "done")
        result.agentId = "ses_abc123"
        append([
            TranscriptEntry(id: "u1", type: "user", content: "go"),
            toolUse("t1", name: "Task", input: ["description": .string("look")]),
            result,
        ])
        XCTAssertEqual(firstToolCall()?.subagentId, "ses_abc123")
    }

    func testSubagentIdIsFoundInTheResultBody() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "go"),
            toolUse("t1", name: "Task", input: ["description": .string("look")]),
            toolResult("t1", text: "<task id=\"ses_xyz789\" state=\"completed\">…</task>"),
        ])
        XCTAssertEqual(firstToolCall()?.subagentId, "ses_xyz789")
    }

    func testNonAgentToolsNeverOfferASubagentDrillIn() {
        var result = toolResult("t1", text: "ok")
        result.agentId = "ses_abc123"
        append([
            TranscriptEntry(id: "u1", type: "user", content: "go"),
            toolUse("t1", name: "Bash", input: ["command": .string("ls")]),
            result,
        ])
        XCTAssertNil(firstToolCall()?.subagentId)
    }

    /// The first tool call in the transcript, wherever it ended up rendering.
    private func firstToolCall() -> ToolCallItem? {
        for block in viewModel.displayBlocks {
            switch block {
            case .tool(let item): return item
            case .work(let turn):
                for case .tool(let item) in turn.items { return item }
            default: continue
            }
        }
        return nil
    }

    func testAnchorSurvivesRegrouping() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "hi"),
            toolUse("t1", name: "Grep", input: ["pattern": .string("foo")]),
            toolResult("t1", text: "none"),
        ])
        // The tool call lives inside a fold whose id is not the entry's id —
        // the history-restore anchor has to resolve through the entry.
        XCTAssertNotNil(viewModel.blockId(containing: "t1"))
        XCTAssertEqual(viewModel.topmostEntryId, "u1")
    }

    // MARK: - Walkthroughs

    private func walkthrough(
        at iso: String, entryId: String? = nil
    ) -> SessionWalkthrough {
        SessionWalkthrough(
            summary: "what changed", publishedAt: iso, publishedEntryId: entryId
        )
    }

    func testAWalkthroughAnchorsOnTheEntryTheServerRecorded() {
        let items = TranscriptGrouping.displayItems(from: [
            TranscriptEntry(
                id: "a1", type: "assistant", content: "Working.",
                timestamp: "2026-01-01T00:00:00Z"
            ),
            // Deliberately NOT named publish_walkthrough: the anchor is what
            // places the card, so the name scan must not be what finds it.
            toolUse("t1", name: "bash"),
            toolResult("t1", text: "ok"),
            TranscriptEntry(
                id: "a2", type: "assistant", content: "Shipped.",
                timestamp: "2026-01-01T00:01:00Z"
            ),
            TranscriptEntry(
                id: "a3", type: "user", content: "Thanks",
                timestamp: "2026-01-01T00:02:00Z"
            ),
        ])
        let blocks = TranscriptGrouping.blocks(
            from: items,
            live: false,
            worktreeDir: nil,
            walkthrough: walkthrough(at: "2026-01-01T09:00:00Z", entryId: "t1")
        )
        XCTAssertEqual(
            blocks.map(\.id),
            [
                "a1", "a2", "a2:footer",
                "walkthrough:2026-01-01T09:00:00Z", "a3",
            ]
        )
    }

    func testAWalkthroughLandsRightAfterTheTurnThatPublishedIt() {
        let items = TranscriptGrouping.displayItems(from: [
            TranscriptEntry(
                id: "a1", type: "assistant", content: "Recording it.",
                timestamp: "2026-01-01T00:00:00Z"
            ),
            toolUse("t1", name: "opensession-walkthrough_publish_walkthrough"),
            toolResult("t1", text: "published"),
            TranscriptEntry(
                id: "a2", type: "assistant", content: "Shipped.",
                timestamp: "2026-01-01T00:01:00Z"
            ),
            TranscriptEntry(
                id: "a3", type: "assistant", content: "Anything else?",
                timestamp: "2026-01-01T00:02:00Z"
            ),
        ])
        let blocks = TranscriptGrouping.blocks(
            from: items,
            live: false,
            worktreeDir: nil,
            // A publish time hours later must not win over the publishing
            // call: where the reader was when it appeared is what matters.
            walkthrough: walkthrough(at: "2026-01-01T09:00:00Z")
        )
        // The turn folds to one block keyed on its first item; its final
        // message escapes the fold and carries the footer.
        XCTAssertEqual(
            blocks.map(\.id),
            ["a1", "a3", "a3:footer", "walkthrough:2026-01-01T09:00:00Z"]
        )
    }

    func testAWalkthroughWhoseCallWasTrimmedFallsBackToItsPublishTime() {
        let items = TranscriptGrouping.displayItems(from: [
            TranscriptEntry(
                id: "a1", type: "assistant", content: "Earlier.",
                timestamp: "2026-01-01T00:00:00Z"
            ),
            TranscriptEntry(
                id: "a2", type: "assistant", content: "Later.",
                timestamp: "2026-01-01T02:00:00Z"
            ),
        ])
        let blocks = TranscriptGrouping.blocks(
            from: items,
            live: false,
            worktreeDir: nil,
            walkthrough: walkthrough(at: "2026-01-01T01:00:00Z")
        )
        XCTAssertEqual(
            blocks.map(\.id).filter { !$0.hasSuffix(":footer") },
            ["a1", "walkthrough:2026-01-01T01:00:00Z", "a2"]
        )
    }

    func testAWalkthroughIsNotAScrollAnchor() {
        let blocks = TranscriptGrouping.blocks(
            from: [],
            live: false,
            worktreeDir: nil,
            walkthrough: walkthrough(at: "2026-01-01T00:00:00Z")
        )
        XCTAssertEqual(blocks.first?.entryIds, [])
    }

    func testTeamNotesInterleaveByTimestampWithoutSplittingAFooter() {
        let items = TranscriptGrouping.displayItems(from: [
            TranscriptEntry(
                id: "a1", type: "assistant", content: "First.",
                timestamp: "2026-01-01T00:00:00Z"
            ),
            TranscriptEntry(
                id: "a2", type: "assistant", content: "Second.",
                timestamp: "2026-01-01T00:02:00Z"
            ),
        ])
        let note = SessionNote(
            id: "note-1", user: "Kent", text: "Look here",
            ts: 1_767_225_660_000, editedAt: nil
        )
        let blocks = TranscriptGrouping.blocks(
            from: items,
            live: false,
            worktreeDir: nil,
            notes: [note]
        )

        XCTAssertEqual(blocks.map(\.id), ["a1", "note:note-1", "a2"])
        XCTAssertTrue(blocks[1].entryIds.isEmpty)
    }

    // MARK: - Review loops

    /// A GitHub-delivered review handoff, as the server classifies it
    /// (protocol `notices.ts`).
    private func handoff(_ id: String, pr: Int?) -> TranscriptEntry {
        TranscriptEntry(
            id: id,
            type: "user",
            content: "This session's PR review found 2 things.",
            notice: EntryNotice(
                kind: "review-handoff",
                title: pr.map { "PR #\($0) review feedback" } ?? "PR review feedback",
                tone: "info",
                body: "collapsed",
                link: nil,
                ask: nil,
                icon: nil
            )
        )
    }

    /// Classified operational notices can retain the legacy user wire type
    /// even though they are not a person's message.
    private func legacyStatusNotice(_ id: String) -> TranscriptEntry {
        TranscriptEntry(
            id: id,
            type: "user",
            content: "Deployment finished for PR #128.",
            notice: EntryNotice(
                kind: "system",
                title: "Deployment finished for PR #128",
                tone: "info",
                body: nil,
                link: nil,
                ask: nil,
                icon: "deploy"
            )
        )
    }

    private func firstLoop(in blocks: [TranscriptBlock]) -> ReviewLoop? {
        for block in blocks {
            if case .reviewLoop(let loop) = block { return loop }
        }
        return nil
    }

    func testReviewHandoffSwallowsTheFixWorkItTriggered() {
        append([
            TranscriptEntry(id: "u1", type: "user", content: "ship it"),
            TranscriptEntry(id: "a1", type: "assistant", content: "Opened the PR."),
            handoff("h1", pr: 128),
            toolUse("t1", name: "Edit", input: [
                "file_path": .string("/wt/a.ts"),
                "old_string": .string("one"),
                "new_string": .string("two"),
            ]),
            toolResult("t1", text: "ok"),
            TranscriptEntry(
                id: "a2",
                type: "assistant",
                content: "Addressed the findings.",
                timestamp: "2026-01-01T00:00:10Z"
            ),
        ])

        let blocks = viewModel.displayBlocks
        XCTAssertEqual(blocks.count, 3, "prompt, answer, and one loop for the review")
        guard let loop = firstLoop(in: blocks) else {
            return XCTFail("the handoff should open a review loop")
        }
        XCTAssertEqual(loop.prNumber, 128)
        XCTAssertEqual(loop.rounds, 1)
        XCTAssertEqual(loop.detail, "1 round", "no verdict yet, so the header counts rounds")
        XCTAssertTrue(
            loop.blocks.contains { if case .work = $0 { true } else { false } },
            "the fix work belongs inside the loop"
        )
        XCTAssertTrue(
            loop.blocks.contains { block in
                if case .message(let entry) = block { return entry.id == "a2" }
                return false
            },
            "so does the answer the fix ended with"
        )
    }

    func testASecondHandoffIsAnotherRoundOfTheSameLoop() {
        append([
            handoff("h1", pr: 128),
            TranscriptEntry(id: "a1", type: "assistant", content: "Fixed."),
            handoff("h2", pr: 128),
            TranscriptEntry(id: "a2", type: "assistant", content: "Fixed again."),
        ])

        let blocks = viewModel.displayBlocks
        XCTAssertEqual(blocks.count, 1, "both rounds read as one phase")
        XCTAssertEqual(firstLoop(in: blocks)?.rounds, 2)
        XCTAssertEqual(firstLoop(in: blocks)?.detail, "2 rounds")
    }

    func testAPromptEndsTheLoopSoNobodyLosesTheirOwnRequest() {
        append([
            handoff("h1", pr: 128),
            TranscriptEntry(id: "a1", type: "assistant", content: "Fixed."),
            TranscriptEntry(id: "u1", type: "user", content: "now do this instead"),
            TranscriptEntry(id: "a2", type: "assistant", content: "Sure."),
        ])

        let blocks = viewModel.displayBlocks
        XCTAssertEqual(blocks.count, 3, "loop, prompt, answer")
        guard case .reviewLoop = blocks[0] else { return XCTFail("expected a loop first") }
        guard case .message(let prompt) = blocks[1], prompt.id == "u1" else {
            return XCTFail("the human's own request must stay outside the fold")
        }
    }

    func testLegacyUserShapedStatusNoticeStaysInsideTheLoop() {
        append([
            handoff("h1", pr: 128),
            TranscriptEntry(id: "a1", type: "assistant", content: "Fixed."),
            legacyStatusNotice("deploy"),
        ])

        let blocks = viewModel.displayBlocks
        XCTAssertEqual(blocks.count, 1, "an operational notice remains part of the review phase")
        guard let loop = firstLoop(in: blocks) else { return XCTFail("expected a loop") }
        XCTAssertTrue(loop.blocks.flatMap(\.entryIds).contains("deploy"))
    }

    func testNotesStayOutsideTheLoop() {
        let entries = [handoff("h1", pr: 7)]
        let blocks = TranscriptGrouping.blocks(
            from: TranscriptGrouping.displayItems(from: entries),
            live: false,
            worktreeDir: nil,
            notes: [SessionNote(
                id: "n1",
                user: "Kent",
                text: "looks right",
                ts: Date.distantFuture.timeIntervalSince1970 * 1000
            )]
        )
        XCTAssertEqual(blocks.count, 2, "a note has its own placement and never folds away")
        guard case .note = blocks[1] else { return XCTFail("the note should follow the loop") }
    }

    func testATrailingLoopInARunningSessionIsLive() {
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        append([handoff("h1", pr: 128), toolUse("t1", name: "Bash")])

        guard let loop = firstLoop(in: viewModel.displayBlocks) else {
            return XCTFail("expected a loop")
        }
        XCTAssertTrue(loop.isLive)
        XCTAssertEqual(loop.detail, "Working")
        XCTAssertFalse(loop.isSettled)
    }

    func testTheVerdictLandsOnTheLastLoopAndNotAfterANewPrompt() {
        var session = Session(id: "bks-1")
        session.prNumber = 128
        session.prState = "OPEN"
        session.prChecks = PrChecksSummary(total: 3, passed: 3, failed: 0, pending: 0)
        session.prOsReview = OsReviewSummary(
            verdict: "approve",
            confidence: 5,
            findings: 0,
            blocking: 0,
            stale: false
        )
        let entries = [handoff("h1", pr: 128), TranscriptEntry(
            id: "a1", type: "assistant", content: "Pushed."
        )]
        let result = ReviewLoopResult(session: session)
        XCTAssertEqual(result?.status, .passed)

        let settled = TranscriptGrouping.blocks(
            from: TranscriptGrouping.displayItems(from: entries),
            live: false,
            worktreeDir: nil,
            reviewResult: result
        )
        guard let loop = firstLoop(in: settled) else { return XCTFail("expected a loop") }
        XCTAssertEqual(loop.result?.status, .passed)
        XCTAssertEqual(loop.detail, "Ready to merge")
        XCTAssertTrue(loop.isSettled)
        XCTAssertEqual(loop.result?.facts(rounds: 1), "1 round · 5/5 · 3 checks passed")

        // A later human turn makes the old verdict stale in spirit, even
        // before GitHub has observed a new push.
        let interrupted = TranscriptGrouping.blocks(
            from: TranscriptGrouping.displayItems(
                from: entries + [TranscriptEntry(id: "u9", type: "user", content: "one more thing")]
            ),
            live: false,
            worktreeDir: nil,
            reviewResult: result
        )
        XCTAssertNil(firstLoop(in: interrupted)?.result)

        let statusAfterReview = TranscriptGrouping.blocks(
            from: TranscriptGrouping.displayItems(
                from: entries + [legacyStatusNotice("deploy")]
            ),
            live: false,
            worktreeDir: nil,
            reviewResult: result
        )
        XCTAssertEqual(
            firstLoop(in: statusAfterReview)?.result?.status,
            .passed,
            "an operational notice must not invalidate the review verdict"
        )
    }

    func testAReviewIsPendingWhileItIsStaleOrChecksAreRunning() {
        var session = Session(id: "bks-1")
        session.prNumber = 1
        session.prState = "OPEN"
        session.prOsReview = OsReviewSummary(confidence: 4, findings: 0, blocking: 0, stale: true)
        XCTAssertEqual(ReviewLoopResult(session: session)?.status, .pending)

        session.prOsReview = OsReviewSummary(confidence: 4, findings: 0, blocking: 0, stale: false)
        session.prChecks = PrChecksSummary(total: 2, passed: 1, failed: 0, pending: 1)
        XCTAssertEqual(ReviewLoopResult(session: session)?.status, .pending)

        session.prChecks = PrChecksSummary(total: 2, passed: 1, failed: 1, pending: 0)
        XCTAssertEqual(ReviewLoopResult(session: session)?.status, .failed)

        session.prState = "MERGED"
        XCTAssertNil(ReviewLoopResult(session: session), "a closed PR has no loop verdict")
    }
}

/// Session ids in agent output become links you can follow. The rewrite runs
/// over every rendered message, so its blind spots (code, URLs) matter more
/// than its hits.
@MainActor
final class SessionLinkTests: XCTestCase {
    private let id = "bks-019fcc8f-b3a7-7000-b4e7-b71681d320cd"

    override func setUp() {
        SessionLinks.register(titles: [:])
    }

    func testACodespannedIdBecomesALink() {
        SessionLinks.register(titles: [id: "Improve iOS session UI"])
        XCTAssertEqual(
            chipsAsLinks(SessionLinks.linkify("Delegated to `\(id)` just now.")),
            "Delegated to [Improve iOS session UI](os1session:\(id)) just now."
        )
    }

    func testAnUnknownIdIsLabelledByItsShortenedSelf() {
        XCTAssertEqual(
            chipsAsLinks(SessionLinks.linkify("see \(id) for details")),
            "see [bks-019fcc8f…](os1session:\(id)) for details"
        )
    }

    func testCodeBlocksAreLeftAlone() {
        let markdown = """
        ```sh
        os send \(id)
        ```
        """
        XCTAssertEqual(SessionLinks.linkify(markdown), markdown)
    }

    func testAnIdInsideAURLIsLeftAlone() {
        // Rewriting a link target would break the link it lives in.
        let markdown = "[the run](https://os.tella.dev/session/\(id))"
        XCTAssertEqual(SessionLinks.linkify(markdown), markdown)
    }

    func testTextWithoutAnIdIsReturnedUntouched() {
        let markdown = "Nothing to see here.\n\n- a list\n- of things"
        XCTAssertEqual(SessionLinks.linkify(markdown), markdown)
    }

    func testOnlyOurOwnSchemeResolvesToASession() {
        XCTAssertEqual(
            SessionLinks.sessionId(from: URL(string: "os1session:\(id)")!),
            id
        )
        XCTAssertNil(
            SessionLinks.sessionId(from: URL(string: "https://os.tella.dev/x")!)
        )
    }
}

/// Tool identity: the collapsed summary line is what people read 95% of the
/// time, so its naming and truncation rules are worth pinning.
final class ToolPresentationTests: XCTestCase {
    func testTranscriptEntryDecodesServerPresentation() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "mcp__legacy__raw_tool",
          "presentation": {
            "canonical": "mcp__opensession-portals__start_portal",
            "mcpServer": "opensession-portals",
            "name": "start_portal",
            "family": "mcp",
            "detail": { "kind": "text", "text": "Start the preview" },
            "lineStats": { "additions": 4, "deletions": 1 },
            "futureField": true
          }
        }
        """#.utf8)

        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        XCTAssertEqual(entry.presentation?.canonical, "mcp__opensession-portals__start_portal")
        XCTAssertEqual(entry.presentation?.mcpServer, "opensession-portals")
        XCTAssertEqual(entry.presentation?.detail?.kind, "text")
        XCTAssertEqual(entry.presentation?.detail?.text, "Start the preview")
        XCTAssertEqual(entry.presentation?.lineStats?.additions, 4)
    }

    func testServerPresentationWinsAndHumanizesMcpLabels() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "mcp__legacy__raw_tool",
          "toolInput": { "wrong": "local fallback" },
          "presentation": {
            "canonical": "mcp__opensession-portals__start_portal",
            "mcpServer": "opensession-portals",
            "name": "start_portal",
            "family": "mcp",
            "detail": { "kind": "text", "text": "Start the preview" },
            "lineStats": { "additions": 4, "deletions": 1 }
          }
        }
        """#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        let presentation = ToolPresentation.make(
            toolName: entry.toolName,
            input: entry.toolInput,
            server: entry.presentation
        )

        XCTAssertEqual(presentation.serverLabel, "Open Session Portals")
        XCTAssertEqual(presentation.label, "Start portal")
        XCTAssertEqual(presentation.labelParts, ["Open Session", "Portals", "Start"])
        XCTAssertEqual(presentation.displayName, "Open Session · Portals · Start")
        XCTAssertEqual(presentation.summary, "Start the preview")
        XCTAssertEqual(presentation.lineStats, ToolLineStats(additions: 4, deletions: 1))
    }

    func testUnknownServerPresentationFallsBackWithoutBreakingDecode() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "Bash",
          "toolInput": { "command": "bun test" },
          "presentation": {
            "family": "future-family",
            "detail": { "kind": "future-detail", "chart": [1, 2, 3] }
          }
        }
        """#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        let presentation = ToolPresentation.make(
            toolName: entry.toolName,
            input: entry.toolInput,
            server: entry.presentation
        )

        XCTAssertEqual(presentation.canonical, "Bash")
        XCTAssertEqual(presentation.family, .run)
        XCTAssertEqual(presentation.summary, "bun test")
    }

    @MainActor
    func testGroupingUsesDecodedServerPresentation() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "mcp__legacy__raw_tool",
          "toolInput": { "wrong": "local fallback" },
          "presentation": {
            "canonical": "mcp__posthog__query_trends",
            "mcpServer": "posthog",
            "name": "query_trends",
            "family": "mcp",
            "detail": { "kind": "text", "text": "Weekly active people" }
          }
        }
        """#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        let blocks = TranscriptGrouping.blocks(
            from: TranscriptGrouping.displayItems(from: [entry]),
            live: false,
            worktreeDir: nil
        )
        guard case .work(let turn)? = blocks.first,
              case .tool(let item)? = turn.items.first else {
            return XCTFail("expected the tool call inside a work turn")
        }

        XCTAssertEqual(item.presentation.displayName, "PostHog · Query trends")
        XCTAssertEqual(item.presentation.summary, "Weekly active people")
    }

    func testOlderEntryWithoutPresentationKeepsNativeFallback() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "Read",
          "toolInput": { "file_path": "/wt/src/App.swift" }
        }
        """#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        let presentation = ToolPresentation.make(
            toolName: entry.toolName,
            input: entry.toolInput,
            server: entry.presentation,
            worktreeDir: "/wt"
        )

        XCTAssertNil(entry.presentation)
        XCTAssertEqual(presentation.canonical, "Read")
        XCTAssertEqual(presentation.summary, "src/App.swift")
    }

    func testServerAssetSummaryKeepsPathPresentation() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "mcp__opensession-assets__write_asset",
          "presentation": {
            "canonical": "mcp__opensession-assets__write_asset",
            "mcpServer": "opensession-assets",
            "name": "write_asset",
            "family": "mcp",
            "detail": { "kind": "text", "text": "reports/summary.html" }
          }
        }
        """#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        let presentation = ToolPresentation.make(
            toolName: entry.toolName,
            input: entry.toolInput,
            server: entry.presentation
        )

        XCTAssertEqual(presentation.summary, "reports/summary.html")
        XCTAssertTrue(presentation.summaryIsPath)
    }

    func testServerPathsSummaryFormatsLabelsAndRemainingCount() throws {
        let data = Data(#"""
        {
          "id": "tu-1",
          "type": "tool_use",
          "toolName": "apply_patch",
          "presentation": {
            "canonical": "Edit",
            "name": "Edit",
            "family": "edit",
            "detail": {
              "kind": "paths",
              "paths": ["/wt/a.swift", "/wt/b.swift"],
              "labels": ["Update", "Add"],
              "more": 2
            }
          }
        }
        """#.utf8)
        let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)

        let presentation = ToolPresentation.make(
            toolName: entry.toolName,
            input: entry.toolInput,
            server: entry.presentation,
            worktreeDir: "/wt"
        )

        XCTAssertEqual(presentation.summary, "Update a.swift  ·  Add b.swift  ·  +2")
        XCTAssertFalse(presentation.summaryIsPath)
    }

    func testEngineDialectsFoldOntoOneName() {
        let dialects = [
            ("bash", "Bash"),
            ("shell", "Bash"),
            ("exec_command", "Bash"),
            ("apply_patch", "Edit"),
            ("str_replace_editor", "Edit"),
            ("notebook_edit", "NotebookEdit"),
            ("ls", "Glob"),
            ("web_fetch", "WebFetch"),
            ("web_search", "WebSearch"),
        ]
        for (raw, canonical) in dialects {
            XCTAssertEqual(
                ToolPresentation.make(toolName: raw, input: nil).canonical,
                canonical,
                "\(raw) should read as \(canonical)"
            )
        }
    }

    func testMcpNamesSplitIntoServerAndTool() {
        let presentation = ToolPresentation.make(
            toolName: "mcp__oc__linear_list_issues",
            input: nil
        )
        XCTAssertEqual(presentation.mcpServer, "linear")
        XCTAssertEqual(presentation.name, "list_issues")
        XCTAssertEqual(presentation.family, .mcp)
        XCTAssertEqual(presentation.displayName, "Linear · List issues")
    }

    func testOpenSessionMcpLabelsReadAsAHierarchy() {
        XCTAssertEqual(
            ToolPresentation.mcpLabelParts(
                server: "opensession-workflows",
                tool: "workflow_status"
            ),
            ["Open Session", "Workflows", "Status"]
        )
        XCTAssertEqual(
            ToolPresentation.mcpLabelParts(
                server: "opensession-sessions",
                tool: "get_session"
            ),
            ["Open Session", "Sessions", "Get"]
        )
        XCTAssertEqual(
            ToolPresentation.mcpLabelParts(
                server: "opensession-connected-services",
                tool: "list_connected_services"
            ),
            ["Open Session", "Connected Services", "List"]
        )
        XCTAssertEqual(
            ToolPresentation.mcpLabelParts(
                server: "screen-studio",
                tool: "start_recording"
            ),
            ["Screen Studio", "Start recording"]
        )
    }

    func testPiMcpDispatcherUsesTheCallInsideItsEnvelope() {
        let presentation = ToolPresentation.make(
            toolName: "mcp_call",
            input: .object([
                "name": .string("opensession-workflows_workflow_status"),
                "arguments": .object(["runId": .string("run-1")]),
            ])
        )
        XCTAssertEqual(presentation.mcpServer, "opensession-workflows")
        XCTAssertEqual(presentation.name, "workflow_status")
        XCTAssertEqual(presentation.displayName, "Open Session · Workflows · Status")
        XCTAssertEqual(presentation.summary, "runId: run-1")
    }

    /// The generic MCP summary lists inputs alphabetically, which for an
    /// assets write means a slice of the file's own text instead of its name.
    func testAnAssetWriteSummarizesAsItsPath() {
        let presentation = ToolPresentation.make(
            toolName: "mcp__oc__opensession-assets_write_asset",
            input: .object([
                "content": .string("<html>a whole page of it</html>"),
                "path": .string("data/points.json"),
            ])
        )
        XCTAssertEqual(presentation.summary, "data/points.json")
        XCTAssertTrue(presentation.summaryIsPath)
    }

    func testNativeToolsAreNotMistakenForMcpServers() {
        XCTAssertNil(ToolPresentation.make(toolName: "apply_patch", input: nil).mcpServer)
        XCTAssertNil(ToolPresentation.make(toolName: "exit_plan_mode", input: nil).mcpServer)
    }

    func testBashSummaryFlattensNewlines() {
        let presentation = ToolPresentation.make(
            toolName: "Bash",
            input: .object(["command": .string("cd src\nbun test")])
        )
        XCTAssertEqual(presentation.summary, "cd src ⏎ bun test")
        XCTAssertEqual(presentation.family, .run)
    }

    func testPathsAreRepoRelativeInsideTheWorktree() {
        let presentation = ToolPresentation.make(
            toolName: "Read",
            input: .object(["file_path": .string("/wt/repo/src/App.tsx")]),
            worktreeDir: "/wt/repo"
        )
        XCTAssertEqual(presentation.summary, "src/App.tsx")
        XCTAssertTrue(presentation.summaryIsPath)
    }

    func testPathsOutsideTheWorktreeShortenToTilde() {
        let presentation = ToolPresentation.make(
            toolName: "Read",
            input: .object(["file_path": .string("/home/ubuntu/notes/x.md")]),
            worktreeDir: "/wt/repo"
        )
        XCTAssertEqual(presentation.summary, "~/notes/x.md")
    }

    func testEditLineStatsComeFromTheInput() {
        let presentation = ToolPresentation.make(
            toolName: "Edit",
            input: .object([
                "file_path": .string("/wt/a.ts"),
                "old_string": .string("one\ntwo"),
                "new_string": .string("one\ntwo\nthree\nfour"),
            ]),
            worktreeDir: "/wt"
        )
        XCTAssertEqual(presentation.lineStats?.additions, 4)
        XCTAssertEqual(presentation.lineStats?.deletions, 2)
        XCTAssertEqual(presentation.touchedFiles.map(\.basename), ["a.ts"])
    }

    func testTodoSummaryNamesTheActiveStep() {
        let presentation = ToolPresentation.make(
            toolName: "TodoWrite",
            input: .object(["todos": .array([
                .object(["content": .string("one"), "status": .string("completed")]),
                .object(["content": .string("two"), "status": .string("in_progress")]),
                .object(["content": .string("three"), "status": .string("pending")]),
            ])])
        )
        XCTAssertEqual(presentation.summary, "two  ·  1/3 done")
    }

    func testEditsCarryTheirDiffForTheFileChipPreview() {
        let presentation = ToolPresentation.make(
            toolName: "Edit",
            input: .object([
                "file_path": .string("/wt/a.ts"),
                "old_string": .string("one"),
                "new_string": .string("two"),
            ]),
            worktreeDir: "/wt"
        )
        XCTAssertEqual(presentation.touchedFiles.first?.hunks, ["-one\n+two"])
    }

    func testToolsThatOnlyNamePathsCarryNoDiff() {
        // Bash touches files without reporting content; inventing a diff for
        // it would be worse than showing none.
        let presentation = ToolPresentation.make(
            toolName: "Bash",
            input: .object(["command": .string("rm a.ts")])
        )
        XCTAssertTrue(presentation.touchedFiles.isEmpty)
    }

    func testDurationsUnderASecondAreNotShown() {
        XCTAssertNil(TranscriptFormat.duration(0.4))
        XCTAssertEqual(TranscriptFormat.duration(12), "12s")
        XCTAssertEqual(TranscriptFormat.duration(184), "3m 4s")
        XCTAssertEqual(TranscriptFormat.duration(3_900), "1h 5m")
    }

    func testToolDurationIsPreparedBeforeTheRowRenders() {
        let use = TranscriptEntry(
            id: "use", type: "tool_use", timestamp: "2026-08-19T12:00:00Z"
        )
        let result = TranscriptEntry(
            id: "result", type: "tool_result", timestamp: "2026-08-19T12:00:02Z"
        )
        let item = ToolCallItem(
            id: "tool-use",
            use: use,
            result: result,
            isLive: false,
            presentation: ToolPresentation.make(toolName: "Bash", input: nil)
        )

        XCTAssertEqual(item.durationLabel, "2s")
    }

    func testEditedFilesSummaryCountsTheRest() {
        let files = ["a.ts", "b.ts", "c.ts", "d.ts"].map {
            TouchedFile(path: "src/\($0)", additions: 1, deletions: 0)
        }
        XCTAssertEqual(TranscriptFormat.editedFiles(files), "a.ts, b.ts +2")
    }
}
