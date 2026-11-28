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
        blocks.compactMap { if case .progress(let group, _) = $0 { group } else { nil } }
    }

    private func progressWork(_ blocks: [TranscriptBlock]) -> [ReviewLoop?] {
        blocks.compactMap { if case .progress(_, let work) = $0 { work } else { nil } }
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

    func testShowsTheWordsOfMarkdownInAStatusNotItsSyntax() {
        XCTAssertEqual(
            ProgressUpdate(say(
                "a",
                "◷ **Image corners PR**: [#11046](https://github.com/acme/app/pull/11046) will merge itself once CI passes"
            ))?.text,
            "#11046 will merge itself once CI passes"
        )
        // An angle-bracketed link target, and a link whose label is its URL.
        XCTAssertEqual(
            ProgressUpdate.plainText("[docs](<https://example.test/docs>) are up"),
            "docs are up"
        )
        XCTAssertEqual(
            ProgressUpdate.plainText(
                "[https://github.com/acme/app/pull/7](https://github.com/acme/app/pull/7) merged"
            ),
            "app#7 merged"
        )
        XCTAssertEqual(
            ProgressUpdate.plainText(
                "https://github.com/acme/app/pull/12 and <https://github.com/acme/web/issues/3#top> are `queued`"
            ),
            "app#12 and web#3 are queued"
        )
        XCTAssertEqual(
            ProgressUpdate.plainText("<https://example.test/x> is live"),
            "https://example.test/x is live"
        )
        XCTAssertEqual(
            ProgressUpdate.plainText("**Deploying** to https://example.test/x"),
            "Deploying to https://example.test/x"
        )
        XCTAssertEqual(ProgressUpdate.plainText("__Merged__   into  `main`"), "Merged into main")
        XCTAssertEqual(
            ProgressUpdate.plainText("3 * 4 of [the tables](https://example.test)"),
            "3 * 4 of the tables"
        )
        XCTAssertNil(ProgressUpdate(say("a", "✓ **CI**: ** **")))
        // A leading status reads plain too.
        let lead = ProgressUpdate.lead(of: say(
            "a",
            "◷ **Merge**: [#9](https://github.com/acme/app/pull/9) queued\n\nIt lands once CI passes."
        ))
        XCTAssertEqual(lead?.update.text, "#9 queued")
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

    func testTheLatestUpdateOwnsTheRowAndKeepsEveryUpdate() {
        let projection = project([
            say("a", "◷ **CI**: Running"),
            wake("w"),
            say("b", "✓ **CI**: All checks passed"),
        ])
        let group = projection.owners["b"]
        XCTAssertEqual(group?.latest, ProgressUpdate(topic: "CI", state: .done, text: "All checks passed"))
        XCTAssertEqual(group?.entries.map(\.id), ["a", "b"])
        XCTAssertEqual(group?.history.map(\.update.text), ["Running"])
        XCTAssertTrue(projection.hidden.contains("a"))
        XCTAssertNil(projection.owners["a"])
    }

    func testTopicsMatchCaseInsensitively() {
        let projection = project([
            say("a", "◷ **CI**: Running"),
            wake("w"),
            say("b", "✓ **ci**: Passed"),
        ])
        XCTAssertEqual(projection.owners["b"]?.entries.count, 2)
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

    func testTopicsShareOneRowUntilATeamNote() {
        let projection = project(
            [
                say("a", "◷ **CI**: Running", at: 0),
                wake("w1"),
                say("b", "◷ **Deployment**: Running", at: 30),
                wake("w2"),
                say("c", "✓ **CI**: Passed", at: 120),
            ],
            notes: [Date(timeIntervalSince1970: 1_767_225_660)] // 00:01:00
        )
        XCTAssertEqual(Set(projection.owners.keys), ["b", "c"])
        XCTAssertEqual(projection.owners["b"]?.latest.topic, "Deployment")
        XCTAssertEqual(projection.owners["b"]?.entries.map(\.id), ["a", "b"])
        XCTAssertEqual(projection.hidden, ["a"])
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
        XCTAssertEqual(rows.count, 1, "one row, not three messages")
        XCTAssertEqual(rows.first?.id, "c")
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
        // The check-backs fold under the row, not beside it.
        XCTAssertFalse(result.contains { if case .reviewLoop = $0 { true } else { false } })
        XCTAssertEqual(progressWork(result).first??.rounds, 2)
    }

    private var shipped: [TranscriptEntry] {
        [
            user("u", "Ship it"),
            toolUse("t1"), toolResult("t1"),
            say("a", "◷ **CI**: Running", at: 10),
            wake("w1"),
            toolUse("t2"), toolResult("t2"),
            say("b", "◷ **Deployment**: Running", at: 70),
            wake("w2"),
            toolUse("t3"), toolResult("t3"),
            say("c", "Live: the change is out.", at: 130),
        ]
    }

    private func workFolds(_ blocks: [TranscriptBlock]) -> [ReviewLoop] {
        blocks.compactMap { block in
            if case .reviewLoop(let loop) = block, loop.kind == .work { loop } else { nil }
        }
    }

    func testAnAnsweredTaskFoldsIntoOneWorkRow() {
        let result = blocks(shipped)
        XCTAssertTrue(progressRows(result).isEmpty, "the answer is the report")
        let folds = workFolds(result)
        XCTAssertEqual(folds.count, 1)
        // From the first dated entry (the tool fixtures carry no time).
        XCTAssertEqual(folds.first?.duration ?? 0, 120, accuracy: 1)
        // No separate first work fold or check-back fold beside it.
        XCTAssertFalse(result.contains { if case .work = $0 { true } else { false } })
        XCTAssertFalse(result.contains { block in
            if case .reviewLoop(let loop) = block { loop.kind == .checkBack } else { false }
        })
        // The statuses and all three commands are inside, one tap away.
        let inner = folds.first?.blocks ?? []
        XCTAssertTrue(inner.flatMap(\.entryIds).contains("a"))
        XCTAssertTrue(inner.flatMap(\.entryIds).contains("b"))
        let tools = inner.reduce(0) { count, block in
            if case .work(let turn) = block { return count + turn.toolCount }
            return count
        }
        XCTAssertEqual(tools, 3)
        guard case .message(let last) = result.last(where: { if case .footer = $0 { false } else { true } })
        else { return XCTFail("the final answer stays a message") }
        XCTAssertEqual(last.id, "c")
    }

    /// An automated event and the work it started read as one row named by
    /// the event, above the answer: no centered notice, no "Worked" row.
    func testAnAutomatedEventFoldsWithItsWorkIntoOneRow() {
        var event = TranscriptEntry(
            id: "e",
            type: "user",
            content: "PR #5682 “Add a toggle. Again” now has merge conflicts with its base branch. https://github.com/acme/app/pull/5682 This session is assigned to handle it.",
            timestamp: "2026-01-01T00:00:00Z"
        )
        event.notice = EntryNotice(
            kind: "system",
            title: "PR #5682 “Add a toggle. Again” now has merge conflicts with its base branch",
            tone: "info",
            body: "collapsed",
            link: nil,
            ask: nil,
            icon: nil
        )
        let result = blocks([
            event,
            toolUse("t1"), toolResult("t1"),
            say("a", "PR #5682 is conflict-free.", at: 600),
        ])
        let folds = workFolds(result)
        XCTAssertEqual(folds.count, 1)
        XCTAssertEqual(folds.first?.trigger, "PR #5682 now has merge conflicts with its base branch")
        XCTAssertEqual(folds.first?.duration ?? 0, 600, accuracy: 1)
        XCTAssertEqual(folds.first?.blocks.first?.id, event.id)
        XCTAssertFalse(result.contains { block in
            if case .message(let entry) = block { return entry.id == "e" }
            if case .work = block { return true }
            return false
        })
    }

    /// A wrap-up a check-back follows stays visible: a review that settled
    /// outside its loop names the work it started, and a wake that did no
    /// work gets no row of its own.
    func testAWrapUpStaysVisibleAboveACheckBacksAnswer() {
        var settled = TranscriptEntry(
            id: "settled",
            type: "user",
            content: "This session's PR #7 passed review. Write a short wrap-up.",
            timestamp: "2026-01-01T00:00:00Z"
        )
        settled.notice = EntryNotice(
            kind: "review-settled",
            title: "PR #7 review passed",
            tone: "info",
            body: "collapsed",
            link: nil,
            ask: nil,
            icon: "done"
        )
        let result = blocks([
            user("ask", "Is the menu weird?"),
            say("reply", "Somewhat, yes."),
            settled,
            toolUse("t1"), toolResult("t1"),
            say("wrap", "PR #7 passed review.\n\n**Still to do**\n\n- Decide how to split the menus.", at: 30),
            wake("w1"),
            say("final", "No checks failed on PR #7.", at: 95),
        ])
        let folds = workFolds(result)
        XCTAssertEqual(folds.count, 1)
        XCTAssertEqual(folds.first?.trigger, "PR #7 review passed")
        XCTAssertEqual(folds.first?.duration ?? 0, 30, accuracy: 1)
        let messages = result.compactMap { block -> String? in
            if case .message(let entry) = block { return entry.id }
            return nil
        }
        XCTAssertEqual(messages, ["ask", "reply", "wrap", "final"])
        XCTAssertEqual(settled.notice?.triggerDetail(settled.text), [])
    }

    /// A short interim note still folds into the task the agent went on with.
    func testAnInterimNoteFoldsIntoTheCheckBack() {
        let result = blocks([
            user("ask", "Merge main"),
            toolUse("t1"), toolResult("t1"),
            say("pushed", "Pushed; waiting on CI.", at: 2),
            wake("w1"),
            toolUse("t2"), toolResult("t2"),
            say("done", "CI is green.", at: 20),
        ])
        XCTAssertEqual(workFolds(result).count, 1)
        let messages = result.compactMap { block -> String? in
            if case .message(let entry) = block { return entry.id }
            return nil
        }
        XCTAssertEqual(messages, ["ask", "done"])
        XCTAssertTrue(TranscriptGrouping.isInterimNote("Pushed; waiting on CI."))
        XCTAssertFalse(TranscriptGrouping.isInterimNote("Shipped.\n\n- Tag a release?"))
        XCTAssertFalse(TranscriptGrouping.isInterimNote("Should I merge?"))
    }

    /// Handled with nothing for the person, the event's status answer is the
    /// one row, with the event and its work folded under it.
    func testAnAutomatedEventAnsweredWithAStatusIsOneRow() {
        var event = TranscriptEntry(
            id: "e",
            type: "user",
            content: "PR #5682 now has merge conflicts with its base branch. This session is assigned to handle it.",
            timestamp: "2026-01-01T00:00:00Z"
        )
        event.notice = EntryNotice(
            kind: "system",
            title: "PR #5682 now has merge conflicts with its base branch",
            tone: "info",
            body: "collapsed",
            link: nil,
            ask: nil,
            icon: nil
        )
        let result = blocks([
            say("a", "◷ **CI**: Running"),
            event,
            toolUse("t1"), toolResult("t1"),
            say("s", "✓ **Merge conflicts**: Resolved", at: 600),
        ])
        let rows = progressRows(result)
        XCTAssertEqual(rows.map(\.latest.label), ["CI: Running", "Merge conflicts: Resolved"])
        guard let work = progressWork(result).last ?? nil else {
            return XCTFail("the event's work folds under its status row")
        }
        XCTAssertEqual(work.trigger, "PR #5682 now has merge conflicts with its base branch")
        XCTAssertEqual(work.duration ?? 0, 600, accuracy: 1)
        XCTAssertEqual(work.blocks.first?.id, "e")
        XCTAssertFalse(result.contains { block in
            switch block {
            case .message(let entry): return entry.id == "e" || entry.id == "s"
            case .work, .footer, .reviewLoop: return true
            default: return false
            }
        })
    }

    /// A reply that opens with a status line keeps only its prose, and the
    /// work row above it stays "Worked for".
    func testALeadingStatusIsDropped() {
        let result = blocks([
            user("u", "Build it"),
            toolUse("t1"), toolResult("t1"),
            say("a", "◷ **Native build**: Running\n\nOne is already queued.", at: 35),
        ])
        XCTAssertTrue(result.contains { block in
            if case .work = block { return true }
            return false
        })
        XCTAssertTrue(result.contains { block in
            if case .message(let entry) = block { return entry.text == "One is already queued." }
            return false
        })
        XCTAssertTrue(progressRows(result).isEmpty)
    }

    /// An event the agent answered without any work stays its own notice.
    func testAnAutomatedEventWithoutWorkStaysANotice() {
        var event = user("e", "PR #12 was merged into main by Kent.")
        event.notice = EntryNotice(
            kind: "system", title: "PR #12 was merged into main by Kent.", tone: "info",
            body: nil, link: nil, ask: nil, icon: "merge"
        )
        let result = blocks([event, say("a", "Merged.")])
        XCTAssertTrue(workFolds(result).isEmpty)
    }

    func testARunningTaskKeepsItsStatusRow() {
        let result = blocks(Array(shipped.dropLast()), live: true)
        XCTAssertEqual(progressRows(result).first?.latest.label, "Deployment: Running")
        XCTAssertEqual(progressRows(result).first?.history.map(\.update.label), ["CI: Running"])
        XCTAssertTrue(workFolds(result).isEmpty)
    }

    func testABlockerOrQuestionStaysAReadableMessage() {
        let result = blocks([
            user("u", "Ship it"),
            say("a", "◷ **CI**: Running"),
            wake("w"),
            say("b", "CI failed on the lint step. Should I fix it or revert?"),
        ])
        XCTAssertTrue(progressRows(result).isEmpty)
        XCTAssertEqual(workFolds(result).count, 1)
        let messages = result.compactMap { if case .message(let entry) = $0 { entry.id } else { nil } }
        XCTAssertTrue(messages.contains("b"), "a blocker is never folded away")
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
        XCTAssertEqual(turn.headerTitle, "Worked for 12s")
        XCTAssertEqual(turn.foldCounts, "1 step", "counts live inside the fold")
    }

    func testALiveWorkHeaderShowsNoDuration() {
        let result = blocks([user("u"), toolUse("t")], live: true)
        guard let turn = result.compactMap({ if case .work(let turn) = $0 { turn } else { nil } }).first
        else { return XCTFail("the running call should fold") }
        XCTAssertTrue(turn.isLive)
        XCTAssertEqual(turn.headerTitle, "Working")
    }

    // MARK: - Status lines inside a work fold (web `foldStatuses`)

    private func update(_ topic: String, _ state: ProgressUpdate.State, _ text: String) -> ProgressUpdate {
        ProgressUpdate(topic: topic, state: state, text: text)
    }

    private func minutes(_ at: Double...) -> (Int) -> Date? {
        { Date(timeIntervalSince1970: at[$0] * 60) }
    }

    func testFoldStatusNamesTheOutcomeALaterUpdateGave() {
        let steps = FoldStatus.resolve(
            [nil, update("CI", .running, "Running"), nil, update("CI", .done, "All checks passed")],
            startedAt: minutes(0, 1, 5, 5),
            isLive: false
        )
        XCTAssertEqual(steps, [nil, .shown(FoldStatus(topic: "CI", text: "CI passed · 4m", isDone: true)), nil, .folded])
    }

    func testFoldStatusSaysHowLongItWaitedWhenNothingClosedIt() {
        let steps = FoldStatus.resolve(
            [update("CI", .running, "Running"), nil, update("Deployment", .running, "Running"), nil],
            startedAt: minutes(0, 4, 6, 9),
            isLive: false
        )
        XCTAssertEqual(steps, [
            .shown(FoldStatus(topic: "CI", text: "Waited for CI · 4m", isDone: false)),
            nil,
            .shown(FoldStatus(topic: "Deployment", text: "Waited for deployment · 3m", isDone: false)),
            nil,
        ])
    }

    func testFoldStatusWaitsInThePresentTenseOnlyWhileNothingHasMovedOn() {
        let updates = [nil, update("CI", .running, "Running"), nil]
        XCTAssertEqual(
            FoldStatus.resolve(
                updates + [update("Deploy", .running, "Running")],
                startedAt: minutes(0, 1, 3, 4),
                isLive: true
            )[1],
            .shown(FoldStatus(topic: "CI", text: "Waited for CI · 2m", isDone: false))
        )
        XCTAssertEqual(
            FoldStatus.resolve(updates, startedAt: minutes(0, 1, 3), isLive: true)[1],
            .shown(FoldStatus(topic: "CI", text: "Waiting for CI", isDone: false))
        )
        XCTAssertEqual(
            FoldStatus.resolve(updates, startedAt: minutes(0, 1, 3), isLive: false)[1],
            .shown(FoldStatus(topic: "CI", text: "Waited for CI · 2m", isDone: false))
        )
    }

    func testFoldStatusKeepsTheAgentsOwnWordsBeyondABareState() {
        let steps = FoldStatus.resolve(
            [
                update("Migration", .running, "3 of 12 tables"),
                nil,
                update("Deployment", .done, "Done"),
                update("Release", .running, "Running"),
                update("Release", .done, "v2.3 is live"),
            ],
            startedAt: minutes(0, 2, 3, 4, 6),
            isLive: false
        )
        XCTAssertEqual(steps, [
            .shown(FoldStatus(topic: "Migration", text: "Migration: 3 of 12 tables · 2m", isDone: false)),
            nil,
            .shown(FoldStatus(topic: "Deployment", text: "Deployment done", isDone: true)),
            .shown(FoldStatus(topic: "Release", text: "Release: v2.3 is live · 2m", isDone: true)),
            .folded,
        ])
    }

    func testCheckTopicsTakeACheckRunsGlyphs() {
        XCTAssertEqual(ProgressUpdate.symbol(topic: "CI", isDone: false), "circle.dashed")
        XCTAssertEqual(ProgressUpdate.symbol(topic: "Native build", isDone: true), "checkmark.circle")
        XCTAssertEqual(ProgressUpdate.symbol(topic: "Deployment", isDone: false), "clock")
        XCTAssertEqual(ProgressUpdate.symbol(topic: "Deployment", isDone: true), "checkmark")
    }
}
