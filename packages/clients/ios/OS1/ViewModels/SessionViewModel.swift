import Foundation
import Observation

/// One open session: owns the WebSocket, holds the transcript, live stream
/// text, run state, and any pending question.
@Observable
@MainActor
final class SessionViewModel {
    static let continueAfterFailurePrompt =
        "Continue where you left off and finish the task. If the work was already done, post the final summary."

    enum ConnectionState: Equatable {
        case connecting
        case connected
        case reconnecting(String?)
        case failed(String)
    }

    private(set) var session: Session
    /// A fenced operation always wins over stale running projections from an
    /// older list poll or socket frame.
    var safety: SessionSafetyState? { session.safety }

    private(set) var entries: [TranscriptEntry] = []
    private(set) var sessionNotes: [SessionNote] = []
    /// The note list can answer after a live delete. Remember removals so that
    /// stale response cannot put a deleted note back into the transcript.
    private var deletedSessionNoteIds: Set<String> = []
    /// Ephemeral entries from the live engine stream (tool calls mid-run).
    /// They render at the end in stream order and graduate into `entries`
    /// when the file watcher lands them via transcript_append — the
    /// transcript FILE is the order authority. (Appending stream entries to
    /// `entries` directly put tool calls ahead of the assistant text that
    /// precedes them in the file, because that text lands ~1s later.)
    private(set) var liveEntries: [TranscriptEntry] = []
    private(set) var liveText = ""
    /// A run finishing settles the trailing turn — "Working" becomes
    /// "Worked", its duration resolves and its footer appears — so the block
    /// list has to be rebuilt on the flip, not just on entry mutations.
    private(set) var isStreaming = false {
        didSet { if oldValue != isStreaming { rebuildDisplayItems() } }
    }
    private(set) var isRunning: Bool {
        didSet { if oldValue != isRunning { rebuildDisplayItems() } }
    }
    /// Anchor for the elapsed-run clock. Opening a session mid-run uses the
    /// server's journaled run start (from the sessions list row); a run that
    /// starts while watching anchors to the status flip.
    private(set) var runStartedAt: Date?
    /// Before the watch answers, the sessions row is the only queue summary
    /// available. Once detailed queue state arrives, derive the count from its
    /// items so a stale list snapshot cannot contradict the visible queue.
    private var hasDetailedQueue = false
    #if DEBUG
    /// Keeps a screenshot fixture from being cleared by the live watch's
    /// ordinary status snapshot after the launch hook installs it.
    private var holdsSafetyScreenshot = false
    private var holdsScreenshotFixture = false
    #endif
    var queuedCount: Int {
        hasDetailedQueue ? queuedItems.count : session.queuedCount ?? 0
    }

    /// The session-row fallback for a terminal failure that did not make it
    /// into the transcript. A live retry and a safety pause each have their
    /// own, more specific state, and a durable system entry wins over this
    /// fallback so the same failure is never shown twice.
    var inlineRunFailureMessage: String? {
        guard !isRunning,
              safety == nil,
              let message = session.lastRunError?.message?.nilIfBlank,
              !entries.contains(where: {
                  $0.type == "system" && $0.text.contains(message)
              })
        else { return nil }
        return message
    }
    /// What this conversation has cost and how full its context window is.
    /// Seeded from the session row and then kept live by `usage_update`,
    /// which the server broadcasts mid-run as well as at the end of a turn.
    private(set) var usage: SessionUsage?
    /// Messages held for after the current run (editable, steerable).
    private(set) var queuedItems: [QueueItem] = []
    /// Legacy steer receipts from older servers. Current servers put an
    /// accepted steer directly in the transcript and name it below instead.
    private(set) var steeredItems: [QueueItem] = []
    /// Transcript entry ids accepted as sent but not yet acknowledged at an
    /// engine delivery boundary. They never render as composer queue chips.
    private(set) var pendingDeliveryIds: Set<String> = []

    /// The create run is still preparing this session's worktree. Seeded
    /// from the sessions row and overridden by the live workspace_status
    /// frame, so the state flips the moment the worktree is ready instead
    /// of on the next poll.
    private var workspaceReadyOverride: Bool?
    var workspacePreparing: Bool {
        workspaceReadyOverride.map { !$0 } ?? (session.workspacePreparing == true)
    }
    /// Chips the server's queue no longer lists but whose message hasn't
    /// landed in the transcript yet. The queue drain broadcasts the emptied
    /// queue BEFORE the delivered prompt reaches the transcript (the ~1s
    /// file watcher echoes it seconds later) — dropping the chip on that
    /// queue_update blinks the message out of the UI until the echo
    /// arrives. Held here (rendered as "Delivering…") until the durable
    /// user entry retires them; `pruneExpiredDelivering` drops ghosts whose
    /// echo never comes (e.g. deleted from another device).
    private(set) var deliveringItems: [QueueItem] = []
    /// Everyone ELSE with this session open right now, from the server's
    /// `presence` frames — the header facepile. Ours is filtered out (the web
    /// pile shows you rightmost; a navigation bar has no room for a face you
    /// already know is there), and a person watching from two devices appears
    /// once, since presence carries one name per socket.
    private(set) var otherViewers: [String] = []
    private(set) var otherTypingUsers: [String] = []
    private(set) var pendingQuestion: AskQuestion?
    /// The answer this device just sent, shown until its transcript record arrives.
    private(set) var sentAskAnswer: SentAskAnswer?
    /// Quick replies for the last settled turn. A pick fills the draft; it
    /// never sends, because the server's suggestion is still only a guess.
    private(set) var replySuggestions: [ReplySuggestion] = []
    private(set) var pendingSlackComposer: SlackComposeRequest?
    private(set) var slackComposeReceipt: SlackComposeReceipt?
    /// The request id currently being removed from Slack. Keeping the receipt
    /// visible while this is set makes a failed Undo recoverable.
    private(set) var undoingSlackComposeReceiptId: String?
    private(set) var connectionState: ConnectionState = .connecting
    private(set) var isLoadingConversation = true
    /// A watch that never receives transcript_init is not a loading state
    /// forever. The reader gets an explicit retry while reconnects continue.
    private(set) var conversationLoadError: String?
    private(set) var notice: String?
    var draft = ""
    /// Images staged in the composer, sent (as data URLs) with the next prompt.
    var attachedImages: [AttachedImage] = []
    /// Transcript text attached to the next message. The controller also owns
    /// the retained TextKit highlight after the composer takes focus.
    let quoteSelection = TranscriptQuoteSelection()
    /// Bumped on every send so the view can scroll to the bottom: the
    /// scroll view's bottom size-change anchor doesn't re-pin once the
    /// reader has scrolled (or the keyboard resized the viewport), leaving
    /// a just-sent message below the fold.
    private(set) var sendSeq = 0
    /// Bumped when a draft starts (empty -> typed), so the view can bring the
    /// end of the conversation into sight: writing a reply from halfway up the
    /// transcript otherwise types into a view of old output. It is a counter
    /// rather than the draft itself because `draft` changes on every keystroke,
    /// and SessionView's body must not depend on that (see the observation
    /// note in packages/clients/ios/AGENTS.md).
    private(set) var composeSeq = 0

    /// Called by the composer on the first character of a new draft.
    func draftStarted() { composeSeq += 1 }

    #if DEBUG
    /// Deterministic states for the native screenshot harness. These are
    /// launch-env-only hooks in debug builds, never protocol mutations.
    func showSafetyPauseForScreenshot() {
        holdsSafetyScreenshot = true
        holdsScreenshotFixture = true
        session.safety = SessionSafetyState(
            status: "paused_for_safety",
            explanation: "This session was paused because the last action could not be confirmed safely.",
            automaticReconciliationRunning: false,
            pausedAt: ISO8601DateFormatter().string(from: .now),
            operation: nil,
            repairAvailable: true
        )
        isRunning = false
        runStartedAt = nil
        isLoadingConversation = false
    }

    func showSteeredMessageForScreenshot() {
        holdsScreenshotFixture = true
        let id = "screenshot-steered-message"
        upsert([TranscriptEntry(
            id: id,
            type: "user",
            content: "Please include the native paused-state handling too.",
            timestamp: ISO8601DateFormatter().string(from: .now)
        )])
        pendingDeliveryIds = [id]
        queuedItems.removeAll { $0.id == id }
        steeredItems.removeAll { $0.id == id }
        deliveringItems.removeAll { $0.id == id }
        isLoadingConversation = false
        rebuildDisplayItems()
    }
    #endif

    func resolveSlackComposer(_ receipt: SlackComposeReceipt) {
        if let pendingSlackComposer {
            guard pendingSlackComposer.id == receipt.requestId else { return }
        } else if let slackComposeReceipt {
            guard slackComposeReceipt.requestId == receipt.requestId else { return }
        }
        pendingSlackComposer = nil
        slackComposeReceipt = receipt
    }

    /// Delete the sent message with the same person's Slack grant. The receipt
    /// disappears only after success, so a rejected request can be retried.
    func undoSlackComposeReceipt() async {
        guard let receipt = slackComposeReceipt,
              receipt.status == .sent,
              let channelId = receipt.channel?.id,
              let ts = receipt.ts,
              undoingSlackComposeReceiptId == nil
        else { return }

        undoingSlackComposeReceiptId = receipt.requestId
        defer {
            if undoingSlackComposeReceiptId == receipt.requestId {
                undoingSlackComposeReceiptId = nil
            }
        }
        do {
            try await slackComposerUndoer(session.id, channelId, ts)
            if slackComposeReceipt?.requestId == receipt.requestId {
                slackComposeReceipt = nil
            }
            notice = "Removed from Slack"
        } catch {
            notice = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    // ── Pull request ──
    /// PR details for the session's branch (toolbar chip + PR panel).
    /// nil until the first fetch lands — the chip falls back to the sessions
    /// list's prNumber snapshot meanwhile — and stays nil when there's no PR.
    private(set) var prDetails: PrDetails?
    /// A fetch failed with nothing loaded — the panel offers a retry instead
    /// of an endless spinner.
    private(set) var prLoadFailed = false
    private var prTask: Task<Void, Never>?
    private var prLoadGeneration = 0
    private let prLoader: @MainActor (String) async throws -> PrDetails?
    private let slackComposerUndoer: @MainActor (String, String, String) async throws -> Void
    private var notesTask: Task<Void, Never>?

    // ── Workflow runs ──
    /// Authoritative snapshots for the Agents panel. The socket upserts live
    /// changes here even while the panel is closed, so opening it cannot miss
    /// the transition a local view-level listener never saw.
    private(set) var workflowRuns: [WorkflowRun] = []
    private(set) var workflowRunsLoaded = false
    private(set) var workflowLoadFailed = false
    private var workflowEventRevision = 0
    private let workflowLoader: @MainActor (String) async throws -> [WorkflowRun]

    // ── Session goal ──
    /// Goal set from this app (`/goal`), used to label the composer menu's
    /// row and prefill its editor. The server owns the real value; this is
    /// only what we've seen set here.
    private(set) var goal: String?

    // ── Per-session run settings ──
    /// Current model id ("" = server default). Changing routes through the
    /// `/model` slash command, which persists + notices like the web picker.
    private(set) var model: String
    /// Reasoning effort; rides every send and persists server-side. "" = unset.
    var effort: String
    /// OpenAI fast-mode flag; rides every send like effort.
    var fastMode: Bool

    // ── Earlier-history paging ──
    /// Older history exists server-side (transcript_init/history `truncated`).
    private(set) var canLoadEarlier = false
    private(set) var loadingEarlier = false
    /// Bumped on every history prepend so the view can restore the reader's
    /// scroll position after a requested page arrives.
    private(set) var historyPrependSeq = 0
    private var historyStartOffset: Int?
    private var historyRev: String?
    private var historyFirstSeq: Int?
    /// Latest durable position received from the server. Re-watches send it
    /// back so a reconnect appends only the missed gap and keeps any earlier
    /// pages the reader already loaded.
    private var transcriptResume: TranscriptResumeCursor?
    /// Walking the whole backlog to the first message, a page at a time.
    /// Separate from `loadingEarlier` (which stays true across the gaps) so
    /// the view can say which of the two is running.
    private(set) var jumpingToStart = false
    /// Bumped when a jump lands, so the view can scroll to the first message.
    private(set) var jumpLandedSeq = 0
    private var jumpLoaded = 0
    private var jumpCursor: Int?
    /// Fat pages keep the round trips — and the whole-transcript rebuilds one
    /// per page costs — in single digits. The ceiling stops a runaway walk on
    /// a transcript nobody should be rendering whole; when it trips the
    /// control stays put so the reader can keep going deliberately.
    private static let jumpPageEntries = 400
    private static let jumpMaxEntries = 4_000

    private var socket: (any SessionSocket)?
    /// Injection seam for tests; production always builds a real OS1Socket.
    private let socketFactory: @MainActor () -> any SessionSocket
    /// Where sends go. Messages live here — on disk — until the server
    /// acknowledges them, so nothing is lost to a dead socket or no signal.
    let outbox: Outbox
    private var reconnectTask: Task<Void, Never>?
    /// Stays set across failed reconnect attempts until a replacement hello
    /// arrives, keeping a deliberate handoff quick without tightening normal
    /// outage retries.
    private var isServerHandoffPending = false
    static let reconnectDelay: Duration = .seconds(2)
    static let handoffReconnectDelay: Duration = .milliseconds(250)
    private var conversationLoadTask: Task<Void, Never>?
    private let conversationLoadTimeout: TimeInterval
    /// Multiple views can briefly overlap during a reversed tab transition.
    /// The connection stays alive until the last mounted view releases it.
    private var viewOwners: Set<UUID> = []
    /// Foreground liveness probe (see `appDidBecomeActive`).
    private var resyncProbeTask: Task<Void, Never>?
    /// When the last server frame arrived — any frame counts.
    private var lastEventAt = Date.distantPast
    private var stopped = true
    /// Scene focus survives socket replacement so an inactive app cannot
    /// reappear as present when a half-open connection reconnects.
    private var isAway = false
    /// stream_done arrived; the durable entry lands via the next transcript_append.
    private var streamEnded = true
    /// Optimistic local user messages, removed once the server echoes them back.
    private var localEchoIds: Set<String> = []
    /// Server user entries that landed here, with the CLIENT-clock moment they
    /// arrived. The transcript broadcast goes out at intake — before the POST
    /// that carries the message answers — so a send's own entry routinely
    /// beats its delivery reply, and a retried send (answered from the
    /// server's prompt receipt) can be answered minutes later. Without this
    /// the echo in `acceptDelivery` was appended next to the server's own copy
    /// and nothing ever retired it: the message stayed on screen twice.
    /// Claims are one-to-one and only reach entries that arrived AFTER the
    /// message was written, so an old identical message ("continue") can never
    /// swallow a fresh bubble.
    private var landedUserEntries: [(id: String, text: String, at: Date)] = []
    /// A delivered continuation normally removes its own failure row as the
    /// new turn lands. Keep the press latched until then, matching the web
    /// notice component and closing the delivery/append race.
    private var continuedFailureNoticeIds: Set<String> = []
    /// Ids for client-side transcript notices (see `noteLocally`).
    private var localNoticeSeq = 0
    /// Chip ids whose message text landed in a user entry that arrived AFTER
    /// the chip was known — marked by `upsert` echoes and by resync entries
    /// under previously-unknown ids. `messageLanded` reads this instead of
    /// scanning the transcript, which false-positived on repeated sends.
    private var landedChipIds: Set<String> = []
    /// When each delivering chip entered the holding state (for the prune).
    private var deliveringSince: [String: Date] = [:]
    private var deliveringPruneTask: Task<Void, Never>?
    /// How long a delivering chip may wait for its transcript echo before
    /// being dropped as a ghost. Internal so tests can reference it.
    let deliveringGrace: TimeInterval = 30
    /// Assistant blocks that already landed as transcript entries. A block
    /// reaches the viewer twice — as stream frames while it is written, and as
    /// the durable entry when it finishes — and whichever arrives second must
    /// be dropped, or the same paragraph shows twice: in the transcript AND in
    /// the live bubble. Mirrors `LiveTextBuffer` on the server and the web.
    private var landedStreamTexts: [String] = []
    /// What has streamed so far for each named block (`blockId` on
    /// stream_text). The durable entry carries the same id, so its arrival
    /// removes exactly the text that block contributed — no string matching,
    /// even when the block was half-written or the wire normalized its text.
    private var liveBlockText: [String: String] = [:]
    /// Named blocks already landed durably: their late frames are a second
    /// copy of what the transcript now carries.
    private var landedBlockIds: Set<String> = []
    /// Assistant entries newly discovered by the last resync. Restricting
    /// partial-response reconciliation to these avoids matching an unrelated
    /// historical response that happens to start with the same words.
    private var resyncAssistantCandidates: [TranscriptEntry] = []
    /// Stream text is coalesced here and flushed to `liveText` at ~8Hz:
    /// every liveText change re-parses the whole bubble's markdown and
    /// re-anchors the scroll view, so per-chunk updates burn a full layout
    /// pass each on fast streams.
    private var pendingLiveText = ""
    private var liveFlushTask: Task<Void, Never>?
    /// Ids for graduated live-text entries (see `graduateLiveText`).
    private var liveTextSeq = 0

    private func appendLiveText(_ text: String) {
        pendingLiveText += text
        guard liveFlushTask == nil else { return }
        liveFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self, !Task.isCancelled else { return }
            self.liveFlushTask = nil
            if !self.pendingLiveText.isEmpty {
                self.liveText += self.pendingLiveText
                self.pendingLiveText = ""
            }
        }
    }

    private func flushLiveTextNow() {
        liveFlushTask?.cancel()
        liveFlushTask = nil
        if !pendingLiveText.isEmpty {
            liveText += pendingLiveText
            pendingLiveText = ""
        }
    }

    /// Move the accumulated live text into an ordered ephemeral entry the
    /// moment a tool call arrives. The text chronologically PRECEDES the tool
    /// call, but the live bubble renders after everything — leaving it there
    /// shows the turn in the wrong order until the durable entry lands, and
    /// the ~1s-later reshuffle reads as flicker. Graduated entries are
    /// stripped the same way the live bubble is once the durable copy lands.
    private func graduateLiveText() {
        flushLiveTextNow()
        guard !liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        liveTextSeq += 1
        liveEntries.append(TranscriptEntry(
            id: "live-text-\(liveTextSeq)",
            type: "assistant",
            content: liveText
        ))
        liveText = ""
    }

    /// Strip one landed assistant block from the live bubble and from any
    /// graduated live-text entries; drops graduated entries that end up empty.
    /// Returns whether the text was found anywhere.
    private func stripLanded(_ text: String) -> Bool {
        var found = false
        if liveText.contains(text) {
            liveText = liveText.replacingOccurrences(of: text, with: "")
            found = true
        }
        for index in liveEntries.indices
        where liveEntries[index].id.hasPrefix("live-text-") {
            if let content = liveEntries[index].content, content.contains(text) {
                liveEntries[index].content = content.replacingOccurrences(of: text, with: "")
                found = true
            }
        }
        liveEntries.removeAll {
            $0.id.hasPrefix("live-text-")
                && $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return found
    }

    /// Reconcile a cached partial response after reconnecting. Only a finished
    /// stream is eligible: while a run is active, an older assistant message
    /// may legitimately begin with the same words as the current response.
    private func reconcileFinishedLiveText() {
        guard streamEnded || !isRunning else { return }
        defer { resyncAssistantCandidates = [] }
        guard !liveText.isEmpty || !pendingLiveText.isEmpty else { return }

        flushLiveTextNow()
        for entry in resyncAssistantCandidates where !entry.text.isEmpty {
            liveText = liveText.replacingOccurrences(of: entry.text, with: "")
        }
        let residual = liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !residual.isEmpty,
           resyncAssistantCandidates.contains(where: {
               $0.text.trimmingCharacters(in: .whitespacesAndNewlines)
                       .hasPrefix(residual)
           }) {
            // The app disconnected mid-block; the snapshot now carries the
            // completed response whose prefix is the cached streaming text.
            liveText = ""
        }
        if liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            liveText = ""
            isStreaming = false
        }
    }

    /// Seed for a just-created session: the opening prompt (and images) render
    /// immediately while the server is still persisting the session file.
    struct OptimisticSeed {
        let prompt: String
        let images: [String]
    }

    /// Composer state parked by the list while switching workspace tabs.
    /// Keeping it outside the discarded conversation view preserves unsent
    /// text and staged screenshots without observing draft changes in the
    /// transcript view's body on every keystroke.
    struct ComposerDraft {
        let text: String
        let images: [AttachedImage]

        var isEmpty: Bool { text.isEmpty && images.isEmpty }
    }

    /// True until the first transcript_init lands for a session opened right
    /// after creation — "Session not found" watch errors are retried quietly
    /// instead of surfaced (the server persists the file a few seconds after
    /// returning the id).
    private var awaitingCreation = false
    private var creationRetryTask: Task<Void, Never>?
    private var creationRetriesLeft = 40

    init(
        session: Session,
        seed: OptimisticSeed? = nil,
        composerDraft: ComposerDraft? = nil,
        socketFactory: @escaping @MainActor () -> any SessionSocket = { OS1Socket() },
        outbox: Outbox = .shared,
        conversationLoadTimeout: TimeInterval = 15,
        prLoader: @escaping @MainActor (String) async throws -> PrDetails? = {
            try await OS1API.pr(sessionId: $0)
        },
        slackComposerUndoer: @escaping @MainActor (String, String, String) async throws -> Void = {
            try await SlackAPI.undoComposer(sessionId: $0, channelId: $1, ts: $2)
        },
        workflowLoader: @escaping @MainActor (String) async throws -> [WorkflowRun] = {
            try await OS1API.workflowRuns(sessionId: $0)
        }
    ) {
        self.session = session
        self.socketFactory = socketFactory
        self.outbox = outbox
        self.conversationLoadTimeout = conversationLoadTimeout
        self.prLoader = prLoader
        self.slackComposerUndoer = slackComposerUndoer
        self.workflowLoader = workflowLoader
        self.isRunning = session.safety == nil && (session.isRunning ?? false)
        self.usage = session.usage
        self.model = session.model ?? ""
        self.effort = session.effort ?? ""
        self.fastMode = session.fastMode ?? false
        if let composerDraft {
            self.draft = composerDraft.text
            self.attachedImages = composerDraft.images
        }
        if self.isRunning {
            self.runStartedAt = session.runStartedDate
        }
        // A session the server says has never run has no transcript to wait
        // for, and the watch confirms that in a moment. Opening on the loading
        // spinner would make an empty tab — the tab strip's "+" lands on one —
        // look like it was still fetching something. `createdAt` is the proof
        // that this IS the server's row: `neverRan` reads as true for a bare
        // id-only stub as well, and about one of those we know nothing.
        if session.createdAt != nil, session.neverRan { isLoadingConversation = false }
        if let seed {
            awaitingCreation = true
            isLoadingConversation = false
            // Echo semantics: the server's own copy of the opening prompt
            // replaces this seed when it lands via transcript_append.
            localEchoIds.insert("optimistic-prompt")
            entries = [TranscriptEntry(
                id: "optimistic-prompt",
                type: "user",
                content: seed.prompt,
                timestamp: ISO8601DateFormatter().string(from: .now),
                images: seed.images.isEmpty ? nil : seed.images
            )]
        }
        // A composer send lives in the outbox until the server accepts it. Put
        // that durable local copy back in the conversation after a relaunch so
        // a failed or offline send never leaves an unexplained blank chat.
        for item in outbox.items(for: session.id) where item.purpose == nil {
            appendOutboxEcho(item)
        }
        if !entries.isEmpty { rebuildDisplayItems() }
    }

    /// A cached conversation may be reopened from an older list-row snapshot.
    /// Keep its loaded transcript while refreshing title/worktree/PR metadata.
    func updateSessionSnapshot(_ session: Session) {
        guard session.id == self.session.id else { return }
        let hadWalkthrough = self.session.walkthrough
        let hadReview = ReviewLoopResult(session: self.session)
        #if DEBUG
        let screenshotSafety = holdsSafetyScreenshot ? self.session.safety : nil
        #endif
        self.session = session
        #if DEBUG
        if let screenshotSafety { self.session.safety = screenshotSafety }
        #endif
        // The walkthrough and the PR's review verdict ride on the session row,
        // not the transcript, so a newly published walkthrough or a fresh
        // review only reach the blocks through a rebuild.
        if session.walkthrough != hadWalkthrough
            || ReviewLoopResult(session: session) != hadReview {
            rebuildDisplayItems()
        }
        // The list row's usage is a snapshot from the last 5s poll, so it can
        // arrive behind the live `usage_update` the socket already delivered.
        // Take it only when it counts at least as many turns.
        if let rowUsage = session.usage, rowUsage.turns >= (usage?.turns ?? 0) {
            usage = rowUsage
        }
        guard stopped else { return }

        // Queue items belong to the old socket snapshot. While closed, fall
        // back to the fresh sessions-row summary until the new watch supplies
        // its detailed queue.
        hasDetailedQueue = false
        queuedItems = []
        steeredItems = []
        pendingDeliveryIds = []
        updateDelivering([])

        if session.safety != nil {
            isRunning = false
            runStartedAt = nil
            streamEnded = true
            isStreaming = false
        } else if let running = session.isRunning {
            isRunning = running
            runStartedAt = running ? session.runStartedDate : nil
            if !running {
                streamEnded = true
                isStreaming = false
            }
        }
        model = session.model ?? ""
        effort = session.effort ?? ""
        fastMode = session.fastMode ?? false
    }

    func start() {
        viewOwners.removeAll()
        startConnection()
    }

    func start(owner: UUID) {
        let wasInactive = viewOwners.isEmpty
        viewOwners.insert(owner)
        if wasInactive { startConnection() }
    }

    private func startConnection() {
        stopped = false
        // Reopening a cached view model happens in an active scene unless the
        // view immediately tells us otherwise. Socket reconnects bypass this
        // method and intentionally preserve the current away state.
        isAway = false
        // While this conversation is on screen it shows its own deliveries;
        // a closed session needs no observer (reopening it resyncs from the
        // server, which by then holds the message).
        outbox.observe(sessionId: session.id) { [weak self] item, delivery in
            self?.acceptDelivery(item, delivery)
        }
        outbox.poke()
        armConversationLoadDeadline()
        connect()
        loadPr()
        loadSessionNotes()
    }

    func stop() {
        viewOwners.removeAll()
        stopConnection()
    }

    func stop(owner: UUID) {
        guard viewOwners.remove(owner) != nil else { return }
        if viewOwners.isEmpty { stopConnection() }
    }

    private func stopConnection() {
        stopTyping()
        stopped = true
        replySuggestions = []
        outbox.stopObserving(sessionId: session.id)
        reconnectTask?.cancel()
        conversationLoadTask?.cancel()
        resyncProbeTask?.cancel()
        creationRetryTask?.cancel()
        deliveringPruneTask?.cancel()
        prLoadGeneration += 1
        prTask?.cancel()
        notesTask?.cancel()
        socket?.disconnect()
        socket = nil
    }

    /// Fire-and-forget PR refresh (open, foreground, run end, live event).
    /// A generation guard keeps a cancelled request that finishes late from
    /// replacing a newer webhook-triggered answer.
    func loadPr() {
        prLoadGeneration += 1
        let generation = prLoadGeneration
        prTask?.cancel()
        prTask = Task { [weak self] in
            await self?.performPrRefresh(generation: generation)
        }
    }

    /// Awaitable PR refresh for the panel's pull-to-refresh / retry. A failure
    /// keeps whatever we already have: stale beats blank; only a failure with
    /// nothing loaded surfaces as prLoadFailed.
    func refreshPr() async {
        prLoadGeneration += 1
        let generation = prLoadGeneration
        prTask?.cancel()
        prTask = nil
        await performPrRefresh(generation: generation)
    }

    private func performPrRefresh(generation: Int) async {
        do {
            let details = try await prLoader(session.id)
            guard !Task.isCancelled, generation == prLoadGeneration else { return }
            prDetails = details
            prLoadFailed = false
        } catch {
            guard !Task.isCancelled, generation == prLoadGeneration else { return }
            prLoadFailed = prDetails == nil
        }
    }

    /// A global PR event belongs to this session when it names any branch the
    /// server associates with it, including linked and discovered PRs whose
    /// branch differs from the checked-out worktree.
    func matchesPrUpdate(repo: String, branch: String) -> Bool {
        if session.effectiveRepo == repo, session.branch == branch { return true }
        if session.attachedRepos?.contains(where: {
            $0.repo == repo && $0.branch == branch
        }) == true { return true }
        return session.prs?.contains(where: {
            $0.repo == repo && $0.branch == branch
        }) == true
    }

    /// Seed or revalidate the Agents panel. A workflow event that lands while
    /// this request is in flight wins for any run id both carry; the older REST
    /// snapshot may only fill runs the event-backed list does not know yet.
    func refreshWorkflowRuns() async {
        let eventRevision = workflowEventRevision
        do {
            let next = try await workflowLoader(session.id)
            guard !Task.isCancelled else { return }
            if eventRevision == workflowEventRevision {
                workflowRuns = next
            } else {
                let known = Set(workflowRuns.map(\.runId))
                workflowRuns.append(contentsOf: next.filter { !known.contains($0.runId) })
            }
            workflowRunsLoaded = true
            workflowLoadFailed = false
        } catch {
            guard !Task.isCancelled else { return }
            workflowRunsLoaded = true
            workflowLoadFailed = workflowRuns.isEmpty
        }
    }

    private func upsertWorkflowRun(_ run: WorkflowRun) {
        workflowEventRevision += 1
        if let index = workflowRuns.firstIndex(where: { $0.runId == run.runId }) {
            workflowRuns[index] = run
        } else {
            workflowRuns.insert(run, at: 0)
        }
        workflowRunsLoaded = true
        workflowLoadFailed = false
    }

    func loadSessionNotes() {
        notesTask?.cancel()
        notesTask = Task { [weak self] in
            guard let self else { return }
            do {
                let notes = try await OS1API.sessionNotes(sessionId: self.session.id)
                guard !Task.isCancelled else { return }
                self.mergeSessionNotes(notes)
            } catch {
                // Notes are an enhancement to the transcript. A server that
                // predates them still opens the conversation normally.
            }
        }
    }

    func addSessionNote() async -> Bool {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachedImages.map(\.dataURL)
        guard !typed.isEmpty || !images.isEmpty else { return false }
        let text = quoteSelection.message(with: typed)
        do {
            let note = try await OS1API.addSessionNote(
                sessionId: session.id,
                text: text,
                images: images
            )
            upsertSessionNote(note)
            draft = ""
            attachedImages = []
            quoteSelection.clear()
            sendSeq += 1
            return true
        } catch {
            notice = error.localizedDescription
            return false
        }
    }

    func editSessionNote(_ note: SessionNote, text: String) async throws {
        let changed = try await OS1API.editSessionNote(
            sessionId: session.id,
            noteId: note.id,
            text: text
        )
        upsertSessionNote(changed)
    }

    func deleteSessionNote(_ note: SessionNote) async throws {
        try await OS1API.deleteSessionNote(sessionId: session.id, noteId: note.id)
        removeSessionNote(id: note.id)
    }

    // ── Pull request actions ──
    //
    // Each mutation refreshes the PR afterwards rather than patching the local
    // copy: merging changes state, checks and the review decision at once, and
    // the panel is already built to render whatever the route returns. Errors
    // propagate — the panel shows the server's own sentence.

    /// Submit a review (APPROVE / REQUEST_CHANGES / COMMENT) on this session's PR.
    func submitPrReview(
        event: String,
        summary: String,
        comments: [PrInlineComment] = []
    ) async throws {
        try await OS1API.submitPrReview(
            sessionId: session.id,
            event: event,
            summary: summary,
            comments: comments
        )
        await refreshPr()
    }

    /// Merge this session's PR — squash unless another method is asked for.
    func mergePr(method: String = "squash") async throws {
        try await OS1API.mergePr(sessionId: session.id, method: method)
        await refreshPr()
    }

    /// Close this session's PR without merging it.
    func closePr() async throws {
        try await OS1API.closePr(sessionId: session.id)
        await refreshPr()
    }

    /// Called when the app returns to the foreground. iOS suspends the socket
    /// while backgrounded and it often comes back half-open: sends "succeed"
    /// locally, nothing arrives, and the ping deadline takes tens of seconds
    /// to notice — the transcript sits stale until the person leaves and
    /// re-enters the session. Instead: re-send `watch` (the server replies
    /// with a full resync — transcript_init plus status/queue extras) and
    /// verify a frame actually comes back; if the socket is dead, tear it
    /// down and reconnect immediately.
    /// Everyone but us, in wire order and deduplicated. The server sends one
    /// name per socket, so a teammate reading from a laptop and a phone would
    /// otherwise show up twice; names are matched on the first token, which is
    /// what the server stamps sockets with, case-insensitively.
    static func otherViewers(_ viewers: [String], me: String) -> [String] {
        let mine = firstName(me)
        var seen = Set<String>()
        return viewers.filter { viewer in
            let key = firstName(viewer)
            guard !key.isEmpty, key != mine else { return false }
            return seen.insert(key).inserted
        }
    }

    static func typingLabel(_ users: [String]) -> String? {
        switch users.count {
        case 0: nil
        case 1: "\(users[0]) is typing…"
        default: "Several people are typing…"
        }
    }

    private static func firstName(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ")
            .first?
            .lowercased() ?? ""
    }

    /// Activity refreshes remain for compatibility with older servers that
    /// expired presence. Current servers hold it until the app sends `away`.
    private var lastPresenceRefresh = Date.distantPast
    /// Rare enough to cost nothing on a session someone reads for an hour.
    private static let presenceRefreshInterval: TimeInterval = 45
    private static let typingRefreshInterval: TimeInterval = 2
    private static let typingIdleInterval: TimeInterval = 3
    private var typingActive = false
    private var lastTypingSent = Date.distantPast
    private var typingStopTask: Task<Void, Never>?

    /// Composer input refreshes a short typing lease. A pause clears it even
    /// while the unsent draft remains in the field.
    func userIsTyping(_ active: Bool) {
        guard active else {
            stopTyping()
            return
        }
        guard !stopped, let socket, connectionState == .connected else { return }
        let now = Date()
        if !typingActive || now.timeIntervalSince(lastTypingSent) >= Self.typingRefreshInterval {
            socket.setTyping(sessionId: session.id, typing: true)
            lastTypingSent = now
        }
        typingActive = true
        typingStopTask?.cancel()
        typingStopTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.typingIdleInterval))
            guard !Task.isCancelled else { return }
            self?.stopTyping()
        }
    }

    private func stopTyping() {
        typingStopTask?.cancel()
        typingStopTask = nil
        if typingActive { socket?.setTyping(sessionId: session.id, typing: false) }
        typingActive = false
        lastTypingSent = .distantPast
    }

    /// The app is no longer active. The watch stays so the transcript keeps
    /// streaming, but our face comes off the selected session.
    func appDidEnterBackground() {
        guard !stopped else { return }
        stopTyping()
        isAway = true
        // Coming back has to re-claim the face immediately, not wait out the
        // refresh interval below.
        lastPresenceRefresh = .distantPast
        socket?.setAway(true)
    }

    /// Reassert active presence for older servers with an inactivity timeout.
    /// Current servers use scene focus instead, so this is only compatibility.
    func userDidInteract() {
        guard !stopped, let socket, connectionState == .connected else { return }
        let now = Date()
        guard now.timeIntervalSince(lastPresenceRefresh) >= Self.presenceRefreshInterval
        else { return }
        lastPresenceRefresh = now
        socket.setAway(false)
    }

    func appDidBecomeActive() {
        guard !stopped else { return }
        isAway = false
        // Coming back is the most likely moment for "we have signal again".
        outbox.clearBackoff()
        outbox.poke()
        loadPr()
        guard connectionState == .connected, let socket else {
            // Not connected (or a pre-suspension connect is stuck mid
            // handshake): skip the backoff and reconnect right now.
            reconnectTask?.cancel()
            self.socket?.disconnect()
            self.socket = nil
            connect()
            return
        }
        let probeStarted = Date()
        socket.watch(sessionId: session.id, resume: transcriptResume)
        // Back on screen: show our face again. (A reconnect starts present, so
        // only a socket that survived the background needs telling.)
        lastPresenceRefresh = Date()
        socket.setAway(false)
        resyncProbeTask?.cancel()
        resyncProbeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, !Task.isCancelled, !self.stopped else { return }
            if self.lastEventAt < probeStarted {
                // Half-open: the re-watch went into the void.
                self.socket?.disconnect()
                self.socket = nil
                self.connect()
            }
        }
    }

    /// Nothing here asks whether we're connected: an offline send is held in
    /// the outbox and delivered when the server is reachable again. Disabling
    /// the button was how messages used to be lost — you'd type, tap a dead
    /// button (or hit a socket that only LOOKED alive), and the text vanished.
    var canSend: Bool {
        guard safety == nil else { return false }
        let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasText || !attachedImages.isEmpty
    }

    enum FailureContinuationStatus: Equatable {
        case available
        case sending
        case failed(String)
    }

    func failureContinuationStatus(for noticeId: String) -> FailureContinuationStatus {
        guard let item = outbox.items(for: session.id).first(where: {
            $0.purpose == "failure:\(noticeId)"
        }) else {
            return continuedFailureNoticeIds.contains(noticeId) ? .sending : .available
        }
        if item.failed {
            return .failed(item.lastError ?? "Couldn't continue this run.")
        }
        return .sending
    }

    /// Send the same ordinary prompt as the web failure action without
    /// disturbing text already waiting in the composer. A rejected delivery
    /// retries its original outbox item, preserving the server's idempotency
    /// key rather than creating a second continuation.
    func continueAfterFailure(noticeId: String) {
        if let item = outbox.items(for: session.id).first(where: {
            $0.purpose == "failure:\(noticeId)"
        }) {
            guard item.failed else { return }
            outbox.retry(id: item.id)
            return
        }

        guard outbox.enqueue(
            sessionId: session.id,
            content: Self.continueAfterFailurePrompt,
            busyMode: "default",
            purpose: "failure:\(noticeId)",
            user: ServerConfig.shared.userName
        ) != nil else {
            notice = "Too many unsent messages — send or delete some first."
            return
        }
        HideStore.shared.unhide(for: session)
        sendSeq += 1
    }

    /// Hand the draft to the outbox. It's on disk before the composer clears,
    /// and it stays there until the server says it has it — so a send made in
    /// a tunnel arrives when the signal does, in the order it was written.
    func sendDraft(busyModeOverride: String? = nil) {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = attachedImages.map(\.dataURL)
        guard !typed.isEmpty || !images.isEmpty else { return }
        let text = quoteSelection.message(with: typed)
        let busyMode = busyModeOverride
            ?? UserDefaults.standard.string(forKey: "os1.composer.busySend")
            ?? "queue"
        guard let item = outbox.enqueue(
            sessionId: session.id,
            content: text,
            images: images,
            effort: effort.isEmpty ? nil : effort,
            fastMode: fastMode ? true : nil,
            busyMode: busyMode,
            user: ServerConfig.shared.userName
        ) else {
            // Full: keep the draft where it is rather than swallowing it.
            notice = "Too many unsent messages — send or delete some first."
            return
        }
        // The outbox is already durable, so the conversation can own the
        // optimistic copy immediately. Its status remains attached to this
        // bubble until the server accepts, rejects, or queues the message.
        appendOutboxEcho(item, images: images)
        rebuildDisplayItems()
        // You can't be done with a session you're actively working in: prompting
        // clears any sidebar hide covering it (opening it deliberately doesn't).
        HideStore.shared.unhide(for: session)
        replySuggestions = []
        draft = ""
        attachedImages = []
        quoteSelection.clear()
        sendSeq += 1
    }

    private func appendOutboxEcho(_ item: Outbox.Item, images: [String]? = nil) {
        let localId = "local-\(item.id)"
        guard !entries.contains(where: { $0.id == localId }) else { return }
        localEchoIds.insert(localId)
        let sources = images ?? outbox.images(for: item)
        entries.append(TranscriptEntry(
            id: localId,
            type: "user",
            content: item.content,
            timestamp: ISO8601DateFormatter().string(from: item.createdAt),
            images: sources.isEmpty ? nil : sources
        ))
    }

    private func removeOutboxEcho(_ item: Outbox.Item) {
        let localId = "local-\(item.id)"
        localEchoIds.remove(localId)
        entries.removeAll { $0.id == localId }
    }

    /// The server took a message: put it where the server says it went. This
    /// replaces the old guess from local `isRunning` — a client that has been
    /// offline has no idea whether a run started meanwhile, and a bubble in
    /// the wrong place blinks out at the next resync.
    private func acceptDelivery(_ item: Outbox.Item, _ delivery: Outbox.Delivery) {
        if let purpose = item.purpose, purpose.hasPrefix("failure:") {
            continuedFailureNoticeIds.insert(String(purpose.dropFirst("failure:".count)))
        }
        switch delivery.status {
        case "steered":
            // Current servers admit a steer as a sent transcript row before
            // answering. Keep the optimistic bubble until that durable row
            // upserts it by delivery id. An older server's `steered` queue row
            // still converts it to a compatibility chip in queueUpdate.
            return
        case "queued":
            removeOutboxEcho(item)
            rebuildDisplayItems()
            // Held server-side; it enters the transcript when the queue
            // delivers it. Show the chip the queue_update will replace —
            // unless that update has already arrived. The socket routinely
            // wins this race (the broadcast goes out while the HTTP response
            // is still travelling, and on a slow link that's the common case,
            // not the rare one), and appending anyway showed the message
            // twice: the server's entry plus an optimistic copy that only
            // cleared when the queue next changed.
            let content = item.content.trimmingCharacters(in: .whitespacesAndNewlines)
            let alreadyShown = queuedItems.contains {
                    !$0.isLocalEcho
                        && $0.content.trimmingCharacters(in: .whitespacesAndNewlines) == content
                }
            guard !alreadyShown else { return }
            let chip = QueueItem(
                id: "local-queued-\(item.id)",
                content: item.content,
                user: item.user
            )
            hasDetailedQueue = true
            queuedItems.append(chip)
        case "handled":
            // A slash command (/model, /goal …) — the server's answer is the
            // whole result; nothing enters the transcript.
            removeOutboxEcho(item)
            rebuildDisplayItems()
            if !delivery.message.isEmpty { notice = delivery.message }
        default:
            // The bubble was minted when the composer accepted the message.
            // Delivery only removes its outbox status; there is no second
            // optimistic copy to append.
            let localId = "local-\(item.id)"
            if entries.contains(where: { $0.id == localId }) { return }
            // The server's own copy of this message may already be on screen:
            // its transcript entry is broadcast at intake, before this reply
            // was even written, so on a slow link the entry wins the race —
            // and a retry answered from the prompt receipt lands long after.
            // Claim that entry rather than echoing a second copy of the
            // message next to it.
            let shown = Set(entries.map(\.id))
            if let landed = landedUserEntries.firstIndex(where: { landed in
                landed.at >= item.createdAt
                    && shown.contains(landed.id)
                    && Self.delivers(content: item.content, in: landed.text)
            }) {
                landedUserEntries.remove(at: landed)
                return
            }
            localEchoIds.insert(localId)
            entries.append(TranscriptEntry(
                id: localId,
                type: "user",
                content: item.content,
                timestamp: ISO8601DateFormatter().string(from: .now),
                images: delivery.images.isEmpty ? nil : delivery.images
            ))
            rebuildDisplayItems()
        }
    }

    /// Pin (or clear) the session goal. Goals have no endpoint of their own —
    /// `/goal` is a server-side slash command on the ordinary prompt channel,
    /// exactly as the web composer sets one.
    func setGoal(_ goal: String?) {
        guard let socket else { return }
        let trimmed = goal?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.goal = trimmed.isEmpty ? nil : trimmed
        socket.prompt(
            sessionId: session.id,
            content: trimmed.isEmpty ? "/goal clear" : "/goal \(trimmed)",
            user: ServerConfig.shared.userName
        )
    }

    /// Append an `@`-mention to the draft. SwiftUI hands out no cursor
    /// position for a TextField, so mentions land at the end rather than at
    /// the caret — where a reference reads naturally anyway.
    func insertMention(_ insert: String) {
        if !draft.isEmpty, !draft.hasSuffix(" "), !draft.hasSuffix("\n") { draft += " " }
        draft += "@\(insert) "
    }

    /// Append a quick reply to any text already in the composer, matching the
    /// web client. Retire the row after one pick so contradictory suggestions
    /// cannot be folded into the same draft.
    func pickReplySuggestion(_ suggestion: ReplySuggestion) {
        let existing = draft.replacingOccurrences(
            of: #"\s+$"#,
            with: "",
            options: .regularExpression
        )
        draft = existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? suggestion.text
            : "\(existing)\n\(suggestion.text)"
        replySuggestions = []
    }

    /// Hold the draft until `at` — the server sends it then, whether or not
    /// the app is running. Clears the draft only once the server has it.
    func schedulePrompt(at: Date) async throws {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return }
        let text = quoteSelection.message(with: typed)
        try await OS1API.schedulePrompt(sessionId: session.id, prompt: text, at: at)
        draft = ""
        quoteSelection.clear()
        sendSeq += 1
    }

    /// Clear the composer's floating notice — which now carries only what is
    /// a word to the person who just tapped (a refused send, a switch that
    /// didn't happen); anything that happened to the SESSION goes to
    /// `noteLocally` instead. The chip retires an info or warn line on its
    /// own timer; this is the tap, and the only way an error one leaves
    /// before another notice replaces it.
    func dismissNotice() { notice = nil }

    /// Record something this app just did as a transcript line of its own.
    /// A client-side action gets no entry from the server, so this is a local
    /// row — and the transcript is where it belongs: it reads in place, in the
    /// order it happened, instead of as a chip pinned over the composer that
    /// says something about the session while covering the thing it changed.
    /// A resync drops it, which is the right lifetime for a line nothing
    /// durable backs. Internal so tests can drive it without a live server.
    func noteLocally(_ title: String, tone: NoticeTone = .info) {
        localNoticeSeq += 1
        entries.append(TranscriptEntry(
            id: "local-notice-\(localNoticeSeq)",
            type: "system",
            content: title,
            timestamp: ISO8601DateFormatter().string(from: .now),
            notice: EntryNotice(
                kind: "system", title: title, tone: tone.rawValue, body: nil, link: nil,
                ask: nil, icon: nil
            )
        ))
        rebuildDisplayItems()
    }

    /// Promote an ask-mode session to code mode. One-way: the server cuts a
    /// worktree, and the local snapshot follows so the row disappears without
    /// waiting for the next sessions refresh. The branch it returns is for
    /// callers that want to say so; the transcript line covers the rest.
    ///
    /// The two outcomes land in different places on purpose: the switch is
    /// something that happened TO the session, so it joins its transcript,
    /// while a failure means nothing happened to the session at all — that is
    /// a word to the person who just tapped, and it stays on the composer
    /// where an error waits to be read instead of scrolling away.
    @discardableResult
    func promoteToCode() async -> String? {
        do {
            let branch = try await OS1API.promoteToCode(sessionId: session.id)
            session.mode = "code"
            if let branch { session.branch = branch }
            noteLocally("Switched to code mode")
            return branch
        } catch {
            notice = "Couldn't switch to code mode"
            return nil
        }
    }

    /// Switch this session's model via the `/model` slash command — handled
    /// server-side (persists, notices, broadcasts) without reaching the engine.
    func changeModel(to id: String) {
        guard !id.isEmpty, id != model, let socket else { return }
        model = id
        // A model family switch invalidates the old effort/fast picks; reset
        // to server defaults rather than carrying them across.
        effort = ""
        fastMode = false
        socket.prompt(
            sessionId: session.id,
            content: "/model \(id)",
            user: ServerConfig.shared.userName
        )
    }

    func answer(question: AskQuestion, answers: [String: String]?) {
        socket?.answer(sessionId: session.id, questionId: question.id, answers: answers)
        pendingQuestion = nil
        sentAskAnswer = answers.map {
            SentAskAnswer(
                id: question.id,
                ask: AnsweredAsk(question: question, answers: $0),
                existingRecordIDs: Set(entries.lazy.filter {
                    $0.notice?.ask != nil || $0.ask != nil
                }.map(\.id))
            )
        }
    }

    private func retireSentAskAnswer(against incoming: [TranscriptEntry]) {
        guard let sent = sentAskAnswer else { return }
        let landed = incoming.contains { entry in
            guard !sent.existingRecordIDs.contains(entry.id),
                  let record = entry.notice?.ask ?? entry.ask,
                  record.questions.count == sent.ask.questions.count else { return false }
            return zip(record.questions, sent.ask.questions).allSatisfy { pair in
                pair.0.question == pair.1.question && pair.0.answer == pair.1.answer
            }
        }
        if landed { sentAskAnswer = nil }
    }

    func cancelRun() {
        socket?.cancelWatchedRun()
    }

    /// Ask the server for one page of history older than what we hold.
    func loadEarlier() {
        requestHistoryPage(whole: false)
    }

    /// Walk the backlog all the way to the first message: each page's arrival
    /// asks for the next (see `continueJump`). A long session is otherwise a
    /// hundred "load earlier" taps away from its start.
    func jumpToStart() {
        guard canLoadEarlier, !loadingEarlier, connectionState == .connected else { return }
        jumpingToStart = true
        jumpLoaded = 0
        jumpCursor = nil
        requestHistoryPage(whole: true)
    }

    private func requestHistoryPage(whole: Bool) {
        guard canLoadEarlier, !loadingEarlier, connectionState == .connected,
              let socket else { endJump(); return }
        if let seq = historyFirstSeq, seq > 1 {
            loadingEarlier = true
            socket.loadHistory(
                sessionId: session.id, beforeSeq: seq,
                limit: whole ? Self.jumpPageEntries : nil
            )
        } else if let offset = historyStartOffset, offset > 0 {
            loadingEarlier = true
            if whole {
                // Byte-window paging can't walk a backlog cheaply; the
                // cursor-less request is answered with the whole transcript
                // in one transcript_init, which lands the jump in one hop.
                socket.loadWholeHistory(sessionId: session.id)
            } else {
                socket.loadHistory(
                    sessionId: session.id, beforeOffset: offset, beforeRev: historyRev
                )
            }
        } else {
            // Older history exists, but the server gave us no cursor to reach
            // it with — a session it serves from the cross-engine merge, which
            // has no byte window to page into (`startOffset: 0`) and no seq
            // store to page through. The cursor-less request is what the web
            // sends in exactly this state, and the server answers it with the
            // whole transcript in one transcript_init. Clearing the control
            // instead (what this did before) left the reader stuck at the tail
            // with a "Load earlier history" button that silently did nothing.
            loadingEarlier = true
            socket.loadWholeHistory(sessionId: session.id)
        }
    }

    /// One page of a jump landed: ask for the next unless the walk is done.
    /// Stops on a whole transcript, an empty page, a cursor that stopped
    /// receding (nothing more is coming), or the ceiling.
    private func continueJump(added: Int) {
        guard jumpingToStart else { return }
        jumpLoaded += added
        let cursor = historyFirstSeq ?? historyStartOffset
        guard canLoadEarlier, added > 0, let cursor, cursor != jumpCursor,
              jumpLoaded < Self.jumpMaxEntries else { endJump(); return }
        jumpCursor = cursor
        requestHistoryPage(whole: true)
    }

    /// `landed: false` for a walk the socket cut short — the reader keeps the
    /// position they had rather than being taken to a start we never reached.
    private func endJump(landed: Bool = true) {
        guard jumpingToStart else { return }
        jumpingToStart = false
        if landed { jumpLandedSeq += 1 }
    }

    private func applyHistoryCursor(_ cursor: HistoryCursor) {
        canLoadEarlier = cursor.truncated
        historyStartOffset = cursor.startOffset
        if let rev = cursor.rev { historyRev = rev }
        historyFirstSeq = cursor.firstSeq
    }

    /// An init is authoritative for protocol mode and resume position. A frame
    /// without resume metadata comes from an older server, so the next watch
    /// must request another snapshot rather than reuse a stale cursor.
    private func applyTranscriptSnapshotCursor(_ cursor: HistoryCursor) {
        if cursor.v2, let lastSeq = cursor.lastSeq {
            transcriptResume = .seq(
                lastSeq: lastSeq,
                lastChangeSeq: cursor.lastChangeSeq ?? lastSeq
            )
        } else if let endOffset = cursor.endOffset, let rev = cursor.rev {
            transcriptResume = .offset(endOffset: endOffset, rev: rev)
        } else {
            transcriptResume = nil
        }
    }

    /// Append watermarks only move forward. Store upserts can republish an old
    /// entry seq, while `lastChangeSeq` still identifies the newer commit.
    private func applyTranscriptAppendCursor(_ cursor: HistoryCursor) {
        switch transcriptResume {
        case .seq(let currentSeq, let currentChange) where cursor.v2:
            transcriptResume = .seq(
                lastSeq: max(currentSeq, cursor.lastSeq ?? 0),
                lastChangeSeq: max(currentChange, cursor.lastChangeSeq ?? 0)
            )
        case .offset where !cursor.v2:
            if let endOffset = cursor.endOffset, let rev = cursor.rev {
                transcriptResume = .offset(endOffset: endOffset, rev: rev)
            }
        default:
            // An append normally follows an init, but accepting its complete
            // cursor also makes recovery tolerant of reordered test fixtures.
            if cursor.v2, let lastSeq = cursor.lastSeq {
                transcriptResume = .seq(
                    lastSeq: lastSeq,
                    lastChangeSeq: cursor.lastChangeSeq ?? lastSeq
                )
            } else if let endOffset = cursor.endOffset, let rev = cursor.rev {
                transcriptResume = .offset(endOffset: endOffset, rev: rev)
            }
        }
    }

    /// Deliberately NOT optimistic: a steer can be refused (nothing steerable
    /// right now, files attached) and the message legitimately stays queued —
    /// the server answers with a notice and the queue_update that follows is
    /// the truth. Moving the chip first would show a steer that didn't happen.
    func steerQueued(_ item: QueueItem) {
        socket?.steerQueued(sessionId: session.id, queueId: item.id)
    }

    func deleteQueued(_ item: QueueItem) {
        socket?.deleteQueued(sessionId: session.id, queueId: item.id)
        removeChip(item)
    }

    /// Drop a steer receipt from view. The run keeps going — the message is
    /// already committed to it — this just stops the receipt from hanging
    /// around until the turn ends.
    func dismissSteered(_ item: QueueItem) {
        socket?.deleteQueued(sessionId: session.id, queueId: item.id)
        removeChip(item)
    }

    /// Deliver a steering receipt now. The server ends the run's current
    /// step so the message lands immediately instead of waiting out a long
    /// tool call, then the run resumes with it in hand. Not optimistic: the
    /// chip stays until the server's queue_update moves it, because the
    /// forced delivery is observable in the transcript within a second.
    func deliverSteeredNow(_ item: QueueItem) {
        socket?.interruptQueued(sessionId: session.id, queueId: item.id)
    }

    /// Removals have to be optimistic in BOTH lists: a chip that leaves the
    /// server's queue without its message landing in the transcript is what
    /// `queueUpdate` reads as "mid-delivery", so a discarded one we still hold
    /// locally would come back as a ghost "Delivering…" row until it timed out.
    private func removeChip(_ item: QueueItem) {
        queuedItems.removeAll { $0.id == item.id }
        steeredItems.removeAll { $0.id == item.id }
        deliveringItems.removeAll { $0.id == item.id }
        // The delivery clock has to go with the chip: a leftover start would
        // be inherited by `updateDelivering` if the server re-lists and
        // re-drains the same id, and the fresh chip would prune instantly as
        // a 30s-old ghost.
        deliveringSince.removeValue(forKey: item.id)
    }

    /// Atomically take an ordinary message out of the server queue. The reply
    /// restores its full payload into the normal composer.
    func editQueuedInComposer(_ item: QueueItem) {
        guard !item.isLocalEcho, !item.hasFiles, !item.hasContextSessions, item.editable,
              MessageAttribution.isViewer(
                item.user ?? "",
                viewerName: ServerConfig.shared.userName,
                viewerLogin: ServerConfig.shared.githubLogin
              ) else {
            return
        }
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              attachedImages.isEmpty else {
            notice = "Send or clear your draft before editing a queued message."
            return
        }
        socket?.takeQueued(sessionId: session.id, queueId: item.id)
    }

    /// Pull back a steer only while it is still waiting behind the engine's
    /// next step boundary. The server replies through queuedPromptTaken after
    /// the engine confirms the exact receipt id was retracted.
    func editSteeredInComposer(_ item: QueueItem) {
        guard !item.isLocalEcho, !item.hasFiles, !item.hasContextSessions, item.editable,
              MessageAttribution.isViewer(
                item.user ?? "",
                viewerName: ServerConfig.shared.userName,
                viewerLogin: ServerConfig.shared.githubLogin
              ) else {
            return
        }
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              attachedImages.isEmpty else {
            notice = "Send or clear your draft before editing a message."
            return
        }
        socket?.takeSteered(sessionId: session.id, queueId: item.id)
    }

    /// Move a queued message one place towards (-1) or away from (+1) the
    /// front of the queue. The server takes the full id order and leaves
    /// entries it doesn't recognise where they are, so local echoes ride
    /// along without being named.
    func moveQueued(_ item: QueueItem, by offset: Int) {
        guard let from = queuedItems.firstIndex(where: { $0.id == item.id }) else { return }
        let to = from + offset
        guard queuedItems.indices.contains(to) else { return }
        queuedItems.swapAt(from, to)
        let order = queuedItems.filter { !$0.isLocalEcho }.map(\.id)
        guard order.count > 1 else { return }
        socket?.reorderQueued(sessionId: session.id, order: order)
    }

    /// Whether a queued message can be reordered at all — a one-item queue
    /// has nothing to move, and a local echo isn't addressable yet.
    func canReorder(_ item: QueueItem) -> Bool {
        queuedItems.count > 1 && !item.isLocalEcho
    }

    /// Pull a message the server hasn't taken yet back into the composer.
    /// Unlike a queued message (edited in place server-side), an outbox item
    /// was never sent — taking it back is a pure local move, and the draft it
    /// becomes is the only copy, so it's dropped from the outbox last.
    func editUnsent(_ item: Outbox.Item) {
        let images = outbox.images(for: item).compactMap {
            AttachedImage(dataURL: $0)
        }
        draft = draft.isEmpty ? item.content : draft + "\n\n" + item.content
        attachedImages.append(contentsOf: images)
        discardUnsent(item)
    }

    func discardUnsent(_ item: Outbox.Item) {
        removeOutboxEcho(item)
        outbox.delete(id: item.id)
        rebuildDisplayItems()
    }

    /// Put one of the viewer's sent turns back into the ordinary composer.
    /// History stays immutable; sending creates a new turn.
    func editSentMessageInComposer(_ entry: TranscriptEntry) {
        guard draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              attachedImages.isEmpty else {
            notice = "Send or clear your draft before editing a message."
            return
        }
        draft = entry.text
        attachedImages = (entry.images ?? []).compactMap(AttachedImage.init(dataURL:))
    }

    // MARK: - Socket lifecycle

    private func connect() {
        if conversationLoadError == nil {
            connectionState =
                (entries.isEmpty || awaitingCreation) ? .connecting : .reconnecting(nil)
        }
        let socket = socketFactory()
        socket.onEvent = { [weak self] event in self?.handle(event) }
        socket.onClose = { [weak self] reason in self?.scheduleReconnect(reason) }
        socket.setMutationRejectedHandler { [weak self] message in self?.notice = message }
        self.socket = socket
        socket.connect()
    }

    private func scheduleReconnect(_ reason: String?) {
        guard !stopped else { return }
        if conversationLoadError == nil { connectionState = .reconnecting(reason) }
        // A history page died with the socket; the watch's fresh
        // transcript_init is what unblocks paging again, so don't leave the
        // control spinning on a request nobody will answer.
        loadingEarlier = false
        endJump(landed: false)
        // Presence is only true while the socket that reported it is up; the
        // rejoin brings fresh frames.
        otherViewers = []
        otherTypingUsers = []
        stopTyping()
        reconnectTask?.cancel()
        let delay = isServerHandoffPending
            ? Self.handoffReconnectDelay
            : Self.reconnectDelay
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !self.stopped, !Task.isCancelled else { return }
            self.connect()
        }
    }

    func retryConversationLoad() {
        guard !stopped else { return }
        conversationLoadError = nil
        isLoadingConversation = true
        reconnectTask?.cancel()
        socket?.disconnect()
        socket = nil
        armConversationLoadDeadline()
        connect()
    }

    private func armConversationLoadDeadline() {
        conversationLoadTask?.cancel()
        guard isLoadingConversation else { return }
        conversationLoadTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.conversationLoadTimeout ?? 15))
            guard let self, !Task.isCancelled, !self.stopped, self.isLoadingConversation else { return }
            self.conversationLoadError = "The conversation did not load. Check the connection and try again."
            self.connectionState = .failed("Couldn't load conversation")
            self.isLoadingConversation = false
        }
    }

    // MARK: - Event handling

    /// Internal (not private) so unit tests can drive the event state machine
    /// with raw frames without a live socket.
    func handle(_ event: ServerEvent) {
        lastEventAt = Date()
        switch event {
        case .hello:
            isServerHandoffPending = false
            connectionState = .connected
            // A replacement socket defaults to present. Restore scene focus
            // before joining the session so a background reconnect never
            // flashes (or remains) as an active viewer.
            if isAway { socket?.setAway(true) }
            // Watch after the handshake frame so the send cannot race the upgrade.
            socket?.watch(sessionId: session.id, resume: transcriptResume)
            // A completed handshake is proof the server is reachable — better
            // evidence than any network path status, so anything waiting out a
            // backoff goes now.
            outbox.clearBackoff()
            outbox.poke()

        case .serverRestarting:
            isServerHandoffPending = true

        case .transcriptInit(let id, let newEntries, let cursor) where id == session.id:
            creationRetryTask?.cancel()
            conversationLoadTask?.cancel()
            conversationLoadError = nil
            // A fresh session's first init can arrive before the engine wrote
            // anything — keep the optimistic prompt bubble rather than blanking
            // the conversation; the real entries land via transcript_append.
            if awaitingCreation && newEntries.isEmpty && !entries.isEmpty {
                awaitingCreation = false
                isLoadingConversation = false
                applyHistoryCursor(cursor)
                applyTranscriptSnapshotCursor(cursor)
                loadingEarlier = false
                endJump()
                break
            }
            awaitingCreation = false
            // Entries the snapshot adds under ids we didn't hold arrived
            // while we were out of sync — they are the only echo candidates
            // for chips and optimistic bubbles. Matching the WHOLE snapshot
            // used to false-positive on repeated sends ("continue"): an old
            // identical message retired the fresh chip and blinked the
            // message out until its real echo landed.
            let knownIds = Set(entries.map(\.id))
            resyncAssistantCandidates = if isRunning && knownIds.isEmpty {
                // First-load snapshots are all "new" locally; none can be
                // attributed to the current stream safely.
                []
            } else {
                newEntries.filter {
                    $0.isAssistant && !knownIds.contains($0.id)
                }
            }
            for candidate in newEntries
            where candidate.isUser && !knownIds.contains(candidate.id) {
                for chip in queuedItems + steeredItems + deliveringItems
                where chipDelivered(chip, in: candidate.text) {
                    landedChipIds.insert(chip.id)
                }
                rememberLandedUserEntry(candidate)
            }
            // Optimistic bubbles whose echo the snapshot doesn't carry
            // survive the resync: an init can race the ~1s persist of a
            // delivered send — or the send was QUEUED server-side behind a
            // run this client thought idle — and wiping the bubble blinks
            // the message out until it finally lands.
            let pendingEchoes = entries.filter { echo in
                localEchoIds.contains(echo.id) && !newEntries.contains { durable in
                    !knownIds.contains(durable.id)
                        && (echo.id == "local-\(durable.id)"
                            || echoDelivered(echo, in: durable))
                }
            }
            entries = newEntries + pendingEchoes
            isLoadingConversation = false
            liveEntries.removeAll()
            localEchoIds = Set(pendingEchoes.map(\.id))
            retireSentAskAnswer(against: newEntries)
            // A resync snapshot is authoritative for landed messages — no
            // upsert runs on it, so retire delivered chips here.
            if !deliveringItems.isEmpty {
                updateDelivering(deliveringItems.filter { !messageLanded($0) })
            }
            applyHistoryCursor(cursor)
            applyTranscriptSnapshotCursor(cursor)
            // A rev-mismatch reply to load_history comes back as a fresh init.
            loadingEarlier = false
            // Also how a legacy jump lands (the whole transcript at once), and
            // how a resync during a walk stops it — either way the reader is
            // taken to the oldest entry now on screen.
            endJump()
            rebuildDisplayItems()
            // A reconnect can include the durable form of a cached live
            // response. Reconcile only once that stream is known finished.
            reconcileFinishedLiveText()

        case .transcriptHistory(let id, let older, let cursor) where id == session.id:
            let known = Set(entries.map(\.id))
            let added = older.filter { !known.contains($0.id) }
            entries.insert(contentsOf: added, at: 0)
            applyHistoryCursor(cursor)
            loadingEarlier = false
            historyPrependSeq += 1
            rebuildDisplayItems()
            continueJump(added: added.count)

        case .transcriptAppend(let id, let appended, let cursor) where id == session.id:
            upsert(appended)
            applyTranscriptAppendCursor(cursor)
            retireSentAskAnswer(against: appended)
            // Landed durably — drop the ephemeral copies (match by id, or by
            // toolUseId in case the two channels mint different entry ids).
            liveEntries.removeAll { live in
                appended.contains {
                    $0.id == live.id
                        || ($0.type == live.type && $0.toolUseId != nil
                            && $0.toolUseId == live.toolUseId)
                }
            }
            // A mid-run assistant block that lands as a durable entry must be
            // stripped from the live bubble and graduated entries (it would
            // render twice otherwise). Blocks the strip does NOT find are
            // remembered so a stream_text that arrives AFTER the append is
            // dropped instead of re-adding the block. Flush the coalescing
            // buffer first so a block split across flushed + pending text
            // still matches.
            flushLiveTextNow()
            for entry in appended where entry.isAssistant && !entry.text.isEmpty {
                if let streamed = liveBlockText.removeValue(forKey: entry.id) {
                    // The block named itself on the way in: take out exactly
                    // what it contributed, however much of it arrived.
                    landedBlockIds.insert(entry.id)
                    _ = stripLanded(streamed)
                    continue
                }
                if stripLanded(entry.text) { continue }
                if !liveText.isEmpty, entry.text.hasPrefix(liveText) {
                    // The entry landed while the block's tail was still
                    // streaming: clear what is on screen and swallow the rest.
                    landedStreamTexts.append(String(entry.text.dropFirst(liveText.count)))
                    liveText = ""
                } else {
                    landedStreamTexts.append(entry.text)
                }
            }
            landedStreamTexts = Array(landedStreamTexts.suffix(30))
            if liveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                liveText = ""
                if streamEnded { isStreaming = false }
            }
            rebuildDisplayItems()

        case .sessionNote(let id, let note) where id == session.id:
            upsertSessionNote(note)

        case .sessionNoteDeleted(let id, let noteId) where id == session.id:
            removeSessionNote(id: noteId)

        case .streamStart(let id) where id == session.id:
            liveFlushTask?.cancel()
            liveFlushTask = nil
            pendingLiveText = ""
            liveText = ""
            liveEntries = []
            landedStreamTexts = []
            liveBlockText = [:]
            landedBlockIds = []
            resyncAssistantCandidates = []
            replySuggestions = []
            isStreaming = true
            streamEnded = false
            rebuildDisplayItems()

        case .streamText(let id, let text, let blockId) where id == session.id:
            isStreaming = true
            // Live typing is the account's choice (Settings > Preferences),
            // default off. Dropping the frame is the whole implementation:
            // the block still arrives as a durable entry over
            // transcript_append, which is what filled the transcript before
            // streaming existed. isStreaming is set above either way, so the
            // run still reads as working.
            guard NativePreferences.liveTypingIsOn else { break }
            if let blockId {
                guard !landedBlockIds.contains(blockId) else { break }
                liveBlockText[blockId, default: ""] += text
                appendLiveText(text)
                break
            }
            // No id to match on: the front of what is still outstanding is
            // this frame's text when the entry beat the block's own tail.
            if let landed = landedStreamTexts.firstIndex(where: { $0.hasPrefix(text) }) {
                let rest = String(landedStreamTexts[landed].dropFirst(text.count))
                if rest.isEmpty { landedStreamTexts.remove(at: landed) }
                else { landedStreamTexts[landed] = rest }
            } else {
                appendLiveText(text)
            }

        case .streamEntry(let id, let entry) where id == session.id:
            guard !entries.contains(where: { $0.id == entry.id }) else { break }
            graduateLiveText()
            if let index = liveEntries.firstIndex(where: { $0.id == entry.id }) {
                liveEntries[index] = entry
            } else {
                liveEntries.append(entry)
            }
            rebuildDisplayItems()

        case .streamDone(let id) where id == session.id:
            streamEnded = true
            flushLiveTextNow()

        case .presence(let id, let viewers) where id == session.id:
            otherViewers = Self.otherViewers(viewers, me: ServerConfig.shared.userName)

        case .typing(let id, let users) where id == session.id:
            otherTypingUsers = Self.otherViewers(users, me: ServerConfig.shared.userName)

        // The create flow's frame carries no session id — that socket is
        // already scoped to this conversation — so an unaddressed one is ours.
        case .usageUpdate(let id, let latest) where id == nil || id == session.id:
            usage = latest

        case .sessionStatus(let id, let running, let safety) where id == session.id:
            #if DEBUG
            if holdsSafetyScreenshot { break }
            #endif
            session.safety = safety
            let effectiveRunning = safety == nil && running
            let completed = isRunning && !effectiveRunning
            if effectiveRunning {
                // Keep the earliest known anchor across resync re-sends.
                if runStartedAt == nil {
                    runStartedAt = session.runStartedDate ?? Date()
                }
            } else {
                runStartedAt = nil
            }
            isRunning = effectiveRunning
            if completed {
                NativeNotifications.post(
                    event: "runComplete",
                    title: session.displayTitle,
                    body: "The session finished running."
                )
            }
            if !effectiveRunning {
                streamEnded = true
                isStreaming = false
                flushLiveTextNow()
                reconcileFinishedLiveText()
                // Unmatched liveText is not cleared here: the durable entry
                // usually lands via transcript_append a beat later (1s file
                // watcher) and the strip there clears it. Wiping now blinks.
                // A finished run often just opened or pushed to a PR — refresh
                // the chip/panel (served from the server's PR cache, so cheap).
                loadPr()
            }

        case .workspaceStatus(let id, let ready) where id == session.id:
            workspaceReadyOverride = ready

        case .modelChanged(let id, let model, _) where id == session.id:
            session.model = model

        case .queueUpdate(let id, let queued, let steered, let pendingIds)
            where id == session.id:
            hasDetailedQueue = true
            pendingDeliveryIds = Set(pendingIds)
            let priorChips = queuedItems + steeredItems + deliveringItems
            var transcriptChanged = false
            // A queued row promoted with Send now can reach this frame just
            // before its durable transcript append. Move that exact id into
            // chat immediately; the append then replaces it instead of adding
            // a second row. Direct composer steers already have local-<id>.
            for deliveryId in pendingDeliveryIds
            where !entries.contains(where: { $0.id == deliveryId }) {
                guard let chip = priorChips.first(where: { $0.id == deliveryId }) else {
                    continue
                }
                entries.append(TranscriptEntry(
                    id: deliveryId,
                    type: "user",
                    content: chip.content,
                    timestamp: ISO8601DateFormatter().string(from: .now),
                    images: chip.images.isEmpty ? nil : chip.images
                ))
                transcriptChanged = true
            }
            // If the durable row beat this frame, retire its direct-send echo
            // by identity rather than fuzzy text matching.
            for deliveryId in pendingDeliveryIds
            where entries.contains(where: { $0.id == deliveryId }) {
                let localId = "local-\(deliveryId)"
                if localEchoIds.remove(localId) != nil {
                    entries.removeAll { $0.id == localId }
                    transcriptChanged = true
                }
            }
            if transcriptChanged { rebuildDisplayItems() }
            // A chip that vanishes from the server's queue without its message
            // having landed in the transcript is mid-delivery: the drain
            // broadcasts the emptied queue before the engine turn writes the
            // user entry (which reaches us via the ~1s file watcher). Hold it
            // as "delivering" instead of blinking the message out of the UI.
            // A chip the frame still lists — by id, or by content for a local
            // chip being replaced with the server's copy — is simply replaced.
            let incoming = queued + steered
            // A send echoed as a thread bubble (the session looked idle) that
            // the server actually QUEUED behind a run: the chip is now the
            // message's representation — it enters the transcript only at the
            // drain — so drop the bubble rather than showing an out-of-order
            // thread copy the next resync would wipe.
            if !localEchoIds.isEmpty {
                let queuedContents = Set(incoming.map {
                    $0.content.trimmingCharacters(in: .whitespacesAndNewlines)
                })
                let orphaned = Set(entries.filter { echo in
                    localEchoIds.contains(echo.id) && queuedContents.contains(
                        echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    )
                }.map(\.id))
                if !orphaned.isEmpty {
                    localEchoIds.subtract(orphaned)
                    entries.removeAll { orphaned.contains($0.id) }
                    rebuildDisplayItems()
                }
            }
            var held = Set<String>()
            updateDelivering(
                (queuedItems + steeredItems + deliveringItems).filter { chip in
                    guard held.insert(chip.id).inserted else { return false }
                    let replaced = incoming.contains {
                        $0.id == chip.id || $0.content == chip.content
                    }
                    return !replaced
                        && !pendingDeliveryIds.contains(chip.id)
                        && !messageLanded(chip)
                }
            )
            // The two lists render as separate rows, so an id claimed by both
            // would show the same message twice, labelled "steering" AND
            // "queued". A steer receipt is the further-along state, so it wins.
            let steeredIds = Set(steered.map(\.id))
            queuedItems = queued.filter { !steeredIds.contains($0.id) }
            steeredItems = steered
            // Landed flags outlive their purpose once the chip is gone.
            landedChipIds.formIntersection(
                Set((queuedItems + steeredItems + deliveringItems).map(\.id))
            )
        case .queuedPromptTaken(let id, let queueId, let item, let message)
            where id == session.id:
            guard let item else {
                notice = message ?? "That queued message could not be edited."
                break
            }
            removeChip(item)
            deliveringItems.removeAll { $0.id == queueId }
            deliveringSince.removeValue(forKey: queueId)
            draft = draft.isEmpty ? item.content : draft + "\n\n" + item.content
            attachedImages.append(
                contentsOf: item.images.compactMap(AttachedImage.init(dataURL:))
            )

        case .askQuestion(let id, let question) where id == session.id:
            let isNewQuestion = pendingQuestion?.id != question.id
            pendingQuestion = question
            if sentAskAnswer?.id != question.id { sentAskAnswer = nil }
            if isNewQuestion {
                NativeNotifications.post(
                    event: "needsInput",
                    title: session.displayTitle,
                    body: "The session needs your input."
                )
            }

        case .askResolved(let id, let questionId) where id == session.id:
            if pendingQuestion?.id == questionId { pendingQuestion = nil }

        case .replySuggestions(let id, let suggestions) where id == session.id:
            replySuggestions = suggestions

        case .slackComposer(let id, let request) where id == session.id:
            if let request, request.id == slackComposeReceipt?.requestId { break }
            pendingSlackComposer = request
            if request != nil { slackComposeReceipt = nil }

        case .slackComposerResolved(let id, let receipt) where id == session.id:
            resolveSlackComposer(receipt)

        case .workflowUpdate(let id, let run) where id == session.id:
            upsertWorkflowRun(run)

        case .gitPushed(let id, _) where id == session.id:
            loadPr()

        case .prUpdated(let repo, let branch) where matchesPrUpdate(
            repo: repo, branch: branch
        ):
            loadPr()

        case .serverError(let message)
        where awaitingCreation && message == "Session not found":
            // Freshly created session the server hasn't persisted yet — re-send
            // the watch until it exists (usually a few seconds, up to ~15s on a
            // slow engine boot) instead of surfacing an error.
            creationRetriesLeft -= 1
            guard creationRetriesLeft > 0 else {
                awaitingCreation = false
                notice = "Session is taking unusually long to appear — pull the list to refresh."
                break
            }
            creationRetryTask?.cancel()
            creationRetryTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.5))
                guard let self, !Task.isCancelled, !self.stopped else { return }
                self.socket?.watch(
                    sessionId: self.session.id, resume: self.transcriptResume
                )
            }

        case .notice(let message), .serverError(let message):
            #if DEBUG
            if holdsScreenshotFixture && message == "Session not found" { break }
            #endif
            // A server notice is something that happened to the SESSION — a
            // run that failed, a sandbox that wasn't there, a rebuild that
            // paused — so it joins the transcript in order, which is where
            // the web viewer puts these same frames and where the session's
            // own notices already render. Pinning it over the composer put a
            // fact about the work on the field you type in, and left it
            // sitting there long after the thing it described was over.
            //
            // Connection churn is the exception: a socket dropping is not an
            // event in the session's history, and re-reporting it on every
            // reconnect would write the transcript full of it.
            // An empty frame is the server clearing, not an event.
            guard !message.isEmpty else { notice = nil; break }
            let normalized = message.lowercased()
            let isConnectionChurn =
                normalized.contains("connect") || normalized.contains("socket")
            if isConnectionChurn {
                if case .connected = connectionState {} else { break }
            }
            noteLocally(message, tone: NoticeTone.derived(fromText: message))

        default:
            break
        }
    }

    /// Transcript entries prepared for display: each tool_use is merged with
    /// its tool_result (matched on toolUseId, or the server's `tr-<id>`
    /// convention) into one collapsible item; orphan results stay standalone.
    enum DisplayItem: Identifiable, Equatable {
        case entry(TranscriptEntry)
        /// `isLive` distinguishes the current stream from incomplete historical
        /// entries, which may not have a matching result after a reload.
        case toolCall(use: TranscriptEntry, result: TranscriptEntry?, isLive: Bool)

        var id: String {
            switch self {
            case .entry(let entry): entry.id
            case .toolCall(let use, _, _): "tool-\(use.id)"
            }
        }
    }

    /// Stored, not computed: rebuilt only when entries/liveEntries mutate.
    /// As a computed property it re-ran (dictionary builds and all) on every
    /// body evaluation — including each ~8Hz liveText flush mid-stream.
    private(set) var displayItems: [DisplayItem] = []

    /// What the transcript actually renders: `displayItems` folded into turns
    /// (see `TranscriptGrouping`). `displayItems` stays flat because the
    /// scroll pin follows its count — grouping alone would hold that count
    /// steady while a live turn grows, and new output would stop following.
    private(set) var displayBlocks: [TranscriptBlock] = []
    @ObservationIgnored private var thinkingMessages = ThinkingMessages(
        UserDefaults.standard.string(forKey: ThinkingMessages.storageKey)
    )
    /// The current person's visible prompts, prepared beside the transcript
    /// blocks so a pointer moving over the rail never scans the conversation.
    private(set) var sentMessageAnchors: [SentMessageAnchor] = []

    /// The web offers Continue only when the final rendered block is an error
    /// notice. Keep that rule here so a later message, warning, footer, note,
    /// or review loop makes an older failure inert on every native surface.
    func failureContinuationEntryId(catalog: ModelCatalog?) -> String? {
        let nativeSource = session.source == "opensession" || session.source == "backstage"
        let hasEngine = session.ran == true
        let effectiveModel = model.isEmpty ? (catalog?.defaultModel ?? "") : model
        let codexCanStartFresh = catalog?.option(for: effectiveModel)?.provider == "codex"
            || effectiveModel.hasPrefix("gpt") || effectiveModel.hasPrefix("codex")
        guard !isRunning, nativeSource || hasEngine || codexCanStartFresh,
              case .message(let entry)? = displayBlocks.last,
              entry.notice?.tone == NoticeTone.error.rawValue
        else { return nil }
        return entry.id
    }
    /// Hide entries at or before this instant from the transcript (the Desk's
    /// stale-conversation cutoff). Setting it re-groups immediately.
    var hideBefore: Date? {
        didSet { if hideBefore != oldValue { rebuildDisplayItems() } }
    }
    /// How many entries `hideBefore` is currently holding back, for the
    /// "Show earlier conversation" affordance.
    private(set) var hiddenEarlierCount = 0

    /// Fold state, kept off the observation graph — see `FoldStateStore`.
    /// It outlives the view tree because `@State` inside a `LazyVStack` row is
    /// destroyed the moment the row leaves the realization window.
    @ObservationIgnored private let folds = FoldStateStore()

    func foldState(for turn: WorkTurn, preference: TurnActivity) -> TurnFoldState {
        folds.fold(for: turn, preference: preference)
    }

    func expansionState(id: String, defaultExpanded: Bool = false) -> TurnFoldState {
        folds.expansion(id: id, defaultExpanded: defaultExpanded)
    }

    func setThinkingMessages(_ value: ThinkingMessages) {
        guard value != thinkingMessages else { return }
        thinkingMessages = value
        rebuildDisplayItems()
    }

    /// Which block currently renders `entryId`. A history page can regroup an
    /// entry into a turn with a different id, so callers that need to find it
    /// after the regroup resolve through the entry rather than the block.
    func blockId(containing entryId: String) -> String? {
        displayBlocks.first { $0.entryIds.contains(entryId) }?.id
    }

    /// The oldest entry currently held by the transcript.
    var topmostEntryId: String? {
        displayBlocks.first?.entryIds.first
    }

    private func rebuildDisplayItems() {
        // Durable file-ordered entries first, then the ephemeral live tail.
        // A conversation left days ago isn't one you're in: the Desk sets a
        // cutoff so it opens on its board instead of yesterday's chat. Display
        // only — nothing is dropped, and clearing the cutoff brings it back.
        var entries = self.entries
        if let hideBefore {
            let kept = entries.filter { ($0.timestampDate ?? .distantFuture) > hideBefore }
            hiddenEarlierCount = entries.count - kept.count
            entries = kept
        } else {
            hiddenEarlierCount = 0
        }
        var all = entries
        let knownIds = Set(entries.map(\.id))
        all.append(contentsOf: liveEntries.filter { !knownIds.contains($0.id) })

        sentMessageAnchors = SentMessageIndex.collect(
            from: all,
            owner: session.transcriptOwner,
            viewerName: ServerConfig.shared.userName,
            viewerLogin: ServerConfig.shared.githubLogin
        )

        let items = TranscriptGrouping.displayItems(
            from: all,
            liveIds: Set(liveEntries.map(\.id))
        )
        displayItems = items
        displayBlocks = TranscriptGrouping.blocks(
            from: items,
            live: isRunning || isStreaming,
            worktreeDir: session.worktreeDir,
            walkthrough: session.walkthrough,
            notes: sessionNotes,
            reviewResult: ReviewLoopResult(session: session),
            thinkingMessages: thinkingMessages
        )
        // What the transcript may link: the files this session's own tools
        // touched. Registering the set here — rather than fetching the diff —
        // costs nothing and keeps a link and its target in step, since a
        // touched file is a file the diff has.
        FileLinks.register(paths: linkableFilePaths(), for: session.id)
        // And the scratch files it wrote — the same set the footer chips
        // offer, so naming one in prose opens exactly what the chip does.
        AssetLinks.register(paths: linkableAssetPaths(), for: session.id)
    }

    /// Repo-relative paths from every turn's touched files. A path outside the
    /// worktree stays absolute or `~/`-shortened (ToolPresentation.tidyPath),
    /// and the Changes panel has no diff for it, so it is not linkable.
    private func linkableFilePaths() -> Set<String> {
        var paths: Set<String> = []
        // Flattened: work a review loop folded away is still work this session
        // did, and prose that names one of its files must still link.
        for block in displayBlocks.flatMap(\.flattened) {
            let touched: [TouchedFile] = switch block {
            case .work(let turn): turn.touchedFiles
            case .footer(let footer): footer.files
            case .tool(let item): item.presentation.touchedFiles
            default: []
            }
            for file in touched
            where !file.path.hasPrefix("/") && !file.path.hasPrefix("~") {
                paths.insert(file.path)
            }
        }
        return paths
    }

    /// The scratch files this session's `write_asset` calls produced. A turn
    /// that has settled names them on its footer; one still running has them
    /// only on the tool rows inside its fold, and prose written before the
    /// footer exists should still link.
    private func linkableAssetPaths() -> Set<String> {
        var paths: Set<String> = []
        for block in displayBlocks.flatMap(\.flattened) {
            switch block {
            case .footer(let footer):
                paths.formUnion(footer.assets)
            case .tool(let item):
                if let path = item.assetPath { paths.insert(path) }
            case .work(let turn):
                for case .tool(let item) in turn.items {
                    if let path = item.assetPath { paths.insert(path) }
                }
            default:
                break
            }
        }
        return paths
    }

    private func upsert(_ incoming: [TranscriptEntry]) {
        for entry in incoming {
            // Current single-message turns use the delivery id as their durable
            // row id. Batched turns name every source separately. Retire those
            // identities before any legacy text fallback so repeated messages
            // cannot claim one another.
            if entry.isUser {
                let sourceIds = Set(entry.sourceMessageIds ?? [])
                let exactIds = sourceIds.union([entry.id])
                for sourceId in exactIds {
                    let localId = "local-\(sourceId)"
                    if localEchoIds.remove(localId) != nil {
                        entries.removeAll { $0.id == localId }
                    }
                }
                if !sourceIds.isEmpty {
                    queuedItems.removeAll {
                        sourceIds.contains($0.id)
                            || ($0.id.hasPrefix("local-queued-")
                                && sourceIds.contains(String($0.id.dropFirst("local-queued-".count))))
                    }
                    steeredItems.removeAll { sourceIds.contains($0.id) }
                    if deliveringItems.contains(where: { sourceIds.contains($0.id) }) {
                        updateDelivering(
                            deliveringItems.filter { !sourceIds.contains($0.id) }
                        )
                    }
                    pendingDeliveryIds.subtract(sourceIds)
                    landedChipIds.formUnion(sourceIds)
                }
            }
            if let index = entries.firstIndex(where: { $0.id == entry.id }) {
                entries[index] = entry
            } else {
                // Drop the optimistic copy once the server's own user entry
                // arrives — verbatim, or the attributed/batched drain form
                // for a send that spent time in the queue.
                if entry.isUser, let localIndex = entries.firstIndex(where: {
                    localEchoIds.contains($0.id) && echoDelivered($0, in: entry)
                }) {
                    localEchoIds.remove(entries[localIndex].id)
                    entries.remove(at: localIndex)
                }
                // A send made while the run looked busy but was actually
                // delivered straight to the engine (run ended in the gap)
                // never gets a queue_update — retire its local chip when the
                // server's user entry lands instead.
                if entry.isUser, let chipIndex = queuedItems.firstIndex(where: {
                    $0.id.hasPrefix("local-queued-") && chipDelivered($0, in: entry.text)
                }) {
                    queuedItems.remove(at: chipIndex)
                }
                // The durable copy of a delivering chip's message landing is
                // the hand-off the holding state exists for — one entry can
                // retire several chips (multi-message drains join a batch
                // into a single attributed user entry).
                if entry.isUser,
                   deliveringItems.contains(where: { chipDelivered($0, in: entry.text) }) {
                    updateDelivering(
                        deliveringItems.filter { !chipDelivered($0, in: entry.text) }
                    )
                }
                // Chips the server still lists as queued/steered when their
                // echo lands are remembered — the eventual drain drops them
                // outright instead of holding a delivered message as a
                // "Delivering…" ghost.
                if entry.isUser {
                    for chip in queuedItems + steeredItems
                    where chipDelivered(chip, in: entry.text) {
                        landedChipIds.insert(chip.id)
                    }
                    rememberLandedUserEntry(entry)
                }
                entries.append(entry)
            }
        }
    }

    private func upsertSessionNote(_ note: SessionNote) {
        deletedSessionNoteIds.remove(note.id)
        if let index = sessionNotes.firstIndex(where: { $0.id == note.id }) {
            sessionNotes[index] = note
        } else {
            sessionNotes.append(note)
        }
        sessionNotes.sort { $0.ts < $1.ts }
        rebuildDisplayItems()
    }

    private func removeSessionNote(id: String) {
        deletedSessionNoteIds.insert(id)
        sessionNotes.removeAll { $0.id == id }
        rebuildDisplayItems()
    }

    private func mergeSessionNotes(_ incoming: [SessionNote]) {
        var merged = Dictionary(uniqueKeysWithValues: sessionNotes.map { ($0.id, $0) })
        for note in incoming where !deletedSessionNoteIds.contains(note.id) {
            if let current = merged[note.id], noteVersion(current) > noteVersion(note) {
                continue
            }
            merged[note.id] = note
        }
        sessionNotes = merged.values.sorted { $0.ts < $1.ts }
        rebuildDisplayItems()
    }

    private func noteVersion(_ note: SessionNote) -> Double {
        note.editedAt ?? note.ts
    }

    // MARK: - Delivering chips

    /// Whether a landed user entry's text is the delivered form of `chip`:
    /// bare, attributed ("[user] content" — the steer and batched-drain
    /// form), or embedded in a joined batch / fenced-context wrapper.
    /// Containment mirrors the server's own steer-receipt reconciliation.
    private func chipDelivered(_ chip: QueueItem, in text: String) -> Bool {
        let content = chip.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return true }
        return text.contains(content)
    }

    /// Whether `chip`'s message has landed SINCE the chip existed. Reads the
    /// flags marked by `upsert` and the resync path — a whole-transcript text
    /// scan here retired fresh chips against old identical messages and
    /// blinked repeated sends out of the UI until their real echo arrived.
    private func messageLanded(_ chip: QueueItem) -> Bool {
        landedChipIds.contains(chip.id)
    }

    /// Whether a server user entry is the delivered form of an optimistic
    /// echo bubble: verbatim, or embedded in the attributed/batched drain
    /// form ("[user] content").
    private func echoDelivered(_ echo: TranscriptEntry, in entry: TranscriptEntry) -> Bool {
        guard entry.isUser else { return false }
        if entry.content == echo.content { return true }
        return Self.delivers(content: echo.text, in: entry.text)
    }

    /// The text half of `echoDelivered`, for a message that has no entry yet —
    /// the claim in `acceptDelivery` matches an outbox item's raw content
    /// against a user entry that already landed.
    private static func delivers(content: String, in text: String) -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        return text.contains(trimmed)
    }

    /// Remember a server user entry as a possible answer to a send still
    /// waiting for its delivery reply. Bounded in both directions: a send this
    /// old has long since been echoed or given up on.
    private func rememberLandedUserEntry(_ entry: TranscriptEntry) {
        let now = Date()
        landedUserEntries.append((id: entry.id, text: entry.text, at: now))
        let cutoff = now.addingTimeInterval(-Self.landedUserEntryGrace)
        landedUserEntries.removeAll { $0.at < cutoff }
        if landedUserEntries.count > Self.landedUserEntryLimit {
            landedUserEntries.removeFirst(
                landedUserEntries.count - Self.landedUserEntryLimit
            )
        }
    }

    private static let landedUserEntryGrace: TimeInterval = 30 * 60
    private static let landedUserEntryLimit = 50

    private func updateDelivering(_ items: [QueueItem]) {
        deliveringItems = items
        let now = Date()
        var since: [String: Date] = [:]
        for item in items { since[item.id] = deliveringSince[item.id] ?? now }
        deliveringSince = since
        deliveringPruneTask?.cancel()
        deliveringPruneTask = nil
        guard !items.isEmpty else { return }
        deliveringPruneTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !Task.isCancelled else { return }
                self.pruneExpiredDelivering()
                if self.deliveringItems.isEmpty { return }
            }
        }
    }

    /// Drop delivering chips whose transcript echo never came (deleted from
    /// another device, server restart) once the grace window passes.
    /// Internal so tests can drive it with a fixed clock.
    func pruneExpiredDelivering(now: Date = Date()) {
        let live = deliveringItems.filter { chip in
            guard let start = deliveringSince[chip.id] else { return true }
            return now.timeIntervalSince(start) < deliveringGrace
        }
        guard live.count != deliveringItems.count else { return }
        updateDelivering(live)
    }
}
