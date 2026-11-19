import Foundation

/// One agent-reported status line: `◷ **CI**: Running` or
/// `✓ **CI**: All checks passed`. Mirrors the web's `progress-updates.ts`.
///
/// It is opt-in, ordinary Markdown, so any client that does not know the
/// shape still shows a readable message. Nothing is inferred from arbitrary
/// prose, and a turn ending is never read as success.
struct ProgressUpdate: Equatable, Sendable {
    enum State: Equatable, Sendable { case running, done }

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
        let text = String(match.output.3).trimmingCharacters(in: .whitespaces)
        guard !topic.isEmpty, !text.isEmpty, !text.contains("?") else { return nil }
        self.topic = topic
        self.state = match.output.1 == "✓" ? .done : .running
        self.text = text
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
    var symbol: String {
        switch state {
        case .running: "clock"
        case .done: "checkmark"
        }
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
