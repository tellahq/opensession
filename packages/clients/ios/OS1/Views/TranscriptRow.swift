import SwiftUI

/// Renders one transcript block: prompts as right-aligned bubbles, answers as
/// plain left-aligned markdown, a turn's work as a collapsible fold, and
/// system events as centered pills toned by severity.
struct TranscriptRow: View {
    let block: TranscriptBlock
    let sessionId: String
    /// Repo root for tidying paths inside nested views (the sub-agent sheet).
    var worktreeDir: String?
    /// Resolves fold/expansion state that has to outlive the row scrolling
    /// out of the lazy stack.
    let foldState: (WorkTurn) -> TurnFoldState
    /// Id, and whether it starts open — a walkthrough does, everything else
    /// that folds inside a row starts closed.
    let expansionState: (String, Bool) -> TurnFoldState
    /// Where a turn's work rests, and whether that includes its tool calls.
    var activity = TurnActivity.standard
    /// True only for a trailing standalone reasoning row in a live transcript.
    /// Work turns derive the same state from `WorkTurn.isLive`.
    var isActiveReasoning = false
    /// Who started this session, for crediting turns that carry no explicit
    /// sender (see `UserBubble`). Nil for automations and sub-agents.
    var owner: String?
    var outbox: Outbox?
    var onEditMessage: ((TranscriptEntry) -> Void)?
    var onEditUnsent: ((Outbox.Item) -> Void)?
    var onDeleteUnsent: ((Outbox.Item) -> Void)?
    var onEditNote: ((SessionNote, String) async throws -> Void)?
    var onDeleteNote: ((SessionNote) async throws -> Void)?
    var onForkMessage: ((TranscriptEntry) -> Void)?
    var failureContinuation: FailureContinuationAction? = nil

    var body: some View {
        switch block {
        case .message(let entry):
            // A notice is anything that isn't someone talking, whatever
            // produced it — the server already decided which.
            if let notice = entry.notice {
                // An answered question is history in the live card's own
                // visual language, so the decision stays scannable. The
                // entry-level `ask` is the compatibility spot for a server
                // that predates `notice.ask`.
                if notice.kind == "ask", let ask = notice.ask ?? entry.ask {
                    AnsweredAskCard(ask: ask)
                } else {
                    NoticeRow(
                        entry: entry,
                        notice: notice,
                        state: expansionState("notice-\(entry.id)", false),
                        failureContinuation: failureContinuation
                    )
                }
            } else if entry.isUser {
                UserBubble(
                    entry: entry,
                    sessionId: sessionId,
                    owner: owner,
                    outbox: outbox,
                    onEdit: onEditMessage,
                    onEditUnsent: onEditUnsent,
                    onDeleteUnsent: onDeleteUnsent,
                    onFork: onForkMessage
                )
            } else if entry.isAssistant, entry.isReasoning == true {
                ReasoningSummaryRow(entry: entry, isActive: isActiveReasoning)
            } else if entry.isAssistant {
                AssistantMessage(
                    entry: entry,
                    sessionId: sessionId,
                    state: expansionState("body-\(entry.id)", false),
                    onFork: onForkMessage
                )
            } else {
                // A system entry from a server too old to classify it.
                NoticeRow(
                    entry: entry,
                    notice: EntryNotice(
                        kind: "system",
                        title: entry.text,
                        tone: NoticeTone.derived(from: entry).rawValue,
                        body: nil,
                        link: nil,
                        ask: nil,
                        icon: nil
                    ),
                    state: expansionState("notice-\(entry.id)", false)
                )
            }
        case .tool(let item):
            ToolCallRow(
                item: item,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: expansionState(item.id, item.hasFeaturedMedia)
            )
        case .work(let turn):
            TurnBlockView(
                turn: turn,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: foldState(turn),
                activity: activity,
                expansionState: expansionState
            )
        case .footer(let footer):
            TurnFooterView(footer: footer, sessionId: sessionId)
        case .walkthrough(let walkthrough):
            // Folded unless the reader opens it: a walkthrough is a screenful
            // of video and a screenful per before/after pair, and it sits in
            // the middle of a conversation that continues after it. Folded is
            // not hidden here — the card keeps a strip of its pictures, which
            // is the part a reader usually wants.
            WalkthroughCard(
                walkthrough: walkthrough,
                state: expansionState(block.id, false)
            )
        case .reviewLoop(let loop):
            // Folded by default, like the web: a settled loop's header already
            // says what it concluded, and the rounds behind it are automation.
            ReviewLoopView(
                loop: loop,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: expansionState(block.id, false),
                expansionState: expansionState
            )
        case .note(let note):
            SessionNoteRow(
                note: note,
                sessionId: sessionId,
                onEdit: isMine(note) ? { text in
                    guard let onEditNote else { return }
                    try await onEditNote(note, text)
                } : nil,
                onDelete: isMine(note) ? {
                    guard let onDeleteNote else { return }
                    try await onDeleteNote(note)
                } : nil
            )
        }
    }

    private func isMine(_ note: SessionNote) -> Bool {
        note.user.trimmingCharacters(in: .whitespacesAndNewlines)
            .localizedCaseInsensitiveCompare(
                ServerConfig.shared.userName.trimmingCharacters(in: .whitespacesAndNewlines)
            ) == .orderedSame
    }
}

private struct SessionNoteRow: View {
    let note: SessionNote
    let sessionId: String
    var onEdit: ((String) async throws -> Void)?
    var onDelete: (() async throws -> Void)?

    @State private var editing = false
    @State private var draft: String
    @State private var busy = false
    @State private var error: String?

    init(
        note: SessionNote,
        sessionId: String,
        onEdit: ((String) async throws -> Void)? = nil,
        onDelete: (() async throws -> Void)? = nil
    ) {
        self.note = note
        self.sessionId = sessionId
        self.onEdit = onEdit
        self.onDelete = onDelete
        _draft = State(initialValue: note.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                UserAvatar(person: note.user, size: 18)
                Text(note.user)
                    .font(.caption.weight(.semibold))
                Text("Note")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.yellowInk)
                Text(note.date, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                if note.editedAt != nil {
                    Text("· edited")
                        .font(.caption2)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                }
                Spacer(minLength: 4)
                if onEdit != nil || onDelete != nil {
                    Menu {
                        if onEdit != nil {
                            Button {
                                draft = note.text
                                editing = true
                            } label: {
                                Label("Edit", systemImage: "square.and.pencil")
                            }
                        }
                        if let onDelete {
                            Button(role: .destructive) {
                                Task {
                                    do { try await onDelete() }
                                    catch { self.error = error.localizedDescription }
                                }
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .menuIndicator(.hidden)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Note actions")
                }
            }
            if editing {
                TextEditor(text: $draft)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(OS1VisualStyle.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(OS1VisualStyle.yellow.opacity(0.5), lineWidth: 1)
                    }
                    .frame(minHeight: 96)
                    .disabled(busy)
                HStack(spacing: 12) {
                    Button("Save") { save() }
                        .buttonStyle(.borderedProminent)
                        .tint(OS1VisualStyle.accent)
                        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel") {
                        draft = note.text
                        editing = false
                    }
                    .buttonStyle(.borderless)
                    .disabled(busy)
                    Spacer()
                }
                .font(.subheadline.weight(.medium))
            } else {
                if !note.text.isEmpty {
                    // An attributed string, so a mention reads as a name and a
                    // pasted URL is tappable: the same two tokens the web
                    // bubble marks up. See `NoteText` for why a note does not
                    // go through the markdown pipeline.
                    Text(NoteText.attributed(note.text))
                        .font(.body)
                        .foregroundStyle(OS1VisualStyle.text)
                        .textSelection(.enabled)
                }
                if let images = note.images, !images.isEmpty {
                    ConversationImageStrip(
                        sources: images,
                        sessionId: sessionId,
                        size: 140
                    )
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            OS1VisualStyle.yellow.opacity(0.10),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .alert("Couldn't change note", isPresented: Binding(
            get: { error != nil },
            set: { if !$0 { error = nil } }
        )) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "Try again.")
        }
        .onChange(of: note.text) { _, text in
            if !editing { draft = text }
        }
    }

    private func save() {
        guard let onEdit, !busy else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard text != note.text else {
            editing = false
            return
        }
        busy = true
        Task {
            do {
                try await onEdit(text)
                editing = false
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Messages

/// A person's message. No name label — the right alignment already says who
/// wrote it — unless someone ELSE wrote this turn, in which case the label is
/// the only thing that says so: the server strips the "[Name] " prefix and the
/// "💬 X answered" header out of the text.
///
/// "Someone else" has two sources, and the second one is easy to miss. A
/// teammate who steered or answered into the session arrives with an explicit
/// `sender`. But the session OWNER's own prompts carry no sender at all — so
/// reading a teammate's session, every one of their messages used to render
/// exactly like your own, and a chat you were only visiting looked like a chat
/// you had written. `owner` is the fallback the web has always applied
/// (`e.sender ?? owner`), and the label is suppressed when that resolves to
/// you.
struct UserBubble: View {
    let entry: TranscriptEntry
    let sessionId: String
    /// Who started this session — the author of any turn without an explicit
    /// sender. Nil for automations (whose turns aren't a person's words) and
    /// for sub-agent transcripts.
    var owner: String?
    var outbox: Outbox?
    var onEdit: ((TranscriptEntry) -> Void)?
    var onEditUnsent: ((Outbox.Item) -> Void)?
    var onDeleteUnsent: ((Outbox.Item) -> Void)?
    var onFork: ((TranscriptEntry) -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme

    private var outboxItem: Outbox.Item? {
        guard entry.id.hasPrefix("local-") else { return nil }
        return outbox?.item(id: String(entry.id.dropFirst("local-".count)))
    }

    /// The name to credit, and whether it came back through Slack. Nil when
    /// this turn is the viewer's own. The rule itself lives in
    /// `MessageAttribution` so it can be tested without a view.
    private var attribution: MessageAttribution.Credit? {
        MessageAttribution.credit(
            sender: entry.sender,
            senderVia: entry.senderVia,
            owner: owner,
            viewerName: ServerConfig.shared.userName,
            viewerLogin: ServerConfig.shared.githubLogin
        )
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 6) {
                if let attribution {
                    Text(
                        attribution.viaSlack
                            ? "💬 \(attribution.name) · via Slack"
                            : attribution.name
                    )
                    .font(.caption2.weight(.semibold))
                    // A reply routed back from Slack is warmer than a plain
                    // steer — the web tints it the same teal, so the two
                    // clients read alike at a glance.
                    .foregroundStyle(
                        attribution.viaSlack
                            ? OS1VisualStyle.humanReply
                            : OS1VisualStyle.textFaint
                    )
                }
                ConversationImageStrip(
                    sources: entry.images ?? [],
                    sessionId: sessionId,
                    alignment: .trailing
                )
                ConversationVideoStrip(
                    sources: entry.videos ?? [],
                    sessionId: sessionId,
                    alignment: .trailing
                )
                if !entry.text.isEmpty {
                    let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
                    Text(entry.text)
                        .font(.body)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .foregroundStyle(OS1VisualStyle.text)
                        .userMessagePanelCompat(
                            in: shape,
                            // A teammate's routed-back reply gets its own
                            // surface, like the web's: a neutral grey bubble
                            // would read as the driver's own words.
                            tint: attribution?.viaSlack == true
                                ? OS1VisualStyle.humanReply.opacity(0.12)
                                : nil
                        )
                        .overlay {
                            if needsHairline {
                                shape.stroke(OS1VisualStyle.border, lineWidth: 0.5)
                            }
                        }
                        .textSelection(.enabled)
                        .contextMenu {
                            Button {
                                copyToPasteboard(entry.text)
                            } label: {
                                Label("Copy message", systemImage: "doc.on.doc")
                            }
                            if let item = outboxItem, let onEditUnsent {
                                Button {
                                    onEditUnsent(item)
                                } label: {
                                    Label("Edit message", systemImage: "square.and.pencil")
                                }
                            } else if attribution == nil, let onEdit {
                                Button {
                                    onEdit(entry)
                                } label: {
                                    Label("Edit and send again", systemImage: "square.and.pencil")
                                }
                            }
                            if outboxItem == nil, let onFork {
                                Button {
                                    onFork(entry)
                                } label: {
                                    Label("Fork from here", systemImage: "arrow.triangle.branch")
                                }
                            }
                            TimestampLabel(date: entry.timestampDate)
                        }
                }
                if let item = outboxItem, let outbox {
                    OutboxMessageStatus(
                        item: item,
                        isSending: outbox.sendingId == item.id,
                        onEdit: onEditUnsent.map { edit in { edit(item) } },
                        onRetry: item.failed ? { outbox.retry(id: item.id) } : nil,
                        onDelete: { onDeleteUnsent?(item) }
                    )
                }
            }
            .frame(maxWidth: userMessageMaxWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var userMessageMaxWidth: CGFloat {
        #if os(macOS)
        520
        #else
        .infinity
        #endif
    }

    /// Whether the bubble needs a drawn edge, or whether its fill already is
    /// one. On iOS in light appearance the bubble sits a clear 14/255 under
    /// `chatCanvas`, and a separator on top of that step reads as a box drawn
    /// round the words rather than as a message. Everywhere else the step is
    /// too small to carry the shape alone: dark puts the bubble a few points
    /// over a near-black page, and on the Mac it is the LIFTED surface, about
    /// 6/255 off the window background in light.
    private var needsHairline: Bool {
        #if os(macOS)
        true
        #else
        colorScheme == .dark
        #endif
    }
}

/// Delivery state stays attached to the message it describes. A send can be
/// retried for minutes or refused outright, and neither should turn the chat
/// blank after the composer has already cleared.
private struct OutboxMessageStatus: View {
    let item: Outbox.Item
    let isSending: Bool
    var onEdit: (() -> Void)?
    var onRetry: (() -> Void)?
    let onDelete: () -> Void

    private var isError: Bool { item.failed || item.attempts > 0 }

    private var label: String {
        if item.failed {
            return item.lastError.map { "Couldn’t send: \($0)" } ?? "Couldn’t send"
        }
        if item.attempts > 0 {
            return item.lastError.map { "Couldn’t send. Retrying: \($0)" }
                ?? "Couldn’t send. Retrying…"
        }
        return isSending ? "Sending…" : "Waiting to send…"
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Label(label, systemImage: isError ? "exclamationmark.circle.fill" : "arrow.up.circle")
                .font(.caption)
                .foregroundStyle(isError ? OS1VisualStyle.redInk : OS1VisualStyle.textFaint)
                .multilineTextAlignment(.trailing)
                .lineLimit(3)
            HStack(spacing: 16) {
                if let onRetry {
                    Button("Retry", action: onRetry)
                        .foregroundStyle(OS1VisualStyle.redInk)
                }
                if let onEdit {
                    Button("Edit", action: onEdit)
                }
                Button("Delete", role: .destructive, action: onDelete)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(OS1VisualStyle.textDim)
            .buttonStyle(.plain)
            .frame(minHeight: 40)
        }
    }
}

/// Provider reasoning is visible activity, not an answer. A generated bold
/// heading is normalized to regular-weight quiet text; any body keeps markdown
/// structure at the same dimmed hierarchy.
struct ReasoningSummaryRow: View {
    let entry: TranscriptEntry
    var isActive = false

    private var display: ReasoningSummaryDisplay {
        ReasoningSummaryDisplay(entry.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = display.activityTitle(isActive: isActive) {
                if isActive {
                    ActiveReasoningTitle(title: title)
                } else {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
            }
            if !display.body.isEmpty {
                MarkdownBody(display.body, dimmed: true)
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .contextMenu {
            Button {
                copyToPasteboard(entry.text)
            } label: {
                Label("Copy reasoning summary", systemImage: "doc.on.doc")
            }
            TimestampLabel(date: entry.timestampDate)
        }
        .accessibilityLabel(isActive ? "Active reasoning" : "Reasoning summary")
        .accessibilityValue(entry.text)
    }
}

/// A small isolated animation subtree. Its timeline redraws only this title,
/// never the transcript row or lazy stack around it. Reduce Motion does not
/// instantiate a timeline and uses the brighter, static endpoint instead.
private struct ActiveReasoningTitle: View {
    let title: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                label.foregroundStyle(OS1VisualStyle.text)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    let cycle = context.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: 1.8) / 1.8
                    label
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .overlay {
                            label
                                .foregroundStyle(OS1VisualStyle.text)
                                .mask {
                                    GeometryReader { geometry in
                                        let width = max(36, geometry.size.width * 0.42)
                                        LinearGradient(
                                            colors: [.clear, .black, .clear],
                                            startPoint: .leading,
                                            endPoint: .trailing
                                        )
                                        .frame(width: width)
                                        .offset(x: (geometry.size.width + width) * cycle - width)
                                    }
                                }
                        }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
    }

    private var label: some View {
        Text(title).font(.body)
    }
}

/// The agent's answer renders plain — no bubble, the shape modern AI chat
/// apps converge on, since only the person's own messages need containing.
struct AssistantMessage: View {
    let entry: TranscriptEntry
    let sessionId: String
    let state: TurnFoldState
    var onFork: ((TranscriptEntry) -> Void)? = nil

    /// Markdown parsing is superlinear, so only this much is parsed up front;
    /// the rest waits behind an explicit tap. Phones are the constrained end
    /// of this — a 200 KB answer would otherwise block the main thread on
    /// every re-render.
    private static let eagerCharacters = 6_000
    /// Past this the expanded body renders as preformatted text: markdown at
    /// that size costs more than it adds.
    private static let markdownCeiling = 32 * 1024

    @State private var fullText: String?
    @State private var loadingFull = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ConversationImageStrip(sources: entry.images ?? [], sessionId: sessionId)
            ConversationVideoStrip(sources: entry.videos ?? [], sessionId: sessionId)
            if !entry.text.isEmpty || state.expanded {
                bodyContent
            }
            if let label = expanderLabel {
                Button {
                    expand()
                } label: {
                    HStack(spacing: 5) {
                        if loadingFull {
                            ProgressView().controlSize(.mini)
                        }
                        Text(loadingFull ? "Loading…" : label)
                    }
                    .font(.footnote.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(OS1VisualStyle.link)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button {
                copyToPasteboard(fullText ?? entry.text)
            } label: {
                Label("Copy message", systemImage: "doc.on.doc")
            }
            if let onFork {
                Button {
                    onFork(entry)
                } label: {
                    Label("Fork from here", systemImage: "arrow.triangle.branch")
                }
            }
            TimestampLabel(date: entry.timestampDate)
            if let model = entry.model, !model.isEmpty {
                Label(
                    "Written by \(TranscriptFormat.modelLabel(model))",
                    systemImage: "sparkles"
                )
            }
        }
    }

    @ViewBuilder
    private var bodyContent: some View {
        let text = visibleText
        if state.expanded, text.count > Self.markdownCeiling {
            // Preformatted, and scrollable in its own right: an enormous
            // answer should not stretch the transcript to its full height.
            ScrollView {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 520)
        } else {
            MarkdownBody(text)
        }
    }

    /// What's on screen right now: the whole message when it fits or has been
    /// expanded, otherwise a head cut at a line boundary so the preview never
    /// ends mid-word.
    private var visibleText: String {
        let text = fullText ?? entry.text
        guard !state.expanded, text.count > Self.eagerCharacters else { return text }
        let head = text.prefix(Self.eagerCharacters)
        if let lastBreak = head.lastIndex(of: "\n"), lastBreak > head.startIndex {
            return String(head[head.startIndex..<lastBreak])
        }
        return String(head)
    }

    private var isClamped: Bool {
        entry.contentClamped == true && fullText == nil
    }

    private var expanderLabel: String? {
        if state.expanded, !isClamped { return "Collapse" }
        let known = entry.contentLength ?? (fullText ?? entry.text).count
        guard isClamped || known > Self.eagerCharacters else { return nil }
        return "Show full message · \(TranscriptFormat.size(known))"
    }

    private func expand() {
        if state.expanded {
            state.toggle()
            return
        }
        // A wire-clamped entry only carries a head; the rest lives on the
        // server and is fetched the first time someone asks for it.
        guard isClamped else {
            state.toggle()
            return
        }
        guard !loadingFull else { return }
        loadingFull = true
        Task {
            fullText = try? await OS1API.fullEntryContent(
                sessionId: sessionId,
                entryId: entry.id
            )
            loadingFull = false
            state.expanded = true
        }
    }
}

/// Timestamps have no hover home on a phone, so they live in the menu.
private struct TimestampLabel: View {
    let date: Date?

    var body: some View {
        if let date {
            Label(
                date.formatted(date: .abbreviated, time: .shortened),
                systemImage: "clock"
            )
        }
    }
}

// MARK: - System notices

/// Everything in a transcript that isn't someone talking, as one centered
/// pill: a runner line, a recap, a compaction, a worker's report, review
/// findings, a heads-up from another session, a restart resume.
///
/// The server hands over a title, a tone, and at most one body and one action
/// (`EntryNotice`), so this view never asks what KIND of notice it is —
/// adding a tenth kind must not add a tenth rendering. Severity rides the tone
/// rather than more words: a failure that reads identically to "model changed"
/// is a failure nobody notices.
struct NoticeRow: View {
    let entry: TranscriptEntry
    let notice: EntryNotice
    let state: TurnFoldState
    var failureContinuation: FailureContinuationAction? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL

    private var tone: NoticeTone { NoticeTone(rawValue: notice.tone) ?? .info }
    private var showsBody: Bool {
        notice.showsBodyInline || (notice.isCollapsible && state.expanded)
    }

    /// Matches the web transcript: passive and warning notices are centered
    /// directly on the transcript. Only an error earns a tinted surface.
    private var hasBackground: Bool { tone == .error }

    var body: some View {
        Group {
            if tone == .error, let failureContinuation {
                VStack(spacing: 8) {
                    content
                    FailureContinuationButton(action: failureContinuation)
                }
            } else {
                content
            }
        }
        .padding(.horizontal, hasBackground ? 12 : 0)
        .padding(.vertical, 7)
        .frame(maxWidth: 520)
        .background(
            hasBackground ? tone.background : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: toggleNotice)
        .accessibilityAddTraits(accessibilityTraits)
        .accessibilityValue(
            notice.isCollapsible ? (state.expanded ? "Expanded" : "Collapsed") : ""
        )
    }

    /// A title-only notice is a short centered pill — the shape every
    /// operational line in the transcript shares. A notice with an inline body
    /// (a recap) is prose instead, so its label runs into the text on one
    /// left-aligned block, the way the web reads it: centering the label over
    /// a left-aligned paragraph left it floating loose above someone else's
    /// sentence.
    @ViewBuilder private var content: some View {
        if notice.showsBodyInline, !entry.text.isEmpty {
            let title = Text("\(notice.title): ")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tone.color)
            let body = Text(entry.text)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
            Text("\(title)\(body)")
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if let symbol = tone.symbol ?? notice.iconSymbol {
                        Image(systemName: symbol)
                            .font(.caption2)
                    }
                    // The title is one line and stays one line. The body
                    // below is where the detail lives, which is what kept a
                    // folded notice from printing its whole text twice.
                    Text(notice.title)
                        .lineLimit(notice.isCollapsible && !state.expanded ? 2 : nil)
                    if notice.isCollapsible {
                        Text(state.expanded ? "hide" : "show")
                            .foregroundStyle(OS1VisualStyle.link)
                    }
                }
                .font(.footnote)
                .foregroundStyle(tone.color)
                .multilineTextAlignment(.center)

                if showsBody, !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // At most one action ("Open worker"): routed through the
                // same private-scheme link a transcript session chip uses,
                // so the id resolves and pushes like any other session link.
                if let link = notice.link,
                   let url = SessionLinks.url(for: link.sessionId) {
                    Button(link.label) { openURL(url) }
                        .buttonStyle(.plain)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.link)
                }
            }
        }
    }

    private func toggleNotice() {
        guard notice.isCollapsible else { return }
        if reduceMotion {
            state.toggle()
        } else {
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { state.toggle() }
        }
    }

    private var accessibilityTraits: AccessibilityTraits {
        if notice.isCollapsible {
            .isButton
        } else if tone == .error && failureContinuation == nil {
            .isStaticText
        } else {
            []
        }
    }
}

struct FailureContinuationAction {
    let viewModel: SessionViewModel
    let noticeId: String
}

private struct FailureContinuationButton: View {
    let action: FailureContinuationAction

    private var status: SessionViewModel.FailureContinuationStatus {
        action.viewModel.failureContinuationStatus(for: action.noticeId)
    }

    var body: some View {
        VStack(spacing: 5) {
            Button {
                Haptics.play(.send)
                action.viewModel.continueAfterFailure(noticeId: action.noticeId)
            } label: {
                HStack(spacing: 6) {
                    if status == .sending {
                        ProgressView().controlSize(.small)
                    }
                    Text(label)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(status == .sending)

            if case .failed(let message) = status {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.red)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var label: String {
        switch status {
        case .available: "Continue"
        case .sending: "Continuing…"
        case .failed: "Try again"
        }
    }
}

// `NoticeTone` — the tone this row and the composer's chip both wear — lives
// in `Models/NoticeTone.swift`.

// MARK: - Streaming

/// Assistant text streaming in over `stream_text` frames, before the durable
/// transcript entry exists. Only rendered once text is available.
struct StreamingBubble: View {
    let text: String

    var body: some View {
        Group {
            if let heading = ReasoningSummaryDisplay.liveHeading(text) {
                ActiveReasoningTitle(title: heading)
                    .accessibilityLabel("Active reasoning")
                    .accessibilityValue(heading)
            } else {
                StreamingMarkdownBody(text)
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The live run, at the end of the transcript: an amber pulse and the
/// ticking clock, sitting directly under the last message so it reads as
/// something that message is still doing. It used to ride the composer, which
/// put the state on the field you type in rather than on the work.
struct RunStatusFooter: View {
    let since: Date?

    var body: some View {
        HStack(spacing: 6) {
            // Amber is the in-progress colour everywhere else in the app —
            // the sessions list's in-progress lane, the tab strip's running
            // pill — so the transcript says "running" in the same voice.
            PulsingDot(color: OS1VisualStyle.yellowInk, size: 6)
            RunElapsedLabel(since: since)
                .font(.caption2.weight(.medium))
                .foregroundStyle(OS1VisualStyle.yellowInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Working")
    }
}

/// Ticking elapsed-run clock ("8.3s", "2m 14s", "1h 5m") — the web viewer's
/// BusyElapsed format. Falls back to "Running" with no anchor.
struct RunElapsedLabel: View {
    let since: Date?

    var body: some View {
        if let since {
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                Text(label(elapsed: context.date.timeIntervalSince(since)))
                    .monospacedDigit()
            }
        } else {
            Text("Running")
        }
    }

    private func label(elapsed: TimeInterval) -> String {
        let s = max(0, elapsed)
        if s < 60 { return String(format: "%.1fs", s) }
        let total = Int(s)
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3600)h \((total % 3600) / 60)m"
    }
}
