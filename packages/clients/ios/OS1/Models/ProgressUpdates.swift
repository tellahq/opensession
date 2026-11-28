import Foundation

/// One agent-reported status line: `◷ **CI**: Running` or
/// `✓ **CI**: All checks passed`. Mirrors the web's `progress-updates.ts`.
///
/// It is opt-in, ordinary Markdown, so any client that does not know the
/// shape still shows a readable message. Nothing is inferred from arbitrary
/// prose, and a turn ending is never read as success.
struct ProgressUpdate: Equatable, Sendable {
    enum State: Equatable, Sendable { case running, done }

    /// A reply that opens with a status line and goes on in prose ("◷
    /// **Native build**: Running", a blank line, then why): the status, and
    /// the prose after it. The reply then shows only its prose. Mirrors the
    /// web's `splitLeadStatus`.
    static func lead(of entry: TranscriptEntry) -> (update: ProgressUpdate, rest: String)? {
        guard entry.isAssistant, entry.isReasoning != true, entry.isError != true else { return nil }
        let text = entry.text.drop { $0.isWhitespace }
        guard text.hasPrefix("✓ **") || text.hasPrefix("◷ **") else { return nil }
        // The status, a blank line, then prose.
        let lines = text.split(maxSplits: 2, omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        guard lines.count == 3,
              lines[1].allSatisfy(\.isWhitespace) else { return nil }
        let prose = lines[2].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prose.isEmpty else { return nil }
        var line = entry
        line.content = String(lines[0])
        line.contentLength = nil
        line.contentClamped = nil
        line.pastedTexts = nil
        line.images = nil
        line.videos = nil
        line.files = nil
        guard let update = ProgressUpdate(line) else { return nil }
        return (update, prose)
    }

    var topic: String
    var state: State
    var text: String

    /// The whole message has to be exactly one status line. Attachments,
    /// errors, reasoning, clamped bodies, extra lines and questions stay
    /// ordinary messages, so a blocker can never hide inside a compact row.
    init?(_ entry: TranscriptEntry) {
        guard entry.isAssistant,
              entry.isReasoning != true,
              entry.isError != true,
              entry.contentClamped != true,
              entry.notice == nil,
              entry.pastedTexts?.isEmpty ?? true,
              entry.images?.isEmpty ?? true,
              entry.videos?.isEmpty ?? true,
              Self.isEmpty(entry.files),
              (entry.contentLength ?? 0) <= entry.text.utf16.count
        else { return nil }
        // Generous bound before any trimming: a status line is short, and a
        // long answer must not be copied on every transcript rebuild.
        guard entry.text.utf8.count <= 1_024 else { return nil }
        let line = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Cheap checks first: most assistant messages fail here. A Swift
        // `Character` can be "\r\n", so newlines are rejected outright
        // rather than trusted to the character classes below.
        guard line.hasPrefix("✓ **") || line.hasPrefix("◷ **"),
              !line.contains(where: \.isNewline),
              let match = line.wholeMatch(
                  of: #/(✓|◷) \*\*([^*]{1,48})\*\*: (.{1,200})/#
              )
        else { return nil }
        let topic = String(match.output.2).trimmingCharacters(in: .whitespaces)
        let raw = String(match.output.3)
        guard !topic.isEmpty,
              !raw.trimmingCharacters(in: .whitespaces).isEmpty,
              !raw.contains("?") else { return nil }
        let text = Self.plainText(raw)
        guard !text.isEmpty else { return nil }
        self.topic = topic
        self.state = match.output.1 == "✓" ? .done : .running
        self.text = text
    }

    /// A status row is one quiet line of plain text, so the Markdown an agent
    /// writes in it (links, bold, code) shows as its words: `[#11046](…)`
    /// reads "#11046", a bare GitHub PR or issue URL "app#11046", and other
    /// bare URLs stay. An empty result means the line is not a status.
    /// Mirrors the web's `plainStatusText`.
    static func plainText(_ text: String) -> String {
        text
            .replacing(#/\[([^\]\r\n]*)\]\(<?([^)\s>]+)>?\)/#) { match in
                linkLabel(
                    String(match.output.1).trimmingCharacters(in: .whitespacesAndNewlines),
                    String(match.output.2)
                )
            }
            .replacing(#/<(https?://[^>\s]+)>/#) { match in
                linkLabel("", String(match.output.1))
            }
            .replacing(#/(^|[\s(])(https?://\S+)/#) { match in
                let url = String(match.output.2)
                return githubRef(url) == nil
                    ? String(match.output.0)
                    : match.output.1 + linkLabel("", url)
            }
            .replacing(#/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/#) { match in
                match.output.1 ?? match.output.2 ?? match.output.3 ?? ""
            }
            .replacing(#/\s+/#, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "repo#123" for a GitHub PR or issue URL (web `GITHUB_REF`).
    private static func githubRef(_ url: String) -> String? {
        guard let match = url.wholeMatch(
            of: #/https?://(?:www\.)?github\.com/[^/\s]+/([^/\s]+)/(?:pull|issues)/(\d+)(?:[/?#]\S*)?/#
                .ignoresCase()
        ) else { return nil }
        return "\(match.output.1)#\(match.output.2)"
    }

    /// A link's own label, else the URL, read as "repo#123" when it is a
    /// GitHub PR or issue (web `linkLabel`).
    private static func linkLabel(_ label: String, _ url: String) -> String {
        if !label.isEmpty, label != url { return label }
        return githubRef(url) ?? url
    }

    private static func isEmpty(_ files: JSONValue?) -> Bool {
        switch files {
        case nil, .null: true
        case .array(let items): items.isEmpty
        default: false
        }
    }

    init(topic: String, state: State, text: String) {
        self.topic = topic
        self.state = state
        self.text = text
    }

    var label: String { "\(topic): \(text)" }

    /// SF Symbol for this state. A clock for in progress, a check for
    /// confirmed success. There is no failure glyph on purpose: failures are
    /// normal replies.
    var symbol: String { Self.symbol(topic: topic, isDone: state == .done) }

    /// A CI or test status takes a check run's own marks instead, as GitHub
    /// draws them: a dashed ring while it runs, a circled check once it
    /// passes, so it reads as CI at a glance rather than as one more timer.
    /// Mirrors the web's `StatusIcon`.
    static func symbol(topic: String, isDone: Bool) -> String {
        if isCheckTopic(topic) { return isDone ? "checkmark.circle" : "circle.dashed" }
        return isDone ? "checkmark" : "clock"
    }

    /// CI, checks, tests and builds (web `isCheckTopic`).
    static func isCheckTopic(_ topic: String) -> Bool {
        topic.firstMatch(
            of: #/\b(ci|checks?|tests?|builds?|lint|typecheck|e2e)\b/#.ignoresCase()
        ) != nil
    }
}

/// What a status line inside a work fold says. A fold reads after the fact,
/// so "CI: Running" from ten minutes ago says the wrong thing: each wait
/// becomes one step where it started, "CI passed · 4m" once a later `✓` of
/// the same topic says how it went, "Waited for CI · 4m" when nothing did,
/// "Waiting for CI" while the fold is live and no later status has moved on
/// from it. Agent wording beyond a bare
/// state word is kept. Mirrors the web's `foldStatuses`.
struct FoldStatus: Equatable, Sendable {
    /// Picks the glyph (`ProgressUpdate.symbol(topic:isDone:)`).
    var topic: String
    var text: String
    var isDone: Bool

    enum Step: Equatable, Sendable {
        case shown(FoldStatus)
        /// A later update of a topic an earlier step already stands for.
        case folded
    }

    /// One slot per fold step, nil where the step is not a status.
    /// `startedAt` is only read around a status.
    static func resolve(
        _ updates: [ProgressUpdate?],
        startedAt: (Int) -> Date?,
        isLive: Bool
    ) -> [Step?] {
        var out = [Step?](repeating: nil, count: updates.count)
        for i in updates.indices {
            guard let first = updates[i], out[i] == nil else { continue }
            let key = first.topic.lowercased()
            var last = i
            var close: Int? = first.state == .done ? i : nil
            var j = i + 1
            while close == nil, j < updates.count {
                if let update = updates[j], update.topic.lowercased() == key {
                    out[j] = .folded
                    last = j
                    if update.state == .done { close = j }
                }
                j += 1
            }
            if let close, let closing = updates[close] {
                out[i] = .shown(FoldStatus(
                    topic: first.topic,
                    text: outcome(closing) + (close > i ? took(startedAt(i), startedAt(close)) : ""),
                    isDone: true
                ))
                continue
            }
            guard let latest = updates[last] else { continue }
            let bare = isBareRunning(latest.text)
            let isCurrent = isLive && !updates[(last + 1)...].contains { $0 != nil }
            let words = bare
                ? "\(isCurrent ? "Waiting" : "Waited") for \(noun(first.topic))"
                : latest.label
            let hasNext = !isCurrent && last + 1 < updates.count
            out[i] = .shown(FoldStatus(
                topic: first.topic,
                text: words + (hasNext ? took(startedAt(i), startedAt(last + 1)) : ""),
                isDone: false
            ))
        }
        return out
    }

    private static func took(_ start: Date?, _ stop: Date?) -> String {
        guard let start, let stop,
              let label = TranscriptFormat.duration(stop.timeIntervalSince(start))
        else { return "" }
        return " · \(label)"
    }

    private static func isBareRunning(_ text: String) -> Bool {
        text.wholeMatch(
            of: #/(running|in progress|pending|queued|started|starting|waiting|building|deploying|underway)(\.{0,3}|…)/#.ignoresCase()
        ) != nil
    }

    private static func outcome(_ update: ProgressUpdate) -> String {
        let bare = update.text.wholeMatch(
            of: #/(done|passed|green|complete|completed|finished|succeeded|success|successful|ok|(all )?(checks|tests) (passed|green))\.?/#.ignoresCase()
        ) != nil
        guard bare else { return update.label }
        let checks = ProgressUpdate.isCheckTopic(update.topic)
        return "\(update.topic) \(checks ? "passed" : "done")"
    }

    /// "Deployment" reads as a noun mid-sentence; "CI" and "PR #12" keep case.
    private static func noun(_ topic: String) -> String {
        let letters = Array(topic.prefix(2))
        guard letters.count == 2, letters[0].isUppercase, letters[1].isLowercase else { return topic }
        return letters[0].lowercased() + topic.dropFirst()
    }
}

/// One status row: a task's newest update, and every update the row stands
/// for, oldest first, whatever their topics. The last entry is the one shown.
struct ProgressGroup: Equatable, Sendable {
    var latest: ProgressUpdate
    var entries: [TranscriptEntry]

    /// The owning row's id: the latest update, so the row sits with the
    /// newest work rather than above the check-backs that followed it.
    var id: String { entries.last?.id ?? "" }

    /// Earlier updates, oldest first, for the row's expandable history.
    var history: [(id: String, update: ProgressUpdate)] {
        entries.dropLast().compactMap { entry in
            ProgressUpdate(entry).map { (entry.id, $0) }
        }
    }
}

/// Which entries are status updates, and which of them owns a row.
///
/// `owners` maps each task's latest update to its group; `hidden` is every
/// earlier update in that task, whose row the owner replaced. The stored
/// transcript is untouched: this only decides how rows draw.
struct ProgressProjection: Equatable, Sendable {
    var owners: [String: ProgressGroup] = [:]
    var hidden: Set<String> = []

    var isEmpty: Bool { owners.isEmpty }

    func contains(_ entryId: String) -> Bool {
        owners[entryId] != nil || hidden.contains(entryId)
    }

    static func isAgentMessage(_ entry: TranscriptEntry) -> Bool {
        entry.notice?.kind == "worker-report" || entry.notice?.kind == "session-notice"
    }

    /// Mirrors the web's `collectProgressUpdates`. Every update in one task
    /// shares a row, whatever its topic, so "CI: Running" then "Deployment:
    /// Running" reads as one row that moved on. A human message (or a review
    /// handoff) and a team note start a new scope, so two different tasks
    /// never share one row. Only a turn's final output may join: an update
    /// followed by more work is narration and stays in the work fold.
    ///
    /// The web also walks the server's transcript outline so an unloaded
    /// human message still splits a group. This app has no outline: it holds
    /// one contiguous tail of the transcript (history pages prepend, the
    /// Desk cutoff trims the head), so any human message between two loaded
    /// updates is itself loaded. Updates before the loaded window simply
    /// start their own row once paged in.
    static func collect(
        from items: [SessionViewModel.DisplayItem],
        noteDates: [Date] = []
    ) -> ProgressProjection {
        var updates: [String: ProgressUpdate] = [:]
        for item in items {
            if case .entry(let entry) = item, let update = ProgressUpdate(entry) {
                updates[entry.id] = update
            }
        }
        // Most transcripts carry no opt-in statuses; skip the rest.
        guard !updates.isEmpty else { return ProgressProjection() }

        var finals: Set<String> = []
        var nextIsWork = false
        for item in items.reversed() {
            switch item {
            case .toolCall:
                nextIsWork = true
            case .entry(let entry):
                if entry.isTool { continue }
                if entry.isAssistant, !nextIsWork { finals.insert(entry.id) }
                // A worker's report or another session's message is agent
                // traffic, like the web's `agentMessageText`: a status before
                // one is narration, never an invisible row owner.
                nextIsWork = entry.isAssistant || Self.isAgentMessage(entry)
            }
        }

        var groups: [ProgressGroup] = []
        var active: Int?
        let notes = noteDates.sorted()
        var note = 0
        for item in items {
            guard case .entry(let entry) = item else { continue }
            if let date = entry.timestampDate {
                while note < notes.count, notes[note] <= date {
                    active = nil
                    note += 1
                }
            }
            if entry.isUser, entry.turnBoundary != true,
               entry.notice == nil || entry.notice?.kind == "review-handoff" {
                active = nil
            } else if entry.isUser, entry.turnBoundary != true, entry.notice?.triggerTitle != nil {
                // An automated event (a GitHub notice, a worker's report) is
                // a task of its own, so its status starts a fresh row.
                active = nil
            }
            guard finals.contains(entry.id), let update = updates[entry.id] else { continue }
            if let index = active {
                groups[index].latest = update
                groups[index].entries.append(entry)
            } else {
                active = groups.count
                groups.append(ProgressGroup(latest: update, entries: [entry]))
            }
        }
        var projection = ProgressProjection()
        for group in groups {
            projection.owners[group.id] = group
            for entry in group.entries.dropLast() { projection.hidden.insert(entry.id) }
        }
        return projection
    }
}
