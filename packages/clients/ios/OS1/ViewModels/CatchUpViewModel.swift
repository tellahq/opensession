import Foundation
import Observation

/// Drives the catch-up deck: a frozen queue of unread workspaces, each main
/// chat, and the archive / read / keep decisions, with one level of undo.
@Observable
@MainActor
final class CatchUpViewModel {
    enum Action: String, Equatable, Sendable, CaseIterable {
        case archive, read, keep

        var pastTense: String {
            switch self {
            case .archive: "Archived"
            case .read: "Marked read"
            case .keep: "Kept unread"
            }
        }
    }

    /// The main chat rendered inside a card. The blocks use the normal
    /// transcript grouping, so answers, work folds, media, and notices read the
    /// same here as they do after opening the session.
    struct Conversation: Equatable {
        var blocks: [TranscriptBlock]
        var failed = false
    }

    /// A decision that can still be taken back.
    struct Undoable: Equatable, Sendable {
        let card: CatchUpCard
        let action: Action
    }

    /// One repo the deck can be narrowed to, and how much of it is left.
    struct RepoOption: Identifiable, Equatable, Sendable {
        let repo: String
        let remaining: Int

        var id: String { repo }
    }

    private(set) var cards: [CatchUpCard] = []
    /// The cards actually on screen: the frozen queue, minus the ones already
    /// decided, narrowed to the chosen repo. Stored rather than computed so a
    /// drag, which re-reads it every frame, costs one property read.
    private(set) var deck: [CatchUpCard] = []
    /// The repo the deck is narrowed to, or nil for all of them.
    private(set) var repoFilter: String?
    /// Cards decided this run. Holding decisions as a SET rather than walking
    /// an index is what lets the filter change which cards are visible without
    /// losing what you have already done. It is also what lets undo put a card
    /// back in its original place rather than on the end of the queue.
    private var decided: Set<String> = []
    private(set) var conversations: [String: Conversation] = [:]
    private(set) var undoable: Undoable?
    /// How many decisions this run — what the finish screen reports.
    private(set) var handled = 0
    /// True until both inputs have answered. "All caught up" is a CLAIM: made
    /// before the sessions list and the read marks land, it is
    /// indistinguishable from a queue that simply never loaded — which is
    /// exactly what a deck opened straight from a cold launch used to show.
    private(set) var isSettling = true

    /// The queue is built ONCE, on the first load that has sessions in it, and
    /// then frozen: our own mark-read and archive calls (and the 5s poll behind
    /// them) would otherwise reshuffle the deck under the card being swiped.
    /// Freezing on the first build with rows — rather than the first build at
    /// all — keeps a cold launch from stranding the deck on "All caught up"
    /// before the sessions list has answered.
    private var frozen = false

    private var loading: Set<String> = []
    private var undoExpiry: Task<Void, Never>?
    private weak var list: SessionsListViewModel?

    var current: CatchUpCard? { card(atOffset: 0) }
    var next: CatchUpCard? { card(atOffset: 1) }
    var following: CatchUpCard? { card(atOffset: 2) }
    var remaining: Int { deck.count }
    /// Nothing unread at all: the deck never had a card, filter or no filter.
    var isEmpty: Bool { cards.isEmpty }
    /// Everything in the current scope is decided. Scoped, so clearing the one
    /// repo you filtered to finishes that repo rather than claiming the whole
    /// queue is done; the header stays up, so the filter can be widened again.
    var isDone: Bool { scopeTotal > 0 && deck.isEmpty }

    /// How many cards the current filter covers, decided or not. This is the
    /// denominator of the progress bar.
    var scopeTotal: Int { cards.filter { matchesFilter($0) }.count }

    /// What is still waiting OUTSIDE the current filter. Clearing one repo is
    /// not being caught up, and a finish screen that says it is sends you away
    /// from work you asked to set aside for a moment, not to skip.
    var remainingElsewhere: Int {
        cards.filter { !decided.contains($0.id) }.count - deck.count
    }

    /// The card `offset` places behind the current one. The deck renders one
    /// slot deeper than it shows, so a card fades in while the swipe in front
    /// of it is still happening.
    func card(atOffset offset: Int) -> CatchUpCard? {
        deck.indices.contains(offset) ? deck[offset] : nil
    }

    // MARK: - Repo filter

    /// Every repo the queue STARTED with, each with what is left in it.
    ///
    /// Built from the frozen queue rather than from what is left, so the menu
    /// holds still while you work: a repo whose last card you just cleared
    /// reads "0" for the rest of the run instead of vanishing under the finger
    /// on its way to the next item.
    var repoOptions: [RepoOption] {
        var order: [String] = []
        var left: [String: Int] = [:]
        for card in cards {
            if left[card.repo] == nil {
                order.append(card.repo)
                left[card.repo] = 0
            }
            if !decided.contains(card.id) { left[card.repo]! += 1 }
        }
        return order.map { RepoOption(repo: $0, remaining: left[$0] ?? 0) }
    }

    /// Narrow the deck to one repo, or widen it back with nil.
    func setRepoFilter(_ repo: String?) {
        guard repo != repoFilter else { return }
        repoFilter = repo
        // A filter change is a change of subject, and the undo it offered
        // belonged to the last one. A card put back into a scope you are no
        // longer looking at is a button that does nothing you can see.
        dismissUndo()
        refreshDeck()
        prefetch()
    }

    private func matchesFilter(_ card: CatchUpCard) -> Bool {
        repoFilter == nil || card.repo == repoFilter
    }

    private func refreshDeck() {
        deck = cards.filter { !decided.contains($0.id) && matchesFilter($0) }
    }

    // MARK: - Building

    /// Wait for the deck to have something true to say, then stop waiting.
    ///
    /// The sessions list is multi-megabyte and the read marks are their own
    /// request, so opening the deck from a launch (or the `OS1_OPEN_CATCHUP`
    /// hook) beats both. Retrying until either the queue has cards or both
    /// inputs have answered is what turns a permanent "All caught up" into a
    /// brief wait. There is deliberately no deadline: an unread count before
    /// the reads hydrate is not an estimate, it is an unsupported claim.
    func settle(from list: SessionsListViewModel) async {
        while !Task.isCancelled {
            rebuild(from: list)
            if !cards.isEmpty { break }
            if list.hasLoaded, ReadsStore.shared.hasHydrated { break }
            try? await Task.sleep(for: .milliseconds(250))
        }
        isSettling = false
    }

    /// Build (or rebuild, until frozen) the queue from the list the sessions
    /// screen already polls. Cheap enough to call on every appearance.
    func rebuild(from list: SessionsListViewModel) {
        self.list = list
        guard !frozen else { return }
        let reads = ReadsStore.shared
        let config = ServerConfig.shared
        let built = CatchUpQueue.build(
            sessions: list.sessions,
            workspaceNames: list.workspaceNames,
            viewerName: config.userName,
            viewerLogin: config.githubLogin,
            isUnread: { reads.isUnread($0) }
        )
        load(built)
        prefetch()
    }

    /// Install a freshly built queue, freezing it once it has anything in it.
    ///
    /// Split out of `rebuild` because the deck's own rules are worth testing
    /// without a sessions list, a reads store and a server standing behind
    /// them: what the filter hides, what a decision removes, what undo puts
    /// back. It deliberately does not prefetch, because loading transcripts is
    /// `rebuild`'s business rather than the queue's.
    func load(_ built: [CatchUpCard]) {
        guard !frozen else { return }
        cards = built
        if !built.isEmpty { frozen = true }
        refreshDeck()
    }

    // MARK: - Decisions

    func act(_ action: Action) {
        guard let card = current else { return }
        switch action {
        case .read:
            for session in card.sessions { ReadsStore.shared.markRead(session) }
        case .archive:
            // Archiving is enough on its own — an archived row is off the list,
            // and leaving its read mark alone is what lets undo restore it to
            // the unread state it actually had.
            for session in card.sessions { list?.archive(session) }
        case .keep:
            break
        }
        undoable = Undoable(card: card, action: action)
        decided.insert(card.id)
        handled += 1
        refreshDeck()
        scheduleUndoExpiry()
        prefetch()
    }

    /// Put the last decision back — the card returns to where it was and the
    /// state change is reversed.
    func undo() {
        guard let entry = undoable else { return }
        undoExpiry?.cancel()
        undoExpiry = nil
        undoable = nil
        switch entry.action {
        case .read:
            for session in entry.card.sessions { ReadsStore.shared.markUnread(session) }
        case .archive:
            for session in entry.card.sessions { list?.unarchive(session) }
        case .keep:
            break
        }
        // Dropping the id is enough to put the card back where it was: the
        // deck is the frozen queue minus what has been decided, so its
        // original neighbours are still on either side of it.
        decided.remove(entry.card.id)
        handled = max(0, handled - 1)
        refreshDeck()
    }

    func dismissUndo() {
        undoExpiry?.cancel()
        undoExpiry = nil
        undoable = nil
    }

    /// A reply lands like a right-swipe: the workspace is read, and the deck
    /// moves on. Delivery goes through the outbox, so it survives a bad network
    /// and the deck doesn't have to hold a socket open per card.
    func reply(_ text: String) {
        guard let card = current else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Outbox.shared.enqueue(
            sessionId: card.target.id,
            content: trimmed,
            // The composer's own preference, read the way it reads it — a reply
            // from here must land the same way one typed in the session would.
            busyMode: UserDefaults.standard.string(forKey: "os1.composer.busySend")
                ?? "queue",
            user: ServerConfig.shared.userName
        )
        act(.read)
    }

    private func scheduleUndoExpiry() {
        undoExpiry?.cancel()
        let pending = undoable
        undoExpiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled, let self, self.undoable == pending else { return }
            self.undoable = nil
        }
    }

    // MARK: - Conversations

    /// Load the current main chat and the one behind it. Prefetching the next
    /// one makes a swipe land on content rather than a placeholder.
    func prefetch() {
        for card in [current, next].compactMap({ $0 }) {
            Task { await loadConversation(for: card) }
        }
    }

    func loadConversation(for card: CatchUpCard) async {
        guard conversations[card.id] == nil, !loading.contains(card.id) else { return }
        loading.insert(card.id)
        defer { loading.remove(card.id) }
        do {
            let entries = try await OS1API.transcript(sessionId: card.target.id)
            conversations[card.id] = Self.conversation(
                from: entries,
                session: card.target
            )
        } catch {
            conversations[card.id] = Conversation(blocks: [], failed: true)
        }
    }

    static func conversation(
        from entries: [TranscriptEntry],
        session: Session
    ) -> Conversation {
        let items = TranscriptGrouping.displayItems(from: entries)
        return Conversation(blocks: TranscriptGrouping.blocks(
            from: items,
            live: session.isRunning == true,
            worktreeDir: session.worktreeDir,
            walkthrough: session.walkthrough,
            thinkingMessages: ThinkingMessages(
                UserDefaults.standard.string(forKey: ThinkingMessages.storageKey)
            )
        ))
    }
}
