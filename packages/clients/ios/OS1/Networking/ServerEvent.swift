import Foundation

/// Parsed server-to-client WebSocket frames. Frame types the client does not
/// care about yet decode to `.ignored` instead of failing, so protocol
/// additions on the server are harmless.
/// Sendable so large frames can decode off the main actor (see OS1Socket).
enum ServerEvent: Sendable {
    case hello(bootId: String)
    case serverRestarting
    case pong
    case transcriptInit(sessionId: String, entries: [TranscriptEntry], cursor: HistoryCursor)
    case transcriptHistory(sessionId: String, entries: [TranscriptEntry], cursor: HistoryCursor)
    case transcriptAppend(
        sessionId: String, entries: [TranscriptEntry], cursor: HistoryCursor = .empty
    )
    case sessionNote(sessionId: String, note: SessionNote)
    case sessionNoteDeleted(sessionId: String, noteId: String)
    case streamStart(sessionId: String)
    /// `blockId` names the assistant block this text belongs to when the
    /// engine names its blocks; the durable entry that lands it carries the
    /// same id, which is what makes cancelling the live copy exact.
    case streamText(sessionId: String, text: String, blockId: String?)
    case streamEntry(sessionId: String, entry: TranscriptEntry)
    case streamDone(sessionId: String)
    case sessionStatus(
        sessionId: String,
        isRunning: Bool,
        safety: SessionSafetyState? = nil
    )
    /// The create run is still preparing this session's worktree (git fetch,
    /// worktree add, dep install). While not ready the viewer says so instead
    /// of looking like an ordinary idle session with a missing transcript.
    case workspaceStatus(sessionId: String, ready: Bool)
    /// The session's model changed mid-run (a fallback, or a teammate's
    /// switch): apply it now instead of waiting for the next sessions poll.
    case modelChanged(sessionId: String, model: String, by: String?)
    /// Everyone with this session open right now, by display name. One entry
    /// per socket, so the same person can appear twice (two devices).
    case presence(sessionId: String, viewers: [String])
    /// People actively composing in this session, once per person.
    case typing(sessionId: String, users: [String])
    /// Who is looking at what, app-wide — one entry per PERSON (the server
    /// resolves a two-device teammate to their most recent session). Broadcast
    /// to every client on change, and once at the handshake.
    case globalPresence(viewing: [PresenceEntry])
    case queueUpdate(
        sessionId: String,
        queued: [QueueItem],
        steered: [QueueItem],
        pendingDeliveryIds: [String] = []
    )
    case queuedPromptTaken(sessionId: String, queueId: String, item: QueueItem?, message: String?)
    /// Cost and context for the whole conversation, refolded by the server
    /// after each turn (and mid-run, as snapshots arrive).
    case usageUpdate(sessionId: String?, usage: SessionUsage)
    case askQuestion(sessionId: String, question: AskQuestion)
    case askResolved(sessionId: String, questionId: String)
    case mention(user: String, mention: MentionRecord)
    case mentionsCleared(user: String, sessionId: String?)
    case replySuggestions(sessionId: String, suggestions: [ReplySuggestion])
    case slackComposer(sessionId: String, request: SlackComposeRequest?)
    case slackComposerResolved(sessionId: String, receipt: SlackComposeReceipt)
    /// A dynamic workflow snapshot changed. The session view model owns the
    /// run list so an update is not lost when the Agents panel is closed.
    case workflowUpdate(sessionId: String, run: WorkflowRun)
    /// This session published local commits. Its PR surfaces should re-read now.
    case gitPushed(sessionId: String, repo: String?)
    /// A git-host webhook changed PR, review, or check state for this branch.
    /// This frame is app-wide and therefore has no session id.
    case prUpdated(repo: String, branch: String)
    case notice(String)
    case serverError(String)
    // Shell output, for the session's terminal panel. Each frame carries the
    // `termId` its sender chose, so one socket could run several shells; the
    // native app opens exactly one and ignores anything else's frames.
    case terminalReady(termId: String, target: String, cwd: String)
    case terminalData(termId: String, data: Data)
    case terminalNotice(termId: String, message: String)
    case terminalExit(termId: String, code: Int)
    case ignored

    static func parse(_ data: Data) -> ServerEvent {
        guard let frame = try? JSONDecoder().decode(RawFrame.self, from: data) else {
            return .ignored
        }
        switch frame.type {
        case "hello":
            return .hello(bootId: frame.bootId ?? "")
        case "server_restarting":
            return .serverRestarting
        case "pong":
            return .pong
        case "transcript_init":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptInit(
                sessionId: id, entries: frame.entries ?? [], cursor: frame.cursor
            )
        case "transcript_history":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptHistory(
                sessionId: id, entries: frame.entries ?? [], cursor: frame.cursor
            )
        case "transcript_append":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptAppend(
                sessionId: id, entries: frame.entries ?? [], cursor: frame.cursor
            )
        case "session_note":
            guard let id = frame.sessionId, let note = frame.note else { return .ignored }
            return .sessionNote(sessionId: id, note: note)
        case "session_note_deleted":
            guard let id = frame.sessionId, let noteId = frame.noteId else { return .ignored }
            return .sessionNoteDeleted(sessionId: id, noteId: noteId)
        case "stream_start":
            guard let id = frame.sessionId else { return .ignored }
            return .streamStart(sessionId: id)
        case "stream_text":
            guard let id = frame.sessionId, let text = frame.text else { return .ignored }
            return .streamText(sessionId: id, text: text, blockId: frame.blockId)
        case "stream_tool_use", "stream_tool_result":
            guard let id = frame.sessionId, let entry = frame.entry else { return .ignored }
            return .streamEntry(sessionId: id, entry: entry)
        case "stream_done":
            guard let id = frame.sessionId else { return .ignored }
            return .streamDone(sessionId: id)
        case "session_status":
            guard let id = frame.sessionId else { return .ignored }
            return .sessionStatus(
                sessionId: id,
                isRunning: frame.isRunning ?? false,
                safety: frame.safety
            )
        case "workspace_status":
            guard let id = frame.sessionId else { return .ignored }
            return .workspaceStatus(sessionId: id, ready: frame.ready ?? true)
        case "model_changed":
            guard let id = frame.sessionId, let model = frame.model else { return .ignored }
            return .modelChanged(sessionId: id, model: model, by: frame.by)
        case "presence":
            guard let id = frame.sessionId else { return .ignored }
            return .presence(sessionId: id, viewers: frame.viewers ?? [])
        case "typing":
            guard let id = frame.sessionId else { return .ignored }
            return .typing(sessionId: id, users: frame.users ?? [])
        case "global_presence":
            return .globalPresence(viewing: (frame.viewing ?? []).compactMap {
                guard let user = $0.user, let sessionId = $0.sessionId else { return nil }
                return PresenceEntry(user: user, sessionId: sessionId)
            })
        case "queue_update":
            guard let id = frame.sessionId else { return .ignored }
            return .queueUpdate(
                sessionId: id,
                queued: (frame.queued ?? []).map(QueueItem.init),
                steered: (frame.steered ?? []).map(QueueItem.init),
                pendingDeliveryIds: frame.pendingDeliveryIds ?? []
            )
        case "queued_prompt_taken":
            guard let id = frame.sessionId, let queueId = frame.queueId else { return .ignored }
            return .queuedPromptTaken(
                sessionId: id, queueId: queueId,
                item: frame.item.map(QueueItem.init), message: frame.message
            )
        case "usage_update":
            // `sessionId` is absent on the frame the create flow emits — that
            // socket is already scoped to the session being created — so the
            // usage is what has to be there, not the id.
            guard let usage = frame.usage else { return .ignored }
            return .usageUpdate(sessionId: frame.sessionId, usage: usage)
        case "ask_question":
            guard let id = frame.sessionId,
                  let questionId = frame.questionId,
                  let questions = frame.questions
            else { return .ignored }
            return .askQuestion(
                sessionId: id,
                question: AskQuestion(id: questionId, questions: questions)
            )
        case "ask_resolved":
            guard let id = frame.sessionId, let questionId = frame.questionId else {
                return .ignored
            }
            return .askResolved(sessionId: id, questionId: questionId)
        case "mention":
            guard let user = frame.user, let mention = frame.mention else { return .ignored }
            return .mention(user: user, mention: mention)
        case "mentions_cleared":
            guard let user = frame.user else { return .ignored }
            return .mentionsCleared(user: user, sessionId: frame.sessionId)
        case "reply_suggestions":
            guard let id = frame.sessionId else { return .ignored }
            // The server sends null to retire the row. Treat it as an empty
            // collection so state handling has one clear path.
            return .replySuggestions(sessionId: id, suggestions: frame.suggestions ?? [])
        case "slack_composer":
            guard let id = frame.sessionId else { return .ignored }
            return .slackComposer(sessionId: id, request: frame.request)
        case "slack_composer_resolved":
            guard let id = frame.sessionId,
                  let requestId = frame.requestId,
                  let status = frame.status.flatMap(SlackComposeReceipt.Status.init(rawValue:))
            else { return .ignored }
            let channel: SlackComposeReceipt.Channel?
            if let wire = frame.channel, let id = wire.id, let name = wire.name {
                channel = SlackComposeReceipt.Channel(id: id, name: name)
            } else {
                channel = nil
            }
            return .slackComposerResolved(
                sessionId: id,
                receipt: SlackComposeReceipt(
                    requestId: requestId,
                    status: status,
                    channel: channel,
                    permalink: frame.permalink,
                    ts: frame.ts
                )
            )
        case "workflow_update":
            guard let id = frame.sessionId, let run = frame.run else { return .ignored }
            return .workflowUpdate(sessionId: id, run: run)
        case "git_pushed":
            guard let id = frame.sessionId else { return .ignored }
            return .gitPushed(sessionId: id, repo: frame.repo)
        case "pr_updated":
            guard let repo = frame.repo, let branch = frame.branch else { return .ignored }
            return .prUpdated(repo: repo, branch: branch)
        case "notice":
            return .notice(frame.message ?? "")
        case "error":
            return .serverError(frame.message ?? "Unknown server error")
        case "term_ready":
            return .terminalReady(
                termId: frame.termId ?? "0",
                target: frame.target ?? "host",
                cwd: frame.cwd ?? ""
            )
        case "term_data":
            // Base64 on the wire: PTY output is bytes, not text, and a chunk
            // can split a multi-byte character. Decoding to a String is the
            // reader's job, which is where the partial tail is held.
            guard let data = Data(base64Encoded: frame.data ?? "") else { return .ignored }
            return .terminalData(termId: frame.termId ?? "0", data: data)
        case "term_notice":
            return .terminalNotice(termId: frame.termId ?? "0", message: frame.message ?? "")
        case "term_exit":
            return .terminalExit(termId: frame.termId ?? "0", code: frame.code ?? 0)
        default:
            return .ignored
        }
    }
}

/// One person and the session they are looking at, from `global_presence`.
struct PresenceEntry: Equatable, Hashable, Sendable {
    let user: String
    let sessionId: String
}

struct SlackComposeRequest: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let message: String
    let channel: String?
    let images: [String]
}

struct SlackComposeReceipt: Equatable, Sendable, Identifiable {
    enum Status: String, Equatable, Sendable {
        case sent
        case cancelled
    }

    struct Channel: Equatable, Sendable {
        let id: String
        let name: String
    }

    let requestId: String
    let status: Status
    let channel: Channel?
    let permalink: String?
    /// Slack's message timestamp. Older servers omit it, so Undo stays unavailable.
    let ts: String?

    init(
        requestId: String,
        status: Status,
        channel: Channel?,
        permalink: String?,
        ts: String? = nil
    ) {
        self.requestId = requestId
        self.status = status
        self.channel = channel
        self.permalink = permalink
        self.ts = ts
    }

    var id: String { requestId }
}

/// One server-generated quick reply. The short label is the chip; the full
/// text is what a tap puts in the composer for review.
struct ReplySuggestion: Decodable, Equatable, Sendable {
    let label: String
    let text: String
}

/// Pagination cursor carried by transcript_init / transcript_history frames.
/// `truncated` means older history exists; paging back sends `load_history`
/// with `beforeOffset` + `beforeRev` (byte cursor into the mirror file) or
/// `beforeSeq` when the server serves the seq-mode transcript store.
struct HistoryCursor: Equatable, Sendable {
    var truncated: Bool
    var startOffset: Int?
    var rev: String?
    var firstSeq: Int?
    /// Reconnect resume metadata. Seq-mode uses the two sequence watermarks;
    /// legacy mode uses the end byte plus `rev`.
    var endOffset: Int?
    var lastSeq: Int?
    var lastChangeSeq: Int?
    var v2: Bool

    init(
        truncated: Bool,
        startOffset: Int? = nil,
        rev: String? = nil,
        firstSeq: Int? = nil,
        endOffset: Int? = nil,
        lastSeq: Int? = nil,
        lastChangeSeq: Int? = nil,
        v2: Bool = false
    ) {
        self.truncated = truncated
        self.startOffset = startOffset
        self.rev = rev
        self.firstSeq = firstSeq
        self.endOffset = endOffset
        self.lastSeq = lastSeq
        self.lastChangeSeq = lastChangeSeq
        self.v2 = v2
    }

    /// No paging or resume metadata (short transcripts, tests).
    static let empty = HistoryCursor(truncated: false)
}

/// The latest durable transcript position, sent back on a re-watch so the
/// server replays only the disconnected gap instead of replacing the loaded
/// conversation with a fresh tail snapshot.
enum TranscriptResumeCursor: Equatable, Sendable {
    case seq(lastSeq: Int, lastChangeSeq: Int)
    case offset(endOffset: Int, rev: String)
}

/// One message waiting on a busy run — either queued (held until the run
/// finishes) or steered (delivering at the next turn boundary).
struct QueueItem: Identifiable, Equatable, Sendable {
    let id: String
    let content: String
    let user: String?
    /// Images the message carries, as `data:` URLs — the chip shows the first
    /// as a thumbnail so a queued screenshot is recognisable.
    let images: [String]
    /// Whether file attachments ride along. The server can't fold a
    /// file-carrying message into a live run, so the chip hides Steer.
    let hasFiles: Bool
    let editable: Bool
    let hasContextSessions: Bool
    /// When the engine accepted this message as a steer (receipts only,
    /// epoch-ms on the wire). Acceptance is not delivery: the run reads its
    /// steering queue when the current step's tool calls finish, so the
    /// steering row counts the wait from here.
    let steeredAt: Date?

    /// Chips minted locally (the optimistic echo of a busy send) carry an id
    /// the server has never seen, so the actions that address a queue entry
    /// by id — edit, reorder — have to wait for the real `queue_update`.
    var isLocalEcho: Bool { id.hasPrefix("local-") }

    fileprivate init(_ wire: RawFrame.WireQueueItem) {
        id = wire.id ?? UUID().uuidString
        content = wire.content ?? ""
        user = wire.user
        images = wire.images ?? []
        hasFiles = !(wire.files ?? []).isEmpty
        editable = wire.editable ?? false
        hasContextSessions = !(wire.contextSessions ?? []).isEmpty
        steeredAt = wire.steeredAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// Local optimistic construction — the composer's echo of a send made
    /// while a run is busy, shown as a queue chip until the server's own
    /// queue_update replaces it.
    init(
        id: String,
        content: String,
        user: String?,
        images: [String] = [],
        hasFiles: Bool = false,
        editable: Bool = true,
        hasContextSessions: Bool = false,
        steeredAt: Date? = nil
    ) {
        self.id = id
        self.content = content
        self.user = user
        self.images = images
        self.hasFiles = hasFiles
        self.editable = editable
        self.hasContextSessions = hasContextSessions
        self.steeredAt = steeredAt
    }

    /// The same entry with new text — and, when the edit touched them, new
    /// attachments — for the optimistic half of an edit. `images: nil` keeps
    /// the ones it already carries, matching what the server does with an
    /// update that names no images.
    func withContent(_ content: String, images: [String]? = nil) -> QueueItem {
        QueueItem(
            id: id,
            content: content,
            user: user,
            images: images ?? self.images,
            hasFiles: hasFiles,
            editable: editable,
            hasContextSessions: hasContextSessions,
            steeredAt: steeredAt
        )
    }
}

/// Superset of every server frame's fields; individual events pick what they need.
private struct RawFrame: Decodable {
    struct WireQueueItem: Decodable {
        /// The `files` payload's shape varies by client (staged-path refs,
        /// inline blobs) and all the chip needs is whether there are any —
        /// so each element is consumed without being interpreted.
        struct OpaqueFile: Decodable {
            init(from decoder: Decoder) throws {}
        }

        let id: String?
        let content: String?
        let user: String?
        let images: [String]?
        let files: [OpaqueFile]?
        let editable: Bool?
        let contextSessions: [String]?
        let steeredAt: Double?
    }

    struct WireSlackChannel: Decodable {
        let id: String?
        let name: String?
    }

    let type: String
    let sessionId: String?
    let bootId: String?
    let entries: [TranscriptEntry]?
    let entry: TranscriptEntry?
    let note: SessionNote?
    let noteId: String?
    let text: String?
    let blockId: String?
    struct WireViewing: Decodable {
        let user: String?
        let sessionId: String?
    }

    let isRunning: Bool?
    let safety: SessionSafetyState?
    let ready: Bool?
    let model: String?
    let by: String?
    let viewers: [String]?
    let users: [String]?
    let viewing: [WireViewing]?
    let queued: [WireQueueItem]?
    let steered: [WireQueueItem]?
    let pendingDeliveryIds: [String]?
    let item: WireQueueItem?
    let usage: SessionUsage?
    let questionId: String?
    let questions: [AskQuestion.Question]?
    let user: String?
    let mention: MentionRecord?
    let suggestions: [ReplySuggestion]?
    let request: SlackComposeRequest?
    let requestId: String?
    let status: String?
    let channel: WireSlackChannel?
    let permalink: String?
    let ts: String?
    let run: WorkflowRun?
    let repo: String?
    let branch: String?
    let message: String?
    let queueId: String?
    let truncated: Bool?
    let startOffset: Int?
    let endOffset: Int?
    let rev: String?
    let firstSeq: Int?
    let lastSeq: Int?
    let lastChangeSeq: Int?
    let v2: Bool?
    // term_* frames.
    let termId: String?
    let target: String?
    let cwd: String?
    let data: String?
    let code: Int?

    var cursor: HistoryCursor {
        HistoryCursor(
            truncated: truncated ?? false,
            startOffset: startOffset,
            rev: rev,
            firstSeq: firstSeq,
            endOffset: endOffset,
            lastSeq: lastSeq,
            lastChangeSeq: lastChangeSeq,
            v2: v2 ?? false
        )
    }
}
