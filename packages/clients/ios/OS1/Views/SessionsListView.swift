import Combine
import SwiftUI

/// The horizontal margin every row, band and lane heading in the list shares —
/// one constant so they can't drift apart. iPhone runs wider than the 16pt the
/// web sidebar uses: at 16 the list read tight against the screen edge, and
/// 20 is also what the system's own plain lists give content at this width.
/// The Mac sidebar keeps 16, where rows are compact and the window supplies
/// its own breathing room.
#if os(iOS)
private let sidebarMargin: CGFloat = 20
#else
private let sidebarMargin: CGFloat = 16
#endif

private struct WorkspaceDeletionConfirmation: ViewModifier {
    @Binding var workspace: SidebarWorkspace?
    let onDelete: (SidebarWorkspace) -> Void

    func body(content: Content) -> some View {
        content.alert(
            "Delete workspace?",
            isPresented: Binding(
                get: { workspace != nil },
                set: { if !$0 { workspace = nil } }
            ),
            presenting: workspace
        ) { workspace in
            Button("Delete workspace", role: .destructive) { onDelete(workspace) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Every session in this workspace will be permanently deleted. This cannot be undone.")
        }
    }
}

/// Sessions list, organized the way the web sidebar is.
///
/// Inbox keeps work in stable Active and Snoozed sections. Activity restores
/// the date bands, and Status is the dynamic lane view (`SidebarGroupBy`). A
/// separate project switch repeats any of those sections per project. The list
/// is then narrowed to a project and a person and searched. Every choice persists,
/// under the same
/// values the web's filter popover stores, so one account reads the same list
/// in both places. The controls live in `SessionsFilterPanel`.
struct SessionsListView: View {
    @State private var viewModel = SessionsListViewModel()
    @State private var showSettings = false
    @State private var settingsAutomationId: String?
    @State private var showDesk = false
    /// The Plain support queue. iOS reaches it from the Support card at the
    /// bottom of the sessions sidebar; Mac keeps it in the sidebar header.
    @State private var showSupport = false
    @State private var supportQueue = SupportQueueModel()
    #if os(iOS)
    /// The tools that are lists: what the team shipped and your own tasks.
    /// Each is pushed onto this stack like a ticket is, for the same reason:
    /// it is a place you go from the list, not a window over it.
    @State private var showFeed = false
    @State private var showTasks = false
    /// Open tasks, for the row's own number. Cheap to ask for because the
    /// server reads one small file.
    @State private var openTaskCount = 0
    /// A session named by id from one of those screens, parked until the
    /// screen has closed. They hand back ids rather than sessions because most
    /// of what they can open is archived, and an archived session is not in
    /// the live list at all.
    @State private var pendingToolSessionOpen: String?
    /// The published reports, pushed onto this stack like a ticket is: a
    /// place you go from the list, not a window over it.
    @State private var showReports = false
    /// How many automations have ever published a report. Fetched once, and
    /// only so the Reports row can say what is behind it — and so an instance
    /// whose automations publish nothing draws no row at all.
    @State private var reportGroupCount = 0
    #endif
    /// The ticket opened from the support queue. It has its own destination
    /// because this screen's navigation path is typed `[Session]`.
    @State private var openTicket: SupportThreadSummary?
    /// The push stack, typed rather than a `NavigationPath`, so a create that
    /// resolves after the person has navigated elsewhere can find its own
    /// pending entry instead of assuming it is still on top.
    @State private var path: [Session] = []
    /// The row you came back FROM. iOS pops the session off the stack, so
    /// without this the list gives no clue where you just were — on a long
    /// list, finding your place again is a scroll and a squint. Mac needs no
    /// equivalent: the open session stays selected in the sidebar.
    @State private var lastOpenedSessionID: String?
    @State private var searchText = ""
    /// Full-text hits from the same transcript search the PWA uses. Kept by
    /// session id so workspace rows can match any conversation behind them.
    @State private var transcriptSnippets: [String: String] = [:]
    @State private var transcriptSearchRevision = 0
    /// Non-nil opens the new-session sheet; carries the per-repo "+" preset.
    @State private var newSessionRequest: NewSessionRequest?
    /// Parked "Start an Agent" requests (`StartAgentIntent`, widgets, Siri).
    @State private var quickCapture = QuickCapture.shared
    /// A session tapped in the Live Activity, parked until the list has loaded.
    @State private var requestedSession = SessionOpenRequest.shared
    /// Opening prompts (and images) of just-created sessions, keyed by id —
    /// seeds the conversation view so it renders instantly instead of waiting
    /// for the server to persist the session.
    @State private var optimisticSeeds: [String: SessionViewModel.OptimisticSeed] = [:]
    /// Staged images survive switching sibling tabs (whose SessionViewModel
    /// and socket are otherwise deliberately recreated). Text lives in
    /// DraftsStore so a remote send cannot be shadowed by stale view state.
    @State private var composerDrafts: [String: SessionViewModel.ComposerDraft] = [:]
    /// Temp IDs remain aliases through the outgoing view's onDisappear so a
    /// draft edited while session creation resolves is saved under the real ID.
    @State private var resolvedSessionIds: [String: String] = [:]
    /// Loaded transcripts for recently visited mobile conversations. The
    /// cache is bounded and cached view models disconnect while off-screen.
    @State private var sessionPageCache = SessionViewModelCache()
    /// Surfaced when a file handoff or background session create fails.
    @State private var createError: String?
    @State private var createErrorTitle = "Couldn't start session"
    /// Established workspace awaiting permanent deletion confirmation.
    @State private var pendingWorkspaceDeletion: SidebarWorkspace?
    /// Configured automation name → directory owner, for Team activity.
    @State private var automationOwners: [String: String] = [:]
    @State private var showArchived = false
    /// The view controls (`SessionsFilterPanel`): a sheet on the phone, a
    /// popover on the Mac.
    @State private var showFilterPanel = false
    /// An archived row opens only after its sheet has dismissed; pushing while
    /// the sheet is still closing can drop the navigation transition on iOS.
    @State private var pendingArchivedOpen: Session?
    /// The catch-up deck — a full-screen pass over everything unread.
    @State private var showCatchUp = false
    /// The session the deck asked to open. Pushed only once the cover is gone:
    /// appending to `path` while it is still dismissing loses the push.
    @State private var pendingCatchUpOpen: Session?
    /// A SHA followed from transcript prose. The sheet resolves it lazily
    /// through `/api/commit`, on both the touch and pointer clients.
    @State private var commitReference: CommitLinks.Reference?
    /// A tapped "Try again" on the unreachable screen, until it lands.
    @State private var isRetrying = false
    #if os(iOS)
    @State private var renamingWorkspace: SidebarWorkspace?
    @State private var renameText = ""
    @State private var detailsWorkspace: SidebarWorkspace?
    @State private var pendingContextMerge: ContextMerge?
    @State private var prActionError: String?
    @State private var slackShare: PrSlackShareRequest?
    #endif

    private struct ContextMerge {
        let session: Session
        let method: String
    }

    struct NewSessionRequest: Identifiable {
        let id = UUID()
        var repo: String?
        /// Opened from the Action Button's "New Idea": the composer's mic
        /// starts listening with the sheet.
        var dictate = false
        /// Set when the opening prompt should start in an existing workspace;
        /// nil starts a standalone session.
        var workspaceId: String?
        /// A sessionless workspace's parked prompt, reopened in New Session.
        var draft: OS1API.WorkspaceDraft?
        /// Files iOS opened with this app. Images keep the vision channel;
        /// everything else stages through `/api/upload` in the composer.
        var images: [AttachedImage] = []
        var files: [AttachedFile] = []
    }

    // Empty until the person picks a grouping, so the default can stay a
    // decision rather than a stored answer — see `SidebarGroupBy.fallback`.
    @AppStorage("os1.list.groupBy") private var groupByRaw = ""
    /// Project bands are independent from the section mode. Empty means no
    /// explicit pick yet, so the project count decides.
    @AppStorage("os1.list.groupByProject") private var groupByProjectRaw = ""
    /// Projects registered on this instance, as of the last load. Read here so
    /// the list re-groups when the first `/api/repos` of a launch lands.
    @AppStorage(RepoCount.storageKey) private var knownRepoCount = RepoCount.unknown
    @AppStorage("os1.list.repo") private var repoFilter = "all"
    @State private var registeredRepoIDs: [String] = []
    @AppStorage("os1.list.sort") private var sortByRaw = SidebarSortBy.updated.rawValue
    // Default to the signed-in person's own sessions, like the web sidebar —
    // the server also hosts hundreds of automation runs and teammates' sessions.
    // Stored raw because two older spellings ("mine", "all") are still on disk;
    // `person` below is what the list reads. See `SidebarPersonLens`.
    @AppStorage(SidebarPersonLens.storageKey) private var peopleFilterRaw = SidebarPersonLens.me
    /// Workspaces an agent started for itself, through the automation machine
    /// identity. They stay out of the list until somebody asks for them, and
    /// say so with a robot beside the name when shown.
    @AppStorage("os1.list.autoCreated") private var showAutoCreated = false
    /// A registered project with no work in it still draws a band, so a
    /// project you just connected has somewhere to start from. On an instance
    /// with more projects than you work in, that is a screen of empty
    /// headings, and this takes them out.
    @AppStorage("os1.list.hideEmptyProjects") private var hideEmptyProjects = false
    @AppStorage("os1.sidebar.repoOrder") private var preferredRepoOrder = "[]"
    /// Section headings the person has folded shut: repo bands, status lanes,
    /// Active and Snoozed. They are keyed like the web sidebar's collapse state and stored
    /// as a JSON array so the choice survives relaunches.
    @AppStorage("os1.list.collapsed") private var collapsedGroupsRaw = "[]"
    /// Source rows the person has hidden — the account's, shared with the web
    /// sidebar's own band menu. See `SidebarFeeds`.
    @AppStorage(SidebarFeeds.storageKey) private var hiddenFeedsRaw = "[]"
    /// Tools the person has hidden, likewise the account's and shared with the
    /// web sidebar's Tools band. See `SidebarTools`. The default stands in
    /// until the first `NativePreferences.hydrate`, so a fresh install offers
    /// the same tools the browser would.
    @AppStorage(SidebarTools.storageKey) private var hiddenToolsRaw = SidebarTools.defaultHiddenJSON
    #if os(macOS)
    @AppStorage(AccountShortcuts.storageKey) private var rawShortcuts = AccountShortcuts.emptyRawValue
    #endif

    #if os(macOS)
    private var accountShortcuts: AccountShortcuts { AccountShortcuts(rawValue: rawShortcuts) }
    #endif

    private var groupBy: SidebarGroupBy {
        SidebarGroupBy.stored(groupByRaw)
            ?? SidebarGroupBy.fallback(repoCount: knownRepoCount)
    }

    /// The picker reads through `groupBy`, so an unpicked grouping still shows
    /// its default as the selected row instead of nothing — and a value stored
    /// under one of this app's five older spellings shows what it now means.
    private var groupBySelection: Binding<String> {
        Binding(get: { groupBy.rawValue }, set: { next in
            if groupByProjectRaw.isEmpty,
               let legacy = SidebarGroupBy.legacyGroupsByProject(groupByRaw) {
                groupByProjectRaw = legacy ? "on" : "off"
            }
            groupByRaw = next
        })
    }

    private var groupsByProject: Bool {
        switch groupByProjectRaw {
        case "on": true
        case "off": false
        default:
            SidebarGroupBy.legacyGroupsByProject(groupByRaw)
                ?? SidebarGroupBy.defaultGroupsByProject(repoCount: knownRepoCount)
        }
    }

    private var groupsByProjectSelection: Binding<Bool> {
        Binding(
            get: { groupsByProject },
            set: { groupByProjectRaw = $0 ? "on" : "off" }
        )
    }
    private var sortBy: SidebarSortBy { SidebarSortBy(rawValue: sortByRaw) ?? .updated }

    /// Whose work the list is showing, as the lens spells it now.
    private var person: String { SidebarPersonLens.stored(peopleFilterRaw) }

    private var personSelection: Binding<String> {
        Binding(get: { person }, set: { peopleFilterRaw = $0 })
    }

    /// The agent's own name, which is also the key its work files under.
    private var agentKey: String {
        InstanceIdentity.shared.personaName.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private var collapsedGroups: Set<String> {
        guard let data = collapsedGroupsRaw.data(using: .utf8),
              let keys = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return Set(keys)
    }

    private func isCollapsed(_ key: String) -> Bool {
        collapsedGroups.contains(key)
    }

    /// The same key a plain "Repo" group carries, so folding a repo shut in
    /// one grouping keeps it shut in the other.
    private func repoBandKey(_ repo: String) -> String { "repo-\(repo)" }

    private func toggleCollapsed(_ key: String) {
        var keys = collapsedGroups
        if keys.contains(key) {
            keys.remove(key)
        } else {
            keys.insert(key)
        }
        guard let data = try? JSONEncoder().encode(keys.sorted()),
              let raw = String(data: data, encoding: .utf8)
        else { return }
        withAnimation(.snappy(duration: 0.25)) {
            collapsedGroupsRaw = raw
        }
    }

    /// A folded section still shows the open session, so the row you're
    /// reading never disappears out from under the selection — the same rule
    /// the web sidebar applies to its collapsed lanes.
    private func showsWhileCollapsed(_ workspace: SidebarWorkspace) -> Bool {
        #if os(macOS)
        guard let selectedSessionID else { return false }
        return workspace.sessions.contains { $0.id == selectedSessionID }
        #else
        return false
        #endif
    }

    private func visibleWorkspaces(
        _ workspaces: [SidebarWorkspace],
        collapsedKey: String
    ) -> [SidebarWorkspace] {
        guard isCollapsed(collapsedKey) else { return workspaces }
        return workspaces.filter(showsWhileCollapsed)
    }

    #if os(macOS)
    @State private var selectedSessionID: String?
    /// Archived rows stay out of the live sidebar, but their hydrated copy can
    /// still own the detail column.
    @State private var openedArchivedSession: Session?
    /// The Command-K palette. Mac only: the iPhone reaches the same places by
    /// pushing, and has no keyboard to summon anything with.
    @State private var showPalette = false
    /// What the picked row does, held until the palette has finished
    /// dismissing — half of these open a sheet, and a sheet cannot present
    /// over one that is still on its way out.
    @State private var pendingPaletteAction: (() -> Void)?
    /// Read so the palette's appearance row can name the one it would switch
    /// to. `RootView` owns the same key; both write it and both see the write.
    @AppStorage("os1.appearance") private var appearance = "system"
    /// What the app is actually drawn in right now — "system" resolves here,
    /// so the row can say "dark" when the Mac is in dark mode.
    @Environment(\.colorScheme) private var colorScheme
    /// The real Settings scene (Cmd+,), which the palette can open too.
    @Environment(\.openSettings) private var openSettings
    #endif

    #if DEBUG && os(iOS)
    private var presentsScreenshotSession: Bool {
        ProcessInfo.processInfo.environment["OS1_PRESENT_SCREENSHOT_SESSION"] == "1"
    }

    private var screenshotSession: Session {
        var session = Session(id: "screenshot-session")
        session.title = "Safety protocol parity"
        session.source = "opensession"
        session.repo = "opensession"
        session.ran = true
        session.createdAt = ISO8601DateFormatter().string(from: .now)
        session.lastActivity = session.createdAt
        return session
    }
    #endif

    var body: some View {
        navigationContainer
            #if DEBUG
            .overlay {
                if ProcessInfo.processInfo.environment["OS1_PR_REVIEW_CARDS_FIXTURE"] == "1" {
                    PrReviewCardsScreenshot()
                }
            }
            #endif
            // Session-id links in agent output (SessionLinks) are ordinary
            // markdown links on a private scheme; catching them here — above
            // the navigation container — is what lets a transcript push the
            // worker it spawned instead of leaving the id as dead text.
            .environment(\.openURL, OpenURLAction { url in
                if let reference = CommitLinks.reference(from: url) {
                    commitReference = reference
                    return .handled
                }
                // A PR chip that reached this far is one no transcript claimed
                // — the Mac app, or a card outside a session. There is no
                // review panel to push without a session, so it opens on
                // GitHub, which is the same fallback the chip had as a plain
                // link before it was one.
                if let reference = PrLinks.reference(from: url) {
                    guard let github = PrLinks.githubURL(for: reference) else {
                        return .handled
                    }
                    return .systemAction(github)
                }
                if let id = AutomationLinks.automationId(from: url) {
                    #if os(macOS)
                    AutomationLinks.queueSettingsOpen(id)
                    openSettings()
                    #else
                    settingsAutomationId = id
                    showSettings = true
                    #endif
                    return .handled
                }
                guard let id = SessionLinks.sessionId(from: url) else {
                    return .systemAction
                }
                return openSessionLink(id: id)
            })
            .task {
                #if DEBUG
                if showsTeamActivityFixture {
                    viewModel.prepareTeamActivityFixture()
                } else {
                    viewModel.startPolling()
                }
                #else
                viewModel.startPolling()
                #endif
                await TeamDirectory.shared.ensureLoaded()
                await loadAutomationOwners()
            }
            #if DEBUG && os(iOS)
            .fullScreenCover(isPresented: .constant(presentsScreenshotSession)) {
                NavigationStack {
                    SessionView(
                        session: screenshotSession,
                        onArchiveWorkspace: {}
                    )
                }
            }
            #endif
            .task(id: searchText) {
                await updateTranscriptSearch()
            }
            .task(id: knownRepoCount) {
                // Not for the sheet's repo picker — for the tiles in this
                // list. The repo list carries each repo's assigned tile
                // color, and without it every tile falls back to its own
                // hash, which is exactly where two repos can collide.
                if let repos = try? await OS1API.repos() {
                    registeredRepoIDs = repos.map(\.id)
                }
            }
            // Keyed on the shared location so turning Support off stops the
            // poll. Both visible locations use the count in their native row.
            .task(id: supportLocation) {
                guard supportLocation != .off else { return }
                while !Task.isCancelled {
                    await supportQueue.load()
                    try? await Task.sleep(for: .seconds(60))
                }
            }
            #if os(iOS)
            // Once, not on a clock. Reports are published every few hours at
            // most, and this only decides whether a row is drawn and what
            // number it carries — the screen behind it loads its own.
            .task {
                if let groups = try? await OS1API.reportGroups() {
                    reportGroupCount = groups.count
                }
            }
            // Same shape, same reason: one read, and only so the Tasks row can
            // say how much is on the list before you open it.
            .task { await refreshOpenTaskCount() }
            #endif
            .onDisappear {
                viewModel.stopPolling()
            }
            .onChange(of: supportLocation) { _, _ in
                // The old page or ticket cannot remain on screen after its
                // entry point moved, including page ↔ sidebar changes on Mac.
                openTicket = nil
                showSupport = false
            }
            .onChange(of: sessionCacheScope) {
                sessionPageCache.removeAll()
            }
            #if os(macOS)
            // File > New Session from the app's account-bound menu command.
            .onReceive(NotificationCenter.default.publisher(for: .os1NewSession)) { _ in
                newSessionRequest = NewSessionRequest()
            }
            // File > New Session in This Workspace.
            .onReceive(
                NotificationCenter.default.publisher(for: .os1NewSessionInWorkspace)
            ) { _ in
                newSessionInCurrentWorkspace()
            }
            // View > Command Palette toggles: the same press that opened it
            // puts it away.
            .onReceive(
                NotificationCenter.default.publisher(for: .os1CommandPalette)
            ) { _ in
                showPalette.toggle()
            }
            #endif
            .onChange(of: viewModel.hasLoaded) {
                autoOpenFromEnvironment()
                openRequestedSession()
                openDeleteConfirmationFromEnvironment()
            }
            // "Start an Agent" (StartAgentIntent — Action Button, widget,
            // Siri). It can run before this view exists (cold launch) or while
            // it's already on screen, so both entrances read the parked request.
            .onAppear {
                openQuickCapture()
                openRequestedSession()
                openDeleteConfirmationFromEnvironment()
                #if DEBUG
                // Screenshot and simulator probe hook for the result-only UI.
                // Showing everyone makes the fixture independent of the
                // Automation identity used by capture-ios.ts.
                if let query = ProcessInfo.processInfo.environment["OS1_SEARCH_QUERY"] {
                    peopleFilterRaw = SidebarPersonLens.everyone
                    searchText = query
                }
                #endif
            }
            .onChange(of: quickCapture.request?.id) { openQuickCapture() }
            .onChange(of: requestedSession.request?.id) { openRequestedSession() }
            #if os(iOS)
            .onOpenURL(perform: openFile)
            #endif
            .alert(
                createErrorTitle,
                isPresented: Binding(
                    get: { createError != nil },
                    set: { if !$0 { createError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(createError ?? "")
            }
            .modifier(WorkspaceDeletionConfirmation(
                workspace: $pendingWorkspaceDeletion,
                onDelete: { workspace in
                    Task { await deleteEstablishedWorkspace(workspace) }
                }
            ))
            .sheet(item: $commitReference) { reference in
                CommitDetailView(reference: reference)
            }
            #if os(iOS)
            .alert(
                "Rename workspace",
                isPresented: Binding(
                    get: { renamingWorkspace != nil },
                    set: { if !$0 { renamingWorkspace = nil } }
                ),
                presenting: renamingWorkspace
            ) { workspace in
                TextField("Workspace name", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    viewModel.rename(workspace, to: renameText)
                }
                .disabled(
                    workspace.workspaceId != nil
                        && renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            } message: { _ in
                Text("Choose a name for this workspace.")
            }
            .confirmationDialog(
                contextMergeTitle,
                isPresented: Binding(
                    get: { pendingContextMerge != nil },
                    set: { if !$0 { pendingContextMerge = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(contextMergeButtonLabel) { performContextMerge() }
                Button("Cancel", role: .cancel) { pendingContextMerge = nil }
            } message: {
                Text("This cannot be undone.")
            }
            .alert(
                "Couldn't update pull request",
                isPresented: Binding(
                    get: { prActionError != nil },
                    set: { if !$0 { prActionError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(prActionError ?? "Please try again.")
            }
            .sheet(item: $detailsWorkspace) { workspace in
                WorktreeInfoSheet(workspace: workspace, listViewModel: viewModel)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $slackShare) { request in
                PrSlackShareSheet(request: request)
            }
            #endif
    }

    #if os(macOS)
    /// Mac: sessions live in a sidebar and the selected one opens in the
    /// detail column (like the web app), instead of iOS push navigation.
    private var navigationContainer: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                macSidebarHeader
                Divider()
                loadingOrList
            }
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            // A ticket takes the detail column the way a session does — the
            // sidebar's deeper panel, not a window over it.
            if let openTicket {
                SupportThreadView(row: openTicket) {
                    supportQueue.forget(id: openTicket.id)
                }
                .id(openTicket.id)
            } else if showSupport {
                SupportQueueView(model: supportQueue) { row in
                    openTicket = row
                }
            } else if let archivedSession = openedArchivedSession {
                SessionView(
                    session: archivedSession,
                    tabs: SessionsListViewModel.tabSessions(
                        in: viewModel.sessions + [archivedSession],
                        containing: archivedSession
                    ),
                    workspaceNames: viewModel.workspaceNames,
                    composerDraft: storedDraft(for: archivedSession.id),
                    onSaveComposerDraft: { draft in
                        saveComposerDraft(draft, for: archivedSession.id)
                    },
                    onForkCreated: openFork,
                    onRestoreArchivedSession: { archived in
                        let restored = await restoreArchived(archived)
                        openedArchivedSession = nil
                        selectedSessionID = restored.id
                    }
                )
                    .id(archivedSession.id)
                    .onChange(of: archivedSession, initial: true) { _, open in
                        ReadsStore.shared.open(open)
                        MentionStore.shared.open(open.id)
                    }
                    .onDisappear {
                        ReadsStore.shared.close(archivedSession.id)
                        MentionStore.shared.close(archivedSession.id)
                    }
            } else if let selectedID = selectedSessionID,
               let session = viewModel.sessions.first(where: { $0.id == selectedID }) {
                SessionView(
                    session: session,
                    seed: optimisticSeeds[session.id],
                    tabs: SessionsListViewModel.tabSessions(
                        in: viewModel.sessions,
                        containing: session
                    ),
                    workspaceNames: viewModel.workspaceNames,
                    composerDraft: storedDraft(for: session.id),
                    onSaveComposerDraft: { draft in
                        saveComposerDraft(draft, for: session.id)
                    },
                    onForkCreated: openFork,
                    onRestoreArchivedSession: { archived in
                        let restored = await restoreArchived(archived)
                        openedArchivedSession = nil
                        selectedSessionID = restored.id
                    }
                )
                    // Fresh view (and socket) per session, not a reused one.
                    .id(selectedID)
                    // The selected session reads as read, and keeps re-marking as
                    // the poll hands it fresher activity — see SessionTabsView
                    // for the same rule on the iOS stack.
                    .onChange(of: session, initial: true) { _, open in
                        ReadsStore.shared.open(open)
                        MentionStore.shared.open(open.id)
                    }
                    .onDisappear {
                        ReadsStore.shared.close(session.id)
                        MentionStore.shared.close(session.id)
                    }
            } else {
                ContentUnavailableView(
                    "Select a session",
                    systemImage: "bubble.left.and.bubble.right"
                )
            }
        }
        // Picking a session in the sidebar means you're done with the ticket —
        // otherwise the detail column would keep showing it while the sidebar
        // says something else is selected.
        .onChange(of: selectedSessionID) { _, id in
            if let id,
               let draft = allSidebarWorkspaces.first(where: {
                   $0.id == id && $0.isDraftWorkspace
               }) {
                resumeDraft(draft)
                selectedSessionID = nil
                return
            }
            if id != nil {
                openTicket = nil
                showSupport = false
                openedArchivedSession = nil
            }
        }
        .sheet(item: $newSessionRequest) { request in
            NewSessionView(
                initialRepo: request.repo,
                initialWorkspaceId: request.workspaceId,
                initialDraft: request.draft,
                autoDictate: request.dictate,
                initialImages: request.images,
                initialFiles: request.files
            ) { session, seed in
                openOptimistic(session, seed: seed)
            } onResolved: { tempId, result in
                resolveCreate(tempId: tempId, result: result)
            } onDraftSaved: { _ in
                Task { await viewModel.refresh() }
            }
        }
        .sheet(isPresented: $showArchived) {
					ArchivedSessionsView(
						sessions: viewModel.archivedSessions,
						loaded: viewModel.archivedHasLoaded,
						onOpen: { session in
							pendingArchivedOpen = session
							showArchived = false
						},
						onRestore: viewModel.unarchive,
						loadFailure: viewModel.archivedLoadFailure,
						onRetry: { Task { await viewModel.refreshArchived(force: true) } }
					)
            .task { await viewModel.refreshArchived() }
        }
        .onChange(of: showArchived) { _, shown in
            guard !shown, let session = pendingArchivedOpen else { return }
            pendingArchivedOpen = nil
            Task { openedArchivedSession = await viewModel.hydrated(session) }
        }
        .sheet(isPresented: $showDesk) {
            DeskSheet()
                .frame(minWidth: 520, minHeight: 600)
        }
        .safeAreaInset(edge: .bottom) {
            errorBanner
                .padding(.bottom, 8)
        }
        // A sheet, not an overlay over the split view. An overlay was the
        // first shape this took, and on macOS it does not repaint: the state
        // flips, the palette is laid out, and nothing is drawn until some
        // other change dirties the window — measured, with the palette
        // appearing only once an unrelated sheet forced a redraw.
        //
        // Rows that present a sheet of their own cannot do it while this one
        // is still dismissing, so what a row runs is parked and run from
        // `onDismiss` instead.
        .sheet(isPresented: $showPalette, onDismiss: runPendingPaletteAction) {
            CommandPaletteView(
                items: paletteItems,
                onRun: { item in
                    pendingPaletteAction = item.run
                    showPalette = false
                },
                onClose: { showPalette = false }
            )
        }
    }

    private func runPendingPaletteAction() {
        guard let action = pendingPaletteAction else { return }
        pendingPaletteAction = nil
        action()
    }

    /// The session the detail column is showing, as the poll last saw it.
    private var selectedSession: Session? {
        guard let selectedSessionID else { return nil }
        return viewModel.sessions.first { $0.id == selectedSessionID }
    }

    /// Every row the palette offers: the commands this window can actually
    /// run, then every live session.
    ///
    /// Scoped to what the Mac app reaches. It has no Notes, Tasks, Reports,
    /// Analytics or Catch up to navigate to, and no session panels to push, so
    /// none of those appear — the web palette's list is a reference, not a
    /// specification. Sessions come from the whole polled list rather than the
    /// filtered sidebar, which is half the point: the palette finds the
    /// session a repo filter or the "My sessions" lens is hiding.
    private var paletteItems: [CommandPaletteItem] {
        #if os(macOS)
        let shortcuts = accountShortcuts
        #endif
        var items: [CommandPaletteItem] = [
            CommandPaletteItem(
                entry: CommandPaletteEntry(
                    id: "command:new-session",
                    title: "New session",
                    subtitle: "Start a session in any repo",
                    keywords: ["create", "start", "compose"],
                    shortcut: shortcuts.primaryBinding(for: .newSession)?.glyphs ?? [],
                    symbol: "plus"
                ),
                run: { newSessionRequest = NewSessionRequest() }
            )
        ]

        if selectedSession != nil {
            items.append(
                CommandPaletteItem(
                    entry: CommandPaletteEntry(
                        id: "command:new-session-in-workspace",
                        title: "New session in this workspace",
                        subtitle: "Share the open session's worktree and branch",
                        keywords: ["sibling", "tab", "workspace"],
                        shortcut: shortcuts.primaryBinding(for: .newSessionInWorkspace)?.glyphs ?? [],
                        symbol: "plus.rectangle.on.rectangle"
                    ),
                    run: { newSessionInCurrentWorkspace() }
                )
            )
        }

        items.append(
            CommandPaletteItem(
                entry: CommandPaletteEntry(
                    id: "command:desk",
                    title: "Open the Desk",
                    subtitle: "The standing concierge session",
                    keywords: ["concierge", "assistant", "voice"],
                    symbol: "lamp.desk"
                ),
                run: { showDesk = true }
            )
        )

        if supportLocation.showsPage {
            items.append(
                CommandPaletteItem(
                    entry: CommandPaletteEntry(
                        id: "command:support",
                        title: "Support queue",
                        subtitle: "Customer tickets waiting for a reply",
                        keywords: ["plain", "tickets", "inbox"],
                        symbol: "lifepreserver"
                    ),
                    run: openSupport
                )
            )
        }

        items.append(contentsOf: [
            CommandPaletteItem(
                entry: CommandPaletteEntry(
                    id: "command:archived",
                    title: "Archived sessions",
                    subtitle: "Browse and restore closed conversations",
                    keywords: ["closed", "history", "restore"],
                    symbol: "archivebox"
                ),
                run: { showArchived = true }
            ),
            CommandPaletteItem(
                entry: CommandPaletteEntry(
                    id: "command:settings",
                    title: "Settings",
                    subtitle: "Connections, appearance, and preferences",
                    keywords: ["preferences", "account", "server"],
                    shortcut: ["⌘", ","],
                    symbol: "gearshape"
                ),
                run: { openSettings() }
            ),
            CommandPaletteItem(
                entry: CommandPaletteEntry(
                    id: "command:appearance",
                    title: colorScheme == .dark
                        ? "Switch to light appearance"
                        : "Switch to dark appearance",
                    subtitle: appearance == "system"
                        ? "Currently following the system"
                        : "Currently always \(appearance)",
                    keywords: ["theme", "dark", "light", "appearance"],
                    symbol: colorScheme == .dark ? "sun.max" : "moon"
                ),
                run: { appearance = colorScheme == .dark ? "light" : "dark" }
            )
        ])

        for session in viewModel.sessions where session.archived != true {
            items.append(paletteItem(for: session))
        }
        return items
    }

    private func paletteItem(for session: Session) -> CommandPaletteItem {
        let repo = RepoTile.label(for: session.effectiveRepo)
        var details = [repo, session.lane.label]
        // The workspace name only earns its place when it says something the
        // title does not. A session that is alone in its workspace carries the
        // same name twice, and the row read "Fix the hover wash · opensession
        // · Fix the hover wash · In progress".
        if let workspaceId = session.workspaceId,
           let name = viewModel.workspaceNames[workspaceId], !name.isEmpty,
           name.caseInsensitiveCompare(session.displayTitle) != .orderedSame {
            details.insert(name, at: 1)
        }
        return CommandPaletteItem(
            entry: CommandPaletteEntry(
                id: "session:\(session.id)",
                title: session.displayTitle,
                subtitle: details.joined(separator: " · "),
                // A session is remembered by its branch or by who started it
                // as often as by its title, and by the workspace it sits in —
                // which is how the palette answers "open a workspace" on a Mac
                // whose sidebar has no workspace row to open.
                keywords: [
                    session.effectiveRepo,
                    session.branch ?? "",
                    session.startedBy ?? "",
                    session.isAutomation ? "automation" : ""
                ].filter { !$0.isEmpty },
                symbol: paletteSymbol(for: session.lane),
                kind: .session,
                recency: session.lastActivityDate
            ),
            run: { selectedSessionID = session.id }
        )
    }

    private func paletteSymbol(for lane: Session.Lane) -> String {
        switch lane {
        case .needsInput: "questionmark.circle"
        case .inProgress: "circle.dotted"
        case .inReview: "arrow.triangle.pull"
        case .done: "checkmark.circle"
        case .backlog: "bubble.left.and.bubble.right"
        }
    }

    /// Cmd+Option+N, and the palette row that shares it.
    ///
    /// A session in a workspace opens a composer scoped to that workspace. A
    /// legacy session without one has no workspace to join, and with nothing
    /// selected there is no workspace to mean, so both use a plain composer.
    private func newSessionInCurrentWorkspace() {
        guard let current = selectedSession else {
            newSessionRequest = NewSessionRequest()
            return
        }
        guard current.workspaceId?.isEmpty == false else {
            newSessionRequest = NewSessionRequest(repo: current.effectiveRepo)
            return
        }
        newSessionRequest = NewSessionRequest(
            repo: current.effectiveRepo,
            workspaceId: current.workspaceId
        )
    }

    /// A stable in-sidebar hierarchy avoids three unrelated icon buttons
    /// floating in the unified window toolbar. Settings remains available in
    /// the app menu (Cmd+,), where Mac users expect it.
    private var macSidebarHeader: some View {
        VStack(alignment: .leading, spacing: 9) {
            ServerAccountPicker(iconSize: 28, openSettings: { openSettings() })

            HStack(spacing: 7) {
                Text("Sessions")
                    .font(.headline)
                Text("\(viewModel.sessions.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(OS1VisualStyle.textFaint)
                Spacer(minLength: 8)
                filterButton
                    .controlSize(.small)
                    .help("Filter, group, and sort sessions")
                if supportLocation.showsPage {
                    Button(action: openSupport) {
                        Image(systemName: "lifepreserver")
                    }
                    .controlSize(.small)
                    .help("Open the support queue")
                }
                Button {
                    showDesk = true
                } label: {
                    Image(systemName: "lamp.desk")
                }
                .controlSize(.small)
                .help("Open the Desk")
                Button {
                    newSessionRequest = NewSessionRequest()
                } label: {
                    Label("New", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .help(
                    accountShortcuts.primaryBinding(for: .newSession).map {
                        "New session (\($0.label))"
                    } ?? "New session"
                )
            }

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                TextField("Search sessions", text: $searchText)
                    .textFieldStyle(.plain)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 9)
            .frame(height: 28)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 7))
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 11)
        .background(.bar)
    }
    #else
    private var navigationContainer: some View {
        NavigationStack(path: $path) {
            loadingOrList
                .inlineTitleBarCompat()
                // The system search field: iOS 26 places it at the bottom edge
                // on iPhone (the Liquid Glass search treatment), replacing the
                // old toolbar toggle + inline field. It sits on the CONTAINER
                // rather than on the list, so the bottom bar is whole from the
                // first frame — hung off the list, it appeared only once the
                // first poll landed, and the Desk button spent the load
                // centred on its own before the field shoved it right.
                .searchable(text: $searchText, prompt: "Search sessions")
                .toolbar {
                    ToolbarItem(placement: .topLeadingCompat) {
                        ServerAccountPicker(iconSize: 44, compact: true) {
                            showSettings = true
                        }
                    }
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItem(placement: .topTrailingCompat) {
                        filterButton
                    }
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button {
                            newSessionRequest = NewSessionRequest()
                        } label: {
                            Image(systemName: "plus")
                                .foregroundStyle(OS1VisualStyle.text)
                        }
                        .accessibilityLabel("New session")
                    }
                    DefaultToolbarItem(kind: .search, placement: .bottomBar)
                    ToolbarSpacer(.fixed, placement: .bottomBar)
                    // Catch up is a tool, so it answers to the account's tool
                    // visibility the same way Reports does. It ships on, since
                    // the deck is built from unread work every account already
                    // has and needs nothing set up.
                    if !isCatchUpHidden {
                        ToolbarItem(placement: .bottomBar) {
                            Button {
                                showCatchUp = true
                            } label: {
                                Image(systemName: catchUpCount > 0
                                    ? "rectangle.stack.fill"
                                    : "rectangle.stack")
                                    .foregroundStyle(catchUpCount > 0
                                        ? OS1VisualStyle.accent
                                        : OS1VisualStyle.text)
                            }
                            .accessibilityLabel(
                                catchUpCount > 0
                                    ? "Catch up on \(catchUpCount) unread workspaces"
                                    : "Open Catch Up"
                            )
                        }
                    }
                    ToolbarItem(placement: .bottomBar) {
                        Button {
                            showDesk = true
                        } label: {
                            Image(systemName: "lamp.desk")
                                .foregroundStyle(OS1VisualStyle.text)
                        }
                        .accessibilityLabel("Open the Desk")
                    }
                }
                .sheet(isPresented: $showSettings) {
                    SettingsView(automationId: settingsAutomationId)
                }
                .onChange(of: showSettings) {
                    if !showSettings { settingsAutomationId = nil }
                }
                .sheet(isPresented: $showDesk) {
                    DeskSheet()
                        .presentationDetents([.large])
                        .presentationDragIndicator(.visible)
                }
                .navigationDestination(isPresented: $showSupport) {
                    SupportQueueView(model: supportQueue) { row in
                        openTicket = row
                    }
                }
                .navigationDestination(isPresented: $showReports) {
                    ReportsListView()
                }
                .navigationDestination(isPresented: $showFeed) {
                    FeedView { sessionId in
                        requestToolSessionOpen(sessionId)
                    }
                }
                .navigationDestination(isPresented: $showTasks) {
                    TasksView { sessionId in
                        requestToolSessionOpen(sessionId)
                    }
                }
                // Pushed onto this stack, not thrown over it: a ticket is
                // somewhere you go from the list, the same as a session, and
                // a sheet would have covered the list you came from. It can't
                // ride `path` — that is typed `[Session]` on purpose — so it
                // gets its own item-driven destination.
                .navigationDestination(item: $openTicket) { row in
                    SupportThreadView(row: row) {
                        supportQueue.forget(id: row.id)
                    }
                }
                .onAppear {
                    #if DEBUG
                    // Dev loop: open the Desk on launch so simulator voice
                    // runs need no UI driving (`OS1_VOICE_AUTOSTART=1`), or
                    // just the sheet — the board, no call — with
                    // `OS1_OPEN_DESK=1`. Both exist because the Desk sits
                    // behind a toolbar tap that a simulator run can't make.
                    let env = ProcessInfo.processInfo.environment
                    if env["OS1_VOICE_AUTOSTART"] != nil || env["OS1_OPEN_DESK"] != nil {
                        showDesk = true
                    }
                    // Same reason as the Desk: the new-session palette sits
                    // behind a toolbar tap, and a toolbar glyph is the one
                    // target a scripted click reliably misses.
                    if env["OS1_OPEN_NEW"] != nil {
                        newSessionRequest = NewSessionRequest()
                    }
                    if let name = env["OS1_OPEN_FILE_NAME"], !name.isEmpty {
                        newSessionRequest = NewSessionRequest(files: [AttachedFile(
                            name: name,
                            mediaType: "application/pdf",
                            path: "/debug/\(name)"
                        )])
                    }
                    if env["OS1_OPEN_SUPPORT"] != nil, supportLocation != .off {
                        openSupport()
                    }
                    // Same reason again: Reports is a row a scripted run
                    // would have to find and scroll to before it could tap it.
                    if env["OS1_OPEN_REPORTS"] != nil {
                        showReports = true
                    }
                    // Same reason again for the two list tools: each is a row
                    // a scripted run would have to find and scroll to.
                    if env["OS1_OPEN_FEED"] != nil { showFeed = true }
                    if env["OS1_OPEN_TASKS"] != nil { showTasks = true }
                    if env["OS1_OPEN_SETTINGS"] != nil {
                        showSettings = true
                    }
                    // Same reason again: the catch-up deck is behind a band row
                    // that only exists when you have unread work, which a
                    // scripted run can't rely on being there.
                    if env["OS1_OPEN_CATCHUP"] != nil {
                        showCatchUp = true
                    }
                    // The person lens is a picker two sheets deep, so a
                    // scripted run cannot reach a borrowed list any other way.
                    if let lens = env["OS1_PERSON_LENS"], !lens.isEmpty {
                        peopleFilterRaw = lens
                    }
                    #endif
                }
                .sheet(item: $newSessionRequest) { request in
                    NewSessionView(
                        initialRepo: request.repo,
                        initialWorkspaceId: request.workspaceId,
                        initialDraft: request.draft,
                        autoDictate: request.dictate,
                        initialImages: request.images,
                        initialFiles: request.files
                    ) { session, seed in
                        openOptimistic(session, seed: seed)
                    } onResolved: { tempId, result in
                        resolveCreate(tempId: tempId, result: result)
                    } onDraftSaved: { _ in
                        Task { await viewModel.refresh() }
                    }
                }
                .sheet(isPresented: $showFilterPanel) {
                    filterPanel
                }
                .sheet(isPresented: $showArchived) {
                    ArchivedSessionsView(
                        sessions: viewModel.archivedSessions,
                        loaded: viewModel.archivedHasLoaded,
                onOpen: { session in
                    pendingArchivedOpen = session
                    showArchived = false
                },
                onRestore: viewModel.unarchive,
                loadFailure: viewModel.archivedLoadFailure,
                onRetry: { Task { await viewModel.refreshArchived(force: true) } }
                    )
                    .task { await viewModel.refreshArchived() }
                }
                .onChange(of: showArchived) { _, shown in
                    guard !shown, let session = pendingArchivedOpen else { return }
                    pendingArchivedOpen = nil
                    Task { path.append(await viewModel.hydrated(session)) }
                }
                .fullScreenCoverCompat(isPresented: $showCatchUp) {
                    CatchUpView(list: viewModel) { session in
                        pendingCatchUpOpen = session
                        showCatchUp = false
                    }
                }
                .onChange(of: showCatchUp) { _, shown in
                    guard !shown, let session = pendingCatchUpOpen else { return }
                    pendingCatchUpOpen = nil
                    path.append(session)
                }
                // A tool screen and a session share this one stack, so the
                // push waits for the screen it came from to leave rather than
                // landing underneath it.
                .onChange(of: showFeed) { _, shown in
                    if !shown { consumePendingToolSessionOpen() }
                }
                .onChange(of: showTasks) { _, shown in
                    if !shown {
                        consumePendingToolSessionOpen()
                        Task { await refreshOpenTaskCount() }
                    }
                }
                .safeAreaInset(edge: .top) {
                    errorBanner
                        .padding(.top, 8)
                }
        }
        // Recorded on the way IN, from the stack itself rather than at each
        // of the four push sites (row tap, session link, optimistic create,
        // dev auto-open), so a session opened by any route marks its row.
        .onChange(of: path) {
            if let open = path.last { lastOpenedSessionID = open.id }
        }
    }
    #endif

    @ViewBuilder
    private var loadingOrList: some View {
        // Screenshot fixtures exercise the finished Team surface without
        // waiting for a production-sized sessions payload to cross into the
        // simulator. This path exists only in DEBUG builds.
        if showsTeamActivityFixture {
            list
        // An empty live list isn't yet an empty account: the archived index
        // is a second request, and a list whose sessions are all archived
        // would otherwise flash "nothing here yet" before it arrives. Only
        // ever waits when the live list came back empty, so the common case
        // renders the moment it lands.
        } else if !viewModel.hasLoaded || (hasNoRows && !viewModel.archivedHasLoaded) {
            loadingState
        } else if hasNoRows {
            if let failure = viewModel.loadFailure {
                unreachableState(failure)
            } else {
                emptyState
            }
        } else {
            list
        }
    }

    private var showsTeamActivityFixture: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["OS1_TEAM_ACTIVITY_FIXTURE"] != nil
        #else
        false
        #endif
    }

    private var hasNoRows: Bool {
        viewModel.sidebarWorkspaces.isEmpty && viewModel.archivedSessions.isEmpty
    }

    /// True while the whole screen is given over to a failed load — which is
    /// also the one time the banner has nothing to add.
    private var showsFailureScreen: Bool {
        viewModel.hasLoaded && hasNoRows && viewModel.loadFailure != nil
    }

    /// The first load. A tailnet server with the tunnel down answers nothing
    /// for a full minute, and a bare spinner spends that minute saying
    /// nothing — so the diagnosis joins it as soon as there is one.
    private var loadingState: some View {
        VStack(spacing: 14) {
            #if os(iOS)
            // The spinner is for the failure case only: once there is a
            // diagnosis to read, rows that will never arrive would be a lie.
            if viewModel.loadFailure == nil {
                SessionsSkeleton()
            } else {
                ProgressView()
            }
            #else
            ProgressView()
            #endif
            if let failure = viewModel.loadFailure {
                VStack(spacing: 3) {
                    Text(failure.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                    Text(failure.fix ?? failure.detail)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: 0.2), value: viewModel.loadFailure)
    }

    /// Floating glass capsule, matching the session view's banner styling,
    /// instead of a full-width opaque bar.
    ///
    /// Silent while the failure screen is up: the same sentence twice, once
    /// mid-screen and once in red at the bottom, reads as two problems.
    @ViewBuilder
    private var errorBanner: some View {
        if let error = viewModel.error, !showsFailureScreen {
            HStack(spacing: 10) {
                Text(error).lineLimit(2)
                if viewModel.archiveFailure != nil {
                    Button("Retry archive") { viewModel.retryArchive() }
                        .buttonStyle(.borderless)
                }
            }
            .font(.footnote)
            .foregroundStyle(.red)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .glassSurface(in: Capsule())
        }
    }

    /// Follow a `bks-…` link from a transcript. A session we're already
    /// polling opens in place; one we've never seen (archived away, another
    /// server, deleted) can't be pushed, so it hands off to the web app rather
    /// than dropping the tap silently.
    private func openSessionLink(id: String) -> OpenURLAction.Result {
        if let session = viewModel.sessions.first(where: { $0.id == id })
            ?? viewModel.archivedSessions.first(where: { $0.id == id }) {
            #if os(macOS)
            if session.slim == true {
                Task { openedArchivedSession = await viewModel.hydrated(session) }
            } else if session.archived == true {
                openedArchivedSession = session
            } else {
                selectedSessionID = session.id
            }
            #else
            if session.slim == true {
                // A row from the archived index carries what a list renders
                // and nothing else — fetch the session itself before opening
                // it, or the conversation comes up quietly missing its PR,
                // its walkthrough and its model.
                Task { path.append(await viewModel.hydrated(session)) }
            } else {
                path.append(session)
            }
            #endif
            return .handled
        }
        guard let base = ServerConfig.shared.baseURL else { return .handled }
        return .systemAction(
            base.appendingPathComponent("session").appendingPathComponent(id)
        )
    }

    #if os(iOS)
    /// Adopt a document iOS opened with this app, then put it in a fresh
    /// composer. Reading happens off-main while the security-scoped URL is
    /// valid; the composer owns plain Data after that, so Files can revoke the
    /// source URL without breaking the upload.
    private func openFile(_ url: URL) {
        Task {
            do {
                let attachment = try await Task.detached(priority: .userInitiated) {
                    try ImportedComposerAttachment.load(from: url)
                }.value
                switch attachment {
                case .image(let image):
                    newSessionRequest = NewSessionRequest(images: [image])
                case .file(let file):
                    newSessionRequest = NewSessionRequest(files: [file])
                }
            } catch {
                createErrorTitle = "Couldn't open file"
                createError = error.localizedDescription
            }
        }
    }
    #endif

    /// Open the composer for an Action Button "New Idea", mic hot. A request
    /// is consumed once, so returning to the list later doesn't reopen it.
    private func openQuickCapture() {
        guard let request = quickCapture.take() else { return }
        newSessionRequest = NewSessionRequest(dictate: request.dictate)
    }

    private func openRequestedSession() {
        guard viewModel.hasLoaded, let request = requestedSession.take() else { return }
        _ = openSessionLink(id: request.sessionId)
    }

    private func loadAutomationOwners() async {
        guard let automations = try? await SettingsAPI.automations() else { return }
        var owners: [String: String] = [:]
        for automation in automations {
            guard let name = automation.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty,
                  let owner = automation.owner?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !owner.isEmpty
            else { continue }
            owners[name] = owner
        }
        automationOwners = owners
    }

    /// Screenshot/probe hook for the destructive confirmation. It chooses an
    /// established workspace only, so draft deletion keeps its direct action.
    private func openDeleteConfirmationFromEnvironment() {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["OS1_CONFIRM_DELETE_WORKSPACE"] != nil,
              pendingWorkspaceDeletion == nil
        else { return }
        if let workspace = allSidebarWorkspaces.first(where: {
            !$0.isDraftWorkspace && $0.workspaceId?.isEmpty == false
        }) {
            pendingWorkspaceDeletion = workspace
        } else {
            var session = Session(id: "delete-confirmation-fixture")
            session.title = "Workspace deletion"
            session.workspaceId = "workspace-deletion-fixture"
            pendingWorkspaceDeletion = SidebarWorkspace(
                id: "workspace:workspace-deletion-fixture",
                title: "Workspace deletion",
                sessions: [session],
                mainSession: session
            )
        }
        #endif
    }

    private func deleteEstablishedWorkspace(_ workspace: SidebarWorkspace) async {
        guard await viewModel.deleteWorkspace(workspace) else { return }
        workspace.sessions.forEach { sessionPageCache.remove(sessionId: $0.id) }
        PinStore.shared.unpin(workspace)
        #if os(macOS)
        selectedSessionID = nil
        openedArchivedSession = nil
        #else
        path.removeAll()
        lastOpenedSessionID = nil
        #endif
    }

    private func requestWorkspaceDeletion(_ workspace: SidebarWorkspace) {
        guard !workspace.isDraftWorkspace,
              !workspace.isOptimistic,
              workspace.workspaceId?.isEmpty == false
        else { return }
        pendingWorkspaceDeletion = workspace
    }

    private func resumeDraft(_ workspace: SidebarWorkspace) {
        guard let workspaceId = workspace.workspaceId,
              let draft = workspace.workspace?.draft else { return }
        newSessionRequest = NewSessionRequest(
            repo: workspace.effectiveRepo,
            workspaceId: workspaceId,
            draft: draft
        )
    }

    /// Dev convenience for simulator runs: OS1_OPEN_SESSION=<id> jumps straight
    /// into that session once the list has loaded.
    private func autoOpenFromEnvironment() {
        guard let id = ProcessInfo.processInfo.environment["OS1_OPEN_SESSION"],
              let session = viewModel.sessions.first(where: { $0.id == id })
        else { return }
        #if os(macOS)
        if selectedSessionID == nil { selectedSessionID = session.id }
        #else
        if path.isEmpty { path.append(session) }
        #endif
    }

    private func storedDraft(for id: String) -> SessionViewModel.ComposerDraft? {
        let draft = SessionViewModel.ComposerDraft(
            text: DraftsStore.shared.text(for: id) ?? "",
            images: composerDrafts[id]?.images ?? []
        )
        return draft.isEmpty ? nil : draft
    }

    private func saveComposerDraft(
        _ draft: SessionViewModel.ComposerDraft,
        for id: String
    ) {
        composerDrafts[id] = draft.images.isEmpty
            ? nil
            : SessionViewModel.ComposerDraft(text: "", images: draft.images)
        DraftsStore.shared.setText(draft.text, for: id, immediate: true)
    }

    /// The moment Start is tapped: an optimistic row (temporary `pending-` id)
    /// joins the list and the conversation view opens seeded from the prompt —
    /// no waiting on the server. `resolveCreate` swaps in the real id (or
    /// rolls back) when the background create finishes.
    private func openOptimistic(
        _ session: Session, seed: SessionViewModel.OptimisticSeed
    ) {
        viewModel.addOptimistic(session)
        optimisticSeeds[session.id] = seed
        #if os(macOS)
        selectedSessionID = session.id
        #else
        path.append(session)
        #endif
    }

    /// The background create finished: move the pending row (and the open
    /// conversation) onto the server's real id, or roll the pending row back
    /// and surface the error.
    private func resolveCreate(tempId: String, result: Result<String, Error>) {
        switch result {
        case .success(let id):
            viewModel.resolveOptimistic(tempId: tempId, realId: id)
            sessionPageCache.remove(sessionId: tempId)
            resolvedSessionIds[tempId] = id
            if let seed = optimisticSeeds.removeValue(forKey: tempId) {
                optimisticSeeds[id] = seed
            }
            if let draft = composerDrafts.removeValue(forKey: tempId) {
                composerDrafts[id] = draft
            }
            DraftsStore.shared.remap(tempId: tempId, to: id)
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = id }
            #else
            // Swap the pending entry wherever it sits in the stack, rather
            // than whatever happens to be on top: worktree prep takes seconds,
            // and by the time it lands the person may have gone back and
            // opened a different session — replacing the top would yank them
            // into the session they started earlier.
            if let index = path.firstIndex(where: { $0.id == tempId }),
               let session = viewModel.sessions.first(where: { $0.id == id }) {
                var next = path
                next[index] = session
                // No visible pop/push double transition.
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    path = next
                }
            }
            #endif
        case .failure(let error):
            viewModel.removeOptimistic(tempId)
            sessionPageCache.remove(sessionId: tempId)
            optimisticSeeds[tempId] = nil
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = nil }
            #else
            // Same care as the success path: drop the failed session's own
            // screen, not whatever the person is looking at now.
            path.removeAll { $0.id == tempId }
            #endif
            createErrorTitle = "Couldn't start session"
            createError = error.localizedDescription
        }
    }

    // ── Filtering / grouping ──────────────────────────────────────────────

    private var availableRepos: [String] {
        SessionsListViewModel.repositoryOrder(
            in: viewModel.sessions,
            workspaceRepos: registeredRepoIDs + viewModel.workspaces.compactMap {
                $0.draft == nil ? nil : $0.repo
            },
            preferredOrderJSON: preferredRepoOrder
        )
    }

    /// Empty registered projects belong in the normal project list while
    /// looking at your own unsearched work: the band's "+" is the shortest
    /// path to a first session. Search and teammate lenses stay
    /// result-driven, and so does the whole list once "Hide when empty" is on
    /// — except when the list is scoped to one project, where the band is what
    /// was asked for rather than clutter.
    private var repoBandRepos: [String] {
        if showsTeamActivityFixture { return [] }
        let occupied = Set(filteredWorkspaces.map(\.effectiveRepo))
        let keepsEmptyBands = repoFilter != "all" || !hideEmptyProjects
        return availableRepos.filter { repo in
            guard repoFilter == "all" || repoFilter == repo else { return false }
            if !keepsEmptyBands
                || !searchText.trimmingCharacters(in: .whitespaces).isEmpty
                || person != SidebarPersonLens.me {
                return occupied.contains(repo)
            }
            return true
        }
    }

    /// Whose work is whose: one rule, shared with the Archived sheet.
    private var peopleLens: PeopleLens { PeopleLens.current() }

    /// Debounced server search with a revision guard. Cancellation normally
    /// stops URLSession too, but the guard also covers a request that finishes
    /// after the query changed away and then back to the same text.
    private func updateTranscriptSearch() async {
        transcriptSearchRevision += 1
        let revision = transcriptSearchRevision
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        transcriptSnippets = [:]
        guard query.count >= 2 else { return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let matches = try await OS1API.searchTranscripts(query)
            guard !Task.isCancelled, revision == transcriptSearchRevision,
                  query == searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            else { return }
            var next: [String: String] = [:]
            for match in matches where next[match.id] == nil {
                next[match.id] = match.snippet
            }
            transcriptSnippets = next
        } catch {
            // Metadata search remains useful when a server predates this route
            // or the connection drops. The next query tries again.
        }
    }

    private func sessionMatchesMetadata(_ session: Session, query: String) -> Bool {
        [session.title, session.effectiveRepo, session.branch, session.id]
            .compactMap { $0 }
            .contains { $0.lowercased().contains(query) }
    }

    private func workspaceMatchesMetadata(
        _ workspace: SidebarWorkspace,
        query: String
    ) -> Bool {
        workspace.title.lowercased().contains(query)
            || workspace.sessions.contains { sessionMatchesMetadata($0, query: query) }
    }

    /// Snippets explain only transcript-only hits. A metadata match already
    /// explains itself through the row's title, repository, or branch.
    private func workspaceSearchSnippet(_ workspace: SidebarWorkspace) -> String? {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty, !workspaceMatchesMetadata(workspace, query: query) else {
            return nil
        }
        return workspace.sessions.compactMap { transcriptSnippets[$0.id] }.first
    }

    private var archivedSearchResults: [Session] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return [] }
        let lens = peopleLens
        let person = person
        let agentKey = agentKey
        return viewModel.archivedSessions.filter { session in
            lens.matches(session, person: person, agentKey: agentKey)
                && (repoFilter == "all" || session.effectiveRepo == repoFilter)
                && (sessionMatchesMetadata(session, query: query)
                    || transcriptSnippets[session.id] != nil)
        }
    }

    private func archivedSearchSnippet(_ session: Session) -> String? {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !sessionMatchesMetadata(session, query: query) else { return nil }
        return transcriptSnippets[session.id]
    }

    private var visibleArchivedSessions: [Session] {
        let lens = peopleLens
        let person = person
        let agentKey = agentKey
        return viewModel.archivedSessions.filter { session in
            lens.matches(session, person: person, agentKey: agentKey)
                && (repoFilter == "all" || session.effectiveRepo == repoFilter)
        }
    }

    /// The current lens as one predicate, with its inputs read once.
    ///
    /// Hides stay here rather than in the view model's grouping: the hide map
    /// changes independently of the session list, so a hidden row has to
    /// disappear on the tap, not on the next poll.
    private func visibilityFilter() -> (SidebarWorkspace) -> Bool {
        let person = person
        let agentKey = agentKey
        let lens = peopleLens
        let repo = repoFilter
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        // Rows this person has hidden drop out of the sidebar — except while
        // a session of theirs is blocked on a question (the poll consumes the
        // hide when that happens), and except while searching, which is how a
        // hidden row is found again so its menu can restore it.
        #if os(iOS)
        let hides = query.isEmpty ? HideStore.shared.hides : [:]
        #endif
        return { workspace in
            #if os(iOS)
            if !hides.isEmpty, workspace.lane != .needsInput,
               hides[SidebarRowKeys.rowKey(for: workspace)] != nil {
                return false
            }
            #endif
            if !lens.matches(workspace, person: person, agentKey: agentKey) {
                return false
            }
            if repo != "all", workspace.effectiveRepo != repo { return false }
            guard !query.isEmpty else { return true }
            if workspaceMatchesMetadata(workspace, query: query) { return true }
            return workspace.sessions.contains { transcriptSnippets[$0.id] != nil }
        }
    }

    /// Whether anything survives the lens — the empty-state overlay's
    /// question. Stops at the first match instead of filtering and sorting
    /// the whole list a second time per body evaluation.
    private var hasVisibleWorkspaces: Bool {
        allSidebarWorkspaces.contains(where: visibilityFilter())
    }

    /// The lens applied once: the rows the list draws, and how many rows the
    /// auto-created switch is moving.
    private struct FilterOutcome {
        var visible: [SidebarWorkspace] = []
        /// Rows that are here only because an agent's work is shown, or held
        /// back only because it isn't — the number the switch at the foot of
        /// the list carries either way. A filter that removes rows silently is
        /// one you forget you set.
        var autoCreatedHeld = 0
    }

    /// One pass, not two. The count of what the auto-created setting moves is
    /// the same walk that decides which rows survive it, which is both the
    /// cheap way to get it and the only way it can't disagree with the list.
    private var filterOutcome: FilterOutcome {
        let passes = visibilityFilter()
        let show = showAutoCreated
        let lens = peopleLens
        let openId = openSessionID
        var outcome = FilterOutcome()
        var kept: [(workspace: SidebarWorkspace, inProgress: Bool, date: Date)] = []
        for workspace in allSidebarWorkspaces {
            guard passes(workspace) else { continue }
            // "Hide" only ever removes a row that is here BECAUSE the machine
            // made it. The row you have open still shows — the list has to
            // keep saying where you are — and so does one you claimed or were
            // tagged in, which are your own acts, not the machine's.
            if AutoCreatedOrigin.wasAutoCreated(workspace),
               !survivesAutoCreatedHide(workspace, lens: lens, openSessionID: openId) {
                outcome.autoCreatedHeld += 1
                if !show { continue }
            }
            // Decorated sort: parse each row's date once, not once per
            // comparison — this runs on the main thread on every body
            // evaluation, and the list can be thousands of rows with the
            // person lens set to everyone.
            kept.append((
                workspace,
                workspace.lane == .inProgress,
                sortBy == .updated ? workspace.lastActivityDate : workspace.createdDate
            ))
        }
        outcome.visible = kept
            .sorted {
                if $0.inProgress != $1.inProgress { return $0.inProgress }
                return $0.date > $1.date
            }
            .map(\.workspace)
        return outcome
    }

    /// An auto-created row the hide must not take: the one you have open, one
    /// you claimed into your own list, and one a teammate tagged you in.
    private func survivesAutoCreatedHide(
        _ workspace: SidebarWorkspace,
        lens: PeopleLens,
        openSessionID: String?
    ) -> Bool {
        workspace.sessions.contains { session in
            session.id == openSessionID
                || lens.claims.contains(session.id)
                || lens.mentions.contains(session.id)
        }
    }

    /// The session on screen beside the list (Mac) or the one you last came
    /// back from (iPhone).
    private var openSessionID: String? {
        #if os(macOS)
        selectedSessionID
        #else
        lastOpenedSessionID
        #endif
    }

    private var filteredWorkspaces: [SidebarWorkspace] { filterOutcome.visible }

    /// Grouped once by the view model, not per read: several properties below
    /// (`filteredWorkspaces`, the empty-state overlay, the tab-strip lookup)
    /// each want the rows, and regrouping thousands of sessions inside a body
    /// evaluation is what used to pin the main thread on launch.
    private var allSidebarWorkspaces: [SidebarWorkspace] {
        viewModel.sidebarWorkspaces
    }

    private struct SessionGroup: Identifiable {
        let id: String
        let title: String
        let workspaces: [SidebarWorkspace]
        let repo: String?
    }

    private struct RepoSessionGroup: Identifiable {
        let repo: String
        let workspaces: [SidebarWorkspace]
        let sections: [SessionGroup]

        var id: String { repo }
    }

    /// Snoozed rows leave the active sections in every grouping. Inbox keeps
    /// both lists nearby, while Activity and Status append the same Snoozed shelf.
    private struct InboxOutcome {
        var active: [SidebarWorkspace] = []
        var snoozed: [SidebarWorkspace] = []
    }

    private var inboxOutcome: InboxOutcome {
        let store = WorkspaceSnoozeStore.shared
        var outcome = InboxOutcome()
        for workspace in filteredWorkspaces {
            if store.isSnoozed(workspace) { outcome.snoozed.append(workspace) }
            else { outcome.active.append(workspace) }
        }
        outcome.active = WorkspaceSnooze.sortActive(outcome.active)
        outcome.snoozed = WorkspaceSnooze.sortSnoozed(
            outcome.snoozed,
            values: store.snoozes
        )
        return outcome
    }

    private func sessionGroups(
        for workspaces: [SidebarWorkspace],
        namespace: String = ""
    ) -> [SessionGroup] {
        let ids = Set(workspaces.map(\.id))
        let inbox = inboxOutcome
        let active = inbox.active.filter { ids.contains($0.id) }
        let snoozed = inbox.snoozed.filter { ids.contains($0.id) }
        let snoozedGroup = SessionGroup(
            id: "\(namespace)snoozed",
            title: "Snoozed",
            workspaces: snoozed,
            repo: nil
        )
        switch groupBy {
        case .inbox:
            return [
                SessionGroup(
                    id: "\(namespace)inbox-active",
                    title: "Active",
                    workspaces: active,
                    repo: nil
                ),
                snoozedGroup,
            ].filter { !$0.workspaces.isEmpty }
        case .activity:
            var groups = SessionsListViewModel.inboxBands(
                active,
                mentionedSessionIds: MentionStore.shared.sessionIds
            ).map { band in
                SessionGroup(
                    id: "\(namespace)activity-\(band.band.rawValue)",
                    title: band.band.label,
                    workspaces: band.workspaces,
                    repo: nil
                )
            }
            if !snoozed.isEmpty { groups.append(snoozedGroup) }
            return groups
        case .status:
            var groups = Session.Lane.allCases.compactMap { lane in
                let inLane = active.filter { $0.lane == lane }
                return inLane.isEmpty
                    ? nil
                    : SessionGroup(
                        id: "\(namespace)lane-\(lane.rawValue)",
                        title: lane.label,
                        workspaces: inLane,
                        repo: nil
                    )
            }
            if !snoozed.isEmpty { groups.append(snoozedGroup) }
            return groups
        }
    }

    private var groups: [SessionGroup] {
        sessionGroups(for: filteredWorkspaces)
    }

    private var repoSessionGroups: [RepoSessionGroup] {
        let byRepo = Dictionary(grouping: filteredWorkspaces, by: \.effectiveRepo)
        return repoBandRepos.map { repo in
            let workspaces = byRepo[repo] ?? []
            return RepoSessionGroup(
                repo: repo,
                workspaces: workspaces,
                sections: sessionGroups(for: workspaces, namespace: "repo-\(repo)-")
            )
        }
    }

    #if os(iOS)
    /// Workspace rows in the order the sidebar actually draws them. Next chat
    /// reads this instead of a backing sessions array because pins, grouping
    /// and collapsed sections all change what comes after the open row.
    private var renderedChatWorkspaces: [SidebarWorkspace] {
        var rendered = visibleWorkspaces(pinnedWorkspaces, collapsedKey: "pinned")
        if groupsByProject {
            for repoGroup in repoSessionGroups {
                guard !isCollapsed(repoBandKey(repoGroup.repo)) else { continue }
                for group in repoGroup.sections {
                    rendered += visibleWorkspaces(
                        group.workspaces,
                        collapsedKey: group.id
                    )
                }
            }
        } else {
            for group in groups {
                rendered += visibleWorkspaces(
                    group.workspaces,
                    collapsedKey: group.id
                )
            }
        }
        return rendered
    }

    /// Nil removes the button when this is the only visible chat.
    private func nextChatAction(after session: Session) -> (() -> Void)? {
        guard nextWorkspace(after: session) != nil else { return nil }
        return { openNextChat(after: session) }
    }

    private func nextWorkspace(after session: Session) -> SidebarWorkspace? {
        guard let current = workspace(containing: session), !current.isDraftWorkspace
        else { return nil }
        return SidebarNext.workspace(
            after: current.id,
            in: renderedChatWorkspaces,
            isUnread: { ReadsStore.shared.isUnread($0.sessions) }
        )
    }

    /// Replace the current push rather than stacking chats. Back still returns
    /// to the sidebar in one gesture, however many times Next was used.
    private func openNextChat(after session: Session) {
        guard let current = workspace(containing: session),
              let open = path.last,
              workspace(containing: open)?.id == current.id,
              let next = nextWorkspace(after: open)
        else { return }
        Haptics.play(.selection)
        path[path.count - 1] = next.mainSession
    }
    #endif

    /// The list's view controls. A panel rather than a menu: there are seven
    /// of them now, and two are switches — every switch inside a `Menu`
    /// dismisses the whole stack, so turning two things off meant opening it
    /// twice and walking two levels down each time.
    @ViewBuilder
    private var filterButton: some View {
        let button = Button {
            showFilterPanel = true
        } label: {
            filterGlyph
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Filter sessions")
        .accessibilityValue(filterAccessibilityValue)

        // The Mac's panel is a popover, so it hangs off the button it points
        // at. The phone's is a sheet, and a sheet presented from inside a
        // `ToolbarItem` does not reliably appear — SwiftUI hosts toolbar
        // content apart from the view it decorates. It rides the navigation
        // container instead, where every other sheet on this screen lives.
        #if os(macOS)
        button.popover(isPresented: $showFilterPanel, arrowEdge: .bottom) {
            filterPanel
        }
        #else
        button
        #endif
    }

    @ViewBuilder
    private var filterGlyph: some View {
        // One symbol pair across both clients, at each one's own size: a
        // control should not be drawn from two sets. It fills in whenever
        // anything is narrowing or hiding rows, which is the state you want to
        // find again when the list looks short.
        let symbol = filterIsActive
            ? "line.3.horizontal.decrease.circle.fill"
            : "line.3.horizontal.decrease"
        let ink = filterIsActive ? OS1VisualStyle.accentInk : OS1VisualStyle.textDim
        #if os(macOS)
        Image(systemName: symbol)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(ink)
            .frame(width: 26, height: 24)
            .contentShape(Rectangle())
        #else
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(ink)
            .frame(width: 24, height: 24)
        #endif
    }

    private var filterPanel: some View {
        SessionsFilterPanel(
            groupBy: groupBySelection,
            groupByProject: groupsByProjectSelection,
            repo: $repoFilter,
            person: personSelection,
            sort: $sortByRaw,
            showAutoCreated: $showAutoCreated,
            hideEmptyProjects: $hideEmptyProjects,
            repos: availableRepos,
            currentUser: ServerConfig.shared.userName
        )
    }

    /// Whether anything is narrowing or hiding rows. The grouping and the sort
    /// are not part of it: they change how the list reads, not what is in it.
    private var filterIsActive: Bool {
        repoFilter != "all"
            || person != SidebarPersonLens.me
            || showAutoCreated
            || hideEmptyProjects
    }

    private var filterAccessibilityValue: String {
        let people: String
        switch person {
        case SidebarPersonLens.me: people = "My sessions"
        case SidebarPersonLens.everyone: people = "Everyone"
        case SidebarPersonLens.unassigned: people = "Unassigned"
        default: people = person
        }
        let repo = repoFilter == "all" ? "All projects" : RepoTile.label(for: repoFilter)
        let order = switch groupBy {
        case .inbox: "stable creation order"
        case .activity: "ordered by activity"
        case .status: "sorted by \(sortBy.label)"
        }
        let projects = groupsByProject ? "grouped by project" : "all projects together"
        return "\(people), grouped by \(groupBy.label), \(projects), \(repo), \(order)"
    }

    // ── List body ─────────────────────────────────────────────────────────

    #if os(macOS)
    private var list: some View {
        List(selection: $selectedSessionID) {
            listSections
        }
        .listStyle(.sidebar)
        .overlay { emptyFilterOverlay }
        // Delete key archives the selected session — the Mac-native
        // counterpart to iOS's swipe.
        .onDeleteCommand {
            if let selectedSessionID,
               let workspace = allSidebarWorkspaces.first(where: {
                   $0.id == selectedSessionID
                       || $0.sessions.contains { $0.id == selectedSessionID }
               }) {
                if workspace.isDraftWorkspace {
                    viewModel.deleteDraftWorkspace(workspace)
                    self.selectedSessionID = nil
                } else {
                    archive(workspace)
                }
            }
        }
    }
    #else
    private var list: some View {
        List {
            listSections
        }
        .listStyle(.plain)
        // The 44pt floor exists for rows that don't state their own height;
        // ours all do, and all it did here was inflate the lane headings into
        // full-height rows. Rows carry the touch metrics in their own padding
        // (which is why SessionRow pads to 13 rather than 11).
        .environment(\.defaultMinListRowHeight, 8)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .listSectionSpacing(10)
        .contentMargins(.top, 4, for: .scrollContent)
        .overlay { emptyFilterOverlay }
        .refreshable {
            await viewModel.refresh()
        }
        .navigationDestination(for: Session.self) { session in
            SessionTabsView(
                session: session,
                tabs: SessionsListViewModel.tabSessions(
                    in: viewModel.sessions,
                    containing: session
                ),
                relatedSessions: viewModel.sessions,
                workspaceNames: viewModel.workspaceNames,
                viewModelForSession: {
                    sessionPageCache.viewModel(
                        for: $0,
                        scope: sessionCacheScope,
                        seed: optimisticSeeds[$0.id],
                        composerDraft: storedDraft(for: $0.id)
                    )
                },
                onSaveComposerDraft: { savedSession, draft in
                    let id = resolvedSessionIds[savedSession.id] ?? savedSession.id
                    saveComposerDraft(draft, for: id)
                },
                onNewSession: {
                    // The session's ⋯ → "New session in this workspace" opens a
                    // composer scoped to the latest workspace. The row retained
                    // by NavigationPath can predate a workspace it joined later.
                    let current = viewModel.sessions.first { $0.id == session.id } ?? session
                    guard current.workspaceId?.isEmpty == false else {
                        // A workspace-less legacy session has no strip to join,
                        // so the composer sheet stays the way in — it's a
                        // standalone session, and its repo/mode are still open
                        // questions.
                        newSessionRequest = NewSessionRequest(repo: session.effectiveRepo)
                        return nil
                    }
                    newSessionRequest = NewSessionRequest(
                        repo: current.effectiveRepo,
                        workspaceId: current.workspaceId
                    )
                    return nil
                },
                onNextChat: nextChatAction(after: session),
                onForkCreated: openFork,
                onRenameWorkspace: { name in
                    guard let workspace = workspace(containing: session) else { return }
                    viewModel.rename(workspace, to: name)
                },
                onArchiveWorkspace: {
                    guard let workspace = workspace(containing: session) else { return }
                    archive(workspace)
                },
                onDeleteWorkspace: {
                    guard let workspace = workspace(containing: session) else { return }
                    requestWorkspaceDeletion(workspace)
                },
                onCloseTab: { closed in
                    sessionPageCache.remove(sessionId: closed.id)
                    viewModel.archive(closed)
                },
                onRestoreTab: { archived in
                    await restoreArchived(archived)
                }
            )
            .id(session.id)
        }
    }
    #endif

    @MainActor
    private func openFork(_ id: String) async {
        do {
            let session = try await OS1API.session(id: id)
            await viewModel.refresh()
            #if os(iOS)
            path.append(session)
            #else
            openedArchivedSession = nil
            selectedSessionID = session.id
            #endif
        } catch {
            createErrorTitle = "Couldn't open fork"
            createError = error.localizedDescription
        }
    }

    /// A scoped history row is deliberately slim. Restore the whole session so
    /// selecting it immediately has its model, walkthrough and PR rather than
    /// waiting for the next live-list poll to replace the summary.
    private func restoreArchived(_ session: Session) async -> Session {
        let restored = await viewModel.hydrated(session)
        viewModel.unarchive(restored)
        return restored
    }

    /// The repo an Inbox row wears on its tile — nothing above it says which
    /// repo it belongs to, since the flat list has no repo bands. Every other
    /// grouping has a repo band or a repo filter doing that job, and a list
    /// that's already one repo (a repo filter, or a single-repo instance)
    /// would only repeat itself.
    private func inboxRowRepo(_ workspace: SidebarWorkspace) -> String? {
        guard !groupsByProject, repoFilter == "all", availableRepos.count > 1
        else { return nil }
        return workspace.effectiveRepo
    }

    #if os(iOS)
    /// Matched across the whole workspace, not just its main session: the
    /// strip's sibling tabs all live behind one row, so returning from a tab
    /// highlights the row that pushed it.
    private func isLastOpened(_ workspace: SidebarWorkspace) -> Bool {
        guard let lastOpenedSessionID else { return false }
        return workspace.sessions.contains { $0.id == lastOpenedSessionID }
    }
    #endif

    @ViewBuilder
    private func sessionRow(_ workspace: SidebarWorkspace) -> some View {
        let session = workspace.mainSession
        let canArchive = !workspace.isOptimistic && !workspace.isDraftWorkspace
        let snoozeValue = WorkspaceSnoozeStore.shared.value(for: workspace)
        let pinned = PinStore.shared.isPinned(workspace)
        let repo = inboxRowRepo(workspace)
        #if os(macOS)
        // Selection drives the detail column; select by id so rows replaced
        // by polling (fresh struct values every refresh) keep the selection.
        // The hover cluster matches web exactly: Pin, Snooze, Archive.
        SessionRow(
            session: workspace.statusSession,
            title: workspace.title,
            sessions: workspace.sessions,
            repo: repo,
            autoCreated: AutoCreatedOrigin.wasAutoCreated(workspace),
            searchSnippet: workspaceSearchSnippet(workspace),
            selected: workspace.sessions.contains { $0.id == selectedSessionID },
            isWorkspaceDraft: workspace.isDraftWorkspace,
            snoozeValue: snoozeValue,
            pinned: pinned,
            onTogglePin: canArchive ? { PinStore.shared.toggle(workspace) } : nil,
            onToggleSnooze: canArchive ? { toggleSnooze(workspace) } : nil,
            onArchive: canArchive ? { archive(workspace) } : nil
        )
        .tag(workspace.isDraftWorkspace ? workspace.id : session.id)
        .contextMenu {
            if workspace.isDraftWorkspace {
                deleteDraftButton(workspace)
            } else {
                pinButton(workspace)
                snoozeButton(workspace)
                archiveButton(workspace)
                deleteWorkspaceButton(workspace)
            }
        }
        #else
        Button {
            if workspace.isDraftWorkspace {
                resumeDraft(workspace)
            } else {
                path.append(session)
            }
        } label: {
            SessionRow(
                session: workspace.statusSession,
                title: workspace.title,
                sessions: workspace.sessions,
                repo: repo,
                autoCreated: AutoCreatedOrigin.wasAutoCreated(workspace),
                searchSnippet: workspaceSearchSnippet(workspace),
                highlighted: isLastOpened(workspace),
                isWorkspaceDraft: workspace.isDraftWorkspace,
                snoozeValue: snoozeValue
            )
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .trailing) {
            if workspace.isDraftWorkspace {
                deleteDraftButton(workspace, viaSwipe: true)
            } else {
                archiveButton(workspace, viaSwipe: true)
                snoozeButton(workspace, viaSwipe: true)
            }
        }
        // Swipe right pins. Swipe left keeps Snooze and Archive together.
        // The tint rides on the swipe, not on the button: it paints the swipe
        // action's own background here, but in the context menu the same tint
        // would land on the glyph and make Pin the one coloured item in a
        // column of grey ones.
        .swipeActions(edge: .leading) {
            pinButton(workspace, filled: true).tint(OS1VisualStyle.yellow)
        }
        // A row with a pull request answers "how big, and is it green?" in a
        // preview above the menu: the phone's shape of the web sidebar's
        // hover card (see SessionRowPreview). A row without one does not get a
        // preview at all: everything a card could add that the row does not
        // already show (model, mode, branch, who started it) is reference
        // detail rather than a reason to pick a menu item, and Worktree
        // details in the very menu underneath opens all of it. A thin card is
        // worse than none: it costs the gesture a beat and answers nothing.
        .modifier(SessionRowMenu(workspace: workspace) {
            if workspace.isDraftWorkspace {
                draftWorkspaceMenu(workspace)
            } else if canArchive {
                workspaceMenu(workspace)
            }
        })
        #endif
    }

    private func archivedSearchRow(_ session: Session) -> some View {
        Button {
            openArchivedSearchResult(session)
        } label: {
            SessionRow(
                session: session,
                repo: repoFilter == "all" && availableRepos.count > 1
                    ? session.effectiveRepo
                    : nil,
                searchSnippet: archivedSearchSnippet(session)
            )
        }
        .buttonStyle(.plain)
        #if os(iOS)
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        #endif
    }

    private func openArchivedSearchResult(_ session: Session) {
        Task {
            let hydrated = await viewModel.hydrated(session)
            #if os(macOS)
            selectedSessionID = nil
            openedArchivedSession = hydrated
            #else
            path.append(hydrated)
            #endif
        }
    }

    #if os(iOS)
    /// Attaches the row's context menu, with the PR preview when there is a PR
    /// to preview. Two `contextMenu` overloads produce two different view
    /// types, so the choice lives in a modifier rather than branching the row.
    private struct SessionRowMenu<Items: View>: ViewModifier {
        let workspace: SidebarWorkspace
        @ViewBuilder let items: () -> Items

        func body(content: Content) -> some View {
            if let session = workspace.pullRequestSession,
               session.pullRequestContextState != nil {
                content.contextMenu(menuItems: items) {
                    SessionRowPreview(
                        title: workspace.title,
                        repo: RepoTile.label(for: session.effectiveRepo),
                        session: session
                    )
                }
            } else {
                content.contextMenu(menuItems: items)
            }
        }
    }
    #endif

    #if os(iOS)
    /// Leading swipe (and context menu) action. Non-destructive: the row stays
    /// where it is and gains a copy in the Pinned band, so the cell just closes
    /// — no `.destructive` role, and the toggle animates the band's insert.
    ///
    /// `filled` for the same reason the tint is set by the caller: a swipe
    /// action is a glyph knocked out of a colour capsule, where the solid
    /// symbol is the system's own shape, while every other glyph in the
    /// context menu is an outline one.
    @ViewBuilder
    private func pinButton(
        _ workspace: SidebarWorkspace,
        filled: Bool = false
    ) -> some View {
        if !workspace.isOptimistic && !workspace.isDraftWorkspace {
            let pinned = PinStore.shared.isPinned(workspace)
            let symbol = pinned ? "pin.slash" : "pin"
            Button {
                withAnimation(.snappy(duration: 0.28)) {
                    PinStore.shared.toggle(workspace)
                }
            } label: {
                Label(
                    pinned ? "Unpin" : "Pin",
                    systemImage: filled ? "\(symbol).fill" : symbol
                )
            }
        }
    }

    /// Flip the whole workspace read or unread, like the web sidebar row's
    /// right-click action — one unread session bolds the row, so the toggle
    /// has to cover every session behind it. Only the move you can actually
    /// make is offered, the way the web menu does it.
    @ViewBuilder
    private func readButton(_ workspace: SidebarWorkspace) -> some View {
        let unread = ReadsStore.shared.isUnread(workspace.sessions)
        Button {
            for session in workspace.sessions {
                if unread {
                    ReadsStore.shared.markRead(session)
                } else {
                    ReadsStore.shared.markUnread(session)
                }
            }
        } label: {
            Label(
                unread ? "Mark as read" : "Mark as unread",
                systemImage: unread ? "envelope.open" : "envelope.badge"
            )
        }
    }

    @ViewBuilder
    private func workspaceMenu(_ workspace: SidebarWorkspace) -> some View {
        // The same three filing actions as the row: Pin, Snooze, Archive.
        pinButton(workspace)
        snoozeButton(workspace)
        readButton(workspace)

        Button {
            renameText = workspace.title
            renamingWorkspace = workspace
        } label: {
            Label("Rename", systemImage: "pencil")
        }

        if let link = workspace.shareURL {
            // Named after the workspace, like the sheet in SessionView.
            ShareLink(item: link, preview: SharePreview(workspace.title)) {
                Label("Share link", systemImage: "square.and.arrow.up")
            }
        }

        if let session = workspace.pullRequestSession,
           let state = session.pullRequestContextState {
            Divider()
            Label(state.label, systemImage: prStateIcon(state))
                .disabled(true)
            prAction(state, session: session)
            if let prURL = session.prUrl.flatMap(URL.init(string:)) {
                Button {
                    copyToPasteboard(prURL.absoluteString)
                    Haptics.play(.selection)
                } label: {
                    Label("Copy GitHub link", systemImage: "doc.on.doc")
                }
                Button {
                    slackShare = PrSlackShareRequest(
                        title: workspace.title,
                        url: prURL,
                        sessionId: session.id,
                        repo: session.repo,
                        branch: session.branch,
                        merged: session.prState == "MERGED",
                        walkthroughSummary: session.walkthrough?.summary,
                        suggestedScreenshot: session.walkthrough?.shots?
                            .first { $0.after != nil }?.after
                    )
                } label: {
                    Label("Share to Slack", systemImage: "paperplane")
                }
                Link(destination: prURL) {
                    Label {
                        Text(verbatim: session.prNumber.map { "Open PR #\($0)" } ?? "Open pull request")
                    } icon: {
                        Image(systemName: "arrow.triangle.pull")
                    }
                }
            }
        }

        // Last of the three that send you somewhere else (share sheet, Safari,
        // this sheet), rather than sitting between Pin and Rename: it is the
        // one you reach for least, and the run of state → edit → go-look-at-it
        // is the order the web row's menu already reads in.
        Button {
            detailsWorkspace = workspace
        } label: {
            Label("Worktree details", systemImage: "info.circle")
        }

        if !workspace.isOptimistic {
            Divider()
            // Hiding is the personal counterpart to archiving: the row leaves
            // YOUR sidebar (here and in the web one) while the session keeps
            // running for everyone else — so it isn't destructive-styled.
            //
            // "…my sidebar", the web menu's wording, is one word too wide for
            // a context menu and wrapped onto a second line — the only item in
            // the menu that did. The shorter phrasing is the web's own, from
            // its narrower menus (FeedRows, the band header).
            if HideStore.shared.isHidden(workspace) {
                Button {
                    HideStore.shared.clear([SidebarRowKeys.rowKey(for: workspace)])
                } label: {
                    Label("Restore to sidebar", systemImage: "eye")
                }
            } else {
                Button {
                    hide(workspace)
                } label: {
                    Label("Hide from sidebar", systemImage: "eye.slash")
                }
            }
            Button(role: .destructive) {
                archive(workspace)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            deleteWorkspaceButton(workspace)
        }
    }

    @ViewBuilder
    private func draftWorkspaceMenu(_ workspace: SidebarWorkspace) -> some View {
        deleteDraftButton(workspace)
    }

    @ViewBuilder
    private func prAction(
        _ state: Session.PullRequestContextState,
        session: Session
    ) -> some View {
        switch state {
        case .merged, .closed:
            EmptyView()
        case .conflicts:
            Button {
                promptForPr(
                    session,
                    "Rebase this branch on the latest base branch, resolve the pull request's merge conflicts, run the relevant tests, commit the changes, and push them."
                )
            } label: {
                Label("Resolve conflicts", systemImage: "arrow.triangle.2.circlepath")
            }
        case .failing:
            Button {
                promptForPr(
                    session,
                    "Investigate the failing checks on PR #\(session.prNumber ?? 0), fix the failures, run the relevant tests, commit the changes, and push them."
                )
            } label: {
                Label("Fix checks", systemImage: "wrench.and.screwdriver")
            }
        case .running:
            if let url = session.prUrl.flatMap(URL.init(string:)) {
                Link(destination: url.appendingPathComponent("checks")) {
                    Label("View checks", systemImage: "checklist")
                }
            }
        case .draft:
            EmptyView()
        case .changesRequested:
            Button {
                promptForPr(
                    session,
                    "Address the requested changes on PR #\(session.prNumber ?? 0), run the relevant tests, commit the changes, and push them."
                )
            } label: {
                Label("Address feedback", systemImage: "text.bubble")
            }
        case .ready:
            Menu {
                Button("Squash and merge") { prepareContextMerge(session, method: "squash") }
                Button("Create a merge commit") { prepareContextMerge(session, method: "merge") }
                Button("Rebase and merge") { prepareContextMerge(session, method: "rebase") }
            } label: {
                Label("Merge pull request", systemImage: "arrow.triangle.merge")
            }
        }
    }

    private func prStateIcon(_ state: Session.PullRequestContextState) -> String {
        switch state {
        case .merged: "arrow.triangle.merge"
        case .closed, .failing: "xmark.circle.fill"
        case .conflicts: "exclamationmark.triangle.fill"
        case .running: "clock.fill"
        case .draft: "pencil.circle.fill"
        case .changesRequested: "exclamationmark.bubble.fill"
        case .ready: "checkmark.circle.fill"
        }
    }

    private func promptForPr(_ session: Session, _ prompt: String) {
        let busyMode = UserDefaults.standard.string(forKey: "os1.composer.busySend") ?? "queue"
        guard Outbox.shared.enqueue(
            sessionId: session.id,
            content: prompt,
            busyMode: busyMode,
            user: ServerConfig.shared.userName
        ) != nil else {
            prActionError = "Too many unsent messages. Send or delete some first."
            return
        }
        HideStore.shared.unhide(for: session)
        Haptics.play(.send)
    }

    private func prepareContextMerge(_ session: Session, method: String) {
        pendingContextMerge = ContextMerge(session: session, method: method)
    }

    private var contextMergeTitle: String {
        guard let number = pendingContextMerge?.session.prNumber else {
            return "Merge pull request?"
        }
        return "Merge PR #\(number)?"
    }

    private var contextMergeButtonLabel: String {
        switch pendingContextMerge?.method {
        case "merge": "Create a merge commit"
        case "rebase": "Rebase and merge"
        default: "Squash and merge"
        }
    }

    private func performContextMerge() {
        guard let pending = pendingContextMerge else { return }
        pendingContextMerge = nil
        Task {
            do {
                try await OS1API.mergePr(
                    sessionId: pending.session.id,
                    method: pending.method
                )
                Haptics.play(.commit)
                await viewModel.refresh()
            } catch {
                prActionError = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    private func hide(_ workspace: SidebarWorkspace) {
        withAnimation(.snappy(duration: 0.28)) {
            HideStore.shared.hide(workspace)
        }
    }

    /// The sidebar row a pushed session belongs to, so the session's own overflow
    /// menu can act on the whole worktree. Resolved ids first: a session pushed
    /// while it was still optimistic keeps its temp id in the stack.
    private func workspace(containing session: Session) -> SidebarWorkspace? {
        let id = resolvedSessionIds[session.id] ?? session.id
        return viewModel.sidebarWorkspaces.first { workspace in
            workspace.sessions.contains { $0.id == id }
        }
    }
    #endif

    #if os(macOS)
    @ViewBuilder
    private func pinButton(_ workspace: SidebarWorkspace) -> some View {
        if !workspace.isOptimistic && !workspace.isDraftWorkspace {
            let pinned = PinStore.shared.isPinned(workspace)
            Button {
                withAnimation(.snappy(duration: 0.28)) {
                    PinStore.shared.toggle(workspace)
                }
            } label: {
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash" : "pin")
            }
        }
    }
    #endif

    /// Reversible filing shared with the web. Snooze means Someday when the
    /// row has no explicit wake date; a snoozed row gets Unsnooze.
    @ViewBuilder
    private func snoozeButton(
        _ workspace: SidebarWorkspace,
        viaSwipe: Bool = false
    ) -> some View {
        if !workspace.isOptimistic && !workspace.isDraftWorkspace {
            let snoozed = WorkspaceSnoozeStore.shared.isSnoozed(workspace)
            let button = Button {
                toggleSnooze(workspace)
            } label: {
                Label(
                    snoozed ? "Unsnooze" : "Snooze",
                    systemImage: viaSwipe ? "moon.fill" : "moon"
                )
            }
            if viaSwipe { button.tint(.gray) }
            else { button }
        }
    }

    /// Archive stays explicit and destructive in context menus and on the Mac
    /// Delete key. It never runs automatically.
    @ViewBuilder
    private func archiveButton(
        _ workspace: SidebarWorkspace,
        viaSwipe: Bool = false
    ) -> some View {
        if !workspace.isOptimistic && !workspace.isDraftWorkspace {
            let button = Button(role: viaSwipe ? .destructive : nil) {
                archive(workspace, animated: !viaSwipe)
            } label: {
                Label("Archive", systemImage: viaSwipe ? "archivebox.fill" : "archivebox")
            }
            if viaSwipe {
                button.tint(OS1VisualStyle.red)
            } else {
                button
            }
        }
    }

    private func toggleSnooze(_ workspace: SidebarWorkspace) {
        withAnimation(.snappy(duration: 0.28)) {
            WorkspaceSnoozeStore.shared.toggleSomeDay(workspace)
        }
        Haptics.play(.selection)
    }

    @ViewBuilder
    private func deleteWorkspaceButton(_ workspace: SidebarWorkspace) -> some View {
        if !workspace.isDraftWorkspace,
           !workspace.isOptimistic,
           workspace.workspaceId?.isEmpty == false {
            Button(role: .destructive) {
                requestWorkspaceDeletion(workspace)
            } label: {
                Label("Delete workspace", systemImage: "trash")
            }
            .disabled(viewModel.workspaceDeletion.deletingWorkspaceId != nil)
        }
    }

    @ViewBuilder
    private func deleteDraftButton(
        _ workspace: SidebarWorkspace,
        viaSwipe: Bool = false
    ) -> some View {
        if workspace.isDraftWorkspace {
            Button(role: .destructive) {
                viewModel.deleteDraftWorkspace(workspace)
            } label: {
                Label("Delete", systemImage: viaSwipe ? "trash.fill" : "trash")
            }
            .tint(OS1VisualStyle.red)
        }
    }

    private func archive(_ workspace: SidebarWorkspace, animated: Bool = true) {
        workspace.sessions.forEach {
            sessionPageCache.remove(sessionId: $0.id)
        }
        // The server unpins archived work for everyone (`unpinEverywhere`);
        // dropping it locally too keeps the Pinned band from holding a row
        // that just left the list.
        PinStore.shared.unpin(workspace)
        #if os(macOS)
        if workspace.sessions.contains(where: { $0.id == selectedSessionID }) {
            selectedSessionID = nil
        }
        #endif
        if animated {
            // Mac hover button / Delete key / context menu: collapse the row
            // instead of blinking it out.
            withAnimation(.snappy(duration: 0.28)) {
                workspace.sessions.forEach(viewModel.archive)
            }
        } else {
            // Swipe path: the List's destructive-role delete animation owns
            // the removal; wrapping the mutation would fight it.
            workspace.sessions.forEach(viewModel.archive)
        }
    }

    private var sessionCacheScope: SessionViewModelCache.Scope {
        let config = ServerConfig.shared
        return SessionViewModelCache.Scope(
            serverURL: config.baseURLString,
            token: config.token
        )
    }

    /// Rows this person pinned, lifted to the top of the list in their own pin
    /// order. They also stay in their normal band below: pinning is quick
    /// access, not a status — the rule the web sidebar's Pinned band follows.
    /// Built from the filtered rows, so the search field and the repo/people
    /// filters narrow the band like everything else.
    #if os(iOS)
    private var pinnedWorkspaces: [SidebarWorkspace] {
        let store = PinStore.shared
        guard !store.pins.isEmpty else { return [] }
        return filteredWorkspaces
            .filter { !WorkspaceSnoozeStore.shared.isSnoozed($0) }
            .compactMap { workspace in store.rank(workspace).map { (workspace, $0) } }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
    }
    #endif

    /// Recent teammate and automation-owner activity from the complete live
    /// payload. It deliberately ignores repo, person, search, hide and snooze
    /// lenses, matching the independent Team surface on the web.
    private var teamActivityGroups: [TeamActivityGroup] {
        #if DEBUG
        if ProcessInfo.processInfo.environment["OS1_TEAM_ACTIVITY_FIXTURE"] != nil {
            var teammate = Session(id: "team-fixture-person")
            teammate.title = "Review onboarding polish"
            teammate.repo = "opensession"
            teammate.isRunning = true
            teammate.lastActivity = ISO8601DateFormatter().string(from: .now)
            var agent = Session(id: "team-fixture-agent")
            agent.title = "Daily support report"
            agent.repo = "opensession"
            agent.isRunning = true
            agent.lastActivity = teammate.lastActivity
            let current = ServerConfig.shared.userName
            let name = TeamDirectory.shared.names.first {
                !SidebarPersonLens.nameMatches($0, key: current)
            } ?? "Teammate"
            return [
                TeamActivityGroup(
                    key: name.lowercased(), label: name,
                    activeSessions: [teammate], allSessions: [teammate]
                ),
                TeamActivityGroup(
                    key: TeamActivity.agentKey, label: TeamActivity.agentLabel,
                    activeSessions: [agent], allSessions: [agent]
                )
            ]
        }
        #endif
        return TeamActivity.groups(
            sessions: viewModel.sessions,
            members: TeamDirectory.shared.activityMembers,
            currentUser: ServerConfig.shared.userName,
            automationOwners: automationOwners
        )
    }

    @ViewBuilder
    private func teamActivityRow(_ session: Session) -> some View {
        #if os(macOS)
        SessionRow(session: session)
            .tag(session.id)
        #else
        Button { path.append(session) } label: {
            SessionRow(session: session)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        #endif
    }

    private func teamPersonHeader(_ group: TeamActivityGroup) -> some View {
        HStack(spacing: 9) {
            if group.key == TeamActivity.agentKey {
                WebIcon(kind: .robot, size: 20, color: OS1VisualStyle.textDim)
            } else {
                UserAvatar(person: group.label, size: 20)
            }
            Text(group.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
            Text("\(group.activeSessions.count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(OS1VisualStyle.textFaint)
            Spacer(minLength: 0)
        }
        .padding(.top, 4)
        #if os(iOS)
        .listRowInsets(EdgeInsets(
            top: 0, leading: sidebarMargin, bottom: 0, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        #endif
    }

    private var teamActivitySection: some View {
        let groups = teamActivityGroups
        let count = groups.reduce(0) { $0 + $1.activeSessions.count }
        return Section {
            ForEach(groups) { group in
                teamPersonHeader(group)
                ForEach(group.activeSessions) { session in
                    teamActivityRow(session)
                }
            }
        } header: {
            groupHeader(title: "Team", count: count, collapseKey: "team")
        }
    }

    private var listSections: some View {
        Group {
            #if os(iOS)
            // Where you can go, above the work: the way the web sidebar has
            // carried its tools since the band lost its heading. A destination
            // you reach by scrolling past every workspace you have is a
            // destination nobody reaches. Who is around rides the Feed row's
            // right edge, where the desktop sidebar puts it.
            mobileToolsBand
            if !pinnedWorkspaces.isEmpty {
                Section {
                    ForEach(
                        visibleWorkspaces(pinnedWorkspaces, collapsedKey: "pinned"),
                        id: \.id
                    ) { workspace in
                        sessionRow(workspace)
                    }
                } header: {
                    groupHeader(
                        title: "Pinned",
                        count: pinnedWorkspaces.count,
                        collapseKey: "pinned"
                    )
                }
            }
            #endif

            if groupsByProject {
                ForEach(repoSessionGroups) { repoGroup in
                    let bandKey = repoBandKey(repoGroup.repo)
                    Section {
                        if !isCollapsed(bandKey) {
                            ForEach(repoGroup.sections) { group in
                                statusLaneHeader(group)
                                ForEach(
                                    visibleWorkspaces(
                                        group.workspaces,
                                        collapsedKey: group.id
                                    )
                                ) { workspace in
                                    sessionRow(workspace)
                                }
                            }
                        }
                    } header: {
                        groupHeader(
                            title: repoGroup.repo,
                            count: repoGroup.workspaces.count,
                            repo: repoGroup.repo,
                            collapseKey: bandKey
                        )
                    }
                }
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(
                            visibleWorkspaces(group.workspaces, collapsedKey: group.id)
                        ) { workspace in
                            sessionRow(workspace)
                        }
                    } header: {
                        if !group.title.isEmpty {
                            groupHeader(
                                title: group.title,
                                count: group.workspaces.count,
                                repo: group.repo,
                                collapseKey: group.id
                            )
                        }
                    }
                }
            }

            let teamGroups = teamActivityGroups
            if !teamGroups.isEmpty && !isCollapsed("team") {
                teamActivitySection
            } else if !teamGroups.isEmpty {
                Section {
                    EmptyView()
                } header: {
                    groupHeader(
                        title: "Team",
                        count: teamGroups.reduce(0) { $0 + $1.activeSessions.count },
                        collapseKey: "team"
                    )
                }
            }

            let archivedMatches = archivedSearchResults
            if !archivedMatches.isEmpty {
                Section {
                    ForEach(archivedMatches) { session in
                        archivedSearchRow(session)
                    }
                } header: {
                    Text("Archived matches")
                }
            }

            let autoCreatedHeld = filterOutcome.autoCreatedHeld
            if autoCreatedHeld > 0 { autoCreatedSwitch(held: autoCreatedHeld) }

            // The tools moved to the top of the list on the phone (see
            // `mobileToolsBand`). The Mac keeps the Plain feed row down here,
            // where a window with room to spare can carry it at the foot of
            // the workspaces it belongs beside.
            #if os(macOS)
            if supportLocation.showsSidebar { plainSidebarRow }
            #endif

            // The archived entry is a destination, not a proof that its index
            // has loaded. Keep it reachable even for an empty or failed fetch.
            if viewModel.hasLoaded {
                Section {
                    Button {
                        showArchived = true
                    } label: {
                        HStack(spacing: 9) {
                            #if os(iOS)
                            Image(systemName: "archivebox")
                                .font(.callout)
                                .foregroundStyle(OS1VisualStyle.textDim)
                                .frame(width: 22, height: 22)
                                // Centred on the repo tiles above it, not
                                // flush with their left edge: the glyph's ink
                                // is narrower than a tile's 22, so sharing a
                                // left edge would leave it looking shifted.
                                // Its own box lands 1pt shy of their centre
                                // line, hence the nudge. An offset, not
                                // padding: the label keeps the 47pt column
                                // the row titles use.
                                .offset(x: 1)
                            #else
                            Image(systemName: "archivebox")
                                .font(.body)
                                .foregroundStyle(OS1VisualStyle.textDim)
                                .frame(width: 16, height: 16)
                            #endif
                            Text("Archived")
                                #if os(iOS)
                                // Same type as a repo band: it's a row that
                                // leads somewhere, not a caption.
                                .font(.callout.weight(.medium))
                                #else
                                .font(.body)
                                #endif
                                .foregroundStyle(OS1VisualStyle.textDim)
                            Spacer()
                            Text("\(viewModel.archivedSessions.count)")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.textFaint)
                                // Same trailing column as a row's run clock:
                                // the shared 16pt margin, no extra inset.
                        }
                        #if os(iOS)
                        // Same reason as SessionRow's 13: no 44pt floor now.
                        .padding(.vertical, 11)
                        #else
                        .padding(.vertical, 3)
                        #endif
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    #if os(iOS)
                    // The shared margin, like every other row in this list —
                    // the archive glyph lands on the same column as the repo
                    // tiles and band headings above it.
                    .listRowInsets(EdgeInsets(
                        top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
                    ))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    #endif
                }
            }

        }
    }

    /// The agent's own workspaces, switched from the foot of the list it is
    /// adding to or taking from: after the rows it counts, where the list runs
    /// out and you would wonder what is missing. It says which way it goes, so
    /// it is always its own undo. Faint, because it is a note about the list
    /// rather than a row in it.
    ///
    /// It does not say "automations". An automation is a job somebody
    /// configured, with a name and a trigger; these are one-off workspaces an
    /// agent opened for itself with no automation behind them.
    private func autoCreatedSwitch(held: Int) -> some View {
        #if os(iOS)
        let glyph: CGFloat = 22
        #else
        let glyph: CGFloat = 16
        #endif
        return Section {
            Button {
                withAnimation(.snappy(duration: 0.25)) { showAutoCreated.toggle() }
            } label: {
                HStack(spacing: 9) {
                    WebIcon(kind: .robot, size: glyph, color: OS1VisualStyle.textFaint)
                    Text(
                        showAutoCreated
                            ? "Hide \(held) started by an agent"
                            : "Show \(held) started by an agent"
                    )
                    #if os(iOS)
                    .font(.callout.weight(.medium))
                    #else
                    .font(.body)
                    #endif
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            #if os(iOS)
            .listRowInsets(EdgeInsets(
                top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
            ))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            #endif
        }
    }

    @ViewBuilder
    private var emptyFilterOverlay: some View {
        if !showsTeamActivityFixture
            && !hasVisibleWorkspaces
            && repoBandRepos.isEmpty
            && viewModel.archivedSessions.isEmpty {
            if !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if person == SidebarPersonLens.me {
                // Same look as the other two states on this screen: three
                // different placeholder styles on one list is what makes a
                // surface read as unfinished.
                ListPlaceholder(
                    symbol: "person.crop.circle",
                    title: "No sessions of yours yet",
                    message: "Sessions you start appear here."
                ) {
                    Button("New session") {
                        newSessionRequest = NewSessionRequest()
                    }
                    .buttonStyle(PlaceholderActionStyle())
                    Button("Show everyone's") {
                        peopleFilterRaw = SidebarPersonLens.everyone
                    }
                    .buttonStyle(PlaceholderActionStyle(prominent: false))
                }
            }
        }
    }

    /// Plain is a project feed on the web, so it sits after the worktree/session
    /// sections and before Archived in the same ordinary row shape.
    private var plainSidebarRow: some View {
        Section {
            Button(action: openSupport) {
                HStack(spacing: 9) {
                    #if os(iOS)
                    mobileToolIcon("lifepreserver")
                    #else
                    RepoTile(name: "plain", size: plainRowTileSize)
                    #endif
                    Text("Plain")
                        #if os(iOS)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        #else
                        .font(.body)
                        #endif
                    Text("\(supportQueue.threads.count)")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textFaint)
                    Spacer()
                    if urgentPlainTicketCount > 0 {
                        Text("\(urgentPlainTicketCount)")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.redInk)
                    }
                }
                .padding(.vertical, plainRowVerticalPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                urgentPlainTicketCount > 0
                    ? "Open Plain, \(supportQueue.threads.count) tickets, \(urgentPlainTicketCount) urgent"
                    : "Open Plain, \(supportQueue.threads.count) tickets"
            )
            // The long press the web sidebar answers with a right-click on the
            // same band. One item, like that menu: this row leads somewhere
            // rather than holding state, so there is nothing else to offer.
            // Not destructive-styled — the queue keeps running for everyone
            // else, and Settings → Appearance brings the row back.
            .contextMenu {
                Button {
                    withAnimation(.snappy(duration: 0.28)) {
                        SupportLocation.set(.off)
                    }
                } label: {
                    Label("Hide from sidebar", systemImage: "eye.slash")
                }
            }
        }
        #if os(iOS)
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        #endif
    }

    private var plainRowTileSize: CGFloat {
        #if os(iOS)
        22
        #else
        16
        #endif
    }

    private var plainRowVerticalPadding: CGFloat {
        #if os(iOS)
        11
        #else
        3
        #endif
    }

    #if os(iOS)
    /// Tool glyphs start on the same leading edge as the repo tiles below.
    /// Their 22-point rail still keeps every label on one shared column.
    private func mobileToolIcon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.callout)
            .foregroundStyle(OS1VisualStyle.textDim)
            .frame(width: 22, height: 22, alignment: .leading)
    }

    /// Support as a tool: the direct queue page, separate from the Plain feed
    /// row above. `supportLocation` makes the two mutually exclusive.
    private var mobileSupportToolRow: some View {
        Section {
            Button(action: openSupport) {
                HStack(spacing: 9) {
                    mobileToolIcon("lifepreserver")
                    Text("Support")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                    Text("\(supportQueue.threads.count)")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textFaint)
                    Spacer()
                    if urgentPlainTicketCount > 0 {
                        Text("\(urgentPlainTicketCount)")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.redInk)
                    }
                }
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                urgentPlainTicketCount > 0
                    ? "Open Support, \(supportQueue.threads.count) tickets, \(urgentPlainTicketCount) urgent"
                    : "Open Support, \(supportQueue.threads.count) tickets"
            )
            .contextMenu {
                Button {
                    withAnimation(.snappy(duration: 0.28)) {
                        SupportLocation.set(.off)
                    }
                } label: {
                    Label("Hide from sidebar", systemImage: "eye.slash")
                }
            }
        }
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// Reports is a sidebar tool on the web, so on a phone it is a row in the
    /// same ordinary shape as Plain, next to it, rather than another glyph in
    /// a toolbar that already holds three.
    private var mobileReportsRow: some View {
        Section {
            Button {
                showReports = true
            } label: {
                HStack(spacing: 9) {
                    mobileToolIcon("text.document")
                    Text("Reports")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                    Text(verbatim: "\(reportGroupCount)")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.textFaint)
                    Spacer()
                }
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                reportGroupCount == 1
                    ? "Open Reports, 1 automation"
                    : "Open Reports, \(reportGroupCount) automations"
            )
            // Same one-item menu as the Plain row above, for the same reason:
            // the row leads somewhere rather than holding state, and Settings
            // → Appearance brings it back.
            .contextMenu {
                Button {
                    withAnimation(.snappy(duration: 0.28)) {
                        SidebarTools.setVisible(SidebarTools.reports, false)
                    }
                } label: {
                    Label("Hide from sidebar", systemImage: "eye.slash")
                }
            }
        }
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// The tools, above the work rather than under it.
    ///
    /// Same set and same order as the web's strip, and the same rule for what
    /// shows: each row is one account-level preference away, and Support is
    /// the three-way location choice rather than a switch.
    @ViewBuilder
    private var mobileToolsBand: some View {
        // None of the tools belong to the person whose list you are borrowing:
        // Tasks and Catch up are yours, and Feed, Plain and Reports are the
        // whole team's. Under a bar with someone else's name on it they read as
        // theirs, so a borrowed list is their workspaces and the bar out.
        if SidebarPersonLens.isBorrowed(person) {
            borrowedLensBar
        } else {
            if !isFeedHidden { mobileFeedRow }
            if !isTasksHidden { mobileTasksRow }
            if supportLocation.showsSidebar { plainSidebarRow }
            if supportLocation.showsPage { mobileSupportToolRow }
            if !isReportsHidden && reportGroupCount > 0 { mobileReportsRow }
        }
    }

    /// Whose list this is, when it is not yours.
    ///
    /// The same bar the web sidebar puts at the top of a borrowed lens
    /// (`borrowedLens` in components/Sidebar.tsx): a filled row that names the
    /// person and carries the one action that belongs to it, which is leaving.
    /// Without it the phone showed a teammate's workspaces with nothing saying
    /// so, and the way back was buried in the filter panel.
    private var borrowedLensBar: some View {
        Section {
            HStack(spacing: 8) {
                if person == SidebarPersonLens.everyone {
                    Image(systemName: "person.2")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 22, height: 22)
                } else if person != SidebarPersonLens.unassigned {
                    UserAvatar(person: borrowedLensName, size: 22)
                }
                Text(borrowedLensName)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    Haptics.play(.selection)
                    withAnimation(.snappy(duration: 0.22)) {
                        peopleFilterRaw = SidebarPersonLens.me
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to your workspaces")
                // The 34pt target overhangs the glyph, so pull it back out to
                // the margin the way the repo bands' "+" does.
                .padding(.trailing, -8)
            }
            .padding(.leading, 12)
            .padding(.trailing, 10)
            .padding(.vertical, 7)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(OS1VisualStyle.blueSoft)
            }
            .accessibilityElement(children: .contain)
        }
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 6, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// What the bar calls the lens. Everyone reads as itself rather than as
    /// "All workspaces", since the bar already says these are workspaces.
    private var borrowedLensName: String {
        SidebarPersonLens.label(
            for: person,
            agentName: InstanceIdentity.shared.personaName,
            roster: TeamDirectory.shared.names
        )
    }

    /// What the team shipped. Merged pull requests and commits in one list,
    /// which is what makes it the page you open when you have not decided
    /// what to work on yet.
    private var mobileFeedRow: some View {
        toolRow(
            title: "Feed",
            symbol: "waveform.path.ecg",
            count: nil,
            accessibility: "Open Feed",
            hides: SidebarTools.feed,
            // The team rides this row's right edge, the way it does in the
            // desktop sidebar: whose work you are reading is a question about
            // the feed, so it is answered on the row that leads to it rather
            // than in a strip of its own above the list.
            trailing: {
                TeamLensPile(
                    person: personSelection,
                    currentUser: ServerConfig.shared.userName
                )
            }
        ) {
            showFeed = true
        }
    }

    /// Your list, and the one any session can add to.
    private var mobileTasksRow: some View {
        toolRow(
            title: "Tasks",
            symbol: "checklist",
            count: openTaskCount > 0 ? openTaskCount : nil,
            accessibility: openTaskCount == 1
                ? "Open Tasks, 1 open"
                : "Open Tasks, \(openTaskCount) open",
            hides: SidebarTools.tasks,
            trailing: { EmptyView() }
        ) {
            showTasks = true
        }
    }

    /// The shape every tool row shares: glyph, name, an optional number, and
    /// the one-item menu that puts it away. Built once rather than per row so
    /// the tools cannot drift apart from each other the way they would if each
    /// carried its own copy of this.
    private func toolRow<Trailing: View>(
        title: String,
        symbol: String,
        count: Int?,
        accessibility: String,
        hides id: String,
        @ViewBuilder trailing: () -> Trailing,
        open: @escaping () -> Void
    ) -> some View {
        Section {
            // The trailing view is a SIBLING of the button, not a child of it:
            // a button nested inside another swallows its taps on iOS, and the
            // point of the pile on the Feed row is that it is its own target.
            HStack(spacing: 0) {
                Button(action: open) {
                    HStack(spacing: 9) {
                        mobileToolIcon(symbol)
                        Text(title)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                        if let count {
                            Text(verbatim: "\(count)")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(accessibility)
                trailing()
            }
            // The same one-item menu the Plain and Reports rows carry, for the
            // same reason: the row leads somewhere rather than holding state,
            // and Settings → Appearance brings it back.
            .contextMenu {
                Button {
                    withAnimation(.snappy(duration: 0.28)) {
                        SidebarTools.setVisible(id, false)
                    }
                } label: {
                    Label("Hide from sidebar", systemImage: "eye.slash")
                }
            }
        }
        .listRowInsets(EdgeInsets(
            top: 2, leading: sidebarMargin, bottom: 2, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// Push a session one of the tool screens named, now that the screen it
    /// was named on has gone.
    private func consumePendingToolSessionOpen() {
        guard let id = pendingToolSessionOpen else { return }
        pendingToolSessionOpen = nil
        Task {
            guard let session = try? await OS1API.session(id: id) else { return }
            path.append(session)
        }
    }

    private func requestToolSessionOpen(_ id: String) {
        pendingToolSessionOpen = id
        showFeed = false
        showTasks = false
    }

    private func refreshOpenTaskCount() async {
        guard let todos = try? await OS1API.todos() else { return }
        openTaskCount = todos.lazy.filter { $0.status == .open }.count
    }

    private var isFeedHidden: Bool {
        SidebarTools.isHidden(SidebarTools.feed, in: hiddenToolsRaw)
    }

    private var isTasksHidden: Bool {
        SidebarTools.isHidden(SidebarTools.tasks, in: hiddenToolsRaw)
    }

    /// Read off `@AppStorage` rather than `UserDefaults` so hiding the row
    /// redraws the list — the same value either way.
    private var isReportsHidden: Bool {
        SidebarTools.isHidden(SidebarTools.reports, in: hiddenToolsRaw)
    }

    private var isCatchUpHidden: Bool {
        SidebarTools.isHidden(SidebarTools.catchUp, in: hiddenToolsRaw)
    }
    #endif

    private var supportLocation: SupportLocation {
        SupportLocation.current(hiddenTools: hiddenToolsRaw, hiddenFeeds: hiddenFeedsRaw)
    }

    private var urgentPlainTicketCount: Int {
        supportQueue.threads.lazy.filter { $0.lane == .urgent }.count
    }

    private func openSupport() {
        openTicket = nil
        showSupport = true
        #if os(macOS)
        openedArchivedSession = nil
        #endif
    }

    /// Counted off the memoized grouping, one predicate per row — see
    /// `CatchUpQueue.unreadRowCount` for why it must not group again here.
    /// Reading `ReadsStore` inside this view is deliberate too: it is
    /// `@Observable`, so a mark landing invalidates the band rather than
    /// everything that could have read it.
    private var catchUpCount: Int {
        let reads = ReadsStore.shared
        guard reads.hasHydrated else { return 0 }
        let config = ServerConfig.shared
        return CatchUpQueue.unreadRowCount(
            in: viewModel.sidebarWorkspaces,
            viewerName: config.userName,
            viewerLogin: config.githubLogin,
            isUnread: { reads.isUnread($0) }
        )
    }

    private func groupHeader(
        title: String,
        count: Int,
        repo: String? = nil,
        collapseKey: String
    ) -> some View {
        HStack(spacing: 6) {
            // Only the naming half of the heading toggles the fold — the
            // repo's "+" stays its own target, and a Button nested inside
            // another swallows its taps on iOS.
            Button {
                toggleCollapsed(collapseKey)
            } label: {
                HStack(spacing: 6) {
                    if let repo {
                        #if os(iOS)
                        RepoTile(name: repo, size: 22)
                        #else
                        RepoTile(name: repo)
                        #endif
                    }
                    Text(repo.map { RepoTile.label(for: $0) } ?? title)
                        #if os(iOS)
                        // A repo band leads somewhere, so it's typed like the
                        // rows under it (web phone: 16px medium), not like the
                        // captions that only label them.
                        .font(.callout.weight(.medium))
                        #else
                        .font(.caption.weight(.semibold))
                        #endif
                    Text("\(count)")
                        #if os(iOS)
                        .font(.footnote.weight(.medium))
                        #else
                        .font(.caption.monospacedDigit())
                        #endif
                    collapseChevron(collapseKey)
                    // Without a trailing "+" to push against, stretch the
                    // heading so the whole line takes the tap.
                    if repo == nil {
                        Spacer(minLength: 0)
                    }
                }
                .foregroundStyle(OS1VisualStyle.textDim)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(collapseLabel(repo.map { RepoTile.label(for: $0) } ?? title, collapseKey))
            if let repo {
                Spacer(minLength: 8)
                Button {
                    newSessionRequest = NewSessionRequest(repo: repo)
                } label: {
                    Image(systemName: "plus")
                        #if os(iOS)
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 30, height: 30)
                        #else
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 20, height: 20)
                        #endif
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .buttonStyle(.borderless)
                #if os(iOS)
                // The 30pt tap target is ~7.5pt wider than the glyph on each
                // side, so leaving it inside the shared margin parked the
                // "+"'s ink well short of it while the repo tile opposite it
                // sits flush — the whole line read as lopsided. Pull the frame
                // out by that overhang so the INK lands on the margin, the
                // same column the row titles below truncate at.
                .padding(.trailing, -7.5)
                #endif
                .accessibilityLabel("New session in \(RepoTile.label(for: repo))")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textCase(nil)
        .padding(.top, 4)
        #if os(iOS)
        // A section header takes the list's own 16pt inset rather than a row's
        // insets, so it needs the difference added by hand to sit on the same
        // column as the rows under it.
        .padding(.horizontal, sidebarMargin - 16)
        // Lopsided on purpose, like the lane headings below it: a band leads
        // the rows under it, so it sits nearer to them than to whatever came
        // before. The list's own header inset is what's being trimmed, hence
        // the negative value.
        .padding(.bottom, -3)
        #endif
    }

    /// A lane heading labels the rows under it, so its own insets are
    /// lopsided on purpose: air above to separate it from the previous lane,
    /// less below so the label reads as attached to its rows. The pair is
    /// measured off the web sidebar at phone width, where the same caption
    /// sits 19pt below the previous lane's last row and 9pt above its own
    /// first one (`.sidebar-lane-group` header: 8px group margin + 9/5px
    /// padding); the rows' own 2pt insets make up the rest. Those insets only
    /// bite because the list drops its 44pt minimum row height (see `list`) —
    /// that floor stretched the caption to a full row and left the label
    /// marooned in the middle of it.
    private func statusLaneHeader(_ group: SessionGroup) -> some View {
        Button {
            toggleCollapsed(group.id)
        } label: {
            HStack(spacing: 5) {
                // Captions, a size below the rows — the web's
                // `.sidebar-lane-group` pair at its phone step (13px semibold
                // label, 12px count).
                Text(group.title)
                    .font(.footnote.weight(.semibold))
                Text("\(group.workspaces.count)")
                    .font(.caption.monospacedDigit())
                collapseChevron(group.id)
            }
            .foregroundStyle(OS1VisualStyle.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(collapseLabel(group.title, group.id))
        .listRowInsets(EdgeInsets(
            top: 17, leading: sidebarMargin, bottom: 7, trailing: sidebarMargin
        ))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// The fold marker: points down when the section is open, right when it's
    /// shut — same language as the web sidebar's group chevron.
    ///
    /// On iOS an open section wears no marker at all. The rows under a repo
    /// already say it's open, so the only thing worth marking is the state
    /// you can't see: a shut band gets the chevron, and the heading beside it
    /// stays a plain name rather than a permanently decorated one.
    @ViewBuilder
    private func collapseChevron(_ key: String) -> some View {
        #if os(iOS)
        if isCollapsed(key) {
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .transition(.opacity)
        }
        #else
        Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(OS1VisualStyle.textFaint)
            .rotationEffect(.degrees(isCollapsed(key) ? -90 : 0))
        #endif
    }

    private func collapseLabel(_ title: String, _ key: String) -> String {
        isCollapsed(key) ? "\(title), collapsed" : "\(title), expanded"
    }

    /// An empty list is a fresh install far more often than it is a quiet
    /// day, so it says where you have landed as well as what to do next —
    /// see `FirstRunPlaceholder`, which is the same placeholder plus the
    /// three facts the phone's modal sign-in never gets to state.
    private var emptyState: some View {
        FirstRunPlaceholder(
            onNewSession: { newSessionRequest = NewSessionRequest() },
            onShowArchived: { showArchived = true }
        )
    }

    /// The list is empty because nothing came back, which is a different
    /// screen from an empty list: "No sessions" reads as a server with
    /// nothing on it, when the truth is a dropped tailnet or a dead signal
    /// and the fix is nowhere near Settings. So the failure gets the
    /// headline, the server we couldn't reach gets named, and the first
    /// button is the one that answers a connection problem.
    private func unreachableState(_ failure: Reachability.Diagnosis) -> some View {
        ListPlaceholder(
            symbol: failure.isConnection
                ? "wifi.exclamationmark"
                : "exclamationmark.triangle",
            title: failure.title,
            message: failureMessage(failure)
        ) {
            // One button, the one the diagnosis asks for. A wrong address
            // doesn't heal by being retried, and a timeout isn't fixed in
            // Settings — offering both would just make you pick.
            switch failure.remedy {
            case .retry:
                // The poll keeps trying underneath either way; this is for
                // the person who just turned the VPN back on and doesn't
                // want to wonder whether the app noticed.
                Button(action: retryLoad) {
                    if isRetrying {
                        // Same footprint as the label it replaces, so the
                        // capsule doesn't resize when the retry starts.
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Try again")
                    }
                }
                .buttonStyle(PlaceholderActionStyle())
                .disabled(isRetrying)
            case .settings:
                settingsButton
            }
            Button("Archived") { showArchived = true }
                .buttonStyle(PlaceholderActionStyle(prominent: false))
        }
    }

    /// The one line under the headline: the fix when the diagnosis knows one,
    /// otherwise the server that stayed silent — naming it is what tells you
    /// whether the app is pointed where you think it is. The system's own
    /// wording is the last resort, for failures that aren't about the
    /// network at all.
    private func failureMessage(_ failure: Reachability.Diagnosis) -> String {
        if let fix = failure.fix { return fix }
        guard failure.isConnection,
              let host = ServerConfig.shared.baseURL?.host(), !host.isEmpty
        else { return failure.detail }
        return "\(host) didn't answer."
    }

    /// Only shown where Settings is the actual fix — a server that can't be
    /// found, a token that isn't accepted — so it wears the full weight.
    @ViewBuilder
    private var settingsButton: some View {
        #if os(macOS)
        SettingsLink { Text("Open Settings") }
            .buttonStyle(PlaceholderActionStyle())
        #else
        Button("Open Settings") { showSettings = true }
            .buttonStyle(PlaceholderActionStyle())
        #endif
    }

    private func retryLoad() {
        guard !isRetrying else { return }
        isRetrying = true
        Task {
            await viewModel.refresh()
            isRetrying = false
        }
    }
}

private struct ArchivedSessionsView: View {
    let sessions: [Session]
    /// Whether the archived index has arrived. Archived rows travel on their
    /// own request, so this screen has a wait of its own now — and "Nothing
    /// archived" would be a claim about a list that hasn't answered yet.
    let loaded: Bool
    let onOpen: (Session) -> Void
    let onRestore: (Session) -> Void
    let loadFailure: String?
    let onRetry: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    /// "mine", "everyone", or one teammate's canonical key — see
    /// `ArchivedOwners`.
    @State private var owner = ArchivedOwners.mine
    @State private var repo = "all"
    @State private var reason = "all"
    /// The team roster, read in `body` so the owner options appear when it
    /// lands — it can arrive after this screen is already open.
    private var roster: [String: String] { TeamDirectory.shared.displayNames }

    /// The signed-in person's own key, so their archive stays "My archived"
    /// rather than appearing a second time as a teammate.
    private var meKey: String {
        let user = ServerConfig.shared.userName
        return (ArchivedOwners.canonical(user, in: roster) ?? user).lowercased()
    }

    private var owners: [ArchivedOwners.Owner] {
        ArchivedOwners.options(in: sessions, roster: roster, excluding: meKey)
    }

    private var repositories: [String] {
        Array(Set(sessions.map(\.effectiveRepo))).sorted()
    }

    private var hasAutoArchived: Bool {
        sessions.contains(where: isAutoArchived)
    }

    private var activeFilterCount: Int {
        (owner == ArchivedOwners.everyone ? 0 : 1)
            + (repo == "all" ? 0 : 1) + (reason == "all" ? 0 : 1)
    }

    private var filteredSessions: [Session] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let lens = PeopleLens.current()
        return sessions.filter { session in
            switch owner {
            case ArchivedOwners.everyone: break
            case ArchivedOwners.mine: if !lens.isMine(session) { return false }
            default:
                if !ArchivedOwners.session(session, hasOwner: owner, roster: roster) {
                    return false
                }
            }
            if repo != "all", session.effectiveRepo != repo { return false }
            if reason == "auto", !isAutoArchived(session) { return false }
            if reason == "manual", isAutoArchived(session) { return false }
            guard !query.isEmpty else { return true }
            let terms = [session.displayTitle, session.effectiveRepo]
                + [session.branch, session.startedBy].compactMap { $0 }
            return terms
                .map { $0.lowercased() }
                .contains { $0.contains(query) }
        }
    }

    private func isAutoArchived(_ session: Session) -> Bool {
        guard let archivedReason = session.archivedReason else { return false }
        return archivedReason != "manual"
    }

    private func metadata(for session: Session) -> String {
        var parts = [RepoTile.label(for: session.effectiveRepo)]
        // Only under "Everyone": with one person picked, their name on every
        // row is the one thing the list already told you.
        if owner == ArchivedOwners.everyone, let startedBy = session.startedBy {
            parts.append(startedBy)
        }
        if reason == "all", isAutoArchived(session) { parts.append("Auto-archived") }
        if let date = session.lastActivityDate {
            parts.append(date.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        NavigationStack {
            List {
                if let loadFailure {
                    ContentUnavailableView {
                        Label("Couldn't load archived sessions", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(loadFailure)
                    } actions: {
                        Button("Try again", action: onRetry)
                    }
                    .listRowSeparator(.hidden)
                } else if sessions.isEmpty, !loaded {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading archived sessions…")
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
                    .listRowSeparator(.hidden)
                } else if filteredSessions.isEmpty {
                    ContentUnavailableView(
                        sessions.isEmpty ? "Nothing archived" : "No matches",
                        systemImage: sessions.isEmpty ? "archivebox" : "magnifyingglass"
                    )
                } else {
                    Section {
                        ForEach(filteredSessions) { session in
                            HStack(spacing: 10) {
                                RepoTile(name: session.effectiveRepo, size: 24)
                                #if os(iOS)
                                Button {
                                    onOpen(session)
                                } label: {
                                    archivedRowLabel(session)
                                }
                                .buttonStyle(.plain)
                                #else
                                archivedRowLabel(session)
                                #endif
                                Button {
                                    onRestore(session)
                                } label: {
                                    Image(systemName: "tray.and.arrow.up")
                                        .font(.body)
                                        .frame(width: 44, height: 44)
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Restore session")
                            }
                            .padding(.vertical, 2)
                        }
                    } header: {
                        Text(filteredSessions.count == sessions.count
                             ? "\(sessions.count) archived"
                             : "\(filteredSessions.count) of \(sessions.count) archived")
                    }
                }
            }
            #if os(iOS)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            #endif
            .searchable(text: $searchText, prompt: "Search archived")
            .task { await TeamDirectory.shared.ensureLoaded() }
            .navigationTitle("Archived")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Section("Owner") {
                            Picker("Owner", selection: $owner) {
                                Text("My archived").tag(ArchivedOwners.mine)
                                Text("Everyone").tag(ArchivedOwners.everyone)
                                // Teammates who have archived something here,
                                // busiest first. Absent on an instance of one.
                                ForEach(owners) { person in
                                    Text(person.label).tag(person.key)
                                }
                            }
                        }
                        if repositories.count > 1 {
                            Section("Repository") {
                                Picker("Repository", selection: $repo) {
                                    Text("All repos").tag("all")
                                    ForEach(repositories, id: \.self) { repository in
                                        Text(RepoTile.label(for: repository)).tag(repository)
                                    }
                                }
                            }
                        }
                        if hasAutoArchived {
                            Section("Reason") {
                                Picker("Reason", selection: $reason) {
                                    Text("All").tag("all")
                                    Text("Auto-archived").tag("auto")
                                    Text("Manual").tag("manual")
                                }
                            }
                        }
                        if activeFilterCount > 0 {
                            Button("Clear filters") {
                                owner = ArchivedOwners.everyone
                                repo = "all"
                                reason = "all"
                            }
                        }
                    } label: {
                        Label(
                            activeFilterCount > 0 ? "Filters (\(activeFilterCount))" : "Filters",
                            systemImage: activeFilterCount > 0
                                ? "line.3.horizontal.decrease.circle.fill"
                                : "line.3.horizontal.decrease.circle"
                        )
                    }
                    .accessibilityLabel("Filters, \(activeFilterCount) active")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func archivedRowLabel(_ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(session.displayTitle)
                .font(.body.weight(.medium))
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(2)
            Text(metadata(for: session))
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension Session.Lane {
    /// Dot colors matching the web sidebar's lane dots.
    var color: Color {
        switch self {
        case .needsInput: OS1VisualStyle.blue
        case .inProgress: OS1VisualStyle.yellow
        case .inReview: OS1VisualStyle.green
        case .done: OS1VisualStyle.purple
        case .backlog: OS1VisualStyle.textFaint.opacity(0.7)
        }
    }
}

#if os(iOS)
/// The first load, shaped like what it is loading: a band heading and a run of
/// rows at the list's own metrics, so the screen the data lands in is already
/// standing when it arrives. A centred spinner says only "wait"; this says
/// where.
private struct SessionsSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    /// Ragged on purpose — a column of equal bars reads as a component, not as
    /// titles about to arrive.
    private let widths: [CGFloat] = [188, 132, 214, 160, 108, 196, 144, 176]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule()
                .fill(OS1VisualStyle.hover)
                .frame(width: 84, height: 11)
                .padding(.vertical, 9)
            ForEach(Array(widths.enumerated()), id: \.offset) { _, width in
                HStack(spacing: 9) {
                    Circle()
                        .fill(OS1VisualStyle.hover)
                        .frame(width: 7, height: 7)
                        .frame(width: 22, height: 22)
                    Capsule()
                        .fill(OS1VisualStyle.hover)
                        .frame(width: width, height: 13)
                }
                .padding(.vertical, 13)
            }
        }
        .padding(.horizontal, sidebarMargin)
        .padding(.top, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // One breath across the whole block, not a travelling sheen: the rows
        // are the message, and a shimmer would draw the eye along them.
        .opacity(dim ? 0.5 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                dim = true
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading sessions")
    }
}
#endif

struct SessionRow: View {
    let session: Session
    var title: String? = nil
    /// Every session the row stands for. Unread emphasis is per ROW, like the web
    /// sidebar's `.sidebar-item-unread`: one session with activity past your read
    /// mark bolds the whole workspace. Empty falls back to `session` alone.
    var sessions: [Session] = []
    /// Set in Inbox mode, where the flat list has no repo band above the row:
    /// the row wears its repo's tile in front of the title. The tile can carry
    /// that on its own now that a repo without an icon gets a color of its own
    /// rather than its org's mark — spelling the name out instead cost either
    /// the title's width or a second line, and both read worse than a swatch.
    var repo: String? = nil
    /// A row an agent minted for itself through the automation machine
    /// identity, rather than one a person started. It wears the same robot an
    /// automation run does: sitting in the ordinary bands next to work a
    /// person started, that is the question the row still raises.
    var autoCreated = false
    /// Conversation context for a transcript-only search hit. Metadata matches
    /// keep their normal one-line row because the title already explains why
    /// they are present.
    var searchSnippet: String? = nil
    /// Mac: whether the native sidebar selection surface is under this row.
    var selected = false
    /// iOS: the session you last had open. A neutral plate rather than a hue —
    /// every colour on this list already means something (the status marks and
    /// repo tiles), and "where you were" is chrome, not status. `tertiary`
    /// rather than the `hover` fill: it has to be legible at a glance while
    /// scrolling past, which the faintest step is not.
    var highlighted: Bool = false
    /// A parked workspace prompt has no session yet. It reuses the row's
    /// layout, but its pencil is the state mark rather than a session status.
    var isWorkspaceDraft = false
    /// Active snooze value: an ISO wake time or Someday.
    var snoozeValue: String? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Settings → Appearance → Show last used time. Off by default, like the
    /// web's resting sidebar, and per device like the web's own copy of it.
    @AppStorage("os1.list.lastUsed") private var lastUsedPref = "off"
    /// Mac: the hover-revealed Pin, Snooze, Archive cluster.
    var pinned = false
    var onTogglePin: (() -> Void)? = nil
    var onToggleSnooze: (() -> Void)? = nil
    var onArchive: (() -> Void)? = nil

    #if os(macOS)
    @State private var hovering = false
    #endif

    var body: some View {
        #if os(macOS)
        content
            .overlay(alignment: .trailing) {
                if hovering,
                   onTogglePin != nil || onToggleSnooze != nil || onArchive != nil {
                    HStack(spacing: 2) {
                        if let onTogglePin {
                            filingButton(
                                pinned ? "pin.slash" : "pin",
                                help: pinned ? "Unpin" : "Pin",
                                action: onTogglePin
                            )
                        }
                        if let onToggleSnooze {
                            filingButton(
                                snoozeValue != nil ? "moon.fill" : "moon",
                                help: snoozeValue != nil ? "Unsnooze" : "Snooze until Someday",
                                action: onToggleSnooze
                            )
                        }
                        if let onArchive {
                            filingButton("archivebox", help: "Archive", action: onArchive)
                        }
                    }
                    // Keep the actions legible over a long title.
                    .padding(2)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 5))
                }
            }
            // onHover must wrap the overlay, not sit under it: with the button
            // on top of the hover target, reaching it ended the content's
            // hover, which unmounted the button under the cursor (flicker).
            .onHover { hovering = $0 }
        #else
        content
        #endif
    }

    private var isHovering: Bool {
        #if os(macOS)
        hovering
        #else
        false
        #endif
    }

    #if os(macOS)
    private func filingButton(
        _ systemName: String,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.borderless)
        .help(help)
    }
    #endif

    /// Mac sidebar rows are compact and body-sized like Finder/System
    /// Settings; iOS keeps the roomier touch metrics.
    private var content: some View {
        HStack(spacing: 9) {
            statusMark
                .frame(width: markSize, height: markSize)
            if let repo {
                RepoTile(name: repo, size: tileSize)
            }
            // Origin reads on the left, beside the status mark and the repo
            // tile: this row is a machine's run, not yours. Faint and a step
            // under the tile so a band of automation rows stays a list rather
            // than a wall of glyphs.
            if session.wasAgentStarted || autoCreated {
                WebIcon(kind: .robot, size: tileSize, color: OS1VisualStyle.textFaint)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(rowTitle)
                    #if os(iOS)
                    // The web sidebar's phone type, exactly: 16px titles (callout)
                    // in medium, dimmed. Unread rows step up in both weight and ink.
                    .font(.callout.weight(unread ? .semibold : .medium))
                    .foregroundStyle(unread ? OS1VisualStyle.text : OS1VisualStyle.textDim)
                    #else
                    .font(.body.weight(unread ? .semibold : .regular))
                    .foregroundStyle(.primary)
                    #endif
                    .lineLimit(1)
                if safety != nil {
                    Text("Paused for safety")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.yellow)
                        .lineLimit(1)
                } else if let searchSnippet, !searchSnippet.isEmpty {
                    Text(searchSnippet)
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if hasDraft && !isWorkspaceDraft {
                Image(systemName: "pencil")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .accessibilityLabel("Unsent draft")
            }
            if let mention {
                UserAvatar(person: mention.by, size: faceSize)
                    .overlay(alignment: .bottomTrailing) {
                        Text("@")
                            .font(.system(size: faceSize * 0.42, weight: .bold))
                            .foregroundStyle(OS1VisualStyle.onAccent)
                            .frame(width: faceSize * 0.6, height: faceSize * 0.6)
                            .background(OS1VisualStyle.accent, in: Circle())
                            .background(
                                OS1VisualStyle.chatCanvas,
                                in: Circle().inset(by: -1.5)
                            )
                            .offset(x: faceSize * 0.1, y: faceSize * 0.1)
                    }
                    .accessibilityLabel("\(mention.by) mentioned you")
            }
            // Whose review request this is. Badged, because the presence faces
            // immediately after it are the same size and shape, and "someone is
            // in here" and "someone is waiting on you" must not look alike.
            if let reviewAskerName {
                UserAvatar(person: reviewAskerName, size: faceSize)
                    .overlay(alignment: .bottomTrailing) {
                        // Sized and placed to sit ON the face's corner rather
                        // than beside it: a badge that clears the avatar reads
                        // as a second, smaller face at this size, and the row
                        // has no width to spare for one.
                        Image(systemName: "eye.fill")
                            .font(.system(size: faceSize * 0.26, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(faceSize * 0.07)
                            .background(OS1VisualStyle.blue, in: Circle())
                            .background(
                                OS1VisualStyle.chatCanvas,
                                in: Circle().inset(by: -1.5)
                            )
                            .offset(x: faceSize * 0.08, y: faceSize * 0.08)
                    }
                    .accessibilityLabel(
                        "Review requested on \(reviewAskerName)'s pull request"
                    )
            }
            // Teammates focused on any session represented by this row.
            if !rowViewers.isEmpty {
                PresenceFacepile(
                    viewers: rowViewers,
                    size: faceSize,
                    separation: .ring,
                    separatorColor: PresenceRowSurface.color(
                        selected: selected || highlighted,
                        hovered: isHovering
                    )
                )
            }
            if let snoozeValue {
                HStack(spacing: 3) {
                    Image(systemName: "moon.fill")
                    Text(WorkspaceSnooze.label(snoozeValue))
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel("Snoozed: \(WorkspaceSnooze.label(snoozeValue))")
            } else if showsClock {
                WorkspaceRunElapsedLabel(since: session.runStartedDate)
                    // No trailing pad: the repo header's "+" now hangs its tap
                    // target past the row margin so its INK sits on 16pt, and
                    // this clock's digits end on that same column on their own.
            } else if let idleAgo {
                // The same trailing slot the clock owns, so a row never shifts
                // when a run starts — it swaps grey for the running yellow.
                Text(idleAgo)
                    #if os(iOS)
                    .font(.caption.weight(.medium).monospacedDigit())
                    #else
                    .font(.caption.monospacedDigit())
                    #endif
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        #if os(iOS)
        // 13, not 11: the list no longer imposes a 44pt minimum row height,
        // so the row's own padding is what keeps its touch target.
        .padding(.vertical, 13)
        // Bleeds into the list's own 16pt margin so the plate reads as the
        // row rather than as a box drawn around its contents.
        .padding(.horizontal, 10)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemFill).opacity(highlighted ? 1 : 0))
        }
        .padding(.horizontal, -10)
        .animation(.easeOut(duration: 0.2), value: highlighted)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rowTitle)
        .accessibilityValue(accessibilityStatus)
        #if os(macOS)
        .help(rowTitle)
        #endif
    }

    /// Read here rather than at the call site on purpose: `ReadsStore` is
    /// `@Observable`, so a mark landing invalidates the rows that read it
    /// instead of the whole list body.
    private var unread: Bool {
        if isWorkspaceDraft { return false }
        return ReadsStore.shared.isUnread(sessions.isEmpty ? [session] : sessions)
    }

    private var hasDraft: Bool {
        DraftsStore.shared.hasDraft(sessions.isEmpty ? [session] : sessions)
    }

    /// The newest tag on any session behind this workspace row. Read here so
    /// MentionStore observation invalidates the row without rebuilding every
    /// unrelated row in the list.
    private var mention: MentionRecord? {
        MentionStore.shared.mention(for: rowSessions)
    }

    /// Read here rather than at the call site because `PresenceStore` is
    /// `@Observable`: a global-presence frame invalidates only rows using it.
    private var rowViewers: [String] {
        if isWorkspaceDraft { return [] }
        #if DEBUG
        if ProcessInfo.processInfo.environment["OS1_PRESENCE_FIXTURE"] == "1" {
            return ["Kent de Bruin", "Michael Robot", "Sarah Chen"]
        }
        #endif
        return PresenceStore.shared.viewers(of: sessions.isEmpty ? [session] : sessions)
    }

    private var markSize: CGFloat {
        #if os(iOS)
        22
        #else
        14
        #endif
    }

    /// A step under the repo tile: a face on a row is "who else is here", not
    /// something to read the row by.
    private var faceSize: CGFloat {
        #if os(iOS)
        20
        #else
        15
        #endif
    }

    /// The repo tile sits a step under the status mark beside it, so it reads
    /// as the row's label rather than a second status.
    private var tileSize: CGFloat {
        #if os(iOS)
        18
        #else
        13
        #endif
    }

    private var showsClock: Bool {
        session.lane == .inProgress && showsElapsedTime
    }

    /// How long ago this row last did anything, when the setting asks for it.
    ///
    /// Deliberately no `TimelineView`: the run clock ticks because seconds are
    /// what it counts, but "3h" changes hourly — the list's own 5s poll
    /// re-renders often enough, and a ticker on every idle row would be pure
    /// waste. Integer math on a date the row has already parsed, so no
    /// formatter is allocated here either.
    private var idleAgo: String? {
        guard lastUsedPref == "always", showsElapsedTime else { return nil }
        let rows = sessions.isEmpty ? [session] : sessions
        guard let latest = rows.compactMap(\.lastActivityDate).max() else { return nil }
        return Self.compactAgo(Date().timeIntervalSince(latest))
    }

    static func compactAgo(_ elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed))
        if total < 60 { return "now" }
        if total < 3_600 { return "\(total / 60)m" }
        if total < 86_400 { return "\(total / 3_600)h" }
        if total < 604_800 { return "\(total / 86_400)d" }
        return "\(total / 604_800)w"
    }

    private var rowTitle: String {
        (title ?? session.displayTitle).replacingOccurrences(
            of: #"^PR\s*#\d+(:|\s*[—–-])\s*"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
    }

    private var showsElapsedTime: Bool {
        #if os(iOS)
        !dynamicTypeSize.isAccessibilitySize
        #else
        true
        #endif
    }

    @ViewBuilder
    private var statusMark: some View {
        if isWorkspaceDraft {
            Image(systemName: "pencil")
                .font(.system(size: markSize * 0.62, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
        } else if safety != nil {
            Image(systemName: "exclamationmark.shield.fill")
                .font(.system(size: markSize * 0.72, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.yellow)
        } else if session.lane == .needsInput {
            PulsingDot(color: OS1VisualStyle.blue, active: animatesStatus)
        } else if reviewWaitsOnMe {
            // Blocked on you, like an unanswered question, so it takes the same
            // blue mark rather than a colour of its own. It outranks the PR's
            // own state below: that a review is yours to give is what decides
            // whether you open the row, and the state is a long-press away.
            PulsingDot(color: OS1VisualStyle.blue, active: animatesStatus)
        } else if session.lane == .inProgress {
            PulsingDot(color: OS1VisualStyle.yellow, active: animatesStatus)
        } else if session.prState == "MERGED" {
            WebIcon(kind: .gitMerge, size: markSize, color: OS1VisualStyle.purple)
        } else if session.prState == "OPEN" {
            WebIcon(kind: .pullRequest, size: markSize, color: OS1VisualStyle.green)
        } else if session.prState == "CLOSED" {
            WebIcon(kind: .pullRequest, size: markSize, color: OS1VisualStyle.red)
        } else {
            PulsingDot(color: OS1VisualStyle.textFaint, active: false)
        }
    }

    private var animatesStatus: Bool {
        #if os(iOS)
        true
        #else
        false
        #endif
    }

    /// The sessions this row stands for — a workspace row speaks for all of
    /// them, and a request on any of their pull requests is a request on the
    /// row.
    private var rowSessions: [Session] {
        sessions.isEmpty ? [session] : sessions
    }

    private var safety: SessionSafetyState? {
        rowSessions.compactMap(\.safety).first
    }

    private var reviewWaitsOnMe: Bool {
        ReviewRequests.waitsOnViewer(
            rowSessions,
            viewerName: ServerConfig.shared.userName,
            viewerLogin: ServerConfig.shared.githubLogin
        )
    }

    /// Whose pull request is waiting, in the roster's spelling of their name
    /// where it knows one, otherwise the GitHub login the wire carried.
    private var reviewAskerName: String? {
        guard
            let login = ReviewRequests.askerLogin(
                rowSessions,
                viewerName: ServerConfig.shared.userName,
                viewerLogin: ServerConfig.shared.githubLogin
            )
        else { return nil }
        return TeamDirectory.shared.displayName(forGithubLogin: login) ?? login
    }

    private var accessibilityStatus: String {
        if isWorkspaceDraft {
            return "Draft, \(RepoTile.label(for: session.effectiveRepo))"
        }
        var parts = [
            safety == nil ? session.lane.label : "Paused for safety",
            RepoTile.label(for: session.effectiveRepo)
        ]
        // The robot is the only sighted cue that a machine owns this row.
        if session.isAutomation { parts.append("automation") }
        // The bold title is the only sighted cue for unread; say it out loud.
        if unread { parts.insert("unread", at: 0) }
        if let mention { parts.insert("\(mention.by) mentioned you", at: 0) }
        // Same for the plate: colour alone never carries meaning.
        if highlighted { parts.insert("last opened", at: 0) }
        if let prState = session.prState?.lowercased() {
            parts.append("pull request \(prState)")
        }
        // The faces are the only cue that someone else is viewing this row.
        if !rowViewers.isEmpty {
            parts.append(
                "\(ListFormatter.localizedString(byJoining: rowViewers)) viewing"
            )
        }
        if let idleAgo { parts.append("last used \(idleAgo)") }
        return parts.joined(separator: ", ")
    }
}

/// Web workspace rows reserve their trailing slot for a live run clock. An
/// idle row leaves that slot empty unless Appearance → Show last used time
/// asks for it, which is the web's default too.
private struct WorkspaceRunElapsedLabel: View {
    let since: Date?

    var body: some View {
        Group {
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(label(context.date.timeIntervalSince(since)))
                }
            } else {
                Text("Running")
            }
        }
        #if os(iOS)
        // 12px, like the web's `.sidebar-ws-ticker` on a phone.
        .font(.caption.weight(.medium).monospacedDigit())
        #else
        .font(.caption.monospacedDigit())
        #endif
        .foregroundStyle(OS1VisualStyle.yellowInk)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func label(_ elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed))
        if total < 60 { return "\(total)s" }
        if total < 3_600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3_600)h \((total % 3_600) / 60)m"
    }
}

/// Status dot that softly pulses while `active` — mirrors the web's
/// `.pulse-dot` (1.4s opacity cycle).
struct PulsingDot: View {
    let color: Color
    var active: Bool = true
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let dot = Circle()
            .fill(color)
            .frame(width: size, height: size)
        if active && !reduceMotion {
            dot.phaseAnimator([1.0, 0.35]) { view, opacity in
                view.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.7)
            }
        } else {
            dot
        }
    }
}
