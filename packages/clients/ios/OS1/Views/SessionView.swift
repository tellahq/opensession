import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Owns session start/stop and foreground presence without putting lifecycle
/// state in the large conversation's AttributeGraph dependencies.
private struct SessionSceneLifecycle: View {
    let viewModel: SessionViewModel

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .task {
                let owner = UUID()
                viewModel.start(owner: owner)
                defer { viewModel.stop(owner: owner) }
                if !AppLifecycle.isActive { viewModel.appDidEnterBackground() }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(3_600))
                }
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.didBecomeActiveNotification
                ) {
                    // Reconnect and resync as soon as the app is active.
                    viewModel.appDidBecomeActive()
                }
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.willResignActiveNotification
                ) {
                    // Presence follows the foreground app, not input activity.
                    viewModel.appDidEnterBackground()
                }
            }
    }
}

struct SessionForkState: Equatable {
    enum Point: Equatable {
        case tip
        case message(String)
    }

    private(set) var point: Point?
    private(set) var creating = false
    private(set) var error: String?

    mutating func enter(messageId: String? = nil) {
        point = messageId.map(Point.message) ?? .tip
        creating = false
        error = nil
    }

    mutating func cancel() {
        self = SessionForkState()
    }

    mutating func begin(sourceId: String) -> OS1API.ForkFrom? {
        guard let point, !creating else { return nil }
        creating = true
        error = nil
        switch point {
        case .tip:
            return OS1API.ForkFrom(sourceId: sourceId)
        case .message(let messageId):
            return OS1API.ForkFrom(sourceId: sourceId, messageId: messageId)
        }
    }

    mutating func fail(_ message: String) {
        creating = false
        error = message
    }

    mutating func complete(sessionId: String) -> String {
        self = SessionForkState()
        return sessionId
    }
}

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    private let tabs: [Session]
    /// Direct child sessions delegated by this conversation. They stay out of
    /// `tabs` and live in the More menu, matching the web session header.
    private let workerSessions: [Session]
    /// Canonical workspace names, id-keyed, as the sessions list holds them.
    /// Regrouping `tabs` here rebuilds the sidebar row this session sits in,
    /// and without these the row would be titled by whatever the fallback
    /// chain finds instead of the workspace's actual name.
    private let workspaceNames: [String: String]
    private let onSelectTab: ((Session) -> Void)?
    private let onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)?
    /// Opens the new-session composer from the iOS navigation bar.
    private let onNewSession: (() -> Void)?
    /// Moves to the next visible chat, prioritizing settled unread work.
    private let onNextChat: (() -> Void)?
    /// Opens a newly created fork without changing this view's transcript.
    private let onForkCreated: ((String) async -> Void)?
    /// Worktree-level actions behind the iOS overflow menu. They belong to the
    /// sessions list, which owns the optimistic row removal and the refresh
    /// that follows — nil simply leaves those entries out of the menu.
    private let onRenameWorkspace: ((String) -> Void)?
    private let onArchiveWorkspace: (() -> Void)?
    private let onDeleteWorkspace: (() -> Void)?
    /// macOS has no sibling strip: its sidebar is the live-session switcher.
    /// The selected session's toolbar still offers the workspace's closed
    /// siblings, and hands restoration back to that sidebar's owner.
    private let onRestoreArchivedSession: ((Session) async -> Void)?
    /// The workspace's closed sessions, when the info sheet is the surface
    /// carrying them. Nil while the tab strip has them, which is what keeps
    /// one list from appearing in two places at once.
    private let workspaceHistory: WorkspaceSessionHistory?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The appearance the conversation itself is drawn in — read out here,
    /// where it's still the app's, so the input bar can be pinned to it.
    @Environment(\.colorScheme) private var appColorScheme

    /// Full-window-width session text is unreadable on the Mac; cap the content
    /// column (transcript AND composer) and center it, like other chat apps.
    private let contentMaxWidth = OS1VisualStyle.sessionMaxWidth

    /// Compact width sits on the standard 16pt phone margin; regular-width
    /// iPad and Mac keep more breathing room while sharing the same 780pt
    /// reading column.
    private var contentInset: CGFloat {
        horizontalSizeClass == .compact ? 16 : 20
    }

    /// Where the reader was when a page of earlier history landed, measured
    /// from the END of the transcript — the one coordinate the page doesn't
    /// move (see `TranscriptScroll.distanceFromEnd`). Set from the scroll
    /// geometry's PREVIOUS value the first time the content grows, which is
    /// the last thing measured before the page was laid out.
    @State private var prependDistanceFromEnd: CGFloat?
    /// The content height before the page landed. A lazy stack can briefly
    /// report less than this while re-realizing its rows; that is not a valid
    /// restoration target yet.
    @State private var prependBaselineContentHeight: CGFloat?
    /// Armed when a page lands, disarmed by the height change it is waiting
    /// for.
    @State private var awaitingPrepend = false
    /// A page requested before the reader began a newer gesture must not claim
    /// their position when its delayed response finally arrives.
    @State private var prependRequestInteraction: Int?
    @State private var scrollInteractionGeneration = 0
    /// Lets the generic new-output observer distinguish a history page from a
    /// real tail append, regardless of modifier callback ordering.
    @State private var lastDisplayHistoryPrependSeq = 0

    /// The transcript's scroll position, for the one thing `ScrollViewProxy`
    /// cannot express: an exact offset. `scrollTo(_:anchor:)` can only align a
    /// ROW with an edge, and a session whose turns merge into a handful of
    /// screens-tall blocks has no row fine-grained enough to land on.
    @State private var scrollPosition = ScrollPosition()

    /// How work folds start out: where a turn's work rests (folded / running,
    /// which opens it only while the turn is live / open), and whether that
    /// includes its tool calls. Set in Settings → Preferences, shared with the
    /// web.
    @AppStorage("os1.appearance.turnActivity") private var turnWork = "running"
    @AppStorage("os1.appearance.toolCalls") private var toolCalls = "folded"
    private var turnActivity: TurnActivity {
        TurnActivity(work: turnWork, tools: toolCalls)
    }

    /// Output arrived while the reader was scrolled up. Turns the return pill
    /// from a navigation aid into a notification.
    @State private var newBelow = false

    /// Keep the view welded to the latest for a moment after opening.
    ///
    /// A conversation opens at the bottom, but its rows keep settling for a
    /// second or two afterwards — markdown parses asynchronously and the lazy
    /// stack realizes rows as it goes — and every one of those height changes
    /// nudges the bottom further down than the anchor recovers. The hold
    /// re-pins through that window, and any real scroll gesture ends it
    /// immediately so it can never fight the reader.
    @State private var holdingAtLatest = true
    @State private var holdTask: Task<Void, Never>?
    private static let initialHoldSeconds: Double = 2.5

    /// Whether the reader is at (or near) the bottom, from live scroll
    /// geometry. New AI output only auto-scrolls while true; scrolling up to
    /// read releases the pin so streams don't yank the reader back down.
    @State private var pinnedToBottom = true
    /// Proximity alone cannot express intent: the first small upward movement
    /// still sits inside `pinTolerance`, but must release live following.
    @State private var readerMovedTowardHistory = false
    @State private var readerScrollActive = false

    /// Size of the session surface. Height keeps short transcripts pinned to
    /// the top; width gives custom toolbar content the finite proposal that a
    /// principal ToolbarItem does not provide on its own.
    @State private var viewportHeight: CGFloat = 0
    @State private var viewportWidth: CGFloat = 0

    /// How close to the bottom (pt) still counts as pinned.
    ///
    /// `scrollToBottom` aligns the LAST ROW's frame with the visible bottom,
    /// so "as far down as this view ever scrolls itself" already sits the
    /// stack's own trailing padding short of the content's end. The tolerance
    /// has to clear that, plus slack for keyboard/inset transitions and lazy
    /// rows settling.
    private let pinTolerance: CGFloat = 76
    /// Gesture completion uses a tighter edge than live following. The wider
    /// tolerance absorbs layout slack; this one recognizes the actual resting
    /// bottom without treating a small upward nudge as a return.
    private var restingBottomTolerance: CGFloat {
        pinTolerance - SessionView.tailClearance
    }

    /// Model/effort catalog for the toolbar picker; fetched on first open.
    @State private var catalog: ModelCatalog?
    @State private var forkState = SessionForkState()

    /// PR details sheet — the macOS toolbar PR chip, the iOS overflow menu.
    @State private var showPrPanel = false

    /// Native counterpart of mobile web's title-opened workspace info page.
    @State private var showWorktreeInfo = false
    @State private var slackShare: PrSlackShareRequest?

    #if os(macOS)
    /// Workspace-scoped archived summaries. Kept out of the global archived
    /// index so opening one session never downloads the whole server history.
    @State private var workspaceArchiveRows: [Session] = []
    @Environment(\.openURL) private var macOpenURL
    #endif

    #if os(iOS)
    /// Rename prompt, raised from the overflow menu.
    @State private var renamingWorkspace = false
    @State private var renameText = ""

    /// Web link tapped in the transcript, shown over the session. The
    /// enclosing action — the one `SessionsListView` installs to turn
    /// `bks-…` links into a push — stays in charge of everything else.
    @State private var safariLink: SafariLink?
    @Environment(\.openURL) private var enclosingOpenURL
    /// The tab strip's assets tab, installed by `SessionTabsView`. Read here
    /// only to hand it to the toolbar menu; it is `Equatable` on the session
    /// it belongs to, so it doesn't invalidate this body as the poll lands.
    @Environment(\.openPanel) private var openPanel
    #endif

    /// Content to stand in for an empty transcript, supplied by the caller
    /// (see `emptyContent(_:)`). Set through a modifier rather than an init
    /// parameter so neither initializer grows a rarely-used argument.
    private var emptyContent: (() -> AnyView)?

    /// Fill this session's empty transcript with your own view — the Desk's
    /// board. Ignored the moment there is anything to show.
    func emptyContent<V: View>(@ViewBuilder _ build: @escaping () -> V) -> SessionView {
        var copy = self
        copy.emptyContent = { AnyView(build()) }
        return copy
    }

    /// Content pinned just above the composer while `emptyContent` is showing
    /// (the Desk's starter pills). Same modifier-not-init reasoning as above.
    private var composerAccessory: (() -> AnyView)?

    /// Add a row above this session's composer, shown only while
    /// `emptyContent` is.
    func composerAccessory<V: View>(@ViewBuilder _ build: @escaping () -> V) -> SessionView {
        var copy = self
        copy.composerAccessory = { AnyView(build()) }
        return copy
    }

    /// The transcript's last row — what "go to the bottom" travels to.
    /// `nil` when there is nothing to travel to, which is an empty transcript:
    /// that space belongs to whatever the caller put in its place (the Desk's
    /// board), and it reads from the top.
    private var tailId: String? {
        if let receipt = viewModel.slackComposeReceipt { return "slack-receipt-\(receipt.id)" }
        if let ask = viewModel.pendingQuestion { return "ask-\(ask.id)" }
        if let sent = viewModel.sentAskAnswer { return "ask-sent-\(sent.id)" }
        // While work is in flight the run clock IS the last row.
        if viewModel.isRunning { return "run-status" }
        if viewModel.inlineRunFailureMessage != nil { return "run-failure" }
        if !viewModel.liveText.isEmpty { return "live-stream" }
        return viewModel.displayBlocks.last?.id
    }

    /// Air under the LAST row, and the reason it is on the row rather than on
    /// the stack: `scrollTo(_:anchor: .bottom)` puts the target's frame on the
    /// visible bottom, so padding below the target is the only kind it
    /// travels past. Without it the newest row lands hard against the visible
    /// bottom — which is inside the composer's fade, where the scroll edge
    /// effect has already washed it out. Measured on an iPhone 17 Pro: going
    /// to the bottom parked the last row 20pt lower than a hand-drag to the
    /// same end, grey and unreadable, while the row above it stayed crisp.
    /// This is that 20pt, so both ways of arriving land in the same place.
    fileprivate static let tailClearance: CGFloat = 20

    /// The caller's stand-in currently owns the transcript area.
    private var showingEmptyContent: Bool {
        emptyContent != nil
            && viewModel.displayBlocks.isEmpty
            && viewModel.liveText.isEmpty
            && viewModel.inlineRunFailureMessage == nil
    }

    init(
        session: Session,
        seed: SessionViewModel.OptimisticSeed? = nil,
        tabs: [Session]? = nil,
        workerSessions: [Session] = [],
        workspaceNames: [String: String] = [:],
        composerDraft: SessionViewModel.ComposerDraft? = nil,
        onSelectTab: ((Session) -> Void)? = nil,
        onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)? = nil,
        onNewSession: (() -> Void)? = nil,
        onNextChat: (() -> Void)? = nil,
        onForkCreated: ((String) async -> Void)? = nil,
        onRenameWorkspace: ((String) -> Void)? = nil,
        onArchiveWorkspace: (() -> Void)? = nil,
        onDeleteWorkspace: (() -> Void)? = nil,
        onRestoreArchivedSession: ((Session) async -> Void)? = nil,
        workspaceHistory: WorkspaceSessionHistory? = nil
    ) {
        _viewModel = State(initialValue: SessionViewModel(
            session: session,
            seed: seed,
            composerDraft: composerDraft
        ))
        self.tabs = tabs ?? [session]
        self.workerSessions = workerSessions
        self.workspaceNames = workspaceNames
        self.onSelectTab = onSelectTab
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        self.onNextChat = onNextChat
        self.onForkCreated = onForkCreated
        self.onRenameWorkspace = onRenameWorkspace
        self.onArchiveWorkspace = onArchiveWorkspace
        self.onDeleteWorkspace = onDeleteWorkspace
        self.onRestoreArchivedSession = onRestoreArchivedSession
        self.workspaceHistory = workspaceHistory
    }

    init(
        viewModel: SessionViewModel,
        tabs: [Session],
        workerSessions: [Session] = [],
        workspaceNames: [String: String] = [:],
        onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)? = nil,
        onNewSession: (() -> Void)? = nil,
        onNextChat: (() -> Void)? = nil,
        onForkCreated: ((String) async -> Void)? = nil,
        onRenameWorkspace: ((String) -> Void)? = nil,
        onArchiveWorkspace: (() -> Void)? = nil,
        onDeleteWorkspace: (() -> Void)? = nil,
        onRestoreArchivedSession: ((Session) async -> Void)? = nil,
        workspaceHistory: WorkspaceSessionHistory? = nil
    ) {
        _viewModel = State(initialValue: viewModel)
        self.tabs = tabs
        self.workerSessions = workerSessions
        self.workspaceNames = workspaceNames
        self.onSelectTab = nil
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        self.onNextChat = onNextChat
        self.onForkCreated = onForkCreated
        self.onRenameWorkspace = onRenameWorkspace
        self.onArchiveWorkspace = onArchiveWorkspace
        self.onDeleteWorkspace = onDeleteWorkspace
        self.onRestoreArchivedSession = onRestoreArchivedSession
        self.workspaceHistory = workspaceHistory
    }

    var body: some View {
        let transcriptContent = ScrollViewReader { proxy in
            Group {
                if viewModel.isLoadingConversation {
                    conversationLoader
                } else if let error = viewModel.conversationLoadError {
                    conversationLoadFailure(error)
                } else {
                    let measuredScroll = transcriptScrollBase
                    // The geometry the prepend restore works from. Reading
                    // `old` is the point: when a page of history lands, the
                    // first height change carries the transcript as it was
                    // measured just BEFORE those rows were laid out, which is
                    // where the reader still thinks they are.
                    .onScrollGeometryChange(for: TranscriptGeometry.self) {
                        TranscriptGeometry(
                            offset: $0.contentOffset.y,
                            contentHeight: $0.contentSize.height,
                            insetTop: $0.contentInsets.top,
                            visibleMaxY: $0.visibleRect.maxY,
                            insetBottom: $0.contentInsets.bottom,
                            containerHeight: $0.containerSize.height
                        )
                    } action: { old, new in
                        let wasFollowing = pinnedToBottom && !readerMovedTowardHistory
                        if awaitingPrepend, new.contentHeight != old.contentHeight {
                            awaitingPrepend = false
                            prependDistanceFromEnd = TranscriptScroll.distanceFromEnd(
                                offset: old.offset,
                                contentHeight: old.contentHeight
                            )
                            prependBaselineContentHeight = old.contentHeight
                        }
                        restoreAfterPrependIfPossible(new)
                        let nearBottom = TranscriptScroll.isNearBottom(
                            TranscriptScroll.Geometry(
                                visibleMaxY: new.visibleMaxY,
                                contentHeight: new.contentHeight,
                                insetBottom: new.insetBottom,
                                containerHeight: new.containerHeight
                            ),
                            tolerance: pinTolerance
                        )
                        let follow = TranscriptScroll.followState(
                            previousOffset: old.offset,
                            offset: new.offset,
                            previousContentHeight: old.contentHeight,
                            contentHeight: new.contentHeight,
                            previousDistanceFromBottom: TranscriptScroll.distanceFromBottom(
                                TranscriptScroll.Geometry(
                                    visibleMaxY: old.visibleMaxY,
                                    contentHeight: old.contentHeight,
                                    insetBottom: old.insetBottom,
                                    containerHeight: old.containerHeight
                                )
                            ),
                            isNearBottom: nearBottom,
                            readerGestureActive: readerScrollActive,
                            layoutChanged: old.insetTop != new.insetTop
                                || old.insetBottom != new.insetBottom
                                || old.containerHeight != new.containerHeight,
                            readerMovedTowardHistory: readerMovedTowardHistory
                        )
                        var nextPinned = follow.pinned
                        // Streamed markdown lays out asynchronously after
                        // `liveText` changes. Follow its measured height, not
                        // the pre-layout text update, so the run footer stays
                        // planted instead of stepping around while words land.
                        if TranscriptScroll.shouldFollowContentGrowth(
                            previousContentHeight: old.contentHeight,
                            contentHeight: new.contentHeight,
                            readerMovedTowardHistory: follow.readerMovedTowardHistory,
                            wasFollowing: wasFollowing,
                            holdingAtLatest: holdingAtLatest,
                            readerScrollActive: readerScrollActive
                        ) {
                            nextPinned = true
                            scrollToBottom(proxy, animated: false, repin: false)
                        }
                        if pinnedToBottom != nextPinned { pinnedToBottom = nextPinned }
                        if readerMovedTowardHistory != follow.readerMovedTowardHistory {
                            readerMovedTowardHistory = follow.readerMovedTowardHistory
                        }
                        if nextPinned, newBelow { newBelow = false }
                    }
                    // One viewport, for the content stack's floor above.
                    // `containerSize` is the unobstructed visible region (it
                    // excludes the content insets the composer and the header
                    // take), which is exactly the height a short transcript
                    // should fill.
                    .onScrollGeometryChange(for: CGFloat.self) { geometry in
                        geometry.containerSize.height
                    } action: { _, height in
                        viewportHeight = height
                    }
                    // A way back down. Without it the only route out of a
                    // scrolled-up transcript is flicking through everything
                    // that arrived meanwhile.
                    .overlay(alignment: .bottom) {
                        if !pinnedToBottom, !holdingAtLatest,
                           !viewModel.displayBlocks.isEmpty {
                            ScrollToLatestButton(hasNewOutput: newBelow) {
                                newBelow = false
                                scrollToBottom(proxy, animated: true)
                                // Output that lands WHILE the scroll animates
                                // leaves it short of the end — and it stays
                                // there, because following only resumes once
                                // the pin re-arms, which it doesn't at a
                                // position that far up. So hold at the latest
                                // for a beat afterwards, exactly like opening
                                // a conversation does; a scroll gesture ends
                                // the hold immediately either way.
                                beginHold(
                                    proxy,
                                    seconds: 0.8,
                                    after: .milliseconds(450)
                                )
                            }
                            .padding(.bottom, 10)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    #if os(macOS)
                    .overlay {
                        GeometryReader { geometry in
                            if horizontalSizeClass != .compact,
                               geometry.size.width >= contentMaxWidth + 96,
                               viewModel.sentMessageAnchors.count >= 2 {
                                let availableHeight = max(44, geometry.size.height - 64)
                                let idealHeight = max(
                                    44,
                                    CGFloat(viewModel.sentMessageAnchors.count - 1) * 10 + 20
                                )
                                let railHeight = min(
                                    availableHeight,
                                    idealHeight
                                )
                                SentMessageRail(
                                    messages: viewModel.sentMessageAnchors,
                                    height: railHeight
                                ) { message in
                                    jumpToSentMessage(message, proxy: proxy)
                                }
                                .position(
                                    x: max(20, (geometry.size.width - contentMaxWidth) / 2 - 18),
                                    y: geometry.size.height / 2
                                )
                            }
                        }
                    }
                    #endif
                    let interactiveScroll = measuredScroll
                        .animation(
                            .snappy(duration: 0.22, extraBounce: 0),
                            value: pinnedToBottom
                        )
                    // A scroll gesture is the reader taking over: the
                    // opening hold ends the moment they touch the transcript.
                    .onScrollPhaseChange { old, phase, context in
                        // A hand on the transcript outranks both the opening
                        // hold and a restore still settling a page of history.
                        let readerPhase = phase == .tracking
                            || phase == .interacting
                            || phase == .decelerating
                        if phase == .interacting, old != .interacting {
                            scrollInteractionGeneration += 1
                            endHold()
                            cancelPrependRestore()
                            if !readerMovedTowardHistory {
                                readerMovedTowardHistory = true
                            }
                            if pinnedToBottom { pinnedToBottom = false }
                        }
                        if readerScrollActive != readerPhase {
                            readerScrollActive = readerPhase
                        }
                        if phase == .idle, readerMovedTowardHistory {
                            let atRestingBottom = TranscriptScroll.isNearBottom(
                                TranscriptScroll.Geometry(
                                    visibleMaxY: context.geometry.visibleRect.maxY,
                                    contentHeight: context.geometry.contentSize.height,
                                    insetBottom: context.geometry.contentInsets.bottom,
                                    containerHeight: context.geometry.containerSize.height
                                ),
                                tolerance: restingBottomTolerance
                            )
                            if atRestingBottom {
                                readerMovedTowardHistory = false
                                pinnedToBottom = true
                                newBelow = false
                            }
                        }
                        // Reading counts as being here: a hand on the transcript
                        // is what keeps our face on this session (the view model
                        // throttles it). Output scrolling past on its own does
                        // not — `.idle` is exactly that case.
                        if phase != .idle { viewModel.userDidInteract() }
                    }
                    // Both entry points into a conversation arm the hold: a
                    // cached one is already loaded when the view appears, so
                    // waiting on the loading flag alone would leave the hold
                    // armed forever and the return pill permanently hidden.
                    let loadedScroll = interactiveScroll
                        .onAppear { beginHold(proxy) }
                        // The transcript exists now: hold it at the latest
                        // while its rows settle.
                        .onChange(of: viewModel.isLoadingConversation) { _, loading in
                            if !loading { beginHold(proxy) }
                        }

                    let receivedScroll = loadedScroll
                        .onChange(of: viewModel.pendingQuestion) {
                            // A question needs eyes even if they've scrolled away.
                            scrollToBottom(proxy, animated: true)
                        }
                        .onChange(of: viewModel.slackComposeReceipt) {
                            // The composer closes into this durable receipt.
                            scrollToBottom(proxy, animated: true)
                        }
                        .onChange(of: viewModel.sentAskAnswer) {
                            scrollToBottom(proxy, animated: true)
                            // The answer receipt is optimistic. Its durable
                            // replacement and the resumed run can change the
                            // tail while this animation still targets the old
                            // row, so follow until those rows settle.
                            beginHold(proxy, after: .milliseconds(450))
                        }

                    let deliveryScroll = receivedScroll
                        .onChange(of: viewModel.composeSeq) {
                            // Typing a reply brings the end of the conversation
                            // into view, so the message lands where you're looking.
                            scrollToBottom(proxy, animated: true)
                        }
                        .onChange(of: viewModel.sendSeq) {
                            // Your own send always lands in view. The bottom
                            // size-change anchor alone doesn't re-pin once the
                            // reader has scrolled up (or the keyboard resized the
                            // viewport), leaving the sent bubble below the fold.
                            scrollToBottom(proxy, animated: true)
                            // The message arrives after the outbox round trip,
                            // so keep following while its row and the keyboard
                            // inset settle instead of stopping at the old tail.
                            beginHold(proxy, after: .milliseconds(450))
                        }
                    // The size-change anchor alone doesn't reliably hold the
                    // bottom while new output arrives (keyboard insets + lazy
                    // row settling knock it loose), so follow explicitly while
                    // pinned: new items animated, per-chunk stream growth not
                    // (an animation every ~120ms flush reads as rubber-banding).
                    // `displayItems` stays flat behind the folded blocks
                    // precisely so this trigger keeps working: a tool call
                    // landing inside an existing turn leaves the BLOCK count
                    // unchanged, and following new output would stop.
                    let outputScroll = deliveryScroll
                        .onChange(of: viewModel.displayItems.count) {
                            displayItemsChanged()
                        }
                        // The clock arriving lengthens the transcript by a row;
                        // follow it so it lands above the composer rather than
                        // behind it.
                        .onChange(of: viewModel.isRunning) { _, running in
                            runningChanged(running)
                        }
                        .onChange(of: viewModel.liveText) {
                            liveTextChanged()
                        }

                    outputScroll
                        .onChange(of: viewModel.historyPrependSeq) {
                        // Keep the reader where they were. The rows land above
                        // everything on screen, so the geometry observer above
                        // takes the measurement and `restoreAfterPrepend` puts
                        // the position back. A "jump to the start" walk pages
                        // repeatedly on its way and ends with a scroll of its
                        // own, so it opts out.
                        beginPrependRestoreIfPossible()
                        }
                        // A landed "jump to the start": the walk's last page is
                        // in the transcript now, so take the reader to the oldest
                        // block it reached — the first message, unless the walk
                        // stopped at its ceiling.
                        .onChange(of: viewModel.jumpLandedSeq) {
                            jumpToStartIfLanded(proxy)
                        }
                }
            }
            // Web links from the transcript open on top of it, not instead of
            // it. Scoped to the transcript rather than the whole session so
            // that only agent output is rerouted — a sign-in URL from settings
            // still belongs to the system browser.
            #if os(iOS)
            .environment(\.openURL, OpenURLAction { url in
                // A PR chip (PrLinks) is caught here rather than one level up,
                // because both of its landings live here: this session's own
                // PR is the review panel one push away, and any other PR is
                // the GitHub page, which belongs in the same in-app browser a
                // transcript link opens in.
                if let reference = PrLinks.reference(from: url) {
                    if PrLinks.isOwnPr(reference, of: viewModel.session),
                       openPanel.isAvailable {
                        openPanel(.review(sessionId: viewModel.session.id))
                    } else if let github = PrLinks.githubURL(for: reference) {
                        safariLink = SafariLink(url: github)
                    }
                    return .handled
                }
                guard SafariLink.isWeb(url) else {
                    // Session links and custom schemes stay with the action
                    // the sessions list installed above us.
                    enclosingOpenURL(url)
                    return .handled
                }
                safariLink = SafariLink(url: url)
                return .handled
            })
            .sheet(item: $safariLink) { link in
                SafariSheet(url: link.url)
                    .ignoresSafeArea()
            }
            #endif
        }
		let chromeContent = transcriptContent
			.environment(\.transcriptSessionId, viewModel.session.id)
            .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                #if os(iOS)
                if tabs.count > 1, let onSelectTab {
                    // A read-only strip: this path hands selection outwards and
                    // owns no archiving, so its pills carry no close control.
                    SessionTabBar(
                        tabs: tabs.map { session in
                            var pill = TabPill(session)
                            pill.closable = false
                            return pill
                        },
                        activeId: viewModel.session.id,
                        onSelect: { id in
                            guard let session = tabs.first(where: { $0.id == id })
                            else { return }
                            onSelectTab(session)
                        },
                        onClose: { _ in },
                        archived: [],
                        restoringIds: [],
                        onRestore: { _ in }
                    )
                }
                #endif
                #if os(iOS)
                SessionToastBanner(viewModel: viewModel)
                #endif
                statusBanner
            }
        }
        .background(OS1VisualStyle.chatCanvas.ignoresSafeArea())
        // Bottom inset, not an overlay: the scroll viewport still extends
        // beneath the composer (content scrolls under the floating glass),
        // while the content inset tracks the composer's real height and the
        // keyboard — a fixed overlay padding hid the newest messages behind
        // both.
        // A BAR, not a plain inset: `safeAreaBar` is what tells the scroll view
        // that its content travels behind the composer, which is what draws the
        // soft scroll edge effect there (see `softScrollEdges`). With a plain
        // `safeAreaInset` the transcript simply stopped above the composer and
        // nothing ever passed under it, so nothing faded.
        #if os(iOS)
        .safeAreaBar(edge: .bottom) { inputBar }
        #else
        .safeAreaInset(edge: .bottom) { inputBar }
        #endif
        #if os(macOS)
        .navigationTitle("")
        .macWindowTitle(viewModel.session.displayTitle)
        #else
        // The system title backs the pill (VoiceOver, the back-swipe preview),
        // so it names the same thing the pill does.
        .navigationTitle(identityTitle)
        #endif
        .inlineTitleBarCompat()
        #if os(iOS)
        // Keep the bar itself transparent so the transcript's soft scroll-edge
        // effect can provide the progressive blur beneath its glass controls.
        .toolbarBackground(.hidden, for: .navigationBar)
        // Toolbar content is hosted outside this view tree, so pin its colour
        // scheme here instead of relying on the surrounding environment.
        .toolbarColorScheme(appColorScheme, for: .navigationBar)
        #endif

        let toolbarContent = chromeContent
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                viewportWidth = $0
            }
            .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .principal) {
                sessionHeaderLane
            }
            #endif
            // Whoever else has this session open, right before the actions
            // menu — the same slot the web viewer's facepile sits in.
            if !viewModel.otherViewers.isEmpty {
                ToolbarItem(placement: .topTrailingCompat) {
                    PresenceFacepile(viewers: viewModel.otherViewers, size: 24)
                }
            }
            #if os(macOS)
            // macOS retains the PR chip in its roomier toolbar; on iOS the
            // same series lives in the title-opened workspace sheet.
            let prRows = SessionPrSeries.rows(for: viewModel.session)
            let primaryPrNumber = viewModel.prDetails?.number ?? viewModel.session.prNumber
            if let chipRow = prRows.first {
                ToolbarItem(placement: .topTrailingCompat) {
                    if prRows.count == 1, let primaryPrNumber, chipRow.isPrimary {
                        Button {
                            showPrPanel = true
                        } label: {
                            PrChipLabel(
                                number: primaryPrNumber,
                                summary: viewModel.prDetails?.summary
                            )
                        }
                        .accessibilityLabel(Text(verbatim: "Pull request #\(primaryPrNumber)"))
                    } else {
                        Menu {
                            if let primaryPrNumber {
                                Button {
                                    showPrPanel = true
                                } label: {
                                    Text(verbatim: "Open pull request #\(primaryPrNumber)")
                                }
                            }
                            ForEach(prRows.filter { primaryPrNumber == nil || !$0.isPrimary }) { row in
                                Button {
                                    openRelatedPr(row)
                                } label: {
                                    Text(verbatim: "\(row.identityLabel) · \(row.title ?? row.state)")
                                }
                            }
                        } label: {
                            if let number = chipRow.number {
                                PrChipLabel(
                                    number: number,
                                    summary: chipRow.isPrimary ? viewModel.prDetails?.summary : nil
                                )
                            } else {
                                Image(systemName: "arrow.trianglehead.pull")
                            }
                        }
                        .accessibilityLabel(Text("Pull requests"))
                    }
                }
            }
            ToolbarItem(placement: .principal) { macSessionTitle }
            if canForkSession {
                ToolbarItem(placement: .topTrailingCompat) {
                    Button {
                        forkState.enter()
                    } label: {
                        Label("Fork", systemImage: "arrow.triangle.branch")
                    }
                    .help("Fork from the current history")
                }
            }
            ToolbarItem(placement: .topTrailingCompat) {
                AddToSidebarButton(session: viewModel.session, siblings: tabs)
            }
            if !workspaceHistoryRows.isEmpty, onRestoreArchivedSession != nil {
                ToolbarItem(placement: .topTrailingCompat) {
                    SessionHistoryMenu(
                        sessions: workspaceHistoryRows,
                        onRestore: restoreArchivedSession
                    )
                    .help("Closed sessions in this workspace")
                }
            }
            ToolbarItem(placement: .topTrailingCompat) {
                modelMenu
                    .help("Model and reasoning settings")
            }
            #endif
            }

        let presentedContent = toolbarContent
            .sheet(isPresented: $showPrPanel) {
            PrPanelView(viewModel: viewModel)
        }
        .sheet(item: $slackShare) { request in
            PrSlackShareSheet(request: request)
        }
        .onChange(of: viewModel.pendingSlackComposer, initial: true) {
            guard let request = viewModel.pendingSlackComposer else {
                if slackShare?.composerRequestId != nil { slackShare = nil }
                return
            }
            slackShare = PrSlackShareRequest(
                title: request.message,
                url: URL(string: "https://slack.com")!,
                sessionId: viewModel.session.id,
                repo: viewModel.session.repo,
                branch: viewModel.session.branch,
                merged: false,
                walkthroughSummary: nil,
                suggestedScreenshot: nil,
                composerRequestId: request.id,
                initialImages: request.images,
                preferredChannel: request.channel,
                onComposerResolved: { viewModel.resolveSlackComposer($0) }
            )
        }
        #if os(iOS)
        .alert("Rename workspace", isPresented: $renamingWorkspace) {
            TextField("Workspace name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { onRenameWorkspace?(renameText) }
                .disabled(
                    viewModel.session.workspaceId != nil
                        && renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
        } message: {
            Text("Choose a name for this workspace.")
        }
        .sheet(isPresented: $showWorktreeInfo) {
            WorktreeInfoView(
                viewModel: viewModel,
                sessions: tabs,
                catalog: catalog
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        #endif
            #if os(macOS)
            .task(id: workspaceHistoryWorkspaceId) {
                await loadWorkspaceHistory()
            }
            #endif

        presentedContent
            // Platform lifecycle notifications avoid a scene-phase environment
            // update walking this transcript during the 10-second background
            // watchdog window. The zero-sized leaf owns only the side effects.
            .background { SessionSceneLifecycle(viewModel: viewModel) }
            .task {
                #if DEBUG && os(iOS)
                // Install screenshot fixtures before network requests so a
                // slow catalog cannot leave the capture in the ordinary state.
                if ProcessInfo.processInfo.environment["OS1_SHOW_SAFETY_PAUSE"] == "1" {
                    viewModel.showSafetyPauseForScreenshot()
                }
                if ProcessInfo.processInfo.environment["OS1_SHOW_STEERED_MESSAGE"] == "1" {
                    viewModel.showSteeredMessageForScreenshot()
                }
                if ProcessInfo.processInfo.environment["OS1_SHOW_FORK_MODE"] == "1" {
                    forkState.enter()
                }
                if ProcessInfo.processInfo.environment["OS1_SHOW_ATTACHMENT_ANNOTATION"] == "1",
                   viewModel.attachedImages.isEmpty {
                    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 600))
                    let image = renderer.image { context in
                        UIColor.systemGroupedBackground.setFill()
                        context.cgContext.fill(CGRect(x: 0, y: 0, width: 900, height: 600))
                        UIColor.secondarySystemGroupedBackground.setFill()
                        context.cgContext.fill(CGRect(x: 70, y: 70, width: 760, height: 460))
                        let title = "Review settings"
                        title.draw(
                            at: CGPoint(x: 120, y: 120),
                            withAttributes: [.font: UIFont.boldSystemFont(ofSize: 42)]
                        )
                        UIColor.systemBlue.setFill()
                        context.cgContext.fillEllipse(in: CGRect(x: 620, y: 365, width: 150, height: 68))
                        "Save".draw(
                            at: CGPoint(x: 650, y: 379),
                            withAttributes: [
                                .font: UIFont.boldSystemFont(ofSize: 28),
                                .foregroundColor: UIColor.white,
                            ]
                        )
                    }
                    if let data = image.jpegData(compressionQuality: 0.9) {
                        viewModel.attachedImages = [
                            AttachedImage(id: "annotation-fixture", jpegData: data)
                        ]
                    }
                }
                #endif
                catalog = try? await OS1API.models(workspaceId: viewModel.session.workspaceId)
                #if DEBUG && os(iOS)
                if ProcessInfo.processInfo.environment["OS1_OPEN_WORKTREE_INFO"] == "1" {
                    showWorktreeInfo = true
                }
                // Land straight on the PR panel. The simulator takes no taps from
                // a headless host, so verifying anything behind a control means
                // reaching it some other way, for the same reason as the sheet above.
                if ProcessInfo.processInfo.environment["OS1_OPEN_PR"] == "1",
                   openPanel.isAvailable {
                    openPanel(.review(sessionId: viewModel.session.id))
                }
                if ProcessInfo.processInfo.environment["OS1_OPEN_CHANGES"] == "1",
                   openPanel.isAvailable {
                    openPanel(.changes(sessionId: viewModel.session.id))
                }
                if ProcessInfo.processInfo.environment["OS1_SHOW_SLACK_RECEIPT"] == "1" {
                    viewModel.resolveSlackComposer(SlackComposeReceipt(
                        requestId: "screenshot-slack-receipt",
                        status: .sent,
                        channel: .init(id: "C123", name: "shipping"),
                        permalink: "https://slack.com",
                        ts: "1700000000.000000"
                    ))
                }
                #endif
            }
            .onDisappear {
                onSaveComposerDraft?(SessionViewModel.ComposerDraft(
                    text: viewModel.draft,
                    images: viewModel.attachedImages
                ))
                viewModel.quoteSelection.clear()
            }
            .onChange(of: DraftsStore.shared.remoteRevision) {
                let remote = DraftsStore.shared.mountedText(for: viewModel.session.id)
                if viewModel.draft != remote { viewModel.draft = remote }
            }
    }

    private var canForkSession: Bool {
        viewModel.session.source == "opensession" && viewModel.session.ran == true
    }

    /// A separate view struct on purpose: typing mutates `viewModel.draft` on
    /// every keystroke, and any read of it (or `canSend`) inside
    /// SessionView.body would re-evaluate this whole body — transcript
    /// included — per key. Keep per-keystroke reads out of SessionView.body.
    private var inputBar: some View {
        VStack(spacing: 0) {
            // Starter pills sit directly above the composer — the place you're
            // already looking when you don't know what to type — and only
            // while the caller's stand-in owns the transcript. Inside the
            // bar's subtree so they ride the same safe-area inset and the
            // keyboard pushes them up with it.
            if showingEmptyContent, let composerAccessory {
                composerAccessory()
            }
            SessionInputBar(
                viewModel: viewModel,
                contentMaxWidth: contentMaxWidth,
                horizontalInset: contentInset,
                autoFocusWhenNeverRan: emptyContent == nil,
                onNextChat: onNextChat,
                forkState: $forkState,
                onForkCreated: onForkCreated,
                // The session's actions ride above the composer on iOS (see
                // `SessionActionBar`), which is why the navigation bar has no
                // ⋯ of its own there.
                onArchiveWorkspace: onArchiveWorkspace,
                onNewSession: onNewSession,
                actionMenu: actionsMenu
            )
        }
        // The system treats a bottom `safeAreaBar` as adaptive chrome: when
        // dark content scrolls under it, it hands the bar's subtree a DARK
        // colour scheme, and every dynamic colour inside follows — so a black
        // code block passing under the composer turned the pill, the queue
        // flap and their text near-black in a light-mode app (measured: the
        // pill's mean luminance 223 → 120, and the page-coloured wash painted
        // black). Pin the appearance the rest of the screen is using; the
        // glass keeps its own look, it just stops repainting the app.
        .environment(\.colorScheme, appColorScheme)
    }

    /// The ⋯ menu, erased so the input bar can carry it without becoming
    /// generic. Built here because every binding it writes to is this view's
    /// state. nil on the Mac, whose roomier toolbar keeps its own controls.
    private var actionsMenu: AnyView? {
        #if os(iOS)
        AnyView(
            SessionActionsMenu(
                viewModel: viewModel,
                tabs: tabs,
                workerSessions: workerSessions,
                workspaceNames: workspaceNames,
                catalog: catalog,
                onNewSession: onNewSession,
                onFork: canForkSession ? { forkState.enter() } : nil,
                onRenameWorkspace: onRenameWorkspace,
                onArchiveWorkspace: onArchiveWorkspace,
                onDeleteWorkspace: onDeleteWorkspace,
                showWorktreeInfo: $showWorktreeInfo,
                showPrPanel: $showPrPanel,
                renaming: $renamingWorkspace,
                renameText: $renameText,
                openPanel: openPanel,
                workspaceHistory: workspaceHistory
            )
        )
        #else
        nil
        #endif
    }

    /// Ghost rows in the transcript's own geometry, rather than a spinner in
    /// the middle of an empty screen: the wait then looks like the thing
    /// being waited for, and the real rows land into a shape that is already
    /// there. It draws itself only if the load outlasts a short delay.
    private var conversationLoader: some View {
        TranscriptSkeleton()
            .padding(.horizontal, contentInset)
            .padding(.vertical, 8)
            .frame(maxWidth: contentMaxWidth)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func conversationLoadFailure(_ error: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't load conversation", systemImage: "exclamationmark.triangle")
        } description: {
            Text(error)
        } actions: {
            Button("Try again") { viewModel.retryConversationLoad() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Sits above the oldest rendered entry; scrolling it into view pages in
    /// the previous window of history (with a button as the manual fallback).
    private var historyLoader: some View {
        HStack(spacing: 6) {
            if viewModel.jumpingToStart {
                ProgressView()
                    .controlSize(.small)
                Text("Loading full history…")
            } else if viewModel.loadingEarlier {
                ProgressView()
                    .controlSize(.small)
                Text("Loading earlier…")
            } else {
                Button("Load earlier history") { requestEarlier() }
                    .buttonStyle(.borderless)
                Divider()
                    .frame(height: 14)
                // The whole backlog in one tap, for readers who'd otherwise
                // page a hundred times to reach the first message.
                Button { requestJumpToStart() } label: {
                    Image(systemName: "arrow.up.to.line")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Jump to the start of the session")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }

    private func requestEarlier() {
        guard viewModel.canLoadEarlier, !viewModel.loadingEarlier else { return }
        cancelPrependRestore()
        prependRequestInteraction = scrollInteractionGeneration
        viewModel.loadEarlier()
    }

    private func requestJumpToStart() {
        guard viewModel.canLoadEarlier, !viewModel.loadingEarlier else { return }
        // The walk ends with an explicit scroll to the first message, so the
        // per-page restore has nothing to keep in place.
        cancelPrependRestore()
        viewModel.jumpToStart()
    }

    @ViewBuilder
    private var statusBanner: some View {
        VStack(spacing: 6) {
            if let safety = viewModel.safety {
                safetyNotice(safety)
            }
            switch viewModel.connectionState {
            case .connected:
                EmptyView()
            case .connecting:
                bannerText("Connecting…", color: .secondary)
            case .reconnecting(let reason):
                bannerText(reason.map { "\($0) · reconnecting…" } ?? "Reconnecting…", color: .orange)
            case .failed(let reason):
                bannerText(reason, color: .red)
            }
        }
    }

    private func safetyNotice(_ safety: SessionSafetyState) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.shield.fill")
                .font(.title3)
                .foregroundStyle(OS1VisualStyle.yellow)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Paused for safety")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                Text(safety.explanation?.nilIfBlank ?? "\(AppBrand.productName) paused this work to avoid repeating an uncertain action.")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Text(safetyHelp(safety))
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: contentMaxWidth, alignment: .leading)
        .background(OS1VisualStyle.yellow.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .accessibilityElement(children: .combine)
    }

    private func safetyHelp(_ safety: SessionSafetyState) -> String {
        if safety.automaticReconciliationRunning == true {
            return "\(AppBrand.productName) is checking it automatically. Repair is not available in the native app; you can still archive this session."
        }
        if safety.repairAvailable == true {
            return "Repair is not available in the native app. Open this session on the web to repair it, or archive it here."
        }
        return "Repair is not available for this pause. You can still archive this session."
    }

    /// Floating glass capsule under the nav bar, instead of a full-width bar.
    private func bannerText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .glassSurface(in: Capsule())
            .padding(.top, 6)
            .frame(maxWidth: .infinity)
    }

    /// Model / reasoning-effort / fast-mode controls, mirroring the web
    /// composer's pill. Model switches route through `/model` (persisted +
    /// noticed); effort/fast ride the next send. The rows themselves live in
    /// `ModelSettingsMenu`, which the iOS overflow menu mounts as well.
    private var modelMenu: some View {
        Menu {
            ModelSettingsMenu(viewModel: viewModel, catalog: catalog)
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
    }

    #if os(macOS)
    private var workspaceHistoryWorkspaceId: String? {
        guard onRestoreArchivedSession != nil,
              let workspaceId = viewModel.session.workspaceId,
              !workspaceId.isEmpty
        else { return nil }
        return workspaceId
    }

    private var workspaceHistoryRows: [Session] {
        SessionsListViewModel.workspaceArchivedSessions(
            known: tabs,
            fetched: workspaceArchiveRows,
            containing: viewModel.session
        )
    }

    private func loadWorkspaceHistory() async {
        guard let workspaceId = workspaceHistoryWorkspaceId else {
            workspaceArchiveRows = []
            return
        }
        guard let rows = try? await OS1API.archivedSessions(workspaceId: workspaceId),
              workspaceId == workspaceHistoryWorkspaceId
        else { return }
        workspaceArchiveRows = rows
    }

    private func restoreArchivedSession(_ session: Session) {
        guard let onRestoreArchivedSession else { return }
        workspaceArchiveRows.removeAll { $0.id == session.id }
        Task { await onRestoreArchivedSession(session) }
    }

    private func openRelatedPr(_ row: SessionPrRow) {
        Task {
            guard let url = await SessionPrSeries.destination(
                for: row,
                sessionId: viewModel.session.id
            ) else { return }
            macOpenURL(url)
        }
    }

    /// Own the detail title instead of accepting NavigationSplitView's
    /// automatic circular title-menu control, which had no useful action.
    private var macSessionTitle: some View {
        HStack(spacing: 8) {
            RepoTile(name: viewModel.session.effectiveRepo, size: 20)
            if viewModel.session.wasAgentStarted {
                WebIcon(kind: .robot, size: 15, color: OS1VisualStyle.textDim)
                    .accessibilityHidden(true)
            }
            Text(viewModel.session.displayTitle)
                .font(.headline)
                .lineLimit(1)
            if viewModel.isRunning {
                PulsingDot(color: OS1VisualStyle.yellow, size: 6)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: 520, alignment: .leading)
        .help(headerSubtitle)
    }
    #endif

    #if os(iOS)
    /// Use the principal lane for its flexible width, but anchor the title at
    /// its leading edge so it follows Back and can consume the open right side.
    private var sessionHeaderLane: some View {
        sessionIdentityButton
            .frame(width: sessionHeaderLaneWidth, alignment: .leading)
    }

    private var sessionHeaderLaneWidth: CGFloat {
        let surfaceWidth = viewportWidth > 0 ? viewportWidth : 390
        return min(560, max(200, surfaceWidth - 160))
    }

    /// Mobile web opens workspace details when its title is tapped. Keep the
    /// same identity in native navigation and present a SwiftUI details sheet.
    private var sessionIdentityButton: some View {
        Button {
            showWorktreeInfo = true
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                // No run dot up here: the bar is identity and navigation,
                // and the running state now reads where the work is, in the
                // clock at the end of the transcript.
                HStack(spacing: 4) {
                    // A machine owns this conversation. Same glyph and same
                    // slot as the web header's automation link. Origin reads
                    // beside the name it produced.
                    if viewModel.session.wasAgentStarted {
                        WebIcon(kind: .robot, size: 15, color: OS1VisualStyle.textDim)
                            .accessibilityHidden(true)
                    }
                    SingleLineFadeText(
                        text: identityTitle,
                        font: .callout.weight(.semibold),
                        width: sessionIdentityWidth - 22
                    )
                        .foregroundStyle(OS1VisualStyle.text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !dynamicTypeSize.isAccessibilitySize {
                    headerSubtitleText
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            // Keep the glass visually tighter than its toolbar-owned 44pt tap
            // target while leaving enough height for both identity lines.
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
            .contentShape(Capsule())
        }
        // Opt this custom identity control into the same Liquid Glass style as
        // the system Back button.
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(.primary)
        .frame(width: sessionIdentityWidth, alignment: .leading)
        .accessibilityLabel("Workspace details")
    }

    private var sessionIdentityWidth: CGFloat {
        let surfaceWidth = viewportWidth > 0 ? viewportWidth : 390
        return min(360, max(128, surfaceWidth - 128))
    }
    #endif

    private func pullRequestButton(number: Int) -> some View {
        Button {
            showPrPanel = true
        } label: {
            PrChipLabel(number: number, summary: viewModel.prDetails?.summary)
        }
        .accessibilityLabel(Text(verbatim: "Pull request #\(number)"))
    }

    private var currentModel: String {
        viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
    }

    /// The bar names the WORKTREE, not the conversation open inside it — the
    /// same name it carries in the sidebar, in Catch up and in the rename
    /// alert one tap away. The identity of a place shouldn't change with which
    /// room of it you are standing in; which room that is, the tab strip says.
    /// Rule and fallbacks: `SessionsListViewModel.worktreeTitle`.
    private var identityTitle: String {
        SessionsListViewModel.worktreeTitle(
            for: viewModel.session, in: tabs, workspaceNames: workspaceNames
        )
    }

    private var headerSubtitle: String {
        let repo = RepoTile.label(for: viewModel.session.effectiveRepo)
        let model = catalog?.label(for: currentModel) ?? currentModel
        let prNumber = viewModel.prDetails?.number ?? viewModel.session.prNumber
        var parts: [String] = []
        if let prNumber {
            parts.append("#\(prNumber)")
        }
        parts.append(repo)
        parts.append(model)
        return parts
            .filter { !$0.isEmpty }
            .joined(separator: " • ")
    }

    private var headerSubtitleText: Text {
        var subtitle = AttributedString(headerSubtitle)
        if let pr = viewModel.prDetails,
           let range = subtitle.range(of: "#\(pr.number)")
        {
            subtitle[range].foregroundColor = pr.summary.color
        }
        return Text(subtitle)
    }

    /// Re-pin to the latest for a beat while the transcript settles.
    ///
    /// - Parameters:
    ///   - seconds: how long to keep re-asserting.
    ///   - delay: wait this long before the first re-assert — for a hold that
    ///     follows an ANIMATED scroll, which would otherwise be cut off
    ///     mid-glide by the first one.
    private func beginHold(
        _ proxy: ScrollViewProxy,
        seconds: Double = SessionView.initialHoldSeconds,
        after delay: Duration = .zero
    ) {
        holdTask?.cancel()
        holdingAtLatest = true
        holdTask = Task {
            if delay > .zero {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, holdingAtLatest else { return }
            }
            // Re-assert during the window, not just at its end: a row that
            // grows at 0.4s pushes the bottom away, and one scroll at 2.5s
            // would leave the reader looking at the wrong place until then.
            for _ in 0..<max(1, Int(seconds / 0.25)) {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, holdingAtLatest else { return }
                scrollToBottom(proxy, animated: false, repin: false)
            }
            holdingAtLatest = false
        }
    }

    private func endHold() {
        holdTask?.cancel()
        holdTask = nil
        holdingAtLatest = false
    }

    /// Put the reader back where the page of earlier history found them as
    /// soon as the lazy stack reports a valid post-prepend height.
    ///
    /// SwiftUI anchors a scroll view across a pure SIZE change, but not across
    /// the data change a prepend is: measured on an iPhone 17 Pro, one page
    /// moved the reader 1,254pt the first time and 2,186pt the next — to the
    /// top of the transcript, several screens from the line they were reading.
    ///
    /// Later markdown growth is an ordinary size change that SwiftUI anchors
    /// itself. Rewriting the offset for every growth step fought scroll
    /// momentum and made one history page feel like a dozen jumps.
    private func restoreAfterPrependIfPossible(_ geometry: TranscriptGeometry) {
        guard let distance = prependDistanceFromEnd,
              let baseline = prependBaselineContentHeight
        else { return }
        guard let y = TranscriptScroll.restoredScrollY(
            distanceFromEnd: distance,
            contentHeight: geometry.contentHeight,
            insetTop: geometry.insetTop,
            minimumContentHeight: baseline
        ) else { return }
        prependDistanceFromEnd = nil
        prependBaselineContentHeight = nil
        scrollPosition.scrollTo(y: y)
    }

    @ViewBuilder private var transcriptRows: some View {
        if viewModel.canLoadEarlier || viewModel.loadingEarlier {
            historyLoader
        }
        // Nothing on screen: the caller may own this space (the Desk puts its
        // board here). Keep it inside the transcript so composer and scrolling
        // behavior remain the session's own.
        if showingEmptyContent, let emptyContent {
            emptyContent()
                .id("empty-content")
        }
        ForEach(viewModel.displayBlocks) { block in
            transcriptRow(block)
        }
        if !viewModel.liveText.isEmpty {
            StreamingBubble(text: viewModel.liveText)
                .id("live-stream")
                .transcriptTail(tailId == "live-stream")
        }
        if let message = viewModel.inlineRunFailureMessage {
            runFailureAlert(message)
                .id("run-failure")
                .transcriptTail(tailId == "run-failure")
        }
        // The run clock closes the transcript while work is in flight, under
        // the durable answer, live stream, or working fold.
        if viewModel.isRunning {
            RunStatusFooter(since: viewModel.runStartedAt)
                .id("run-status")
                .transcriptTail(tailId == "run-status")
        }
        if let ask = viewModel.pendingQuestion {
            AskQuestionCard(ask: ask) { answers in
                viewModel.answer(question: ask, answers: answers)
            }
            .id("ask-\(ask.id)")
            .transcriptTail(true)
        }
        if let sent = viewModel.sentAskAnswer {
            AnsweredAskCard(ask: sent.ask)
                .id("ask-sent-\(sent.id)")
                .transcriptTail(true)
        }
        if let receipt = viewModel.slackComposeReceipt {
            SlackComposeReceiptRow(
                receipt: receipt,
                isUndoing: viewModel.undoingSlackComposeReceiptId == receipt.id,
                onUndo: { await viewModel.undoSlackComposeReceipt() }
            )
            .id("slack-receipt-\(receipt.id)")
            .transcriptTail(true)
        }
        // A small child at the end keeps a single giant lazy transcript block
        // realized when the reader lands at the bottom. It is not the scroll
        // target; `scrollToBottom` explains why it aims at a real row instead.
        Color.clear
            .frame(height: 1)
            .id("transcript-end")
    }

    private func runFailureAlert(_ message: String) -> some View {
        VStack(spacing: 4) {
            Label("Run failed", systemImage: "exclamationmark.triangle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.redInk)
            Text(message)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .multilineTextAlignment(.center)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(
            OS1VisualStyle.red.opacity(0.08),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .accessibilityElement(children: .combine)
    }

    private var transcriptScrollBase: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                transcriptRows
            }
            .padding(.horizontal, contentInset)
            .padding(.vertical, 8)
            .frame(maxWidth: contentMaxWidth)
            // Fill at least one viewport from the top so short transcripts do
            // not hang above the composer under the bottom scroll anchor.
            .frame(
                maxWidth: .infinity,
                minHeight: viewportHeight,
                alignment: .top
            )
        }
        .softScrollEdges()
        .environment(\.transcriptQuoteSelection, viewModel.quoteSelection)
        .transcriptQuoteInteractions(viewModel.quoteSelection)
        .onKeyPress(.escape) {
            guard viewModel.quoteSelection.text != nil else { return .ignored }
            viewModel.quoteSelection.clear()
            return .handled
        }
        .defaultScrollAnchor(showingEmptyContent ? .top : .bottom)
        .defaultScrollAnchor(
            showingEmptyContent ? .top : .bottom,
            for: .sizeChanges
        )
        // A transcript swipe dismisses the keyboard immediately. Interactive
        // dismissal can park the safe-area bar partly behind the keyboard,
        // hiding the composer while the keyboard still looks open.
        .scrollDismissesKeyboardImmediatelyCompat()
        .scrollPosition($scrollPosition)
    }

    private func transcriptRow(_ block: TranscriptBlock) -> some View {
        let continuation = viewModel.failureContinuationEntryId(catalog: catalog) == block.id
            ? FailureContinuationAction(viewModel: viewModel, noticeId: block.id)
            : nil

        return TranscriptRow(
            block: block,
            sessionId: viewModel.session.id,
            worktreeDir: viewModel.session.worktreeDir,
            foldState: {
                viewModel.foldState(for: $0, preference: turnActivity)
            },
            expansionState: {
                viewModel.expansionState(id: $0, defaultExpanded: $1)
            },
            activity: turnActivity,
            isActiveReasoning: viewModel.isRunning
                && block.id == viewModel.displayBlocks.last?.id,
            // An automation's turns are not a person's words, so they get no
            // author fallback. The web makes the same exception.
            owner: viewModel.session.transcriptOwner,
            outbox: viewModel.outbox,
            onEditMessage: { entry in
                viewModel.editSentMessageInComposer(entry)
            },
            onEditUnsent: { item in
                viewModel.editUnsent(item)
            },
            onDeleteUnsent: { item in
                viewModel.discardUnsent(item)
            },
            onEditNote: { note, text in
                try await viewModel.editSessionNote(note, text: text)
            },
            onDeleteNote: { note in
                try await viewModel.deleteSessionNote(note)
            },
            onForkMessage: canForkSession ? { entry in
                forkState.enter(messageId: entry.id)
            } : nil,
            failureContinuation: continuation
        )
        .id(block.id)
        .transcriptTail(block.id == tailId)
    }

    private func beginPrependRestoreIfPossible() {
        guard !viewModel.jumpingToStart,
              prependRequestInteraction == scrollInteractionGeneration
        else {
            cancelPrependRestore()
            return
        }
        prependRequestInteraction = nil
        awaitingPrepend = true
    }

    private func displayItemsChanged() {
        let isHistoryPrepend = lastDisplayHistoryPrependSeq != viewModel.historyPrependSeq
        lastDisplayHistoryPrependSeq = viewModel.historyPrependSeq
        if isHistoryPrepend { return }
        // A tail append during a restore breaks its pure-prepend invariant, so
        // the reader's current position wins over the stale distance from end.
        cancelPrependRestore()
        if !pinnedToBottom, !holdingAtLatest {
            newBelow = true
        }
    }

    private func runningChanged(_ running: Bool) {
        if running, !pinnedToBottom, !holdingAtLatest { newBelow = true }
    }

    private func liveTextChanged() {
        cancelPrependRestore()
        if !pinnedToBottom, !viewModel.liveText.isEmpty {
            newBelow = true
        }
    }

    private func jumpToStartIfLanded(_ proxy: ScrollViewProxy) {
        cancelPrependRestore()
        if let first = viewModel.displayBlocks.first?.id {
            proxy.scrollTo(first, anchor: .top)
        }
    }

    private func cancelPrependRestore() {
        awaitingPrepend = false
        prependDistanceFromEnd = nil
        prependBaselineContentHeight = nil
        prependRequestInteraction = nil
    }

    /// Take the transcript to its last row — the ask card, the run clock, the
    /// live stream or the newest block, whichever ends it.
    ///
    /// It aims at a REAL row rather than at the trailing sentinel, even though
    /// the sentinel is the content's actual last point: a `LazyVStack` only
    /// realizes what intersects the visible window, and a session whose whole
    /// loaded transcript is one long turn has exactly one giant child — land
    /// on the 1pt sentinel below it and the screen comes up BLANK until a
    /// touch forces a layout pass (measured; it stayed blank for a minute).
    /// The row's own `transcriptTail` padding is what keeps it clear of the
    /// composer's fade, since this puts its frame's bottom edge on the visible
    /// bottom.
    private func scrollToBottom(
        _ proxy: ScrollViewProxy,
        animated: Bool,
        repin: Bool = true
    ) {
        guard let target = tailId else { return }
        if repin {
            if readerMovedTowardHistory { readerMovedTowardHistory = false }
            if !pinnedToBottom { pinnedToBottom = true }
        }
        if animated {
            withAnimation(.snappy) { proxy.scrollTo(target, anchor: .bottom) }
        } else {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    private func jumpToSentMessage(
        _ message: SentMessageAnchor,
        proxy: ScrollViewProxy
    ) {
        guard let target = viewModel.blockId(containing: message.id) else { return }
        endHold()
        cancelPrependRestore()
        readerMovedTowardHistory = true
        pinnedToBottom = false
        newBelow = false
        viewModel.userDidInteract()
        proxy.scrollTo(target, anchor: .top)
    }
}

private extension View {
    /// Mark the transcript's last row, which carries the clearance that keeps
    /// it out of the composer's fade — see `SessionView.tailClearance`.
    func transcriptTail(_ isTail: Bool) -> some View {
        padding(.bottom, isTail ? SessionView.tailClearance : 0)
    }
}

private struct SlackComposeReceiptRow: View {
    let receipt: SlackComposeReceipt
    let isUndoing: Bool
    let onUndo: () async -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let logo = Brand.logo(for: "slack") {
                BrandLogoShape(logo: logo)
                    .fill(Brand.colors(for: "slack")?.background ?? .secondary)
                    .frame(width: 12, height: 12)
            }
            if receipt.status == .sent {
                if let channel = receipt.channel {
                    Text("Sent to \(Text("#\(channel.name)").fontWeight(.semibold))")
                } else {
                    Text("Sent to Slack")
                }
                if let value = receipt.permalink, let url = URL(string: value) {
                    Text("·").foregroundStyle(OS1VisualStyle.textFaint)
                    Link("Open in Slack", destination: url)
                        .underline()
                }
                if receipt.channel != nil, receipt.ts != nil {
                    Text("·").foregroundStyle(OS1VisualStyle.textFaint)
                    Button(isUndoing ? "Undoing…" : "Undo") {
                        Task { await onUndo() }
                    }
                    .buttonStyle(.plain)
                    .underline()
                    .disabled(isUndoing)
                }
            } else {
                Text("Slack message cancelled")
            }
        }
        .font(.footnote)
        .foregroundStyle(OS1VisualStyle.textDim)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Isolated from `SessionView.body` so lane and hide updates do not invalidate
/// the transcript. On Mac this is the open session's direct toolbar action.
private struct AddToSidebarButton: View {
    let session: Session
    let siblings: [Session]

    var body: some View {
        if SidebarAddition.currentIntent(for: session, siblings: siblings) != nil {
            Button {
                SidebarAddition.add(session: session, siblings: siblings)
            } label: {
                Label("Add to sidebar", systemImage: "sidebar.left")
            }
            .help("Add to sidebar")
        }
    }
}

#if os(iOS)
/// The session's overflow menu — the trailing nav-bar control, a native `Menu` so
/// iOS renders (and animates) it as a real UIMenu.
///
/// It carries the worktree actions the sidebar row offers under long-press, so
/// the session isn't a dead end for them: details, its pull request, rename, share,
/// hide and archive — plus "New session", which used to be the bare `+` this menu
/// replaced.
///
/// Its own view struct on purpose. The menu reads `prDetails` and the hide
/// store, and reading either inside `SessionView.body` would re-evaluate the
/// whole body — transcript included — every time one of them moved.
private struct SessionActionsMenu: View {
    let viewModel: SessionViewModel
    /// The sessions of this worktree — the sidebar row, regrouped below.
    let tabs: [Session]
    /// Direct child sessions hidden from the tab strip.
    let workerSessions: [Session]
    /// Workspace names for that regrouping; see `SessionView.workspaceNames`.
    let workspaceNames: [String: String]
    /// Model/effort catalog for the nested settings rows; nil until the first
    /// `/api/models` fetch lands, which only costs the Model row.
    let catalog: ModelCatalog?
    let onNewSession: (() -> Void)?
    let onFork: (() -> Void)?
    let onRenameWorkspace: ((String) -> Void)?
    let onArchiveWorkspace: (() -> Void)?
    let onDeleteWorkspace: (() -> Void)?
    @Binding var showWorktreeInfo: Bool
    @Binding var showPrPanel: Bool
    @Binding var renaming: Bool
    @Binding var renameText: String
    /// The tab strip's assets tab, when this session is in one. Unavailable
    /// where there is no strip to open a tab in, which keeps the entry out of
    /// the menu there rather than offering something that can't happen.
    let openPanel: OpenPanelAction
    /// This workspace's closed sessions, when this menu is the surface
    /// carrying them. Nil while the tab strip has them, which is what keeps
    /// one list from being offered in two places at once.
    var workspaceHistory: WorkspaceSessionHistory?

    @State private var pendingMerge: String?
    @State private var merging = false
    @State private var mergeError: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Menu {
            if addIntent != nil {
                Button {
                    SidebarAddition.add(session: viewModel.session, siblings: tabs)
                } label: {
                    Label("Add to sidebar", systemImage: "sidebar.left")
                }
            }
            if let onNewSession {
                Button(action: onNewSession) {
                    // Two words, because the workspace it lands in is the one
                    // you're already looking at — spelling it out wrapped the
                    // row onto two lines to say what the tab strip then shows
                    // anyway. VoiceOver keeps the long form, where naming the
                    // scope costs no space: the same split as the web tab
                    // strip's bare "+" and its aria-label.
                    Label("New session", systemImage: "plus")
                }
                .accessibilityLabel(
                    // A workspace-less legacy session has nothing to join, so
                    // the plain wording stays honest there.
                    viewModel.session.workspaceId == nil
                        ? "New session"
                        : "New session in this workspace"
                )
            }
            if let onFork {
                Button(action: onFork) {
                    Label("Fork", systemImage: "arrow.triangle.branch")
                }
                .accessibilityHint("Starts a new session from the current history")
            }
            if !workerSessions.isEmpty {
                Menu {
                    ForEach(workerSessions) { worker in
                        Button {
                            openWorker(worker)
                        } label: {
                            Label(
                                worker.displayTitle,
                                systemImage: worker.isRunning == true ? "circle.fill" : "circle"
                            )
                        }
                        .accessibilityLabel(
                            "\(worker.displayTitle), \(worker.isRunning == true ? "running" : "finished")"
                        )
                    }
                } label: {
                    Label(
                        "Delegated workers (\(workerSessions.count))",
                        systemImage: "arrow.down.right"
                    )
                }
            }
            // What was closed here, next to the way to open a new one: the
            // two are the same errand, another conversation in this
            // workspace. These rows normally hang off the tab strip's history
            // button, so they appear exactly when there is no strip to hold
            // them, which is also when someone is most likely to go looking
            // for what was closed. High in the menu rather than beside the
            // destructive rows where the web keeps it, because this menu is
            // long enough to scroll on a phone and the entry that has no
            // other home must not be the one below the fold. A submenu, since
            // the list is usually one or two entries but can run to twenty.
            if let workspaceHistory, !workspaceHistory.sessions.isEmpty {
                Menu {
                    SessionHistoryItems(
                        sessions: workspaceHistory.sessions,
                        restoringIds: workspaceHistory.restoringIds,
                        onRestore: workspaceHistory.restore
                    )
                } label: {
                    Label(
                        "Closed sessions",
                        systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90"
                    )
                }
            }
            Button {
                showWorktreeInfo = true
            } label: {
                Label("Worktree details", systemImage: "info.circle")
            }
            // What the next turn runs on. It was only reachable through the
            // worktree details sheet, which is a long way to go for a setting
            // the web changes from the composer.
            Menu {
                ModelSettingsMenu(viewModel: viewModel, catalog: catalog, showsUsage: false)
            } label: {
                Label("Model settings", systemImage: "slider.horizontal.3")
            }
            // Everything the worktree has changed, for the edits no visible
            // tool row names — the ones made before the transcript you're
            // reading, and the ones the agent made without saying so.
            if openPanel.isAvailable {
                Button {
                    openPanel(.changes(sessionId: viewModel.session.id))
                } label: {
                    Label("Changes", systemImage: "plusminus")
                }
            }
            // The whole scratch folder, for the files no visible tool row
            // names — the ones written before the transcript you're reading.
            if openPanel.isAvailable {
                Button {
                    openPanel(.assets(sessionId: viewModel.session.id))
                } label: {
                    Label("Assets", systemImage: "folder")
                }
            }
            // What this session put on a port: its dev server, a docs site,
            // whatever it brought up. Opening the list never wakes a sleeping
            // sandbox; only a restart someone asked for does.
            if openPanel.isAvailable {
                Button {
                    openPanel(.portals(sessionId: viewModel.session.id))
                } label: {
                    Label("Portals", systemImage: "globe")
                }
            }
            // A shell in the worktree, for the one short command that is
            // quicker to run than to ask for, and for following a log the
            // session is already writing.
            if openPanel.isAvailable {
                Button {
                    openPanel(.terminal(sessionId: viewModel.session.id))
                } label: {
                    Label("Terminal", systemImage: "apple.terminal")
                }
            }
            // The batches of agents this session fanned work out to. The
            // conversation shows that a run happened; what each agent came
            // back with is only here.
            if openPanel.isAvailable {
                Button {
                    openPanel(.agents(sessionId: viewModel.session.id))
                } label: {
                    Label("Agents", systemImage: "square.stack.3d.up")
                }
            }
            if let number = viewModel.prDetails?.number ?? viewModel.session.prNumber {
                Button {
                    // A tab where there's a strip to open one in; the sheet
                    // stays the fallback for the surfaces without one.
                    if openPanel.isAvailable {
                        openPanel(.review(sessionId: viewModel.session.id))
                    } else {
                        showPrPanel = true
                    }
                } label: {
                    Label {
                        Text(verbatim: "Pull request #\(number)")
                    } icon: {
                        Image(systemName: "arrow.triangle.pull")
                    }
                }
                if viewModel.prDetails?.isOpen == true {
                    Menu {
                        Button("Squash and merge") { pendingMerge = "squash" }
                        Button("Create a merge commit") { pendingMerge = "merge" }
                        Button("Rebase and merge") { pendingMerge = "rebase" }
                    } label: {
                        Label(
                            merging ? "Merging pull request…" : "Merge pull request",
                            systemImage: "arrow.triangle.merge"
                        )
                    }
                    .disabled(merging)
                }
            }

            Section {
                // The rename itself runs from SessionView's alert; the menu
                // only raises it, so the callback's presence is the gate.
                if onRenameWorkspace != nil {
                    Button {
                        renameText = workspace?.title ?? viewModel.session.displayTitle
                        renaming = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                }
                // The share sheet names the link after the workspace, the same
                // name the header shows and the Slack unfurl leads with. A
                // session is a tab inside it, so its own title isn't the page.
                if let workspace, let link = workspace.shareURL {
                    ShareLink(item: link, preview: SharePreview(workspace.title)) {
                        Label("Share link", systemImage: "square.and.arrow.up")
                    }
                }
            }

            if let workspace, !workspace.isOptimistic {
                Section {
                    // Hiding is the personal counterpart to archiving: the row
                    // leaves YOUR sidebar while the session keeps running for
                    // everyone else — so it isn't destructive-styled.
                    if HideStore.shared.isHidden(workspace), addIntent == nil {
                        Button {
                            // `unhide` rather than clearing this row's key:
                            // it drops every key the session could sit under,
                            // which is deliberately safe (over-clearing only
                            // ever restores a row) and keeps the menu off the
                            // row-key helper.
                            HideStore.shared.unhide(for: viewModel.session)
                        } label: {
                            Label("Restore to sidebar", systemImage: "eye")
                        }
                    } else if !HideStore.shared.isHidden(workspace) {
                        Button {
                            HideStore.shared.hide(workspace)
                        } label: {
                            // Shortened for the same reason as the list's copy:
                            // "…my sidebar" wraps onto a second line here.
                            Label("Hide from sidebar", systemImage: "eye.slash")
                        }
                    }
                    if let onArchiveWorkspace {
                        Button(role: .destructive, action: onArchiveWorkspace) {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                    if workspace.workspaceId?.isEmpty == false, let onDeleteWorkspace {
                        Button(role: .destructive, action: onDeleteWorkspace) {
                            Label("Delete workspace", systemImage: "trash")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .foregroundStyle(OS1VisualStyle.textDim)
        }
        .accessibilityLabel("Session actions")
        .confirmationDialog(
            mergeConfirmationTitle,
            isPresented: Binding(
                get: { pendingMerge != nil },
                set: { if !$0 { pendingMerge = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(mergeButtonLabel(pendingMerge ?? "squash")) {
                merge(method: pendingMerge ?? "squash")
            }
            Button("Cancel", role: .cancel) { pendingMerge = nil }
        } message: {
            Text(mergeConfirmationMessage)
        }
        .alert(
            "Couldn’t merge pull request",
            isPresented: Binding(
                get: { mergeError != nil },
                set: { if !$0 { mergeError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(mergeError ?? "Please try again.")
        }
    }

    private func openWorker(_ worker: Session) {
        guard let url = SessionLinks.url(for: worker.id) else { return }
        openURL(url)
    }

    private var addIntent: SidebarAddition.Intent? {
        SidebarAddition.currentIntent(for: viewModel.session, siblings: tabs)
    }

    private var mergeConfirmationTitle: String {
        guard let number = viewModel.prDetails?.number else { return "Merge pull request?" }
        return "Merge PR #\(number)?"
    }

    private var mergeConfirmationMessage: String {
        guard let pr = viewModel.prDetails else { return "This cannot be undone." }
        var warnings: [String] = []
        if pr.mergeable == "CONFLICTING" { warnings.append("it has conflicts") }
        if (pr.checks ?? []).contains(where: { $0.rank == .failure }) {
            warnings.append("checks are failing")
        } else if (pr.checks ?? []).contains(where: { $0.rank == .pending }) {
            warnings.append("checks are still running")
        }
        if pr.isDraft == true { warnings.append("it’s still a draft") }
        if pr.reviewDecision == "CHANGES_REQUESTED" { warnings.append("changes were requested") }
        let base = pr.baseRefName ?? "the base branch"
        guard !warnings.isEmpty else { return "This merges into \(base)." }
        return "This merges into \(base) even though \(warnings.joined(separator: ", "))."
    }

    private func mergeButtonLabel(_ method: String) -> String {
        switch method {
        case "merge": "Create a merge commit"
        case "rebase": "Rebase and merge"
        default: "Squash and merge"
        }
    }

    private func merge(method: String) {
        pendingMerge = nil
        guard !merging else { return }
        merging = true
        mergeError = nil
        Task {
            do {
                try await viewModel.mergePr(method: method)
                Haptics.play(.commit)
            } catch {
                mergeError = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
            merging = false
        }
    }

    /// The sidebar row these sessions form. `tabs` is exactly one worktree's
    /// sessions, so regrouping them reproduces the row — and, crucially, the row
    /// KEY that hides are stored under — without reaching for the list's model.
    private var workspace: SidebarWorkspace? {
        SessionsListViewModel.sidebarWorkspaces(
            in: tabs,
            workspaceNames: workspaceNames
        ).first { workspace in
            workspace.sessions.contains { $0.id == viewModel.session.id }
        }
    }
}
#endif

/// The way back to the bottom of a transcript the reader scrolled away from.
///
/// On the phone it is just the arrow: the direction is the whole message, a
/// thumb wants the target, and a wordless disc sits over the conversation
/// without reading as another message in it. The Mac keeps the words and
/// stays small — a pointer needs no 44pt target, and a desktop window has
/// room for a label that says which way "down" goes.
///
/// It doubles as the "there is output you haven't seen" signal — new content
/// below the fold wears the accent colour rather than the neutral control
/// surface, which is the difference between a control and a notification.
///
/// Both shapes sit on a solid surface, deliberately neither glass nor
/// material: those sample what is behind them, so a dark code block or image
/// scrolling under the control dragged it toward its dark appearance while
/// the glyph kept its light-mode colour. It travels over arbitrary content,
/// so it keeps one appearance and earns its lift from a hairline and a soft
/// shadow instead — the same opaque treatment the web control wears.
struct ScrollToLatestButton: View {
    let hasNewOutput: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            #if os(macOS)
            HStack(spacing: 4) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 10, weight: .semibold))
                Text(hasNewOutput ? "New messages" : "Scroll to bottom")
                    .font(.caption.weight(.medium))
            }
            .foregroundStyle(
                hasNewOutput ? OS1VisualStyle.accentInk : OS1VisualStyle.textDim
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(OS1VisualStyle.panel, in: Capsule())
            .overlay { Capsule().stroke(OS1VisualStyle.border, lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.12), radius: 6, y: 1)
            .contentShape(Capsule())
            #else
            Image(systemName: "arrow.down")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(
                    hasNewOutput ? OS1VisualStyle.onAccent : OS1VisualStyle.textDim
                )
                .frame(width: 40, height: 40)
                // The accent fill is the phone's version of the accent label
                // the Mac gets: without words, colour is the only thing left
                // to carry "there is something new down there".
                .background(
                    hasNewOutput ? OS1VisualStyle.accent : OS1VisualStyle.panel,
                    in: Circle()
                )
                .overlay {
                    if !hasNewOutput {
                        Circle().stroke(OS1VisualStyle.border, lineWidth: 0.5)
                    }
                }
                .shadow(color: .black.opacity(0.12), radius: 6, y: 1)
                // Padded out to a 44pt target: the disc reads better at 40.
                .padding(2)
                .contentShape(Circle())
            #endif
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            hasNewOutput ? "New messages below. Scroll to latest" : "Scroll to latest"
        )
    }
}

#if os(iOS)
/// Keeps the tab strip anchored while sibling conversations move horizontally
/// according to their order. Recently visited conversations reuse their loaded
/// view model; SessionView still disconnects each socket while it is off-screen.
struct SessionTabsView: View {
    let initialSession: Session
    let tabs: [Session]
    /// Every live session available for resolving direct worker relationships.
    let relatedSessions: [Session]
    /// Passed straight through to SessionView; see its `workspaceNames`.
    let workspaceNames: [String: String]
    let viewModelForSession: (Session) -> SessionViewModel
    let onSaveComposerDraft: (Session, SessionViewModel.ComposerDraft) -> Void
    /// Open a new session in this workspace. Answers with the session that was
    /// created — this view focuses it as a tab — or nil when there was nothing
    /// to open as one (a workspace-less session falls back to the composer
    /// sheet, and a failed create has already surfaced its error).
    let onNewSession: () async -> Session?
    /// Move from this workspace to the next visible chat in the sidebar.
    let onNextChat: (() -> Void)?
    let onForkCreated: (String) async -> Void
    /// Rename the worktree these sessions share, from the session's overflow menu.
    let onRenameWorkspace: (String) -> Void
    /// Archive every session of the worktree, from the session's overflow menu.
    let onArchiveWorkspace: () -> Void
    /// Permanently delete the established workspace after the list confirms it.
    let onDeleteWorkspace: () -> Void
    /// Close (archive) a session closed from the tab strip.
    let onCloseTab: (Session) -> Void
    /// Hydrate and restore a closed sibling. The returned whole session becomes
    /// the active tab immediately while the live sessions poll catches up.
    let onRestoreTab: (Session) async -> Session?

    @State private var activeId: String
    @State private var transitionEdge = Edge.trailing
    /// Sessions closed from the strip during this visit. Archiving alone doesn't
    /// retire the pushed session's tab: `tabSessions` deliberately keeps the
    /// session the stack was pushed with even once it's archived (so a session
    /// opened from the archive sheet still renders), which would leave the tab
    /// you just closed sitting in the strip.
    @State private var closedIds: Set<String> = []
    /// The session detail being read one level deeper — its assets, one of
    /// those files, its pull request. A push rather than a tab: these are
    /// details OF the conversation, so the chevron and the edge swipe are the
    /// way back, and nothing has to be closed afterwards.
    @State private var panel: SessionPanel?
    /// A scratch file opened from a link in the prose. Held here because this
    /// is where those links are caught.
    @State private var assetOverlay: AssetOverlayItem?
    /// A "+" that hasn't answered yet, so a second tap can't mint a second tab.
    @State private var openingTab = false
    /// The scoped archive response, plus the two short-lived overlays needed
    /// while a close or restore made here is ahead of that response.
    @State private var fetchedArchivedTabs: [Session] = []
    @State private var locallyArchivedTabs: [Session] = []
    @State private var locallyRestoredTabs: [Session] = []
    @State private var restoringTabIds: Set<String> = []
    @State private var archiveRevision = 0
    /// The link handler INSTALLED ABOVE this view (the sessions list's, which
    /// follows session-id links). Reading it here is safe and is the point:
    /// `.environment` applies to descendants, so this property still holds the
    /// inherited action, and the one this view installs can hand everything it
    /// doesn't own back to it instead of dead-ending at `.systemAction`.
    @Environment(\.openURL) private var enclosingOpenURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    /// The appearance outside the bar, to pin the floating tab strip to.
    @Environment(\.colorScheme) private var tabsColorScheme

    init(
        session: Session,
        tabs: [Session],
        relatedSessions: [Session] = [],
        workspaceNames: [String: String] = [:],
        viewModelForSession: @escaping (Session) -> SessionViewModel,
        onSaveComposerDraft: @escaping (Session, SessionViewModel.ComposerDraft) -> Void,
        onNewSession: @escaping () async -> Session?,
        onNextChat: (() -> Void)?,
        onForkCreated: @escaping (String) async -> Void,
        onRenameWorkspace: @escaping (String) -> Void,
        onArchiveWorkspace: @escaping () -> Void,
        onDeleteWorkspace: @escaping () -> Void,
        onCloseTab: @escaping (Session) -> Void,
        onRestoreTab: @escaping (Session) async -> Session?
    ) {
        initialSession = session
        self.tabs = tabs
        self.relatedSessions = relatedSessions
        self.workspaceNames = workspaceNames
        self.viewModelForSession = viewModelForSession
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        self.onNextChat = onNextChat
        self.onForkCreated = onForkCreated
        self.onRenameWorkspace = onRenameWorkspace
        self.onArchiveWorkspace = onArchiveWorkspace
        self.onDeleteWorkspace = onDeleteWorkspace
        self.onCloseTab = onCloseTab
        self.onRestoreTab = onRestoreTab
        _activeId = State(initialValue: session.id)
    }

    private var knownTabs: [Session] {
        tabs + locallyRestoredTabs + locallyArchivedTabs
    }

    private var visibleTabs: [Session] {
        var byId: [String: Session] = [:]
        for session in tabs + locallyRestoredTabs { byId[session.id] = session }
        let candidates = byId.values.filter { !closedIds.contains($0.id) }
        let current = candidates.first { $0.id == activeId }
            ?? candidates.first { $0.id == initialSession.id }
            ?? initialSession
        return SessionsListViewModel.tabSessions(in: candidates, containing: current)
    }

    private var activeSession: Session {
        visibleTabs.first(where: { $0.id == activeId })
            ?? visibleTabs.first
            ?? initialSession
    }

    private var archivedTabs: [Session] {
        SessionsListViewModel.workspaceArchivedSessions(
            known: knownTabs,
            fetched: fetchedArchivedTabs,
            containing: activeSession
        )
    }

    private var historyWorkspaceId: String? {
        let current = knownTabs.last { $0.id == activeSession.id } ?? activeSession
        guard let workspaceId = current.workspaceId, !workspaceId.isEmpty else { return nil }
        return workspaceId
    }

    /// Which of this workspace's two surfaces is carrying its closed sessions.
    private var historyPlacement: SessionHistoryPlacement {
        SessionsListViewModel.historyPlacement(
            liveTabs: visibleTabs.count, archived: archivedTabs.count
        )
    }

    /// The closed sessions, for the overflow menu, and only while there is no
    /// strip to hold them. Restoring from there lands the workspace back on
    /// two tabs, so the strip returns and takes the list with it.
    private var overflowMenuHistory: WorkspaceSessionHistory? {
        guard historyPlacement == .actionsMenu else { return nil }
        return WorkspaceSessionHistory(
            sessions: archivedTabs,
            restoringIds: restoringTabIds,
            restore: { restore($0.id) }
        )
    }

    private var historyRequestKey: String {
        "\(historyWorkspaceId ?? "none"):\(archiveRevision)"
    }

    private var conversationTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let removalEdge: Edge = transitionEdge == .trailing ? .leading : .trailing
        return .asymmetric(
            insertion: .move(edge: transitionEdge).combined(with: .opacity),
            removal: .move(edge: removalEdge).combined(with: .opacity)
        )
    }

    var body: some View {
        ZStack {
            ForEach([activeSession]) { session in
                SessionView(
                        viewModel: viewModelForSession(session),
                        tabs: visibleTabs,
                        workerSessions: SessionsListViewModel.workerSessions(
                            in: relatedSessions,
                            parentId: session.id
                        ),
                        workspaceNames: workspaceNames,
                        onSaveComposerDraft: { draft in
                            onSaveComposerDraft(session, draft)
                        },
                        onNewSession: openNewTab,
                        onNextChat: onNextChat,
                        onForkCreated: onForkCreated,
                        onRenameWorkspace: onRenameWorkspace,
                        // Archiving the worktree from within it leaves nothing to
                        // show here, so pop back to the sessions list — the same
                        // landing as closing the last tab.
                        onArchiveWorkspace: {
                            onArchiveWorkspace()
                            dismiss()
                        },
                        onDeleteWorkspace: onDeleteWorkspace,
                        workspaceHistory: overflowMenuHistory
                    )
                    // What the transcript's asset chips and the overflow menu
                    // reach for. Installed here rather than passed down: the
                    // deepest caller is a tool-call row several layers in.
                    .environment(\.openPanel, .pushing(sessionId: session.id) { pushed in
                        panel = pushed
                    })
                    // A file path in the transcript (FileLinks) is a markdown
                    // link on a private scheme; catching it here is what turns
                    // it into that file's diff. Everything else is handed to
                    // the handler above — the sessions list's, which owns
                    // session-id links — because an OpenURLAction that
                    // answers `.systemAction` skips it.
                    .environment(\.openURL, OpenURLAction { url in
                        if let path = FileLinks.path(from: url) {
                            panel = .changes(sessionId: session.id, path: path)
                            return .handled
                        }
                        // A scratch file named in the prose (AssetLinks) opens
                        // where its chip would: through AssetOpen, so the one
                        // decision about pictures vs. everything else is made
                        // in one place.
                        if let path = AssetLinks.path(from: url) {
                            AssetOpen.open(
                                sessionId: session.id,
                                path: path,
                                overlay: $assetOverlay
                            )
                            return .handled
                        }
                        enclosingOpenURL(url)
                        return .handled
                    })
                    .transition(conversationTransition)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // One level deeper than the conversation, on the stack that pushed it:
        // the strip goes with the conversation it belongs to, and the chevron
        // and the edge swipe come back to exactly where you were.
        .navigationDestination(item: $panel) { panel in
            panelContent(panel)
        }
        // Hosted beside the stack rather than on the transcript row that was
        // tapped: the link is caught here, so this is what owns the state.
        .assetOverlayPreview(
            $assetOverlay,
            openPanel: .pushing(sessionId: activeSession.id) { panel = $0 }
        )
        // No .clipped() here: this container sits within the safe area, so a
        // clip cuts the transcript's edge-to-edge rendering at the safe-area
        // bounds — an opaque-looking nav bar and a dead strip above the home
        // indicator. Tab-switch slides may draw offscreen; that's invisible
        // on a full-screen push.
        // A BAR, not a plain inset — the same reason the composer is one (see
        // SessionView.body): `safeAreaBar` is what tells the scroll view its
        // content travels behind the strip, which is what makes the tabs float
        // over the transcript and draws the soft scroll edge effect there. With
        // a plain inset the transcript simply started below an opaque band.
        // A strip is drawn for siblings to switch between. One tab needs no
        // switcher, and a bar holding a single pill only repeats the name the
        // header already carries, so this workspace's closed sessions travel
        // to the overflow menu instead (see `overflowMenuHistory`) rather
        // than keeping a whole bar alive for the history control.
        .safeAreaBar(edge: .top, spacing: 0) {
            if visibleTabs.count > 1 {
                SessionTabBar(
                    tabs: visibleTabs.map(TabPill.init),
                    activeId: activeId,
                    onSelect: select,
                    onClose: close,
                    archived: historyPlacement == .tabStrip ? archivedTabs : [],
                    restoringIds: restoringTabIds,
                    onRestore: restore
                )
                // Same reason the composer bar is pinned (see
                // SessionView.inputBar): a `safeAreaBar` is adaptive chrome,
                // and dark content travelling under it repaints the strip and
                // its labels in the other appearance.
                .environment(\.colorScheme, tabsColorScheme)
            }
        }
        // Reading a session clears its unread mark, and keeps clearing it while
        // you stay in it: `activeSession` is re-read from the sessions poll,
        // so each new `lastActivity` re-marks the open session instead of bolding
        // its row behind you. Same rule as the web viewer's markRead tick.
        .onChange(of: activeSession, initial: true) { _, session in
            ReadsStore.shared.open(session)
            MentionStore.shared.open(session.id)
        }
        .onDisappear {
            ReadsStore.shared.close(activeSession.id)
            MentionStore.shared.close(activeSession.id)
        }
        .onChange(of: visibleTabs) { _, updatedTabs in
            // A conversation whose detail is open can be archived from
            // elsewhere; that panel goes with it.
            if let open = panel,
               !updatedTabs.contains(where: { $0.id == open.sessionId }) {
                panel = nil
            }
            guard !updatedTabs.contains(where: { $0.id == activeId }),
                  let fallback = updatedTabs.first
            else { return }

            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                activeId = fallback.id
            }
        }
        .onChange(of: tabs) { _, serverTabs in
            let serverIds = Set(serverTabs.map(\.id))
            locallyRestoredTabs.removeAll { serverIds.contains($0.id) }
        }
        .task(id: historyRequestKey) {
            await loadWorkspaceHistory()
        }
    }

    private func close(_ id: String) {
        guard let session = visibleTabs.first(where: { $0.id == id }) else { return }
        closeSession(session)
    }

    /// Close a session from the strip: archive it, then land on a neighbour —
    /// the tab to its right, or the one to its left when it was last. Closing
    /// the only remaining session leaves nothing to show, so the stack pops back
    /// to the sessions list.
    private func closeSession(_ session: Session) {
        let strip = visibleTabs
        let next = SessionsListViewModel.tabAfterClosing(session, in: strip)
        var archived = session
        archived.archived = true
        locallyArchivedTabs.removeAll { $0.id == session.id }
        locallyArchivedTabs.append(archived)
        locallyRestoredTabs.removeAll { $0.id == session.id }
        onCloseTab(session)

        guard let next else {
            dismiss()
            return
        }
        withAnimation(tabSwitchAnimation) {
            // Whatever detail of it was pushed is a detail of an archived
            // session now, so it goes back with it.
            if panel?.sessionId == session.id { panel = nil }
            if session.id == activeId {
                let closedIndex = strip.firstIndex { $0.id == session.id } ?? 0
                let nextIndex = strip.firstIndex { $0.id == next.id } ?? 0
                transitionEdge = nextIndex > closedIndex ? .trailing : .leading
                activeId = next.id
            }
            _ = closedIds.insert(session.id)
        }
        archiveRevision += 1
    }

    /// One conversation giving way to another: a tab closed, tapped, or newly
    /// opened at the end of the strip. They're the same move, so they share a
    /// curve.
    private var tabSwitchAnimation: Animation {
        reduceMotion
            ? .easeOut(duration: 0.16)
            : .snappy(duration: 0.26, extraBounce: 0)
    }

    /// The overflow menu's "New session in this workspace": open the tab, don't
    /// ask about it. The session is created empty, so the new tab lands on its
    /// own composer — the sheet had nothing left to collect. It joins `tabs`
    /// through the list's optimistic overlay before this returns, so switching
    /// to it is an ordinary tab selection.
    private func openNewTab() {
        guard !openingTab else { return }
        openingTab = true
        Task {
            let created = await onNewSession()
            openingTab = false
            guard let created else { return }
            withAnimation(tabSwitchAnimation) {
                // A new session sorts last, so it always arrives from the right.
                transitionEdge = .trailing
                activeId = created.id
            }
        }
    }

    private func select(_ id: String) {
        let ids = visibleTabs.map(\.id)
        guard id != activeId, let targetIndex = ids.firstIndex(of: id) else { return }

        let currentIndex = ids.firstIndex(of: activeId) ?? 0
        withAnimation(tabSwitchAnimation) {
            transitionEdge = targetIndex > currentIndex ? .trailing : .leading
            activeId = id
        }
    }

    private func restore(_ id: String) {
        guard !restoringTabIds.contains(id),
              let archived = archivedTabs.first(where: { $0.id == id })
        else { return }
        restoringTabIds.insert(id)
        Task {
            defer { restoringTabIds.remove(id) }
            guard var restored = await onRestoreTab(archived) else { return }
            restored.archived = false
            fetchedArchivedTabs.removeAll { $0.id == id }
            locallyArchivedTabs.removeAll { $0.id == id }
            locallyRestoredTabs.removeAll { $0.id == id }
            locallyRestoredTabs.append(restored)
            closedIds.remove(id)
            archiveRevision += 1
            withAnimation(tabSwitchAnimation) {
                transitionEdge = .trailing
                activeId = id
            }
        }
    }

    private func loadWorkspaceHistory() async {
        guard let workspaceId = historyWorkspaceId else {
            fetchedArchivedTabs = []
            return
        }
        guard let rows = try? await OS1API.archivedSessions(workspaceId: workspaceId),
              workspaceId == historyWorkspaceId
        else { return }
        fetchedArchivedTabs = rows
    }

    private func panelContent(_ panel: SessionPanel) -> some View {
        SessionPanelView(
            panel: panel,
            viewModel: viewModelForSession(session(withId: panel.sessionId))
        )
    }

    private func session(withId id: String) -> Session {
        visibleTabs.first { $0.id == id } ?? activeSession
    }
}

/// What one pill in the strip needs to draw itself.
///
/// The bar takes descriptions rather than sessions so its rendering can't
/// reach for anything a pill shouldn't know; everything a session detail
/// opens is a PUSH (see `SessionPanel`), never another pill, which is what
/// keeps "closing a tab archives a session" unambiguously true.
struct TabPill: Identifiable, Equatable {
    enum Activity: Equatable { case idle, running, waiting }

    let id: String
    let title: String
    var activity: Activity = .idle
    var closable = true

    init(_ session: Session) {
        id = session.id
        title = session.displayTitle
        activity = session.safety != nil || session.waitingForInput == true
            ? .waiting
            : (session.isRunning == true ? .running : .idle)
        // An optimistic session doesn't exist server-side yet, so there is
        // nothing to archive — it gets no × rather than a long press into an
        // empty menu.
        closable = !session.isOptimistic
    }
}

/// Workspace session tabs, as individually floating glass pills under the
/// navigation bar. Not one bar: each tab is its own capsule with its own
/// surface, so the row reads as chips over the session rather than a second band
/// of chrome. The transcript passes BEHIND them (the strip is attached as a
/// `safeAreaBar`) and dissolves through the soft scroll edge effect plus the
/// `transcriptTopWash` the transcript itself carries.
///
/// The active tab is centered when the strip opens, while horizontal overflow
/// remains native touch scrolling.
private struct SessionTabBar: View {
    let tabs: [TabPill]
    let activeId: String
    let onSelect: (String) -> Void
    /// Close a tab from the strip — archiving, for the ones that are sessions.
    let onClose: (String) -> Void
    let archived: [Session]
    let restoringIds: Set<String>
    let onRestore: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var activeTabIndicator

    /// Every pill wears this shape — its glass, its material, and the active
    /// tab's fill — so the three layers share one silhouette.
    private var pillShape: Capsule { Capsule(style: .continuous) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(tabs) { pill in
                        tab(pill)
                    }
                    if !archived.isEmpty {
                        SessionHistoryMenu(
                            sessions: archived,
                            restoringIds: restoringIds,
                            onRestore: { onRestore($0.id) }
                        )
                        .frame(width: 44, height: 44)
                        .background(
                            OS1VisualStyle.background.opacity(0.3),
                            in: pillShape
                        )
                        .background(.thickMaterial, in: pillShape)
                        .glassSurface(in: pillShape, interactive: true)
                    }
                }
                // The rail lives on the CONTENT, not the scroll view: pills
                // stay on the composer's 12pt line at rest and still scroll
                // out to the screen edges, where the wash takes them.
                .padding(.horizontal, 12)
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
            // No top padding: the pills are the session's own chrome rather than
            // a second band, so they ride tight under the navigation bar.
            .padding(.bottom, 4)
            .onAppear {
                proxy.scrollTo(activeId, anchor: .center)
            }
            .onChange(of: activeId) { _, id in
                if reduceMotion {
                    proxy.scrollTo(id, anchor: .center)
                } else {
                    withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
    }

    /// One tab pill. The close affordance is attached here rather than in the
    /// strip so an optimistic session — which the server can't archive yet — is
    /// simply left without one, instead of long-pressing into an empty menu.
    @ViewBuilder
    private func tab(_ pill: TabPill) -> some View {
        let capsule = tabPill(pill)
        if pill.closable {
            capsule.contextMenu {
                Button(role: .destructive) {
                    onClose(pill.id)
                } label: {
                    Label("Close session", systemImage: "xmark")
                }
            }
        } else {
            capsule
        }
    }

    private func tabPill(_ pill: TabPill) -> some View {
        let isActive = pill.id == activeId
        // The × rides on the OPEN tab only, matching the web strip's "close the
        // session you're in" gesture without spending an extra 32pt of a phone's
        // strip on every sibling — those close through the long-press menu.
        let showsClose = isActive && pill.closable
        return HStack(spacing: 0) {
            Button {
                if !isActive { onSelect(pill.id) }
            } label: {
                HStack(spacing: 7) {
                    switch pill.activity {
                    case .waiting:
                        PulsingDot(
                            color: OS1VisualStyle.blue,
                            size: 6
                        )
                    case .running:
                        PulsingDot(
                            color: OS1VisualStyle.yellow,
                            size: 6
                        )
                    case .idle:
                        EmptyView()
                    }
                    Text(pill.title)
                        .font(.footnote.weight(
                            isActive ? .semibold : .medium
                        ))
                        .lineLimit(1)
                }
                .foregroundStyle(
                    isActive
                        ? OS1VisualStyle.text
                        : OS1VisualStyle.textFaint
                )
                .padding(.leading, 12)
                // The × supplies the trailing inset when it's there.
                .padding(.trailing, showsClose ? 2 : 12)
                .frame(minWidth: 44, minHeight: 44)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? 260 : 180)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(
                isActive ? .isSelected : []
            )
            .accessibilityValue(tabAccessibilityValue(pill))

            if showsClose {
                Button {
                    onClose(pill.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        // A full-height 32pt box: the glyph stays small, the
                        // tappable area clears Apple's 44pt guidance vertically
                        // and sits comfortably wide of the title.
                        .frame(width: 32, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close session")
            }
        }
        // The active tab's fill sits INSIDE its own glass, above the material:
        // with every pill carrying its own surface there is no shared band for
        // an indicator to slide along, so "selected" is the pill's own surface.
        //
        // OPAQUE, and lighter than the canvas rather than tinted: a tint over a
        // near-white pill (this was `hover`) made the tab you are IN the
        // greyest chip in the strip, which is backwards. Now the open tab is
        // solid white and its siblings are translucent, so the strip reads
        // lit-one/dimmed-rest at a glance instead of by a shade of grey.
        .background {
            if isActive {
                let indicator = pillShape.fill(OS1VisualStyle.tabActive)

                if reduceMotion {
                    indicator
                } else {
                    indicator.matchedGeometryEffect(
                        id: "active-session-tab",
                        in: activeTabIndicator
                    )
                }
            }
        }
        // Near-solid, exactly like the composer: the transcript passes behind
        // each pill, and bare glass took on the luminance of whatever scrolled
        // under it — a dark code block dragged the whole tab dark. The page
        // colour over a thick material holds it at a stable brightness; the
        // session still shows around it, not through it.
        //
        // The idle tabs keep less of that paint. They still sit on the thick
        // material, so a dark row underneath can't drag them about — they just
        // sit a step back from the open one instead of matching it.
        .background(
            OS1VisualStyle.background.opacity(isActive ? 0.7 : 0.3),
            in: pillShape
        )
        .background(.thickMaterial, in: pillShape)
        .glassSurface(in: pillShape, interactive: true)
        .id(pill.id)
    }

    private func tabAccessibilityValue(_ pill: TabPill) -> String {
        let state = switch pill.activity {
        case .waiting: "Needs input"
        case .running: "Running"
        case .idle: "Idle"
        }
        return pill.id == activeId ? "Selected, \(state)" : state
    }
}
#endif

/// A workspace's closed sessions, handed to whichever surface is carrying
/// them: the tab strip while there is one, the info sheet when the workspace
/// is down to a single conversation and draws none. `SessionTabsView` owns
/// the rows, so the two surfaces share one fetch and one restore.
struct WorkspaceSessionHistory {
    let sessions: [Session]
    /// Rows whose restore is in flight, so a second tap can't ask twice.
    let restoringIds: Set<String>
    let restore: (Session) -> Void
}

/// The rows of a workspace's closed sessions, written once for the three
/// surfaces that offer them: the strip's history button, the iOS overflow menu
/// when there is no strip, and the macOS toolbar. Selecting a row restores it
/// rather than merely opening a read-only archived conversation, matching the
/// web tab strip.
private struct SessionHistoryItems: View {
    let sessions: [Session]
    var restoringIds: Set<String> = []
    let onRestore: (Session) -> Void

    var body: some View {
        ForEach(sessions) { session in
            Button {
                onRestore(session)
            } label: {
                Label(session.displayTitle, systemImage: "arrow.uturn.backward")
            }
            .disabled(restoringIds.contains(session.id))
        }
    }
}

/// The closed sessions of one workspace, as a menu of their own. iOS places
/// this beside its tab pills; macOS puts it in the detail toolbar because the
/// sidebar already serves as that platform's live tab list. Where there is no
/// strip, the same rows hang off the overflow menu instead (see
/// `SessionActionsMenu`).
private struct SessionHistoryMenu: View {
    let sessions: [Session]
    var restoringIds: Set<String> = []
    let onRestore: (Session) -> Void

    var body: some View {
        Menu {
            SessionHistoryItems(
                sessions: sessions,
                restoringIds: restoringIds,
                onRestore: onRestore
            )
        } label: {
            Image(systemName: "clock.arrow.trianglehead.counterclockwise.rotate.90")
        }
        .accessibilityLabel("Closed sessions")
    }
}

/// The bottom input area: queue/steer/delivering chips, the run-status chip,
/// staged images, and the composer. A SEPARATE view struct on purpose — its
/// body is the only place that reads `viewModel.draft` / `canSend`, so with
/// @Observable's per-body tracking a keystroke invalidates just this bar.
/// When these lived as computed properties of SessionView, every keystroke
/// re-evaluated SessionView.body and re-diffed every visible transcript row
/// on the main thread — typing visibly hitched on long sessions even with
/// nothing streaming.
private struct SessionInputBar: View {
    @Bindable var viewModel: SessionViewModel
    @AppStorage("os1.composer.sendKey") private var sendKey = "enter"
    @AppStorage("os1.composer.busySend") private var busySend = "queue"
    /// Read for the Mac send menu's key hints only. See `BusySendHints`.
    @AppStorage("os1.composer.busySendMod") private var busySendMod = "steer"
    @AppStorage("os1.composer.replySuggestions") private var showReplySuggestions = true
    @AppStorage("os1.composer.nextChatButton") private var showNextChatButton = true
    /// Matches the transcript column cap so the bar centers with it.
    let contentMaxWidth: CGFloat
    let horizontalInset: CGFloat
    /// Open with the keyboard up when this session has nothing to read.
    /// False when the caller has put something in the transcript's place (the
    /// Desk's board), which a keyboard would cover.
    var autoFocusWhenNeverRan = true
    /// Kept optional so non-sidebar conversations, such as the Desk, draw no row.
    var onNextChat: (() -> Void)?
    @Binding var forkState: SessionForkState
    var onForkCreated: ((String) async -> Void)?
    /// The rest of the iOS action bar above the composer. Each is optional
    /// for the same reason: a conversation with no workspace behind it (the
    /// Desk) simply draws fewer buttons.
    var onArchiveWorkspace: (() -> Void)?
    var onNewSession: (() -> Void)?
    var actionMenu: AnyView?
    @FocusState private var inputFocused: Bool
    /// What the "+" menu opened, if anything. One `@State` and one `.sheet`
    /// on purpose: stacking sheet modifiers on a single view leaves only the
    /// last one working.
    private enum ComposerSheet: Identifiable {
        case goal, reference, schedule

        var id: String {
            switch self {
            case .goal: "goal"
            case .reference: "reference"
            case .schedule: "schedule"
            }
        }
    }
    @State private var sheet: ComposerSheet?
    /// In-flight promote — the row says so rather than looking inert, since
    /// cutting a worktree isn't always instant.
    @State private var promoting = false
    /// Latched once the draft has wrapped past one line, cleared when the
    /// draft empties. It has to latch: the multi-line layout hands the field
    /// the whole width, so text that just wrapped between the round buttons
    /// usually fits on one line again once it opens — an unlatched height
    /// test would oscillate between the two forms on a single keystroke.
    @State private var draftWrapped = false
    /// Owned here rather than in the button: the composer swaps between its
    /// one-row and two-row layouts as the draft grows, which is exactly what
    /// a long dictation does — state living in the button would die mid-word.
    @State private var dictation = Dictation()
    @State private var sessionProjection = ComposerSessionProjectionState()
    @State private var inputSelection: TextSelection?
    /// Notes are one-message context: they post straight to the team and never
    /// enter the engine or busy-message queue.
    @State private var noteMode = false
    @State private var addingNote = false
    /// Stop was asked for and is waiting on an answer.
    @State private var stopConfirm = false
    /// Roughly the height of a one-line `.body` field, scaled with Dynamic
    /// Type. The wrap test compares against 1.6× this, comfortably between
    /// one line and two whatever internal padding the field carries.
    @ScaledMetric(relativeTo: .body) private var oneLineFieldHeight: CGFloat = 22

    /// Air above the topmost element in the bar — and where the composer
    /// scrim's dissolve has to finish, so it ends level with that element.
    private static let barTopPadding: CGFloat = 6

    private var typingLabel: String? {
        SessionViewModel.typingLabel(viewModel.otherTypingUsers)
    }

    #if os(macOS)
    /// Local key monitor that turns Shift+Return into a newline insert.
    @State private var shiftReturnMonitor: Any?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // The run clock used to live here. It belongs to the work, not to
            // the field you type in, so it now ticks at the end of the
            // transcript under the last message (`RunStatusFooter`) — this
            // chip is left for what's waiting on the composer itself.
            if noteMode {
                noteModeChip
                    .transition(
                        .opacity.combined(with: .scale(scale: 0.94, anchor: .bottomLeading))
                    )
            }

            // Next chat is a button of its own here only on the Mac. On iOS
            // it is one seat in the action bar below, next to the other
            // session actions, rather than a second control saying the same
            // thing a few points away.
            #if os(iOS)
            if offersReplySuggestions {
                replySuggestionRow
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(
                        .opacity.combined(with: .scale(scale: 0.96, anchor: .bottomLeading))
                    )
            }
            #else
            if offersReplySuggestions || (showNextChatButton && onNextChat != nil) {
                HStack(spacing: 8) {
                    if offersReplySuggestions {
                        replySuggestionRow
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .transition(
                                .opacity.combined(
                                    with: .scale(scale: 0.96, anchor: .bottomLeading)
                                )
                            )
                    } else {
                        Spacer(minLength: 0)
                    }
                    if showNextChatButton, let onNextChat {
                        nextChatButton(action: onNextChat)
                            .padding(.trailing, 12)
                    }
                }
            }
            #endif

            if forkState.point != nil {
                forkModeChip
                    .transition(
                        .opacity.combined(with: .scale(scale: 0.94, anchor: .bottomLeading))
                    )
            }

            if viewModel.quoteSelection.text != nil {
                selectedTextChip
                    .transition(
                        .opacity.combined(with: .scale(scale: 0.94, anchor: .bottomLeading))
                    )
            }

            if (viewModel.queuedCount > 0 && viewModel.queuedItems.isEmpty)
                || composerNotice != nil {
                composerChip
                    // Grows out of the composer it belongs to, rather than
                    // being cut in above it.
                    .transition(
                        .opacity.combined(with: .scale(scale: 0.94, anchor: .bottomLeading))
                    )
            }

            if !viewModel.attachedImages.isEmpty {
                AttachedImagesRow(
                    images: viewModel.attachedImages,
                    onRemove: { image in
                        guard let index = viewModel.attachedImages.firstIndex(of: image)
                        else { return }
                        viewModel.draft = ImageAttachmentComments.rebasing(
                            viewModel.draft, removingImageAt: index
                        )
                        viewModel.attachedImages.remove(at: index)
                    },
                    onComment: { index, region, text in
                        viewModel.draft = ImageAttachmentComments.appending(
                            to: viewModel.draft,
                            imageIndex: index,
                            region: region,
                            comment: text
                        )
                    }
                )
            }

            if let typingLabel {
                Text(typingLabel)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .padding(.horizontal, 12)
                    .accessibilityAddTraits(.updatesFrequently)
            }

            #if os(iOS)
            // Keep the actions with the composer inside the keyboard-adjusted
            // safe-area bar, so they remain directly above an open keyboard.
            if hasActionBar {
                SessionActionBar(
                    onArchive: onArchiveWorkspace,
                    onNewSession: onNewSession,
                    onNextChat: showNextChatButton ? onNextChat : nil,
                    menu: actionMenu
                )
            }
            #endif

            ComposerMentionPalette(
                text: projectedDraft.wrappedValue,
                selection: inputSelection,
                scope: ComposerMentionScope(sessionId: viewModel.session.id)
            ) { edit in
                projectedDraft.wrappedValue = edit.text
                inputSelection = edit.selection
                inputFocused = true
            }

            VStack(spacing: 0) {
                if hasQueueItems {
                    queueFlap
                        // Slides out from behind the composer rather than
                        // jump-cutting: the flap IS the composer's tucked-in
                        // sibling, so it should look like it came from there.
                        .transition(
                            .move(edge: .bottom).combined(with: .opacity)
                        )
                        .zIndex(0)
                }
                composer
                    .zIndex(1)
            }
            // One animation for the whole flap: rows arriving, leaving, being
            // steered from one section to the next, and the bar's own reflow
            // all move together. Keyed on a signature rather than a count so
            // an in-place edit animates too.
            .animation(.smooth(duration: 0.26), value: queueSignature)
        }
        .frame(maxWidth: contentMaxWidth)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, horizontalInset)
        .padding(.top, Self.barTopPadding)
        .padding(.bottom, 8)
        .animation(.smooth(duration: 0.22), value: composerNotice)
        .animation(.smooth(duration: 0.18), value: noteMode)
        .animation(.smooth(duration: 0.2), value: viewModel.replySuggestions)
        .animation(.smooth(duration: 0.18), value: viewModel.quoteSelection.text)
        .animation(.smooth(duration: 0.18), value: forkState.point)
        // Stopping a turn is the one thing in the composer you can't take
        // back, and the stop disc sits a thumb's width from send — so it asks
        // first, in the web composer's words. Deliberately an alert rather
        // than a sheet: the web gives this question a centered dialog of its
        // own, and an action sheet sliding out of the same edge the composer
        // lives on reads as part of the composer.
        .alert("Stop this response?", isPresented: $stopConfirm) {
            Button("Keep going", role: .cancel) {}
            // Return confirms, the way initial focus on Stop does on the web.
            Button("Stop", role: .destructive) { confirmStop() }
                .keyboardShortcut(.defaultAction)
        } message: {
            Text("You can ask again or send a follow-up anytime.")
        }
        // A turn that finishes on its own while the question is up leaves
        // nothing to stop, so the question goes with it rather than stopping
        // whatever runs next.
        .onChange(of: viewModel.isRunning) { _, running in
            if !running { stopConfirm = false }
        }
        // Only the notices that carry bad news knock: "switched to code mode"
        // is information, and a phone that buzzes at information is a phone
        // people turn haptics off on.
        .haptic(trigger: visibleNotice) { previous, notice in
            guard let notice, notice != previous else { return nil }
            return NoticeTone.derived(fromText: notice) == .info ? nil : .warn
        }
        // A notice is a passing remark, not a state: most of them describe
        // something that has already finished happening ("app update paused",
        // "switched to code mode"), and one that sits over the composer for
        // the rest of the session reads as a condition the session is still
        // in. So it retires itself — except an error, which is the one kind
        // somebody has to actually read.
        .task(id: visibleNotice) {
            guard let notice = visibleNotice,
                let after = NoticeTone.derived(fromText: notice).autoDismissAfter
            else { return }
            try? await Task.sleep(for: after)
            guard !Task.isCancelled else { return }
            viewModel.dismissNotice()
        }
        // A session that has never run has nothing to read, so the only thing
        // to do in it is write — open with the keyboard up. This is the tab
        // strip's "+" landing: the tab appears already waiting for the prompt
        // that the sheet used to ask for.
        // …unless the caller put something there to read. A stub `Session`
        // built from an id alone reads as never-run, so without this the
        // Desk opens with a keyboard covering its own board.
        .onAppear {
            if viewModel.session.neverRan && autoFocusWhenNeverRan { inputFocused = true }
            #if DEBUG && os(iOS)
            // Open with the keyboard up, for the same reason as the panel
            // hooks in `SessionView`: a headless capture host can tap
            // nothing, so the focused state is only reachable this way.
            if ProcessInfo.processInfo.environment["OS1_FOCUS_COMPOSER"] == "1" {
                inputFocused = true
            }
            #endif
        }
        // Leaving the session must not leave the mic or typing status open.
        .onDisappear {
            dictation.stop()
            viewModel.userIsTyping(false)
        }
        // Presented from the bar, not from the "+" itself: the button moves
        // between the collapsed pill and the expanded toolbar, and a sheet
        // anchored to a view that goes away closes with it.
        .sheet(item: $sheet) { which in
            switch which {
            case .goal:
                GoalSheet(
                    initial: viewModel.goal ?? "",
                    hadGoal: viewModel.goal != nil
                ) { goal in
                    viewModel.setGoal(goal)
                }
            case .reference:
                ReferenceFileSheet(sessionId: viewModel.session.id) { match in
                    viewModel.insertMention(match.insert)
                    inputFocused = true
                }
            case .schedule:
                SchedulePromptSheet { at in
                    do {
                        try await viewModel.schedulePrompt(at: at)
                        Haptics.play(.send)
                        return nil
                    } catch {
                        return "Couldn't schedule that message."
                    }
                }
            }
        }
        // No background: the composer and chips are individual glass elements
        // floating over the transcript, which stays visible behind and below
        // them and dissolves into the bar through the soft scroll edge effect
        // — plus a wash under the pill, where that effect alone left rows
        // legible right down to the home indicator.
        #if os(iOS)
        .composerBottomWash()
        #endif
        #if os(macOS)
        .onAppear { installShiftReturnMonitor() }
        .onDisappear { removeShiftReturnMonitor() }
        #endif
        .transcriptQuoteComposerRegion(viewModel.quoteSelection)
    }

    #if os(iOS)
    /// Whether the action bar has anything to hold. A conversation with no
    /// workspace behind it draws no bar at all rather than an empty capsule.
    private var hasActionBar: Bool {
        onArchiveWorkspace != nil
            || onNewSession != nil
            || actionMenu != nil
            || (showNextChatButton && onNextChat != nil)
    }
    #endif

    private var offersReplySuggestions: Bool {
        showReplySuggestions
            && !viewModel.isRunning
            && viewModel.pendingQuestion == nil
            && !noteMode
            && !viewModel.replySuggestions.isEmpty
    }

    private func nextChatButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text("Next")
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
            }
            .font(.callout.weight(.medium))
            .foregroundStyle(OS1VisualStyle.text)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .background(.thickMaterial, in: Capsule())
        .glassSurface(in: Capsule(), interactive: true)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityLabel("Next chat")
        .help("Next chat")
    }

    /// The same quiet, horizontally scrolling pills as the web and Desk
    /// composers. The visible shape is compact; each button keeps a 44pt hit
    /// target for touch. A tap only fills the field and returns focus to it.
    private var replySuggestionRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(Array(viewModel.replySuggestions.enumerated()), id: \.offset) { _, suggestion in
                    Button {
                        viewModel.pickReplySuggestion(suggestion)
                        inputFocused = true
                    } label: {
                        Text(suggestion.label)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(OS1VisualStyle.hover))
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(suggestion.text)
                    .help(suggestion.text)
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private var hasQueueItems: Bool {
        !viewModel.deliveringItems.isEmpty || !viewModel.steeredItems.isEmpty
            || !viewModel.queuedItems.isEmpty
    }

    /// The compact chip floating above the composer: what is waiting to be
    /// sent. On Mac it also carries a word to the person who just tapped — a
    /// refused send, a switch that didn't happen. iOS presents that feedback
    /// below the session tabs instead, where it cannot cover the composer.
    /// A notice about the SESSION goes to the transcript (`noteLocally`),
    /// where it reads in order.
    ///
    /// The notice wears its tone rather than a blanket orange — the same
    /// grey/amber/red the transcript's own notices use, so "run failed" and
    /// "switched to code mode" stop looking equally alarming. Two lines, not
    /// one: the wording is the server's, and truncating a sentence mid-word
    /// to keep a capsule tidy loses the half that says what to do.
    @ViewBuilder private var composerChip: some View {
        let notice = composerNotice
        let tone = notice.map(NoticeTone.derived(fromText:)) ?? .info
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if viewModel.queuedCount > 0, viewModel.queuedItems.isEmpty {
                // Pre-handshake count from the sessions list, before the watch
                // delivers the actual items.
                Text("\(viewModel.queuedCount) queued")
                    .foregroundStyle(.secondary)
            }
            if let notice {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if let symbol = tone.symbol {
                        Image(systemName: symbol)
                    }
                    Text(notice).lineLimit(2)
                }
                .foregroundStyle(tone.color)
            }
        }
        .font(.caption2)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        // A capsule at this height, so the resting one-line chip is unchanged
        // — but a notice that wraps to two lines gets a rounded rectangle
        // instead of the lens a capsule turns into.
        .glassSurface(in: RoundedRectangle(cornerRadius: 12.5, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12.5, style: .continuous))
        .onTapGesture {
            guard notice != nil else { return }
            viewModel.dismissNotice()
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(notice == nil ? "" : "Dismisses the notice")
    }

    private var forkModeChip: some View {
        HStack(spacing: 7) {
            Image(systemName: "arrow.triangle.branch")
            VStack(alignment: .leading, spacing: 1) {
                Text(forkModeTitle)
                if let error = forkState.error {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(OS1VisualStyle.redInk)
                }
            }
            Spacer(minLength: 8)
            if forkState.creating {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    forkState.cancel()
                    inputFocused = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel fork")
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(OS1VisualStyle.text)
        .padding(.leading, 10)
        .padding(.trailing, 3)
        .padding(.vertical, 3)
        .background(OS1VisualStyle.accent.opacity(0.12), in: Capsule())
    }

    private var forkModeTitle: String {
        switch forkState.point {
        case .tip: "Forking from current history. Type the new direction."
        case .message: "Forking from selected message. Type the new direction."
        case nil: ""
        }
    }

    private var noteModeChip: some View {
        HStack(spacing: 7) {
            Image(systemName: "note.text")
            Text("Team note")
            Spacer(minLength: 8)
            Button {
                noteMode = false
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Leave note mode")
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(OS1VisualStyle.yellowInk)
        .padding(.leading, 10)
        .padding(.trailing, 3)
        .padding(.vertical, 3)
        .background(
            OS1VisualStyle.yellow.opacity(0.12),
            in: Capsule()
        )
    }

    private var selectedTextChip: some View {
        HStack(spacing: 7) {
            Image(systemName: "cursorarrow")
                .foregroundStyle(OS1VisualStyle.textFaint.opacity(0.6))
            Text("Selected text")
            Spacer(minLength: 8)
            Button {
                viewModel.quoteSelection.clear()
                inputFocused = true
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove selected text")
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(OS1VisualStyle.text)
        .padding(.leading, 10)
        .padding(.trailing, 3)
        .padding(.vertical, 3)
        .background(OS1VisualStyle.panel, in: Capsule())
        .overlay { Capsule().stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5) }
        .help(viewModel.quoteSelection.text ?? "")
    }

    private var composerNotice: String? {
        #if os(iOS)
        nil
        #else
        visibleNotice
        #endif
    }

    private var visibleNotice: String? {
        guard let notice = viewModel.notice else { return nil }
        if case .connected = viewModel.connectionState { return notice }
        let normalized = notice.lowercased()
        return normalized.contains("connect") || normalized.contains("socket")
            ? nil
            : notice
    }

    /// The queue uses the web composer's flap treatment: inset from the input,
    /// rounded at the top, and tucked behind the composer at the bottom.
    private var queueFlap: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(queueTitle)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .padding(.horizontal, 12)
                .padding(.bottom, 4)

            ForEach(viewModel.deliveringItems) { item in
                QueuedMessageRow(
                    item: item, phase: .delivering, showsDivider: item.id != firstRowId
                )
            }
            ForEach(viewModel.steeredItems) { item in
                QueuedMessageRow(
                    item: item,
                    phase: .steering,
                    showsDivider: item.id != firstRowId,
                    // Forces the run's step boundary so the message lands now.
                    // Ids the server never confirmed can't address the queue.
                    onDeliverNow: item.isLocalEcho
                        ? nil : { viewModel.deliverSteeredNow(item) },
                    onEdit: (!item.isLocalEcho && item.editable
                        && MessageAttribution.isViewer(
                            item.user ?? "",
                            viewerName: ServerConfig.shared.userName,
                            viewerLogin: ServerConfig.shared.githubLogin
                        ))
                        ? {
                            viewModel.editSteeredInComposer(item)
                            inputFocused = true
                        } : nil,
                    // The run keeps the message either way — this only
                    // retires the receipt early.
                    onDelete: { viewModel.dismissSteered(item) }
                )
            }
            ForEach(viewModel.queuedItems) { item in
                let presentation = QueueMessagePresentation(
                    content: item.content,
                    user: item.user
                )
                QueuedMessageRow(
                        item: item,
                        phase: .queued,
                        showsDivider: item.id != firstRowId,
                        // Steering needs a run to fold into, and the server can't
                        // fold a message that carries files.
                        onSteer: (viewModel.isRunning && !item.hasFiles
                            && !presentation.isGitHub)
                            ? {
                                Haptics.play(.send)
                                viewModel.steerQueued(item)
                            } : nil,
                        onEdit: (!item.isLocalEcho && !item.hasFiles
                            && !item.hasContextSessions && item.editable
                            && MessageAttribution.isViewer(
                                item.user ?? "",
                                viewerName: ServerConfig.shared.userName,
                                viewerLogin: ServerConfig.shared.githubLogin
                            ))
                            ? {
                                viewModel.editQueuedInComposer(item)
                                inputFocused = true
                            } : nil,
                        onMove: (!presentation.isGitHub
                            && !presentation.isSessionMessage
                            && viewModel.canReorder(item))
                            ? { offset in viewModel.moveQueued(item, by: offset) } : nil,
                        onDelete: { viewModel.deleteQueued(item) }
                    )
            }
        }
        .padding(.top, 10)
        // 14 of this is tucked under the composer by the negative padding
        // below, so the last row clears the seam by 6 — the old 26 left a
        // visible band of empty flap under the message.
        .padding(.bottom, 20)
        // Opaque, NOT a material: a material takes its tone from whatever is
        // behind it, so a code block scrolling under the bar turned the flap
        // (and the messages in it) dark in a light-mode app. Chrome you type
        // into has to hold its own colour, and `flapSurface` keeps it a shade
        // off the composer in either appearance so the two still read as two
        // layers of one piece.
        .background(OS1VisualStyle.flapSurface, in: flapShape)
        .overlay { flapShape.stroke(OS1VisualStyle.border, lineWidth: 0.5) }
        // Flush with the composer, not inset from it: the flap is that same
        // column continued upward, and an 18pt inset each side read as a
        // second, narrower panel parked behind the input.
        .padding(.bottom, -14)
    }

    /// The composer's own outline. While the flap is open the two are ONE
    /// piece rather than a pill parked on a panel: the flap keeps the rounded
    /// top, the composer keeps the rounded bottom, and the seam where they
    /// meet is square, so the queue reads as a section of the input instead
    /// of a separate surface behind it.
    private var composerShape: UnevenRoundedRectangle {
        let top = hasQueueItems ? 0 : composerCornerRadius
        return UnevenRoundedRectangle(
            topLeadingRadius: top,
            bottomLeadingRadius: composerCornerRadius,
            bottomTrailingRadius: composerCornerRadius,
            topTrailingRadius: top,
            style: .continuous
        )
    }

    /// Shares the composer's own corner now that it shares its edges — a
    /// tighter radius on a box the same width read as a different surface.
    private var flapShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: composerCornerRadius,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: composerCornerRadius,
            style: .continuous
        )
    }

    /// Identity of the topmost row, so every row below it can draw the
    /// separator that divides them — the flap's sections are one list, not
    /// four, and it should read as one.
    private var firstRowId: String? {
        viewModel.deliveringItems.first?.id
            ?? viewModel.steeredItems.first?.id
            ?? viewModel.queuedItems.first?.id
    }

    private var queueTitle: String {
        let queuedPresentations = viewModel.queuedItems.map {
            QueueMessagePresentation(content: $0.content, user: $0.user)
        }
        let reviewCount = queuedPresentations.lazy.filter(\.isReviewHandoff).count
        let sessionMessageCount = queuedPresentations.lazy.filter(\.isSessionMessage).count
        let queued = viewModel.queuedItems.count - reviewCount - sessionMessageCount
        let inFlight = viewModel.steeredItems.count + viewModel.deliveringItems.count
        var parts: [String] = []
        if queued > 0 {
            parts.append("\(queued) \(queued == 1 ? "message" : "messages") queued")
        }
        if reviewCount > 0 {
            parts.append("\(reviewCount) PR \(reviewCount == 1 ? "review" : "reviews") waiting")
        }
        if sessionMessageCount > 0 {
            parts.append(
                "\(sessionMessageCount) session "
                    + "\(sessionMessageCount == 1 ? "message" : "messages") waiting"
            )
        }
        // Never folded into the "queued" count: these are already committed to
        // the running turn, and calling them queued reads as "my message
        // didn't go through" (the web learned this the hard way).
        if inFlight > 0 { parts.append("\(inFlight) in flight") }
        return parts.joined(separator: " · ")
    }

    /// What the flap currently shows, as a value the animation can key on:
    /// every row's identity and phase, plus queued text so an in-place edit
    /// animates rather than snapping.
    private var queueSignature: String {
        var parts: [String] = []
        parts.append(contentsOf: viewModel.deliveringItems.map { "d\($0.id)" })
        parts.append(contentsOf: viewModel.steeredItems.map { "s\($0.id)" })
        parts.append(contentsOf: viewModel.queuedItems.map { "q\($0.id):\($0.content.count)" })
        return parts.joined(separator: "|")
    }

    /// Phone resting layout: ONE row — [+] [field] [send], the way Slack and
    /// Messages do it, with the controls seated on the pill's bottom edge.
    /// Once the draft passes one line it becomes the Messages multi-line
    /// form instead: the text takes the full width of the box with real air
    /// around it, and the controls drop to their own row underneath. Growing
    /// the field between the buttons instead would keep squeezing long text
    /// into the narrow middle column. Mac always uses the multi-line form.
    private var isSingleRow: Bool {
        #if os(iOS)
        !draftWrapped && (noteMode || viewModel.attachedImages.isEmpty)
        #else
        false
        #endif
    }

    /// Insets for the multi-line form. The phone's are Messages-sized: a
    /// wrapped draft is a block of prose and reads as one only with proper
    /// margins. The Mac composer sits in a wider window and keeps its
    /// tighter, longstanding values.
    private var multiLineInset: (horizontal: CGFloat, top: CGFloat, bottom: CGFloat) {
        #if os(iOS)
        (16, 14, 6)
        #else
        (10, 9, 5)
        #endif
    }

    /// Inset for the control row under the field. Smaller than the text's,
    /// because the round buttons carry ~6pt of their own transparent frame —
    /// matching the numbers would push them visibly further in than the text.
    private var controlRowInset: (horizontal: CGFloat, bottom: CGFloat) {
        #if os(iOS)
        (4, 5)
        #else
        (4, 3)
        #endif
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Bottom-aligned: as the draft grows the field rises and the round
            // buttons stay seated on the pill's bottom edge, rather than
            // drifting to the middle of a tall row.
            HStack(alignment: .bottom, spacing: 4) {
                if isSingleRow {
                    addMenu
                }

                TextField(
                    text: projectedDraft,
                    selection: $inputSelection,
                    prompt: Text(composerPlaceholder).foregroundStyle(
                        noteMode ? OS1VisualStyle.notePlaceholder : OS1VisualStyle.textFaint
                    ),
                    // Without the vertical axis a TextField is a one-line
                    // field that scrolls sideways: the lineLimit below is
                    // inert, the box never grows, and the multi-line layout
                    // underneath can never be reached.
                    axis: .vertical
                ) {
                    Text(noteMode ? "Team note" : "Message")
                }
                .textFieldStyle(.plain)
                .disabled(viewModel.safety != nil)
                .lineLimit(1...10)
                .foregroundStyle(OS1VisualStyle.text)
                // Measured on the field itself, BEFORE the frame and padding
                // below — so the reading is the text's own height and doesn't
                // move when the surrounding layout does.
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    if height > oneLineFieldHeight * 1.6 { draftWrapped = true }
                }
                .onChange(of: viewModel.draft) { previous, draft in
                    if draft.isEmpty { draftWrapped = false }
                    // Keep the unsent text where it survives this app: on the
                    // server, per session (debounced inside the store). This
                    // also covers sending, which empties the draft and so
                    // takes the pencil off the row here and in the browser.
                    DraftsStore.shared.setText(draft, for: viewModel.session.id)
                    if inputFocused {
                        viewModel.userIsTyping(!draft.isEmpty)
                    } else if draft.isEmpty {
                        viewModel.userIsTyping(false)
                    }
                    // Typing is the loudest possible "I'm here".
                    viewModel.userDidInteract()
                    // Starting to write is a statement about where you want to
                    // be: at the end of the conversation you're replying to.
                    if !noteMode, previous.isEmpty, !draft.isEmpty {
                        viewModel.draftStarted()
                        // The first character is the earliest honest signal
                        // that a send is coming — warm the engine there, so
                        // the tap and the tick happen together rather than a
                        // beat apart.
                        Haptics.prepare()
                    }
                }
                // A vertical-axis TextField is greedy: without an explicit
                // fill it claims the row's whole width in the pill and pushes
                // the send button off the right edge. The minimum height is
                // the round buttons' own, so a one-line draft sits centred
                // between them instead of hugging the bottom alignment.
                .frame(maxWidth: .infinity, minHeight: isSingleRow ? 44 : nil)
                // In the single row the buttons set the pill's height and the
                // field just sits between them. Multi-line, the text owns the
                // full width of the box and gets real air around it — the
                // inset a paragraph needs to read as a paragraph, not the 4pt
                // gap that suits a one-line field between two round buttons.
                .padding(.horizontal, isSingleRow ? 4 : multiLineInset.horizontal)
                .padding(.top, isSingleRow ? 0 : multiLineInset.top)
                .padding(.bottom, isSingleRow ? 0 : multiLineInset.bottom)
                .focused($inputFocused)
                .onChange(of: inputFocused) { _, focused in
                    if !focused { viewModel.userIsTyping(false) }
                }
                // Mac: Return sends; Shift/Option-Return insert a newline. On
                // iOS the software keyboard's return key just wraps, as before.
                .onSubmit {
                    #if os(iOS)
                    send()
                    #else
                    if sendKey == "enter" { send() }
                    #endif
                }
                // A copied screenshot pastes straight into the attachments
                // (Cmd+V on Mac, long-press Paste on iOS); text pastes flow
                // through to the field untouched.
                .pastesImages(into: $viewModel.attachedImages)

                if isSingleRow {
                    // Dictation leads the trailing controls: it belongs to
                    // writing the message, not to the run, so it keeps the
                    // same seat whether or not a turn is in flight — stop
                    // appears between it and send instead of displacing it.
                    ComposerDictationButton(dictation: dictation, draft: $viewModel.draft)
                    // Stop is the only meaningful action while a turn runs
                    // with nothing typed; once there IS a draft, send joins
                    // it rather than replacing it — queueing the next message
                    // mid-run is the common case, and the two-row layout has
                    // always shown both.
                    if viewModel.isRunning {
                        stopButton
                    }
                    if noteMode || !viewModel.isRunning || canSubmit {
                        sendButton
                    }
                }
            }
            // Keep the existing 4pt inset in every one-row state. The resting
            // pill gets smaller through width, not tighter spacing.
            .padding(isSingleRow ? 4 : 0)

            if !isSingleRow {
                HStack(spacing: 6) {
                    addMenu
                    Spacer(minLength: 8)

                    ComposerDictationButton(dictation: dictation, draft: $viewModel.draft)

                    if viewModel.isRunning {
                        stopButton
                    }

                    sendButton
                }
                .padding(.horizontal, controlRowInset.horizontal)
                .padding(.bottom, controlRowInset.bottom)
            }
        }
        // The surface is a background SIBLING rather than three modifiers on
        // the row, and that placement is the point. A `Menu` whose label sits
        // inside a glass subtree makes the system treat the enclosing glass —
        // here the whole pill — as the menu's morph source: opening the "+"
        // took the entire composer off screen for as long as the menu was up,
        // and closing it flashed the pill back as a flat, square-cornered
        // white block. Behind the row instead, the glass is no longer an
        // ancestor of the "+" or the send menu, and the composer stays put.
        // The surface stays a sibling of the controls.
        .background {
            Color.clear
                #if os(iOS)
                // Keep the writing surface truly solid so it takes visual
                // priority over the translucent action bar. Applying glass on
                // top of this fill tinted the white back toward the canvas.
                .background(
                    OS1VisualStyle.background,
                    in: composerShape
                )
                #else
                .glassSurface(
                    in: composerShape
                )
                #endif
                // Ask mode is ambient — it lasts the session's whole life, not
                // one message — so it's said by tinting the surface you write
                // on rather than by a chip you'd stop seeing. Same green, and
                // the same lighter hand, as the web composer's.
                //
                // An overlay, not another `.background`: each background in
                // this stack sits further back, and the page colour above is
                // near-opaque, so a tint added there paints where nothing can
                // see it.
                .overlay {
                    if noteMode {
                        composerShape.fill(OS1VisualStyle.yellow.opacity(0.10))
                    } else if viewModel.session.mode == "ask" {
                        composerShape.fill(OS1VisualStyle.green.opacity(0.09))
                    }
                }
                #if os(iOS)
                // Only the composer's empty surface focuses the field. Keeping
                // this gesture behind the controls prevents it from competing
                // with the send menu's tap.
                .contentShape(composerShape)
                .onTapGesture { inputFocused = true }
                #endif
        }
        #if os(iOS)
        // A subtle full-point edge keeps the solid input distinct from the
        // canvas. Its neutral ink resolves separately in light and dark mode.
        .overlay {
            composerShape.strokeBorder(
                OS1VisualStyle.composerBorder,
                lineWidth: 1
            )
        }
        // Growth and the one-row → multi-line morph both want to track the
        // text rather than ease behind it — a snappy, short spring so a fast
        // typist never sees the box lagging the caret.
            .animation(.snappy(duration: 0.18), value: viewModel.draft)
            .animation(.snappy(duration: 0.18), value: isSingleRow)
            .animation(.snappy(duration: 0.18), value: inputFocused)
            .animation(.snappy(duration: 0.18), value: noteMode)
            // Preserve the pill's internal spacing and shorten only its
            // resting footprint. An open queue stays flush with the composer.
            .padding(
                .horizontal,
                isSingleRow && !inputFocused && !hasQueueItems ? 8 : 0
            )
        #endif
    }

    private var projectedDraft: Binding<String> {
        sessionProjection.binding(
            $viewModel.draft,
            titleGeneration: TranscriptLinks.shared.generation,
            refreshTitles: !inputFocused
        )
    }

    /// The composer's "+": attachments plus the session-level actions
    /// (mentions, goal, promote, scheduling) the web input has always carried
    /// behind the same button.
    private var addMenu: some View {
        ComposerAddMenu(
            images: $viewModel.attachedImages,
            hasGoal: viewModel.goal != nil,
            // `/goal` is a native slash command; a Slack- or Linear-sourced
            // session would just post the text at the agent. "backstage" is the
            // pre-rename source value older servers still send.
            onSetGoal: isNativeSession ? { sheet = .goal } : nil,
            onReferenceFile: { sheet = .reference },
            hasDraft: !viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            // Scheduling is a server-side hold on a native session's own queue;
            // an agent-owned session has no such queue to put it on.
            onSchedule: noteMode ? nil : (isNativeSession ? { sheet = .schedule } : nil),
            attachmentsEnabled: true,
            noteMode: noteMode,
            onToggleNoteMode: {
                noteMode.toggle()
                inputFocused = true
            },
            // Ask mode reads the code but can't change it. Promoting cuts a
            // worktree, so it's one-way — and the server only allows it here.
            onSwitchToCode: (isNativeSession && viewModel.session.mode == "ask")
                ? {
                    promoting = true
                    Task {
                        await viewModel.promoteToCode()
                        promoting = false
                    }
                }
                : nil,
            promoting: promoting
        )
    }

    /// A session this app owns end to end, rather than one mirrored from Slack or
    /// Linear. "backstage" is the pre-rename value older servers still send.
    private var isNativeSession: Bool {
        viewModel.session.source == "opensession"
            || viewModel.session.source == "backstage"
    }

    private var composerPlaceholder: String {
        if noteMode { return "Only your team will see this" }
        if viewModel.safety != nil { return "Paused for safety" }
        if viewModel.quoteSelection.text != nil { return "Chat with selected text" }
        if viewModel.workspacePreparing {
            return "Setting up your workspace · messages queue until it's ready"
        }
        guard viewModel.isRunning else { return "Message" }
        return busySend == "steer"
            ? "Message — steers this run"
            : "Message — queues for after this run"
    }

    /// A send-menu row's title, with the key that does the same thing
    /// appended on the Mac. A `String` rather than a literal on purpose: that
    /// picks `Label`'s StringProtocol initializer, so the title never runs
    /// through `LocalizedStringKey`.
    private func busyMenuTitle(_ title: String, pref: String) -> String {
        #if os(macOS)
        guard let keys = BusySendHints.keys(
            for: pref,
            busySend: busySend,
            busySendMod: busySendMod,
            sendKey: sendKey
        ) else { return title }
        return "\(title) · \(keys)"
        #else
        return title
        #endif
    }

    /// A tap sends with the person's busy-send preference. During a run, a
    /// long press exposes Steer and Queue without shrinking the familiar send
    /// arrow or spending the common tap on a menu.
    @ViewBuilder
    private var sendButton: some View {
        if noteMode {
            Button { send() } label: { sendButtonFace }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .accessibilityLabel("Add note")
        } else if viewModel.isRunning {
            Menu {
                busySendActions
            } label: {
                sendButtonFace
            } primaryAction: {
                send()
            }
            .menuOrder(.fixed)
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
            .accessibilityLabel("Send")
            .accessibilityHint(busySendAccessibilityHint)
        } else {
            Button {
                send()
            } label: {
                sendButtonFace
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
    }

    private var busySendAccessibilityHint: String {
        let action = busySend == "steer"
            ? "Steers this run."
            : "Queues for after this run."
        #if os(iOS)
        return "\(action) Touch and hold for more send options."
        #else
        return "\(action) Open the menu for more send options."
        #endif
    }

    @ViewBuilder
    private var busySendActions: some View {
        Button {
            send(busyModeOverride: "steer")
        } label: {
            Label(
                busyMenuTitle("Steer into this run", pref: "steer"),
                systemImage: busySend == "steer" ? "checkmark" : "arrow.turn.up.right"
            )
        }
        Button {
            send(busyModeOverride: "queue")
        } label: {
            Label(
                busyMenuTitle("Queue for after this run", pref: "queue"),
                systemImage: busySend == "steer" ? "clock" : "checkmark"
            )
        }
    }

    /// The same full-size send arrow in every state. Long-press behavior stays
    /// invisible until it is useful, like other system button menus.
    private var sendButtonFace: some View {
        Image(systemName: "arrow.up")
            .font(.system(size: 15, weight: .semibold))
            // Explicit colours for the resting state, not the semantic
            // `.fill.secondary` / `Color.secondary` pair: both are faint
            // to begin with, and the dimming SwiftUI applies to a disabled
            // button on top of that left the disc invisible against the
            // near-white composer (measured: 242 vs a 252 background).
            .foregroundStyle(
                canSubmit ? OS1VisualStyle.onAccent : OS1VisualStyle.textDim
            )
            .frame(width: 32, height: 32)
            .background(
                canSubmit
                    ? AnyShapeStyle(OS1VisualStyle.accent)
                    : AnyShapeStyle(OS1VisualStyle.hover),
                in: Circle()
            )
            .animation(.easeOut(duration: 0.15), value: canSubmit)
    }

    private var canSubmit: Bool {
        if noteMode {
            return !addingNote
                && (!viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || !viewModel.attachedImages.isEmpty)
        }
        if forkState.point != nil {
            return !forkState.creating && (!viewModel.draft
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !viewModel.attachedImages.isEmpty)
        }
        return viewModel.canSend
    }

    private func send(busyModeOverride: String? = nil) {
        guard canSubmit else { return }
        if forkState.point != nil {
            createFork()
        } else if noteMode {
            addingNote = true
            Task {
                if await viewModel.addSessionNote() {
                    Haptics.play(.send)
                    noteMode = false
                }
                addingNote = false
            }
        } else {
            let previousSend = viewModel.sendSeq
            viewModel.sendDraft(busyModeOverride: busyModeOverride)
            // The outbox accepted it synchronously. Play here so button taps,
            // menu picks, and keyboard sends all get one firm confirmation,
            // while a full outbox gets the warning cue instead.
            if viewModel.sendSeq != previousSend { Haptics.play(.send) }
        }
    }

    private func createFork() {
        guard let forkFrom = forkState.begin(sourceId: viewModel.session.id) else { return }
        let prompt = viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = viewModel.attachedImages.map(\.dataURL)
        Task {
            do {
                let id = try await OS1API.createSession(
                    prompt: prompt.isEmpty ? "Continue from here." : prompt,
                    repo: viewModel.session.effectiveRepo,
                    mode: viewModel.session.mode ?? "ask",
                    images: images,
                    forkFrom: forkFrom
                )
                viewModel.draft = ""
                viewModel.attachedImages = []
                DraftsStore.shared.setText("", for: viewModel.session.id)
                Haptics.play(.send)
                let destination = forkState.complete(sessionId: id)
                await onForkCreated?(destination)
            } catch {
                forkState.fail(error.localizedDescription)
            }
        }
    }

    /// Every way of stopping goes through the question; nothing here calls
    /// `cancelRun` directly.
    private func requestStop() {
        guard viewModel.isRunning else { return }
        stopConfirm = true
    }

    private func confirmStop() {
        stopConfirm = false
        // Firmer than a send on purpose, and now on the deliberate half of
        // the gesture rather than on the tap that only asked.
        Haptics.play(.stop)
        viewModel.cancelRun()
    }

    @ViewBuilder
    private var stopButton: some View {
        #if os(macOS)
        Button {
            requestStop()
        } label: {
            Label("Stop", systemImage: "stop.fill")
                .font(.caption.weight(.medium))
        }
        .buttonStyle(.bordered)
        .tint(OS1VisualStyle.red)
        .controlSize(.small)
        .frame(minWidth: 68, minHeight: 44)
        .help("Stop current turn")
        #else
        Button {
            requestStop()
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(OS1VisualStyle.red, in: Circle())
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .accessibilityLabel("Stop current turn")
        #endif
    }

    private var composerCornerRadius: CGFloat {
        #if os(macOS)
        18
        #else
        26
        #endif
    }

    #if os(macOS)
    /// Shift+Return inserts a newline while plain Return sends: a local key
    /// monitor routes it to the focused field editor as
    /// `insertNewlineIgnoringFieldEditor` (the same path Option+Return takes
    /// natively), so the break lands at the cursor.
    private func installShiftReturnMonitor() {
        guard shiftReturnMonitor == nil else { return }
        shiftReturnMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            MainActor.assumeIsolated {
                let mods = event.modifierFlags
                    .intersection(.deviceIndependentFlagsMask)
                    .subtracting(.capsLock)
                // Escape asks to stop the run, like the web composer.
                // A pending quote keeps its own Escape (the transcript clears
                // it), so that one passes through untouched.
                if event.keyCode == 53 {
                    guard inputFocused, mods.isEmpty, viewModel.isRunning,
                        viewModel.quoteSelection.text == nil
                    else { return event }
                    stopConfirm = true
                    return nil
                }
                guard inputFocused, event.keyCode == 36 || event.keyCode == 76 else {
                    return event
                }
                let preferredSendKey = UserDefaults.standard.string(
                    forKey: "os1.composer.sendKey"
                ) ?? "enter"
                if mods == .command || mods == .control {
                    let mode = UserDefaults.standard.string(
                        forKey: "os1.composer.busySendMod"
                    ) ?? "steer"
                    send(busyModeOverride: noteMode ? nil : mode)
                    return nil
                }
                if mods == .shift || (mods.isEmpty && preferredSendKey == "mod-enter") {
                    NSApp.sendAction(
                        #selector(NSTextView.insertNewlineIgnoringFieldEditor(_:)),
                        to: nil, from: nil
                    )
                    return nil
                }
                return event
            }
        }
    }

    private func removeShiftReturnMonitor() {
        if let monitor = shiftReturnMonitor {
            NSEvent.removeMonitor(monitor)
            shiftReturnMonitor = nil
        }
    }
    #endif

    // MARK: - Queue rows

    /// One server-accepted message that isn't in the transcript yet. "Queued"
    /// holds until the run fully finishes; "Steering" is accepted for the
    /// run's next turn boundary but can still be pulled back before it crosses
    /// that boundary; "Delivering" has left the server queue and is waiting on
    /// its transcript echo (~1s file watcher), so it is inert but stays visible.
    private struct QueuedMessageRow: View {
        enum Phase { case queued, steering, delivering }

        let item: QueueItem
        let phase: Phase
        /// Every row but the first draws the hairline above it.
        var showsDivider = false
        var onSteer: (() -> Void)?
        /// Deliver-now on a steering receipt: end the run's current step so
        /// the message lands immediately instead of waiting out a long tool
        /// call. The agent resumes with the message in hand.
        var onDeliverNow: (() -> Void)?
        var onEdit: (() -> Void)?
        /// -1 moves the message one place towards the front of the queue,
        /// +1 one place back. Absent when there's nothing to reorder.
        var onMove: ((Int) -> Void)?
        var onDelete: (() -> Void)?

        /// Live drag state: how far the row rides the finger, and how much of
        /// that travel has already been spent swapping with a neighbour.
        @State private var dragTravel: CGFloat = 0
        @State private var dragConsumed: CGFloat = 0

        /// Sentinels and routing prefixes stripped, plus the "who sent this"
        /// tag — the queue carries agent-to-agent deliveries, not just what
        /// the person typed.
        private var message: QueueMessagePresentation {
            QueueMessagePresentation(content: item.content, user: item.user)
        }

        /// Only the states worth explaining say so. "Queued" is what the
        /// flap's own title already says, and repeating it under every
        /// message was pure noise; the clock beside it is enough.
        private var label: String? {
            switch phase {
            case .queued: nil
            case .steering: "Sent · pending delivery"
            case .delivering: "Delivering…"
            }
        }

        /// Only the states that need the person to know something wear their
        /// colour in words. Queued and in-flight are ordinary — their mark
        /// carries the colour and the label stays quiet, so a flap full of
        /// messages doesn't read as a flap full of warnings.
        private var labelColor: Color {
            OS1VisualStyle.textFaint
        }

        /// Queued is the flap's ordinary state, so it wears no mark at all:
        /// the title above already counts the queue and the composer says
        /// where a send goes, which left the clock decorating every row with
        /// something nobody needed told three times. The other phases keep
        /// theirs — those DO say something the row's text doesn't.
        private var hasMark: Bool { phase != .queued }

        /// The state, as a small tinted mark rather than a bold coloured
        /// sentence per row. In-flight pulses like the run chip above.
        ///
        /// These two take the ink rather than the fill, which is the one
        /// place a glyph should: they sit inline with `labelColor` saying the
        /// same thing, and a bright amber mark beside dark amber words reads
        /// as two states rather than one.
        @ViewBuilder
        private var mark: some View {
            switch phase {
            case .queued:
                EmptyView()
            case .steering, .delivering:
                PulsingDot(color: OS1VisualStyle.green, size: 6)
            }
        }

        /// Only a message a person typed is editable in place: a worker
        /// report or GitHub review feedback is routing, and rewriting one would strip
        /// the prefix the server delivers it by.
        private var canEdit: Bool {
            onEdit != nil && message.label == nil && !item.isLocalEcho
        }

        var body: some View {
            // The message leads and wears the text colour; its state is the
            // small mark beside it and one faint line under it. It used to be
            // the other way round — a bold orange banner per row over a dimmed
            // message — which made a queue of two ordinary messages look like
            // a stack of warnings.
            // Centred, not top-aligned: the trailing glyphs are taller than a
            // one-line message, so top alignment left the text floating a good
            // 10pt above the buttons it sits beside — and stacked that
            // difference as dead space under the message.
            HStack(alignment: .center, spacing: 10) {
                if hasMark {
                    mark
                        .frame(width: 12, height: 16)
                }
                if let first = item.images.first,
                   let thumb = DataImage(dataURL: first) {
                    thumb
                        .frame(width: 32, height: 32)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(alignment: .bottomTrailing) {
                            if item.images.count > 1 {
                                Text("+\(item.images.count - 1)")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 3)
                                    .background(.black.opacity(0.55), in: Capsule())
                                    .padding(2)
                            }
                        }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.body)
                        .font(.subheadline)
                        .lineLimit(2)
                        .foregroundStyle(OS1VisualStyle.text)
                        // Sighted readers get the queue's state from the flap
                        // title; VoiceOver reads rows, not headers, so the one
                        // phase that shows nothing says it here instead.
                        .accessibilityLabel(
                            phase == .queued
                                ? "\(message.body), queued — delivers after this run"
                                : message.body
                        )
                    HStack(spacing: 5) {
                        if let label {
                            Text(label)
                                .font(.caption2)
                                .foregroundStyle(labelColor)
                                .lineLimit(1)
                        }
                        if phase == .steering, let since = item.steeredAt {
                            SteerElapsed(since: since)
                        }
                        if let from = message.label {
                            Text(from)
                                .font(.caption2)
                                .foregroundStyle(OS1VisualStyle.textFaint)
                                .lineLimit(1)
                        }
                        if item.hasFiles {
                            Image(systemName: "paperclip")
                                .font(.caption2)
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                    }
                }
                Spacer(minLength: 6)
                // Glyphs, not words: three peer actions on a two-line row, so
                // they read as a row of controls the way the web's do. Steer
                // wears the composer's own send arrow — folding a held
                // message into the live run IS sending it now, and the arrow
                // says that faster than the word "steer" ever did.
                // Discard, edit, then send: destructive furthest from the
                // thumb's resting path and the primary action rightmost,
                // directly above the composer's own send button.
                //
                // Single-stroke glyphs, so the pair reads as one set. Discard
                // is an `xmark` — the same dismissal the composer's
                // attachments and the note-mode chip use, and honest about
                // what happens (the message never reached the transcript, so
                // nothing is being destroyed).
                //
                // Edit is NOT here: a third glyph on every row turned a queue
                // of five messages into fifteen buttons, and it was the one
                // action with an obvious gesture — the row itself. Tapping a
                // message opens it, which is also the only way to read one the
                // two-line clamp cut off.
                HStack(spacing: 0) {
                    if let onDelete {
                        rowAction("xmark", "Discard message", onDelete)
                    }
                    if let onSteer {
                        rowAction("arrow.up", "Steer into this run", onSteer)
                    }
                    if let onDeliverNow {
                        rowAction("arrow.up.to.line", "Deliver now", onDeliverNow)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(alignment: .top) {
                if showsDivider {
                    Rectangle()
                        .fill(OS1VisualStyle.border.opacity(0.6))
                        .frame(height: 0.5)
                        // Inset to the row's own text column at both ends, the
                        // way a list separator clears its row's leading icon.
                        // Full-bleed hairlines cut the flap into a stack of
                        // table cells now that it is part of the input box.
                        .padding(.leading, hasMark ? 34 : 12)
                        .padding(.trailing, 12)
                }
            }
            // The row IS the edit affordance now that the pencil is gone —
            // and the only way to read a message the two-line clamp cut off.
            // Rows with nothing to edit (a worker report, GitHub feedback, or
            // a receipt from someone else) stay inert rather than opening a
            // sheet on what they can't change.
            .contentShape(Rectangle())
            .onTapGesture { if canEdit { onEdit?() } }
            // Drag to reorder, without leaving for a menu: each row-height of
            // travel swaps this message with its neighbour, and the row rides
            // the finger for the remainder so the queue reorders live. The
            // 12pt minimum keeps it clear of the tap above.
            //
            // simultaneousGesture, NOT gesture: as a plain `.gesture` this
            // competes with the row's own tap and the context menu's press,
            // and loses — the drag never recognised at all (verified in the
            // simulator, zero onChanged callbacks).
            .offset(y: dragTravel)
            .zIndex(dragTravel == 0 ? 0 : 1)
            .simultaneousGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        guard let onMove else { return }
                        let travelled = value.translation.height
                        // A tick per swap, the way a picker ticks per notch:
                        // the rows move under the finger while your eyes are
                        // on the one you're dragging, so the count of swaps is
                        // otherwise something you have to look up to check.
                        while travelled - dragConsumed > Self.rowStep {
                            dragConsumed += Self.rowStep
                            onMove(1)
                            Haptics.play(.selection)
                        }
                        while travelled - dragConsumed < -Self.rowStep {
                            dragConsumed -= Self.rowStep
                            onMove(-1)
                            Haptics.play(.selection)
                        }
                        dragTravel = travelled - dragConsumed
                    }
                    .onEnded { _ in
                        dragConsumed = 0
                        withAnimation(.snappy(duration: 0.2)) { dragTravel = 0 }
                    },
                including: onMove == nil ? .subviews : .all
            )
            .contextMenu { rowActions }
        }

        /// How far a drag has to travel before this message trades places with
        /// the one next to it. Rows are one or two lines, so there is no exact
        /// answer; a step near the shorter height reorders promptly without
        /// skipping past a neighbour.
        private static let rowStep: CGFloat = 56

        /// How long a steer may wait before the row starts counting. Under
        /// this the number is noise on a fold-in about to land; past it the
        /// silence is what reads as a hang (the engine reads its steering
        /// queue only when the current step's tool calls finish, so a long
        /// test run holds a steer for minutes).
        private static let steerSlowSeconds: TimeInterval = 5

        /// Ticking wait readout for a steering receipt. Counts up rather
        /// than predicting a landing time, because nothing here knows how
        /// long the running tool will take.
        private struct SteerElapsed: View {
            let since: Date
            var body: some View {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let waited = context.date.timeIntervalSince(since)
                    if waited >= QueuedMessageRow.steerSlowSeconds {
                        Text(Self.format(waited))
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                }
            }
            private static func format(_ t: TimeInterval) -> String {
                let s = Int(t)
                if s < 60 { return "\(s)s" }
                return "\(s / 60)m \(String(format: "%02d", s % 60))s"
            }
        }

        /// One control in the row's trailing cluster. 40x32 of hit area around
        /// a 16pt glyph: these are peers of the composer's own buttons a few
        /// points below them, and at 32/13 they read as a smaller, more
        /// tentative class of control on the one surface you act from. The
        /// hit area stays wide but no longer stands taller than the two-line
        /// message it flanks — a 40pt-tall button set the whole row's height
        /// and padded the flap out with space nothing was in.
        private func rowAction(
            _ symbol: String,
            _ label: String,
            _ action: @escaping () -> Void
        ) -> some View {
            Button(action: action) {
                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(width: 40, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
        }

        @ViewBuilder
        private var rowActions: some View {
            if canEdit, let onEdit {
                Button("Edit", systemImage: "square.and.pencil", action: onEdit)
            }
            if let onSteer {
                Button("Steer into this run", systemImage: "arrow.up", action: onSteer)
            }
            if let onDeliverNow {
                Button("Deliver now", systemImage: "arrow.up.to.line", action: onDeliverNow)
            }
            if let onMove {
                Button("Move up", systemImage: "arrow.up.to.line") { onMove(-1) }
                Button("Move down", systemImage: "arrow.down.to.line") { onMove(1) }
            }
            if let onDelete {
                Button(role: .destructive, action: onDelete) {
                    Label("Discard", systemImage: "trash")
                }
            }
        }
    }
}
