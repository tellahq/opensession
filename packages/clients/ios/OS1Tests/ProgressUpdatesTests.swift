import XCTest
@testable import OS1

/// Opt-in status lines (`◷ **CI**: Running`, `✓ **CI**: All checks passed`)
/// share one row across automated turns. Mirrors the web's
/// `progress-updates.test.ts` and pins the rules that keep a blocker or a
/// question from ever hiding inside that row.
@MainActor
final class ProgressUpdatesTests: XCTestCase {
    private func say(
        _ id: String,
        _ content: String,
        at seconds: Int = 0
    ) -> TranscriptEntry {
        TranscriptEntry(
            id: id,
            type: "assistant",
            content: content,
            timestamp: String(format: "2026-01-01T00:%02d:%02dZ", seconds / 60, seconds % 60)
        )
    }

    private func user(_ id: String, _ content: String = "Another change") -> TranscriptEntry {
        TranscriptEntry(id: id, type: "user", content: content)
    }

    private func wake(_ id: String) -> TranscriptEntry {
        TranscriptEntry(id: id, type: "user", content: "", turnBoundary: true)
    }

    private func toolUse(_ id: String) -> TranscriptEntry {
        TranscriptEntry(
            id: id,
            type: "tool_use",
            content: "Using Bash",
            toolName: "Bash",
            toolInput: .object(["command": .string("gh pr checks")]),
            toolUseId: id
        )
    }

    private func toolResult(_ useId: String) -> TranscriptEntry {
        TranscriptEntry(id: "tr-\(useId)", type: "tool_result", content: "ok", toolUseId: useId)
    }

    private func project(
        _ entries: [TranscriptEntry],
        notes: [Date] = []
    ) -> ProgressProjection {
        ProgressProjection.collect(
            from: TranscriptGrouping.displayItems(from: entries),
            noteDates: notes
        )
    }

    private func blocks(_ entries: [TranscriptEntry], live: Bool = false) -> [TranscriptBlock] {
        TranscriptGrouping.blocks(
            from: TranscriptGrouping.displayItems(from: entries),
            live: live,
            worktreeDir: nil
        )
    }

    private func progressRows(_ blocks: [TranscriptBlock]) -> [ProgressGroup] {
        blocks.compactMap { if case .progress(let group) = $0 { group } else { nil } }
    }

    // MARK: - Parsing

    func testParsesReadableMarkdownWithoutGuessingAVerdict() {
        XCTAssertEqual(
            ProgressUpdate(say("a", "◷ **CI**: Running")),
            ProgressUpdate(topic: "CI", state: .running, text: "Running")
        )
        XCTAssertEqual(ProgressUpdate(say("a", "✓ **CI**: All checks passed"))?.state, .done)
        XCTAssertEqual(ProgressUpdate(say("a", "  ✓ **Deploy**: Live  \n"))?.topic, "Deploy")
        for content in [
            "All checks passed",
            "✓ Merge resolved",
            "✓ **CI**: Passed\nPreview remains unverified.",
            "✓ **CI**: Passed\r\nPreview remains unverified.",
            "✓ **CI**: Passed\n\nApprove the merge?",
            "```\n✓ **CI**: Passed\n```",
            "! **CI**: Failed",
            "✓ ** **: Passed",
            "✓ **CI**: Passed. Should I merge?",
            "✓ **CI**: ",
            "✓ **\(String(repeating: "x", count: 49))**: Passed",
            "✓ **CI**: \(String(repeating: "x", count: 201))",
        ] {
            XCTAssertNil(ProgressUpdate(say("a", content)), content)
        }
    }

    func testNeverFoldsReasoningUserTextErrorsAttachmentsOrClampedContent() {
        var variants: [TranscriptEntry] = []
        var entry = say("a", "✓ **CI**: Passed")
        entry.isReasoning = true; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed"); entry.isError = true; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed"); entry.contentClamped = true; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed"); entry.contentLength = 1_000; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed"); entry.images = ["/image.png"]; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed"); entry.videos = ["/video.mp4"]; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed"); entry.pastedTexts = ["details"]; variants.append(entry)
        entry = say("a", "✓ **CI**: Passed")
        entry.files = .array([.object(["name": .string("report.txt"), "path": .string("/report.txt")])])
        variants.append(entry)
        variants.append(user("a", "✓ **CI**: Passed"))
        for variant in variants {
            XCTAssertNil(ProgressUpdate(variant))
        }
    }

    // MARK: - Projection

    func testTheFirstRowTakesTheLatestLabelAndKeepsEveryUpdate() {
        let projection = project([
            say("a", "◷ **CI**: Running"),
            wake("w"),
            say("b", "✓ **CI**: All checks passed"),
        ])
        let group = projection.owners["a"]
        XCTAssertEqual(group?.latest, ProgressUpdate(topic: "CI", state: .done, text: "All checks passed"))
        XCTAssertEqual(group?.entries.map(\.id), ["a", "b"])
        XCTAssertEqual(group?.history.map(\.update.text), ["Running"])
        XCTAssertTrue(projection.hidden.contains("b"))
        XCTAssertNil(projection.owners["b"])
    }

    func testTopicsMatchCaseInsensitively() {
        let projection = project([
            say("a", "◷ **CI**: Running"),
            wake("w"),
            say("b", "✓ **ci**: Passed"),
        ])
        XCTAssertEqual(projection.owners["a"]?.entries.count, 2)
    }

    func testANewHumanRequestStartsAFreshRow() {
        let projection = project([
            say("a", "✓ **CI**: Passed"),
            user("u"),
            say("b", "◷ **CI**: Running"),
        ])
        XCTAssertEqual(projection.owners["a"]?.entries.count, 1)
        XCTAssertEqual(projection.owners["b"]?.entries.count, 1)
    }

    func testAReviewHandoffStartsAFreshRow() {
        var handoff = user("h", "Review feedback")
        handoff.notice = EntryNotice(
            kind: "review-handoff",
            title: "PR #12 review feedback",
            tone: "info",
            body: "collapsed",
            link: nil,
            ask: nil,
            icon: nil
        )
        let projection = project([
            say("a", "◷ **CI**: Running"),
            handoff,
            say("b", "✓ **CI**: Passed"),
        ])
        XCTAssertNotNil(projection.owners["a"])
        XCTAssertNotNil(projection.owners["b"])
    }

    func testSeparateTopicsAndTeamNotesKeepTheirOwnRows() {
        let projection = project(
            [
                say("a", "◷ **CI**: Running", at: 0),
                wake("w1"),
                say("b", "◷ **Build**: Running", at: 30),
                wake("w2"),
                say("c", "✓ **CI**: Passed", at: 120),
            ],
            notes: [Date(timeIntervalSince1970: 1_767_225_660)] // 00:01:00
        )
        XCTAssertEqual(Set(projection.owners.keys), ["a", "b", "c"])
        XCTAssertTrue(projection.hidden.isEmpty)
    }

    func testNarrationFollowedByMoreWorkIsNeverAHiddenAnchor() {
        let projection = project([
            say("a", "◷ **CI**: Running"),
            toolUse("t"),
            toolResult("t"),
            say("b", "✓ **CI**: Passed"),
        ])
        XCTAssertFalse(projection.contains("a"), "narration stays in the work fold")
        XCTAssertEqual(projection.owners["b"]?.entries.count, 1)
    }

    func testAStatusFollowedByAnAgentMessageStaysNarration() {
        for kind in ["worker-report", "session-notice"] {
            var report = user("r", "Worker finished.")
            report.notice = EntryNotice(
                kind: kind, title: "Report", tone: "info", body: "collapsed",
                link: nil, ask: nil, icon: nil
            )
            let projection = project([user("u"), say("a", "◷ **CI**: Running"), report])
            XCTAssertFalse(projection.contains("a"), kind)
        }
    }

    func testEmptyFilesDoNotBlockAStatus() {
        var entry = say("a", "✓ **CI**: Passed")
        entry.files = .array([])
        XCTAssertNotNil(ProgressUpdate(entry))
    }

    func testOrdinaryTranscriptsProjectNothing() {
        XCTAssertTrue(project([user("u"), say("a", "Done. CI passed.")]).isEmpty)
    }

    // MARK: - Blocks

    func testCheckBacksCollapseToOneStatusRowAndKeepTheirWork() {
        let result = blocks([
            user("u", "Merge main"),
            toolUse("t1"), toolResult("t1"),
            say("a", "◷ **CI**: Running", at: 10),
            wake("w1"),
            toolUse("t2"), toolResult("t2"),
            say("b", "◷ **CI**: Still running", at: 70),
            wake("w2"),
            toolUse("t3"), toolResult("t3"),
            say("c", "✓ **CI**: All checks passed", at: 130),
        ])
        let rows = progressRows(result)
        XCTAssertEqual(rows.count, 1, "one stable row, not three messages")
        XCTAssertEqual(rows.first?.id, "a")
        XCTAssertEqual(rows.first?.latest.text, "All checks passed")
        XCTAssertEqual(rows.first?.entries.map(\.id), ["a", "b", "c"])
        // The status lines leave as rows, never as plain messages or footers.
        for block in result {
            if case .message(let entry) = block {
                XCTAssertFalse(["a", "b", "c"].contains(entry.id))
            }
            if case .footer(let footer) = block {
                XCTAssertFalse(["a", "b", "c"].contains(footer.entryId))
            }
        }
        // The work behind each update is still there to open.
        let tools = result.flatMap(\.flattened).reduce(0) { count, block in
            if case .work(let turn) = block { return count + turn.toolCount }
            return count
        }
        XCTAssertEqual(tools, 3)
        // Every update stays addressable for scroll anchors.
        XCTAssertTrue(result.flatMap(\.entryIds).contains("c"))
    }

    func testABlockerOrQuestionStaysAReadableMessage() {
        let result = blocks([
            user("u", "Ship it"),
            say("a", "◷ **CI**: Running"),
            wake("w"),
            say("b", "CI failed on the lint step. Should I fix it or revert?"),
        ])
        XCTAssertEqual(progressRows(result).count, 1)
        let messages = result.compactMap { if case .message(let entry) = $0 { entry.id } else { nil } }
        XCTAssertTrue(messages.contains("b"), "a blocker is never folded into the status row")
    }

    func testAScheduledCheckBackLeadingOnlyToAStatusDropsItsNotice() {
        let scheduled = TranscriptEntry(
            id: "s",
            type: "user",
            content: "Check CI again.",
            notice: EntryNotice(
                kind: "scheduled-prompt",
                title: "Scheduled check-back",
                tone: "info",
                body: "collapsed",
                link: nil,
                ask: nil,
                icon: "clock"
            )
        )
        let result = blocks([
            user("u", "Watch CI"),
            say("a", "◷ **CI**: Running"),
            scheduled,
            say("b", "✓ **CI**: Passed"),
        ])
        XCTAssertFalse(result.contains { $0.id == "s" })
        XCTAssertEqual(progressRows(result).first?.latest.text, "Passed")
    }

    // MARK: - Work header

    func testTheWorkHeaderSaysOnlyWorkedAndDuration() {
        let result = blocks([
            user("u", "Fix it"),
            TranscriptEntry(
                id: "t", type: "tool_use", content: "Using Bash", timestamp: "2026-01-01T00:00:00Z",
                toolName: "Bash", toolInput: .object(["command": .string("bun test")]), toolUseId: "t"
            ),
            TranscriptEntry(
                id: "tr-t", type: "tool_result", content: "ok", timestamp: "2026-01-01T00:00:12Z",
                toolUseId: "t"
            ),
            say("a", "Fixed.", at: 14),
        ])
        guard let turn = result.compactMap({ if case .work(let turn) = $0 { turn } else { nil } }).first
        else { return XCTFail("the tool call should fold") }
        XCTAssertEqual(turn.headerMeta, "· 12s")
        XCTAssertEqual(turn.foldCounts, "1 step", "counts live inside the fold")
    }

    func testALiveWorkHeaderShowsNoDuration() {
        let result = blocks([user("u"), toolUse("t")], live: true)
        guard let turn = result.compactMap({ if case .work(let turn) = $0 { turn } else { nil } }).first
        else { return XCTFail("the running call should fold") }
        XCTAssertTrue(turn.isLive)
        XCTAssertNil(turn.headerMeta)
    }
}
