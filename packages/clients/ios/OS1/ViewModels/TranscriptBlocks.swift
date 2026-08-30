import Foundation

/// One rendered unit of the transcript. The flat entry list groups into these
/// the way the web viewer's `TranscriptBlocks` does: a turn's tool calls (and
/// the prose between them) collapse into one fold, the turn's FINAL answer
/// escapes that fold and reads as a normal message, and a metadata footer
/// closes a settled turn.
///
/// The point of the shape is the reading rhythm it produces:
/// question → [work] → answer → meta.
enum TranscriptBlock: Identifiable, Equatable {
    /// A standalone message: a prompt, a system notice, or a turn's answer.
    case message(TranscriptEntry)
    /// A lone tool call outside any turn (an orphan result after a reload).
    case tool(ToolCallItem)
    /// The collapsible work fold.
    case work(WorkTurn)
    /// Duration / model / touched files under a settled answer.
    case footer(TurnFooter)
    /// The agent-published walkthrough, at the point it was published.
    case walkthrough(SessionWalkthrough)
    /// A team note that the agent never sees.
    case note(SessionNote)
    /// A PR review handoff and the fix work it triggered, as one fold.
    case reviewLoop(ReviewLoop)

    var id: String {
        switch self {
        case .message(let entry): entry.id
        case .tool(let item): item.id
        case .work(let turn): turn.id
        case .footer(let footer): footer.id
        case .walkthrough(let walkthrough): "walkthrough:\(walkthrough.publishedAt)"
        case .note(let note): "note:\(note.id)"
        case .reviewLoop(let loop): loop.id
        }
    }

    /// Where a scroll restore should land. A turn keys on its FIRST item so
    /// its identity is stable while it grows, but anchors on its LAST — a
    /// history page can merge older entries into the topmost turn, which
    /// moves the first item without moving the last.
    var anchorId: String {
        if case .work(let turn) = self { return turn.anchorId }
        return id
    }

    /// This block plus, for a review loop, everything folded inside it — so
    /// callers that walk the transcript for content (linkable files, written
    /// assets) still see work that a loop swallowed.
    var flattened: [TranscriptBlock] {
        if case .reviewLoop(let loop) = self { return [self] + loop.blocks }
        return [self]
    }

    /// Every transcript entry this block renders, for anchor resolution.
    var entryIds: [String] {
        switch self {
        case .message(let entry): [entry.id]
        case .tool(let item): [item.use?.id, item.result?.id].compactMap { $0 }
        case .work(let turn): turn.items.flatMap(\.entryIds)
        case .footer(let footer): [footer.entryId]
        // A walkthrough is not a transcript entry, so it can never be a
        // scroll anchor.
        case .walkthrough: []
        case .note: []
        // A loop stands in for every entry it folded, so an anchor inside one
        // resolves to the loop's row rather than to nothing.
        case .reviewLoop(let loop): loop.blocks.flatMap(\.entryIds)
        }
    }
}

/// A PR review handoff and the work it triggered, folded into one disclosure.
///
/// A review round is noisy out of proportion to what it means: the handoff
/// itself, the fix turns, the push, then the next handoff. Closed, the loop
/// says what it concluded; open, it reads like a worker — the same icon-led
/// step rows, with the verdict at the end. Mirrors the web viewer's
/// `groupReviewLoops` / `ReviewLoopBlock`.
struct ReviewLoop: Identifiable, Equatable {
    var id: String
    /// The PR under review, when the handoff named one.
    var prNumber: Int?
    /// How many handoffs this loop swallowed — one per review round.
    var rounds: Int
    /// The loop is the live tail of a running session: still working.
    var isLive: Bool
    /// The blocks the loop folded, in transcript order — handoff notices
    /// included, so their entries stay addressable. The view skips drawing
    /// them: the disclosure header IS the handoff.
    var blocks: [TranscriptBlock]
    /// The settled verdict, on the final loop only.
    var result: ReviewLoopResult?

    /// What the closed row says. A live loop is always working, whatever
    /// GitHub last reported about the PR.
    var detail: String {
        if isLive { return "Working" }
        switch result?.status {
        case .passed: return "Ready to merge"
        case .failed: return "Needs changes"
        case .pending: return "Working"
        case nil: return roundsLabel
        }
    }

    /// The loop has reached a verdict, so opening it can move that verdict
    /// down to its own row and give the header the round count instead.
    var isSettled: Bool { !isLive && result != nil && result?.status != .pending }

    var roundsLabel: String { "\(rounds) round\(rounds == 1 ? "" : "s")" }
}

/// The latest GitHub facts about the PR a review loop was working on, as the
/// loop's row shows them. Mirrors the web's `reviewLoopResult`.
struct ReviewLoopResult: Equatable {
    enum Status: Equatable { case pending, passed, failed }

    var status: Status
    /// 1-5: how safe the reviewer thought this was to merge.
    var confidence: Int?
    var checksPassed: Int?
    var checksFailed: Int?
    /// P0/P1 findings — what would block a merge.
    var blocking: Int?

    /// Nil unless there is an open PR with a review on it — anything else has
    /// no verdict to report, and a row that guesses is worse than no row.
    init?(session: Session) {
        guard session.prNumber != nil,
              session.prState == "OPEN",
              let review = session.prOsReview
        else { return nil }
        let checks = session.prChecks
        confidence = review.confidence
        checksPassed = checks?.passed
        checksFailed = checks?.failed
        blocking = review.blocking

        if review.stale == true || (checks?.pending ?? 0) > 0 {
            status = .pending
            return
        }
        let failed = (checks?.failed ?? 0) > 0
            || session.prReviewDecision == "CHANGES_REQUESTED"
            || review.verdict == "request_changes"
            || (review.blocking ?? 0) > 0
            || ((review.findings ?? 0) > 0 && (review.confidence ?? 0) < 4)
        status = failed ? .failed : .passed
    }

    /// "2 rounds · 4/5 · 1 blocking · 3 checks passed" — the numbers behind
    /// the verdict, in the web's order, with empty pieces dropped rather than
    /// leaving stray separators.
    func facts(rounds: Int) -> String {
        var parts = ["\(rounds) round\(rounds == 1 ? "" : "s")"]
        if let confidence { parts.append("\(confidence)/5") }
        if let blocking, blocking > 0 { parts.append("\(blocking) blocking") }
        if let checksFailed, checksFailed > 0 {
            parts.append("\(checksFailed) check\(checksFailed == 1 ? "" : "s") failed")
        }
        if let checksPassed, checksPassed > 0 {
            parts.append("\(checksPassed) checks passed")
        }
        return parts.joined(separator: " · ")
    }
}

/// One tool call merged with its result, plus the identity/summary the row
/// draws. The presentation is built during the display pass so no view body
/// ever parses tool input.
struct ToolCallItem: Identifiable, Equatable {
    var id: String
    var use: TranscriptEntry?
    var result: TranscriptEntry?
    /// Only a stream entry is eligible for the "expand while running" mode; a
    /// reloaded transcript can hold old uses with no persisted result.
    var isLive: Bool
    var presentation: ToolPresentation
    /// Prepared with the transcript blocks, not from `ToolCallRow.body`. The
    /// latter runs during scene updates and must stay free of date parsing.
    let durationLabel: String?

    init(
        id: String,
        use: TranscriptEntry?,
        result: TranscriptEntry?,
        isLive: Bool,
        presentation: ToolPresentation
    ) {
        self.id = id
        self.use = use
        self.result = result
        self.isLive = isLive
        self.presentation = presentation
        if let start = use?.timestampDate, let end = result?.timestampDate {
            let elapsed = end.timeIntervalSince(start)
            durationLabel = elapsed >= 1.5 ? TranscriptFormat.duration(elapsed) : nil
        } else {
            durationLabel = nil
        }
    }

    var isError: Bool { use?.isError == true || result?.isError == true }
    var isPending: Bool { result == nil && use != nil }
    var media: TranscriptMedia { result?.media ?? TranscriptMedia() }
    var featuredMedia: TranscriptMedia {
        result?.explicitlyFeaturedMedia ?? TranscriptMedia()
    }
    var hasMedia: Bool { !media.isEmpty }
    var hasFeaturedMedia: Bool { !featuredMedia.isEmpty }

    /// The scratch file this call wrote, when it was an assets write — the key
    /// that opens it. Session assets live outside every worktree, so the path
    /// means nothing to anything but the assets tab.
    var assetPath: String? {
        let input = ToolPresentation.resolveCall(
            toolName: use?.toolName ?? "",
            input: use?.toolInput
        ).input
        guard presentation.mcpServer == "opensession-assets",
              presentation.name == "write_asset",
              let path = input?["path"]?.stringValue,
              !path.isEmpty
        else { return nil }
        return path
    }

    /// The worker this Task call spawned, when it announced one — the key
    /// that opens its transcript. The engine reports it either as the
    /// result's `agentId` or inside the result body as `<task id="ses_…">`.
    var subagentId: String? {
        guard presentation.family == .agent else { return nil }
        if let id = result?.agentId ?? use?.agentId, !id.isEmpty { return id }
        guard let text = result?.text,
              let range = text.range(
                  of: "<task id=\"ses_[A-Za-z0-9]+\"",
                  options: .regularExpression
              ),
              let idRange = text[range].range(
                  of: "ses_[A-Za-z0-9]+",
                  options: .regularExpression
              )
        else { return nil }
        return String(text[range][idRange])
    }
}

enum TurnItem: Identifiable, Equatable {
    /// Intermediate assistant prose — narration between tool calls.
    case message(TranscriptEntry)
    case tool(ToolCallItem)

    var id: String {
        switch self {
        case .message(let entry): entry.id
        case .tool(let item): item.id
        }
    }

    var entryIds: [String] {
        switch self {
        case .message(let entry): [entry.id]
        case .tool(let item): [item.use?.id, item.result?.id].compactMap { $0 }
        }
    }
}

/// The collapsed work of one turn, pre-summarized so the header renders
/// without touching the items.
struct WorkTurn: Identifiable, Equatable {
    var id: String
    var anchorId: String
    var items: [TurnItem]
    /// The turn is still producing output — the header says "Working".
    var isLive: Bool
    var duration: TimeInterval?
    /// Distinct tool families in first-use order: the fold's fingerprint.
    var families: [ToolFamily]
    var toolCount: Int
    var failureCount: Int
    var touchedFiles: [TouchedFile]
    var lineStats: ToolLineStats
    /// A result carried an image — the fold opens so it isn't hidden.
    var hasMedia: Bool
    /// Media the agent explicitly surfaced. Closed folds keep this visible;
    /// open folds render it in the tool row that produced it.
    var featuredMedia: TranscriptMedia = TranscriptMedia()
    /// "Bash: bun test" — what the fold is doing right now, shown while it is
    /// live and collapsed so the work never looks stalled.
    var livePreview: String?

    var hasFailure: Bool { failureCount > 0 }
    var hasNarration: Bool

    /// How the fold should start out, before any manual toggle.
    func defaultExpanded(preference: TurnActivity) -> Bool {
        // A tool-only turn already has one complete summary in its header.
        // Keep it closed unless the person explicitly keeps all work open.
        if !hasNarration, preference.work != .open { return false }
        // The default is open while the work is happening and folded the
        // moment it settles, which is also the only work setting where a
        // finished turn's notes can be put away, since the header then owns
        // them. The nested tool-call setting does not change this outer fold.
        return preference.defaultExpanded(isLive: isLive)
    }

    func rendersToolCallsInPlace(preference: TurnActivity) -> Bool {
        !hasNarration || preference.rendersToolCallsInPlace
    }
}

/// The metadata row under a settled turn's answer.
struct TurnFooter: Identifiable, Equatable {
    var id: String
    var entryId: String
    /// Raw markdown of the answer, for "Copy message".
    var text: String
    var timestamp: Date?
    /// Per-message model, when the server recorded one.
    var model: String?
    var duration: TimeInterval?
    var files: [TouchedFile]
    /// Scratch files the turn wrote with `opensession-assets` — a report, a
    /// chart, a page of sample data. Named here as well as inside the fold
    /// because the fold is shut by default: an artifact nobody can see is one
    /// nobody opens.
    var assets: [String] = []

    var isEmpty: Bool {
        duration == nil && model == nil && files.isEmpty && assets.isEmpty
    }
}

/// Display text for provider reasoning summaries. Generated leading bold is
/// chrome, not answer emphasis, so it becomes a regular-weight title while a
/// longer body retains markdown.
struct ReasoningSummaryDisplay: Equatable {
    let title: String
    let body: String

    init(_ content: String) {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("**"),
              let close = trimmed.dropFirst(2).range(of: "**"),
              !trimmed[trimmed.index(trimmed.startIndex, offsetBy: 2)..<close.lowerBound]
                .contains("\n")
        else {
            title = ""
            body = trimmed
            return
        }
        let after = trimmed[close.upperBound...]
        guard after.isEmpty || after.first?.isWhitespace == true else {
            title = ""
            body = trimmed
            return
        }
        title = String(
            trimmed[trimmed.index(trimmed.startIndex, offsetBy: 2)..<close.lowerBound]
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        body = String(after).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The activity chrome for this summary. Providers that send prose rather
    /// than a generated heading still get one stable live label; their prose
    /// remains in `body` and readable below it. Durable prose gets no label.
    func activityTitle(isActive: Bool) -> String? {
        if !title.isEmpty { return title }
        return isActive ? "Thinking" : nil
    }

    /// A tolerant compatibility check for the old bold-heading-only shape.
    static func isLegacyHeading(_ content: String) -> Bool {
        // Generated headings are short. Reject normal prose before trimming or
        // parsing it so the O(n) grouping pass never repeatedly copies a large
        // durable answer while new stream snapshots arrive.
        guard content.utf8.count <= 4_096 else { return false }
        let display = ReasoningSummaryDisplay(content)
        return !display.title.isEmpty && display.body.isEmpty
    }

    /// A streamed generated heading may not have received its closing `**`
    /// yet. Multiline output is normal answer markdown, not this live state.
    static func liveHeading(_ content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("**"), !trimmed.contains("\n") else { return nil }
        var heading = String(trimmed.dropFirst(2))
        if heading.hasSuffix("**") { heading.removeLast(2) }
        heading = heading.trimmingCharacters(in: .whitespacesAndNewlines)
        return heading.isEmpty ? nil : heading
    }
}

// MARK: - Grouping

@MainActor
enum TranscriptGrouping {
    /// Merge each `tool_use` with its `tool_result` (matched on `toolUseId`,
    /// or the server's `tr-<id>` convention) into one item; orphan results
    /// stay standalone. The transcript FILE is the order authority, so this
    /// preserves the order it was given.
    ///
    /// Shared with the sub-agent viewer, which renders a worker's transcript
    /// through exactly the same pipeline as the main session.
    static func displayItems(
        from all: [TranscriptEntry],
        liveIds: Set<String> = []
    ) -> [SessionViewModel.DisplayItem] {
        var resultByUseId: [String: TranscriptEntry] = [:]
        for entry in all where entry.type == "tool_result" {
            let key = entry.toolUseId ?? String(entry.id.dropFirst("tr-".count))
            if resultByUseId[key] == nil { resultByUseId[key] = entry }
        }
        let useIds = Set(
            all.filter { $0.type == "tool_use" }.map { $0.toolUseId ?? $0.id }
        )
        var items: [SessionViewModel.DisplayItem] = []
        for entry in all {
            switch entry.type {
            case "tool_use":
                let key = entry.toolUseId ?? entry.id
                items.append(.toolCall(
                    use: entry,
                    result: resultByUseId[key],
                    isLive: liveIds.contains(entry.id)
                ))
            case "tool_result":
                // Only orphans render standalone — a result whose use exists
                // anywhere in the transcript is folded into that item.
                let key = entry.toolUseId ?? String(entry.id.dropFirst("tr-".count))
                if !useIds.contains(key) {
                    items.append(.entry(entry))
                }
            default:
                items.append(.entry(entry))
            }
        }
        return items
    }

    /// Fold the flat display list into blocks. Pure and O(n) — it runs in the
    /// view model's rebuild pass, never in a view body.
    ///
    /// `live` marks the session as still running, which keeps the trailing
    /// turn labelled "Working" and suppresses its footer (a turn that hasn't
    /// finished has no duration worth showing).
    static func blocks(
        from items: [SessionViewModel.DisplayItem],
        live: Bool,
        worktreeDir: String?,
        walkthrough: SessionWalkthrough? = nil,
        notes: [SessionNote] = [],
        reviewResult: ReviewLoopResult? = nil
    ) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        var turn: [TurnItem] = []

        func flush(isTrailing: Bool) {
            defer { turn = [] }
            guard !turn.isEmpty else { return }

            // A plain final assistant row is the only answer candidate. Before
            // `isReasoning`, providers persisted intermediate summaries as a
            // bold-only row; every such row in the work is activity, including
            // the last assistant message when later tools prove it was not the
            // answer. A bold final answer stays ordinary answer markdown.
            let finalIndex: Int? = {
                guard let index = turn.indices.last,
                      case .message(let entry) = turn[index],
                      entry.isReasoning != true
                else { return nil }
                return index
            }()
            var normalized = turn
            for index in normalized.indices where index != finalIndex {
                guard case .message(var entry) = normalized[index],
                      entry.isReasoning == nil,
                      ReasoningSummaryDisplay.isLegacyHeading(entry.text)
                else { continue }
                entry.isReasoning = true
                normalized[index] = .message(entry)
            }

            let tools = normalized.compactMap { item -> ToolCallItem? in
                if case .tool(let call) = item { return call }
                return nil
            }
            // No tools: nothing worth hiding, so every message stands alone.
            guard !tools.isEmpty else {
                blocks.append(contentsOf: normalized.map { item in
                    switch item {
                    case .message(let entry): TranscriptBlock.message(entry)
                    case .tool(let call): TranscriptBlock.tool(call)
                    }
                })
                return
            }
            // Explicit and inferred reasoning stays interleaved with the tools
            // it describes, matching the web transcript. It is work even at
            // the tail and must never acquire answer metadata or hierarchy.
            let final: TranscriptEntry? = if let finalIndex,
                                             case .message(let entry) = normalized[finalIndex] {
                entry
            } else {
                nil
            }
            let folded = final == nil ? normalized : Array(normalized.dropLast())
            let isLive = live && isTrailing

            if let first = folded.first, let last = folded.last {
                blocks.append(.work(makeTurn(
                    items: folded,
                    firstId: first.id,
                    lastId: last.id,
                    tools: tools.filter { call in folded.contains { $0.id == call.id } },
                    isLive: isLive
                )))
            }
            guard let final else { return }
            blocks.append(.message(final))
            // A running turn's footer would show a duration that is still
            // ticking; wait for it to settle.
            guard !isLive else { return }
            let start = normalized.first.flatMap(startTimestamp)
            let end = final.timestampDate
            let footer = TurnFooter(
                id: "\(final.id):footer",
                entryId: final.id,
                text: final.text,
                timestamp: end,
                model: final.model,
                duration: duration(from: start, to: end),
                files: mergeTouchedFiles(tools),
                assets: writtenAssets(tools)
            )
            if !footer.isEmpty { blocks.append(.footer(footer)) }
        }

        for (index, item) in items.enumerated() {
            let isLast = index == items.count - 1
            switch item {
            case .toolCall(let use, let result, let isLive):
                turn.append(.tool(ToolCallItem(
                    id: "tool-\(use.id)",
                    use: use,
                    result: result,
                    isLive: isLive,
                    presentation: ToolPresentation.make(
                        toolName: use.toolName,
                        input: use.toolInput,
                        server: use.presentation,
                        worktreeDir: worktreeDir
                    )
                )))
            case .entry(let entry) where entry.turnBoundary == true:
                // Hidden system-triggered turns separate completed output from
                // later work without drawing an empty user message.
                flush(isTrailing: false)
            case .entry(let entry) where entry.isAssistant:
                turn.append(.message(entry))
            case .entry(let entry) where entry.isTool:
                // Orphan tool_result — same compact treatment inside the fold.
                turn.append(.tool(ToolCallItem(
                    id: "tool-\(entry.id)",
                    use: nil,
                    result: entry,
                    isLive: false,
                    presentation: ToolPresentation.make(
                        toolName: entry.toolName,
                        input: entry.toolInput,
                        server: entry.presentation,
                        worktreeDir: worktreeDir
                    )
                )))
            case .entry(let entry):
                flush(isTrailing: false)
                blocks.append(.message(entry))
            }
            if isLast { flush(isTrailing: true) }
        }
        return groupReviewLoops(
            place(notes, into: place(walkthrough, into: blocks)),
            live: live,
            result: reviewResult
        )
    }

    private enum ReviewBlockRole {
        case handoff(prNumber: Int?)
        case userMessage
        case other
    }

    /// Operational notices can retain the legacy `user` wire type. Match the
    /// message presentation rule so only an actual person's message ends a loop.
    private static func reviewBlockRole(_ block: TranscriptBlock) -> ReviewBlockRole {
        guard case .message(let entry) = block else { return .other }
        if entry.notice?.kind == "review-handoff" {
            return .handoff(prNumber: handoffPrNumber(block))
        }
        return entry.isUser && entry.notice == nil ? .userMessage : .other
    }

    /// A review handoff and the work it triggers form one quiet phase. A real
    /// user message always ends it, so people never lose their own request in
    /// a collapsed automation trail. Mirrors the web's `groupReviewLoops`.
    private static func groupReviewLoops(
        _ blocks: [TranscriptBlock],
        live: Bool,
        result: ReviewLoopResult?
    ) -> [TranscriptBlock] {
        guard blocks.contains(where: isReviewHandoff) else { return blocks }
        var grouped: [TranscriptBlock] = []
        var index = 0
        while index < blocks.count {
            let first = blocks[index]
            guard case .handoff(let firstPrNumber) = reviewBlockRole(first) else {
                grouped.append(first)
                index += 1
                continue
            }
            var loop: [TranscriptBlock] = [first]
            var rounds = 1
            var prNumber = firstPrNumber
            while index + 1 < blocks.count {
                let next = blocks[index + 1]
                let nextRole = reviewBlockRole(next)
                // Notes and walkthroughs have their own placement and must
                // never vanish inside an automation disclosure.
                if case .note = next { break }
                if case .walkthrough = next { break }
                // A normal user message is a new conversation phase. A second
                // review handoff belongs to this loop and starts its next round.
                if case .userMessage = nextRole { break }
                index += 1
                loop.append(next)
                if case .handoff(let nextPrNumber) = nextRole {
                    rounds += 1
                    prNumber = prNumber ?? nextPrNumber
                }
            }
            grouped.append(.reviewLoop(ReviewLoop(
                id: "review-loop:\(first.id)",
                prNumber: prNumber,
                rounds: rounds,
                isLive: false,
                blocks: loop
            )))
            index += 1
        }

        // A running session's trailing loop is live whatever GitHub last said
        // about the PR; a later human turn makes an older verdict stale in
        // spirit, so only the final loop with nothing but automation after it
        // reports one.
        let lastLoop = grouped.lastIndex { if case .reviewLoop = $0 { true } else { false } }
        guard let lastLoop else { return grouped }
        let interrupted = grouped[(lastLoop + 1)...].contains { block in
            if case .userMessage = reviewBlockRole(block) { return true }
            return false
        }
        guard case .reviewLoop(var loop) = grouped[lastLoop] else { return grouped }
        loop.isLive = live && lastLoop == grouped.count - 1
        if let result, !interrupted, !loop.isLive { loop.result = result }
        grouped[lastLoop] = .reviewLoop(loop)
        return grouped
    }

    /// Whether this block is the GitHub-delivered review handoff that opens a
    /// loop. The server classifies it (protocol `notices.ts`), so nothing here
    /// re-derives it from the message text.
    private static func isReviewHandoff(_ block: TranscriptBlock) -> Bool {
        if case .handoff = reviewBlockRole(block) { return true }
        return false
    }

    /// The PR the handoff's title names ("PR #128 review feedback"), when it
    /// named one — an older handoff carries no number.
    private static func handoffPrNumber(_ block: TranscriptBlock) -> Int? {
        guard case .message(let entry) = block,
              let title = entry.notice?.title,
              let range = title.range(of: "PR #[0-9]+", options: .regularExpression)
        else { return nil }
        return Int(title[range].dropFirst("PR #".count))
    }

    /// Interleave team notes by timestamp without splitting an answer from its
    /// footer. Mirrors the web transcript's placement rule.
    private static func place(
        _ notes: [SessionNote], into blocks: [TranscriptBlock]
    ) -> [TranscriptBlock] {
        guard !notes.isEmpty else { return blocks }
        var out = blocks
        var at = 0
        for note in notes.sorted(by: { $0.ts < $1.ts }) {
            while at < out.count, (blockTime(out[at]) ?? .distantPast) <= note.date {
                at += 1
            }
            out.insert(.note(note), at: at)
            at += 1
        }
        return out
    }

    /// Drop the walkthrough card straight after the turn that published it —
    /// that's where the reader was when it appeared, and it reads as the
    /// result of that work rather than a floating attachment. When the
    /// publishing call has been trimmed out of the loaded window, fall back to
    /// its publish time, and to the end of the transcript if even that is
    /// unusable.
    private static func place(
        _ walkthrough: SessionWalkthrough?, into blocks: [TranscriptBlock]
    ) -> [TranscriptBlock] {
        guard let walkthrough else { return blocks }
        var out = blocks
        // The server records the publishing entry (publishedEntryId), so the
        // normal path is a lookup. The scan below is for walkthroughs
        // published before that field, and for a publishing call that has
        // scrolled out of the loaded window.
        let anchored = walkthrough.publishedEntryId.flatMap { id in
            blocks.firstIndex { $0.entryIds.contains(id) }
        }
        if let publishing = anchored ?? blocks.lastIndex(where: publishesWalkthrough) {
            // Past the turn's answer and footer, not straight after the fold:
            // the card summarizes the work, so splitting the turn from the
            // reply it ended with would read as an interruption.
            var at = publishing + 1
            if at < blocks.count, case .message = blocks[at] { at += 1 }
            if at < blocks.count, case .footer = blocks[at] { at += 1 }
            out.insert(.walkthrough(walkthrough), at: at)
            return out
        }
        guard let published = walkthrough.publishedDate else {
            out.append(.walkthrough(walkthrough))
            return out
        }
        let after = blocks.firstIndex { (blockTime($0) ?? .distantPast) > published }
        out.insert(.walkthrough(walkthrough), at: after ?? blocks.count)
        return out
    }

    /// Whether this block contains the `publish_walkthrough` tool call, under
    /// whatever name the engine gave it (`opensession-walkthrough_publish…`,
    /// `mcp__…__publish_walkthrough`).
    private static func publishesWalkthrough(_ block: TranscriptBlock) -> Bool {
        func isPublish(_ item: ToolCallItem) -> Bool {
            let name = item.use?.toolName ?? item.presentation.canonical
            return name.hasSuffix("publish_walkthrough")
        }
        switch block {
        case .tool(let item): return isPublish(item)
        case .work(let turn):
            return turn.items.contains { item in
                if case .tool(let call) = item { return isPublish(call) }
                return false
            }
        default: return false
        }
    }

    private static func blockTime(_ block: TranscriptBlock) -> Date? {
        switch block {
        case .message(let entry): entry.timestampDate
        case .tool(let item): (item.result ?? item.use)?.timestampDate
        case .work(let turn): turn.items.last.flatMap(endTimestamp)
        case .footer(let footer): footer.timestamp
        case .walkthrough(let walkthrough): walkthrough.publishedDate
        case .note(let note): note.date
        // Loops are formed after placement, so this is only for completeness:
        // a loop reads as the time of the last thing inside it.
        case .reviewLoop(let loop): loop.blocks.last.flatMap(blockTime)
        }
    }

    private static func makeTurn(
        items: [TurnItem],
        firstId: String,
        lastId: String,
        tools: [ToolCallItem],
        isLive: Bool
    ) -> WorkTurn {
        var families: [ToolFamily] = []
        for tool in tools where !families.contains(tool.presentation.family) {
            families.append(tool.presentation.family)
        }
        let files = mergeTouchedFiles(tools)
        let stats = files.reduce(into: ToolLineStats()) {
            $0 = $0 + ToolLineStats(additions: $1.additions, deletions: $1.deletions)
        }
        let start = items.first.flatMap(startTimestamp)
        let end = items.last.flatMap(endTimestamp)
        var preview: String?
        if isLive, let last = tools.last {
            let summary = last.presentation.summary
            preview = summary.isEmpty
                ? last.presentation.displayName
                : "\(last.presentation.displayName): \(summary)"
        }
        return WorkTurn(
            id: firstId,
            anchorId: lastId,
            items: items,
            isLive: isLive,
            duration: isLive ? nil : duration(from: start, to: end),
            families: Array(families.prefix(6)),
            toolCount: tools.count,
            failureCount: tools.filter(\.isError).count,
            touchedFiles: files,
            lineStats: stats,
            hasMedia: tools.contains(where: \.hasMedia),
            featuredMedia: featuredMedia(from: tools),
            livePreview: preview,
            hasNarration: items.contains {
                if case .message = $0 { return true }
                return false
            }
        )
    }

    /// Explicitly surfaced media in tool order, with repeated captures to the
    /// same source shown once.
    private static func featuredMedia(from tools: [ToolCallItem]) -> TranscriptMedia {
        var media = TranscriptMedia()
        var seen: Set<String> = []
        for tool in tools {
            for source in tool.featuredMedia.images where seen.insert(source).inserted {
                media.images.append(source)
            }
            for source in tool.featuredMedia.videos where seen.insert(source).inserted {
                media.videos.append(source)
            }
        }
        return media
    }

    /// Same path touched twice keeps its first position and sums its counts.
    private static func mergeTouchedFiles(_ tools: [ToolCallItem]) -> [TouchedFile] {
        var order: [String] = []
        var merged: [String: TouchedFile] = [:]
        for file in tools.flatMap(\.presentation.touchedFiles) {
            if var existing = merged[file.path] {
                existing.additions += file.additions
                existing.deletions += file.deletions
                existing.hunks += file.hunks
                merged[file.path] = existing
            } else {
                order.append(file.path)
                merged[file.path] = file
            }
        }
        return order.compactMap { merged[$0] }
    }

    /// Every scratch file the turn wrote, in write order and once each — a
    /// file rewritten three times is still one file to open.
    private static func writtenAssets(_ tools: [ToolCallItem]) -> [String] {
        var seen: Set<String> = []
        return tools.compactMap(\.assetPath).filter { seen.insert($0).inserted }
    }

    private static func startTimestamp(_ item: TurnItem) -> Date? {
        switch item {
        case .message(let entry): entry.timestampDate
        case .tool(let call): (call.use ?? call.result)?.timestampDate
        }
    }

    private static func endTimestamp(_ item: TurnItem) -> Date? {
        switch item {
        case .message(let entry): entry.timestampDate
        case .tool(let call): (call.result ?? call.use)?.timestampDate
        }
    }

    private static func duration(from start: Date?, to end: Date?) -> TimeInterval? {
        guard let start, let end else { return nil }
        let elapsed = end.timeIntervalSince(start)
        return elapsed >= 1 ? elapsed : nil
    }
}

/// Fold open/closed, held per turn OUTSIDE the view tree.
///
/// A `@State` flag inside a `LazyVStack` row is destroyed the moment the row
/// scrolls out of the realization window, so a fold the reader deliberately
/// opened silently snaps shut when they scroll back. One small observable
/// object per turn keeps the state alive and keeps invalidation scoped: a
/// toggle re-evaluates that fold's body, not every visible fold (which is
/// what a single dictionary on the view model would do).
@Observable
@MainActor
final class TurnFoldState {
    var expanded: Bool
    /// Once the human decides, later default changes stop overriding them.
    private(set) var userToggled = false

    init(expanded: Bool) {
        self.expanded = expanded
    }

    func toggle() {
        userToggled = true
        expanded.toggle()
    }

    /// Re-apply a computed default (preference change, a failure landing in a
    /// live turn) unless the human has taken control of this fold.
    func syncDefault(_ value: Bool) {
        guard !userToggled, expanded != value else { return }
        expanded = value
    }
}

/// Every fold's state for one transcript, keyed by block id.
///
/// Deliberately NOT observable: reading the map must not subscribe a row to
/// every other row's expansion. The individual `TurnFoldState` objects it
/// hands out are observable, so a toggle invalidates exactly one fold.
@MainActor
final class FoldStateStore {
    private var states: [String: TurnFoldState] = [:]

    /// The open/closed state for one work fold, created on first sight with
    /// the preference-derived default and reused forever after.
    func fold(for turn: WorkTurn, preference: TurnActivity) -> TurnFoldState {
        let fallback = turn.defaultExpanded(preference: preference)
        if let existing = states[turn.id] {
            // Only the live tail may re-derive its default afterwards; a
            // settled fold above the reader must never change height on its
            // own (see the transcript's scroll notes in SessionView).
            if turn.isLive { existing.syncDefault(fallback) }
            return existing
        }
        let state = TurnFoldState(expanded: fallback)
        states[turn.id] = state
        return state
    }

    /// Expansion for anything else that folds inside a row — a tool call's
    /// detail, a clamped message's body, a long system notice.
    func expansion(id: String, defaultExpanded: Bool = false) -> TurnFoldState {
        if let existing = states[id] {
            existing.syncDefault(defaultExpanded)
            return existing
        }
        let state = TurnFoldState(expanded: defaultExpanded)
        states[id] = state
        return state
    }
}
