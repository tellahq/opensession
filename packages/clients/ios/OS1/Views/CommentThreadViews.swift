import SwiftUI

// Comment threads in the native session view: the team note in the timeline,
// the strip of comments under a passage's row, the thread sheet, the new
// comment sheet and the comments list. Mirrors the web's
// components/comments/ and NoteBubble.tsx.
//
// Everything here reads `SessionComments` itself, so a reply or a resolve
// re-renders these views and never `SessionView.body` (AGENTS.md).

/// What a transcript row needs to show and act on threads. Absent in hosts
/// with no session to write to (a sub-agent pane), which show notes read-only.
struct CommentsContext {
    let viewModel: SessionViewModel
    var comments: SessionComments { viewModel.comments }
}

@MainActor private var agentName: String {
    let name = InstanceIdentity.shared.personaName.trimmingCharacters(in: .whitespaces)
    return name.isEmpty ? "the agent" : name
}

private func isMe(_ name: String?) -> Bool {
    CommentThreads.sameUser(name, ServerConfig.shared.userName)
}

private func commentTime(_ date: Date) -> String {
    Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
}

// MARK: - Timeline note

/// A team note in the timeline: a thread with no passage. A resolved one folds
/// to a line so the timeline stays readable; a long one shows its opener and
/// latest replies, and the rest opens in the thread sheet.
struct TimelineThreadCard: View {
    let thread: CommentThread
    let sessionId: String
    var context: CommentsContext?

    @State private var expanded = false
    @State private var onScreen = false
    /// The newest comment a receipt went out for, so one is sent per comment
    /// even while its echo is in flight.
    @State private var seenSentFor: String?
    /// Replies shown in the timeline before the rest fold behind a button.
    private static let inlineReplies = 3

    private var live: CommentThread { context?.comments.thread(id: thread.id) ?? thread }

    var body: some View {
        let thread = live
        VStack(alignment: .leading, spacing: 10) {
            if thread.isResolved, !expanded {
                folded(thread)
            } else {
                ThreadBadges(thread: thread)
                CommentItemView(
                    thread: thread,
                    comment: thread.root,
                    sessionId: sessionId,
                    context: context,
                    label: "Note",
                    trailing: context.map { context in
                        AnyView(ThreadActionsMenu(thread: thread, context: context))
                    }
                )
                let replies = Array(thread.comments.dropFirst())
                if replies.count > Self.inlineReplies, let context {
                    Button {
                        context.comments.focus(thread.id)
                    } label: {
                        Text("Show \(replies.count - Self.inlineReplies) earlier replies")
                            .font(.footnote.weight(.medium))
                    }
                    .buttonStyle(.borderless)
                    .padding(.leading, 26)
                }
                ForEach(replies.suffix(Self.inlineReplies)) { comment in
                    CommentItemView(thread: thread, comment: comment, sessionId: sessionId, context: context)
                }
                if thread.agentIsAnswering() { AgentAnsweringRow() }
                NoteSeenRow(receipts: NoteReceipts.tagged(thread, people: NoteReceipts.roster))
                if let context, !thread.legacy {
                    HStack(spacing: 14) {
                        Button {
                            context.comments.focus(thread.id)
                        } label: {
                            Label(thread.isResolved ? "Reply to reopen" : "Reply", systemImage: "arrowshape.turn.up.left")
                        }
                        if thread.comments.contains(where: \.agent), !thread.isResolved {
                            Button {
                                context.viewModel.sendThreadToSession(thread)
                            } label: {
                                Label("Send to session", systemImage: "arrow.up.right")
                            }
                        }
                        if thread.isResolved {
                            Button("Fold") { expanded = false }
                        }
                    }
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.borderless)
                    .padding(.leading, 26)
                    .frame(minHeight: 32)
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
        .accessibilityElement(children: .contain)
        .onScrollVisibilityChange(threshold: 0.5) { onScreen = $0 }
        .task(id: seenOwedKey) { await markSeenAfterDwell() }
    }

    /// How long a note must stay on screen before it counts as seen.
    private static let seenDwell: Duration = .seconds(1)

    private var latestKey: String {
        "\(live.comments.last?.id ?? ""):\(live.comments.count)"
    }

    /// Set while my receipt is owed and the note is on screen; nil otherwise,
    /// which cancels a pending dwell.
    private var seenOwedKey: String? {
        let thread = live
        guard context != nil, !thread.legacy, onScreen,
              !(thread.isResolved && !expanded),
              seenSentFor != latestKey,
              NoteReceipts.needsSeenMark(thread, me: ServerConfig.shared.userName, people: NoteReceipts.roster)
        else { return nil }
        return "\(thread.id)|\(latestKey)"
    }

    private func markSeenAfterDwell() async {
        guard seenOwedKey != nil, let context else { return }
        do { try await Task.sleep(for: Self.seenDwell) } catch { return }
        // Read at the end of the dwell rather than observed: a scene-phase
        // environment read here would invalidate every note row.
        guard AppLifecycle.isActive else { return }
        let key = latestKey
        let thread = live
        // Clearing the key cancels this task, so the request runs on its own.
        seenSentFor = key
        Task {
            do {
                try await context.viewModel.markThreadSeen(thread)
            } catch {
                if seenSentFor == key { seenSentFor = nil }
            }
        }
    }

    private func folded(_ thread: CommentThread) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark")
                .font(.caption.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
            UserAvatar(person: thread.root.user, size: 18)
            Text("\(Text(thread.root.user).fontWeight(.semibold).foregroundStyle(OS1VisualStyle.text)) \u{00b7} \(thread.preview())")
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
            Spacer(minLength: 4)
            if thread.replyCount > 0 {
                Text(thread.replyCount == 1 ? "1 reply" : "\(thread.replyCount) replies")
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
            Button("Show") { expanded = true }
                .font(.footnote.weight(.medium))
                .buttonStyle(.borderless)
                .frame(minHeight: 32)
        }
    }
}

// MARK: - Read receipt

/// Under a note: which of the people its newest comment tags have seen it.
/// Faded faces have not yet. Nothing when nobody is tagged (web `NoteSeen`).
struct NoteSeenRow: View {
    let receipts: [TagReceipt]

    var body: some View {
        if let line = NoteReceipts.line(receipts) {
            HStack(spacing: 6) {
                HStack(spacing: -4) {
                    ForEach(receipts.prefix(3), id: \.name) { receipt in
                        UserAvatar(person: receipt.name, size: 14)
                            .opacity(receipt.seenAt == nil ? 0.4 : 1)
                    }
                }
                Text(line)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, 25)
            .help(detail)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(line.replacingOccurrences(of: " \u{00b7} ", with: ". "))
        }
    }

    private var detail: String {
        receipts.map { receipt in
            "\(receipt.name) \u{00b7} " + (receipt.seenAt.map {
                commentTime(Date(timeIntervalSince1970: $0 / 1_000))
            } ?? "not seen")
        }
        .joined(separator: "\n")
    }
}

// MARK: - Passage strip

/// The comments on passages of one transcript row, under it. Each opens its
/// thread; the quote says which words it is about, since the native
/// renderer's text cannot carry the web's live highlight.
struct AnchoredThreadsStrip: View {
    let entryIds: [String]
    let context: CommentsContext

    var body: some View {
        let threads = context.comments.inlineThreads(in: entryIds)
        if !threads.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(threads) { thread in
                    Button {
                        context.comments.focus(thread.id)
                    } label: {
                        AnchoredThreadChip(thread: thread)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the comment thread")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct AnchoredThreadChip: View {
    let thread: CommentThread

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: thread.isResolved ? "checkmark.bubble" : "text.bubble")
                .font(.footnote)
                .foregroundStyle(thread.isResolved ? OS1VisualStyle.textFaint : OS1VisualStyle.yellowInk)
                .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 3) {
                if let exact = thread.anchor?.exact {
                    Text(exact)
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    UserAvatar(person: thread.root.user, size: 14)
                    Text(thread.root.user).font(.caption.weight(.semibold))
                    Text(thread.preview(length: 60))
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .lineLimit(1)
                    if thread.replyCount > 0 {
                        Text("\u{00b7} \(thread.replyCount)")
                            .font(.caption2)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            OS1VisualStyle.yellow.opacity(thread.isResolved ? 0.04 : 0.10),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(OS1VisualStyle.yellow.opacity(thread.isResolved ? 0.3 : 0.8))
                .frame(width: 2)
                .padding(.vertical, 6)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Pieces

struct ThreadBadges: View {
    let thread: CommentThread

    var body: some View {
        if thread.assignee != nil || thread.isResolved {
            HStack(spacing: 8) {
                if let assignee = thread.assignee {
                    HStack(spacing: 4) {
                        UserAvatar(person: assignee, size: 14)
                        Text(isMe(assignee) ? "Assigned to you" : "Assigned to \(assignee)")
                            .lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .padding(.vertical, 2)
                    .padding(.leading, 3)
                    .padding(.trailing, 8)
                    .background(OS1VisualStyle.text.opacity(0.08), in: Capsule())
                }
                if thread.isResolved {
                    Label(
                        thread.resolvedBy.map { "Resolved by \($0)" } ?? "Resolved",
                        systemImage: "checkmark"
                    )
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                }
            }
        }
    }
}

/// The passage a thread points at, for surfaces away from it.
struct ThreadPassage: View {
    let anchor: TextAnchor

    var body: some View {
        Text(anchor.exact)
            .font(.subheadline)
            .foregroundStyle(OS1VisualStyle.textDim)
            .lineLimit(4)
            .padding(.leading, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle().fill(OS1VisualStyle.yellow).frame(width: 2)
            }
            .textSelection(.enabled)
    }
}

struct AgentAnsweringRow: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("\(agentName) is reading the session")
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

struct CommentItemView: View {
    let thread: CommentThread
    let comment: ThreadComment
    let sessionId: String
    var context: CommentsContext?
    var label: String?
    var trailing: AnyView?

    @State private var editing = false
    @State private var editText = ""
    @State private var busy = false
    @State private var error: String?

    private var mine: Bool { !comment.agent && isMe(comment.user) }
    private var canDelete: Bool { mine || comment.agent }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                if comment.agent {
                    Image(systemName: "sparkles")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.accent)
                        .frame(width: 18, height: 18)
                } else {
                    UserAvatar(person: comment.user, size: 18)
                }
                Text(comment.user)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if let label {
                    Text(label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.yellowInk)
                }
                Text(commentTime(comment.date) + (comment.editedAt != nil ? " \u{00b7} edited" : ""))
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let trailing {
                    trailing
                } else if context != nil, canDelete, !editing {
                    Menu {
                        if mine {
                            Button { beginEdit() } label: { Label("Edit", systemImage: "pencil") }
                        }
                        Button(role: .destructive) { delete() } label: { Label("Delete", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .menuIndicator(.hidden)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Comment actions")
                }
            }
            Group {
                if editing {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Edit comment", text: $editText, axis: .vertical)
                            .textFieldStyle(.plain)
                            .lineLimit(2...8)
                            .padding(8)
                            .background(OS1VisualStyle.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(OS1VisualStyle.yellow.opacity(0.5), lineWidth: 1)
                            }
                            .disabled(busy)
                        HStack(spacing: 12) {
                            Button("Save") { save() }
                                .buttonStyle(.borderedProminent)
                                .tint(OS1VisualStyle.accent)
                                .disabled(busy || editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button("Cancel") { editing = false }
                                .buttonStyle(.borderless)
                                .disabled(busy)
                        }
                        .font(.subheadline.weight(.medium))
                    }
                } else {
                    if !comment.text.isEmpty {
                        if comment.agent {
                            MarkdownBody(comment.text, richBlocks: false)
                        } else {
                            Text(NoteText.attributed(comment.text))
                                .font(.body)
                                .foregroundStyle(OS1VisualStyle.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if let images = comment.images, !images.isEmpty {
                        ConversationImageStrip(sources: images, sessionId: sessionId, size: 140)
                    }
                }
            }
            .padding(.leading, 25)
        }
        .alert("Couldn't change comment", isPresented: Binding(
            get: { error != nil },
            set: { if !$0 { error = nil } }
        )) {
            Button("OK") { error = nil }
        } message: {
            Text(error ?? "Try again.")
        }
        .onReceive(NotificationCenter.default.publisher(for: .os1EditThreadRoot)) { note in
            guard comment.id == thread.root.id, note.object as? String == thread.id, mine else { return }
            beginEdit()
        }
    }

    private func beginEdit() {
        editText = comment.text
        editing = true
    }

    private func save() {
        guard let context, !busy else { return }
        let text = editText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard text != comment.text else { editing = false; return }
        busy = true
        Task {
            do {
                try await context.viewModel.editThreadComment(thread, comment, text: text)
                editing = false
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func delete() {
        guard let context else { return }
        Task {
            do { try await context.viewModel.deleteThreadComment(thread, comment) }
            catch { self.error = error.localizedDescription }
        }
    }
}

extension Notification.Name {
    /// Start editing a thread's opening comment (from the thread's own menu,
    /// which stands in for that comment's menu).
    static let os1EditThreadRoot = Notification.Name("os1EditThreadRoot")
}

/// The thread's actions, on the opening comment's row: resolve, send to the
/// session, ask the agent, copy the link, assign, and the opener's own edit
/// and delete.
struct ThreadActionsMenu: View {
    let thread: CommentThread
    let context: CommentsContext
    var onResolved: (() -> Void)?

    @State private var error: String?

    private var people: [String] { TeamDirectory.shared.names }

    var body: some View {
        Menu {
            if !thread.legacy {
                Button {
                    run("Couldn't update the comment") {
                        try await context.viewModel.setThreadStatus(thread, thread.isResolved ? .open : .resolved)
                        if !thread.isResolved { onResolved?() }
                    }
                } label: {
                    Label(thread.isResolved ? "Reopen" : "Resolve",
                          systemImage: thread.isResolved ? "arrow.uturn.backward" : "checkmark")
                }
                Button {
                    context.viewModel.sendThreadToSession(thread)
                } label: {
                    Label("Send to session", systemImage: "arrow.up.right")
                }
                Button {
                    run("Couldn't ask \(agentName)") { try await context.viewModel.askAgentInThread(thread) }
                } label: {
                    Label("Ask \(agentName)", systemImage: "sparkles")
                }
                .disabled(thread.agentIsAnswering())
                Button {
                    copyLink()
                } label: {
                    Label("Copy link", systemImage: "link")
                }
                if !people.isEmpty || thread.assignee != nil {
                    Menu {
                        if thread.assignee != nil {
                            Button("Nobody") {
                                run("Couldn't assign") { try await context.viewModel.assignThread(thread, to: nil) }
                            }
                        }
                        ForEach(people.filter { !CommentThreads.sameUser($0, thread.assignee) }, id: \.self) { person in
                            Button(isMe(person) ? "\(person) (you)" : person) {
                                run("Couldn't assign") { try await context.viewModel.assignThread(thread, to: person) }
                            }
                        }
                    } label: {
                        Label("Assign to", systemImage: "person")
                    }
                }
            }
            if !thread.root.agent, isMe(thread.root.user) {
                Divider()
                Button {
                    NotificationCenter.default.post(name: .os1EditThreadRoot, object: thread.id)
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    run("Couldn't delete the comment") {
                        try await context.viewModel.deleteThreadComment(thread, thread.root)
                    }
                } label: {
                    Label(thread.legacy ? "Delete" : "Delete thread", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Thread actions")
        .task { await TeamDirectory.shared.ensureLoaded() }
        .alert(error ?? "", isPresented: Binding(
            get: { error != nil },
            set: { if !$0 { error = nil } }
        )) {
            Button("OK") { error = nil }
        }
    }

    private func run(_ failure: String, _ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { self.error = "\(failure). \(error.localizedDescription)" }
        }
    }

    private func copyLink() {
        let path = CommentThreads.link(sessionId: context.viewModel.session.id, threadId: thread.id)
        let url = ServerConfig.shared.baseURL.flatMap { URL(string: path, relativeTo: $0)?.absoluteString } ?? path
        copyToPasteboard(url)
    }
}

// MARK: - Composer

/// A comment box whose unsent text survives the sheet or row remounting
/// (`CommentDrafts`).
struct CommentComposerField: View {
    let sessionId: String
    let draftKey: String
    let placeholder: String
    let submitLabel: String
    var autoFocus = false
    let onSubmit: (String) async throws -> Void

    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var canSubmit: Bool {
        !busy && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($focused)
                    .disabled(busy)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(OS1VisualStyle.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(OS1VisualStyle.border.opacity(0.8), lineWidth: 1)
                    }
                    .onSubmit {
                        #if os(macOS)
                        submit()
                        #endif
                    }
                Button(action: submit) {
                    if busy {
                        ProgressView().controlSize(.small).frame(width: 36, height: 36)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(canSubmit ? OS1VisualStyle.accent : OS1VisualStyle.textFaint, in: Circle())
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel(submitLabel)
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.red)
            }
        }
        .onAppear {
            text = CommentDrafts.shared.text(session: sessionId, key: draftKey)
            if autoFocus { focused = true }
        }
        .onChange(of: draftKey) { _, key in
            text = CommentDrafts.shared.text(session: sessionId, key: key)
        }
        .onChange(of: text) { _, value in
            CommentDrafts.shared.set(value, session: sessionId, key: draftKey)
        }
    }

    private func submit() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                try await onSubmit(value)
                text = ""
                CommentDrafts.shared.clear(session: sessionId, key: draftKey)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

// MARK: - Sheets

private struct SheetHeader<Trailing: View>: View {
    let title: String
    let onDone: () -> Void
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.headline)
            Spacer(minLength: 8)
            trailing
            Button("Done", action: onDone)
                .keyboardShortcut(.cancelAction)
                .font(.body.weight(.medium))
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }
}

/// One thread, whole: long threads scroll, the reply box stays put.
struct CommentThreadSheet: View {
    let threadId: String
    let context: CommentsContext
    let onClose: () -> Void

    var body: some View {
        let sessionId = context.viewModel.session.id
        VStack(spacing: 0) {
            if let thread = context.comments.thread(id: threadId) {
                SheetHeader(title: thread.anchor == nil ? "Note" : "Comment", onDone: onClose) {
                    if !thread.legacy {
                        Button {
                            Task { try? await context.viewModel.setThreadStatus(thread, thread.isResolved ? .open : .resolved) }
                        } label: {
                            Label(thread.isResolved ? "Reopen" : "Resolve",
                                  systemImage: thread.isResolved ? "arrow.uturn.backward" : "checkmark")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if let anchor = thread.anchor { ThreadPassage(anchor: anchor) }
                            ThreadBadges(thread: thread)
                            ForEach(Array(thread.comments.enumerated()), id: \.element.id) { index, comment in
                                CommentItemView(
                                    thread: thread,
                                    comment: comment,
                                    sessionId: sessionId,
                                    context: context,
                                    trailing: index == 0
                                        ? AnyView(ThreadActionsMenu(thread: thread, context: context))
                                        : nil
                                )
                                .id(comment.id)
                            }
                            if thread.agentIsAnswering() { AgentAnsweringRow() }
                            if thread.comments.contains(where: \.agent), !thread.isResolved {
                                Button {
                                    context.viewModel.sendThreadToSession(thread)
                                    onClose()
                                } label: {
                                    Label("Send to session", systemImage: "arrow.up.right")
                                }
                                .buttonStyle(.bordered)
                            }
                            Color.clear.frame(height: 1).id("thread-end")
                        }
                        .padding(18)
                    }
                    // A long thread opens at its newest comment, next to the
                    // reply box, and follows replies as they land.
                    .defaultScrollAnchor(.bottom)
                    .onChange(of: thread.comments.count) {
                        withAnimation(.smooth(duration: 0.2)) { proxy.scrollTo("thread-end", anchor: .bottom) }
                    }
                }
                if !thread.legacy {
                    Divider()
                    CommentComposerField(
                        sessionId: sessionId,
                        draftKey: CommentDrafts.replyKey(thread.id),
                        placeholder: thread.isResolved ? "Reply to reopen" : "Reply",
                        submitLabel: "Reply"
                    ) { text in
                        try await context.viewModel.replyToThread(thread, text: text)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
            } else {
                SheetHeader(title: "Comment", onDone: onClose) { EmptyView() }
                ContentUnavailableView("This comment was deleted", systemImage: "text.bubble")
            }
        }
        .background(OS1VisualStyle.chatCanvas)
        #if os(macOS)
        .frame(minWidth: 480, idealWidth: 560, minHeight: 420, idealHeight: 640)
        #endif
    }
}

/// Writing a new comment on a passage.
struct NewCommentSheet: View {
    let anchor: TextAnchor
    let context: CommentsContext
    let onClose: () -> Void

    @State private var assignee: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "New comment", onDone: onClose) { EmptyView() }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ThreadPassage(anchor: anchor)
                    if anchor.entryId.isEmpty {
                        Text("This passage could not be matched to a message, so the comment is posted as a note.")
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                    if !TeamDirectory.shared.names.isEmpty {
                        Picker("Assign to", selection: $assignee) {
                            Text("Nobody").tag(String?.none)
                            ForEach(TeamDirectory.shared.names, id: \.self) { person in
                                Text(isMe(person) ? "\(person) (you)" : person).tag(String?.some(person))
                            }
                        }
                        .pickerStyle(.menu)
                    }
                    Text("Tag @agent to have \(agentName) answer here.")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            CommentComposerField(
                sessionId: context.viewModel.session.id,
                draftKey: CommentDrafts.newKey(anchor),
                placeholder: "Comment",
                submitLabel: "Comment",
                autoFocus: true
            ) { text in
                let quoted = anchor.entryId.isEmpty ? CommentThreads.quote(anchor.exact) + "\n\n" + text : text
                try await context.viewModel.createComment(
                    text: quoted,
                    anchor: anchor.entryId.isEmpty ? nil : anchor,
                    assignee: assignee
                )
                onClose()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .background(OS1VisualStyle.chatCanvas)
        .task { await TeamDirectory.shared.ensureLoaded() }
        #if os(macOS)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 340, idealHeight: 420)
        #endif
    }
}

/// Every thread on the session: open, assigned to me, resolved.
struct CommentsListSheet: View {
    let context: CommentsContext
    let onClose: () -> Void
    @State private var filter = CommentThreadFilter.open

    var body: some View {
        let shown = filter.apply(context.comments.threads, me: ServerConfig.shared.userName)
        VStack(spacing: 0) {
            SheetHeader(title: "Comments", onDone: onClose) { EmptyView() }
            Picker("Show", selection: $filter) {
                ForEach(CommentThreadFilter.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 18)
            .padding(.bottom, 10)
            Divider()
            if shown.isEmpty {
                ContentUnavailableView(
                    filter == .resolved ? "No resolved comments" : "No comments",
                    systemImage: "text.bubble",
                    description: Text("Select text in the transcript and choose Comment.")
                )
            } else {
                List(shown) { thread in
                    Button {
                        context.comments.showingList = false
                        context.comments.focus(thread.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            if let anchor = thread.anchor {
                                Text(anchor.exact)
                                    .font(.caption)
                                    .foregroundStyle(OS1VisualStyle.textDim)
                                    .lineLimit(2)
                            }
                            HStack(spacing: 6) {
                                UserAvatar(person: thread.root.user, size: 16)
                                Text(thread.root.user).font(.subheadline.weight(.semibold))
                                Text(commentTime(Date(timeIntervalSince1970: thread.updatedAt / 1_000)))
                                    .font(.caption2)
                                    .foregroundStyle(OS1VisualStyle.textFaint)
                            }
                            Text(thread.preview(length: 140))
                                .font(.subheadline)
                                .foregroundStyle(OS1VisualStyle.text)
                                .lineLimit(3)
                            if thread.replyCount > 0 || thread.assignee != nil {
                                HStack(spacing: 8) {
                                    if thread.replyCount > 0 {
                                        Text(thread.replyCount == 1 ? "1 reply" : "\(thread.replyCount) replies")
                                    }
                                    if let assignee = thread.assignee {
                                        Text(isMe(assignee) ? "Assigned to you" : "Assigned to \(assignee)")
                                    }
                                }
                                .font(.caption)
                                .foregroundStyle(OS1VisualStyle.textDim)
                            }
                        }
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .background(OS1VisualStyle.chatCanvas)
        #if os(macOS)
        .frame(minWidth: 460, idealWidth: 520, minHeight: 420, idealHeight: 600)
        #endif
    }
}

// MARK: - Presenter

/// Attaches the comment sheets to the session view and takes thread links
/// (`ThreadFocus`). Reads comment state in its own body, so presenting a
/// thread never re-evaluates the transcript.
struct SessionCommentsPresenter: ViewModifier {
    let viewModel: SessionViewModel

    func body(content: Content) -> some View {
        let comments = viewModel.comments
        let context = CommentsContext(viewModel: viewModel)
        content
            .sheet(item: Binding(
                get: { comments.presentedThreadId.map(ThreadSheetItem.init) },
                set: { comments.presentedThreadId = $0?.id }
            )) { item in
                CommentThreadSheet(threadId: item.id, context: context) {
                    comments.presentedThreadId = nil
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .sheet(item: Binding(
                get: { comments.pendingAnchor },
                set: { comments.pendingAnchor = $0 }
            )) { anchor in
                NewCommentSheet(anchor: anchor, context: context) {
                    comments.pendingAnchor = nil
                }
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: Binding(
                get: { comments.showingList },
                set: { comments.showingList = $0 }
            )) {
                CommentsListSheet(context: context) { comments.showingList = false }
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .onChange(of: ThreadFocus.shared.generation, initial: true) { takeFocus() }
            .onChange(of: comments.threads.count) { takeFocus() }
    }

    private func takeFocus() {
        let comments = viewModel.comments
        guard let id = ThreadFocus.shared.take(
            sessionId: viewModel.session.id,
            available: { comments.thread(id: $0) != nil }
        ) else { return }
        comments.focus(id)
    }
}

private struct ThreadSheetItem: Identifiable {
    let id: String
}

extension TextAnchor: Identifiable {
    var id: String { "\(entryId)\u{1f}\(exact)\u{1f}\(prefix)\u{1f}\(suffix)" }
}

/// The toolbar's comments button: opens the list, counts open threads.
struct CommentsToolbarButton: View {
    let comments: SessionComments

    var body: some View {
        let open = comments.openCount
        Button {
            comments.showingList = true
        } label: {
            Image(systemName: open > 0 ? "text.bubble.fill" : "text.bubble")
                .foregroundStyle(OS1VisualStyle.text)
        }
        .accessibilityLabel(open > 0 ? "Comments, \(open) open" : "Comments")
        .help("Comments")
    }
}
