import Foundation
import Observation

/// Pure mutation state for established-workspace deletion. Kept separate from
/// draft deletion, whose immediate one-row behavior remains unchanged.
struct WorkspaceDeletionState: Equatable {
    struct Failure: Equatable {
        let workspaceId: String
        let message: String
    }

    private(set) var deletingWorkspaceId: String?
    private(set) var failure: Failure?

    mutating func begin(_ workspaceId: String) {
        deletingWorkspaceId = workspaceId
        failure = nil
    }

    mutating func succeed(_ workspaceId: String) {
        guard deletingWorkspaceId == workspaceId else { return }
        deletingWorkspaceId = nil
        failure = nil
    }

    mutating func fail(_ workspaceId: String, message: String) {
        guard deletingWorkspaceId == workspaceId else { return }
        deletingWorkspaceId = nil
        failure = Failure(workspaceId: workspaceId, message: message)
    }
}

/// One row frame from the server, queued until the next coalesced apply.
enum SessionRowUpdate: Sendable {
    case row(Session)
    case removed(String)

    var id: String {
        switch self {
        case .row(let session): session.id
        case .removed(let id): id
        }
    }
}

/// A row frame the list has applied, and the `sessionsRevision` that carries
/// it. See `SessionsListViewModel.replay(_:after:)`.
struct AppliedRowUpdate: Sendable {
    var revision: Int
    var update: SessionRowUpdate
}

/// What one batch of row frames did to the live list. See
/// `SessionsListViewModel.applyingRowUpdates`.
struct SessionRowUpdateResult: Equatable, Sendable {
    var sessions: [Session]
    var changed: Bool
    /// Pending creates whose server row arrived in this batch.
    var retiredOptimisticIds: [String]
    /// Rows this batch dropped from the live list.
    var removedIds: [String]
    var resurfacedHideKeys: [String]
}

/// Sessions overview. The active account's socket pushes row frames for most
/// metadata changes (`session_row` / `session_row_removed`, applied by
/// `applyingRowUpdates`); `GET /api/sessions` is polled underneath as the
/// fallback that heals a missed frame and covers a server that sends none.
@Observable
@MainActor
final class SessionsListViewModel {
    private(set) var sessions: [Session] = []
    private(set) var archivedSessions: [Session] = []
    private(set) var workspaceNames: [String: String] = [:]
    private(set) var workspaces: [OS1API.WorkspaceSummary] = []
    private(set) var error: String?
    /// Why the list has nothing in it, when the reason is a failed load
    /// rather than a server with nothing on it.
    ///
    /// Kept apart from `error`, which also carries action failures (a rename
    /// that didn't take, an archive that bounced): the empty screen stands in
    /// for the list itself, so it may only speak about loading the list.
    private(set) var loadFailure: Reachability.Diagnosis?
    private(set) var hasLoaded = false
    /// Whether the archived index has come back at least once. Its own flag,
    /// because it arrives on its own request: without it the Archived screen
    /// would say "Nothing archived" for the seconds before the answer lands,
    /// which is a statement about a list still in flight.
    private(set) var archivedHasLoaded = false
    /// Unlike an empty archive, a failed index has something actionable to say.
    /// Kept separate from the live-list failure, whose banner describes a
    /// different request.
    private(set) var archivedLoadFailure: String?
    private(set) var workspaceDeletion = WorkspaceDeletionState()

    private var pollTask: Task<Void, Never>?

    /// The fallback poll's cadence. `OS1_SESSIONS_POLL_SECONDS` lengthens it
    /// for a build under test, so that a change which shows up demonstrably
    /// came over the socket. Nothing is persisted.
    private static let pollInterval: Duration = {
        if let raw = ProcessInfo.processInfo.environment["OS1_SESSIONS_POLL_SECONDS"],
           let seconds = Double(raw), seconds > 0 {
            return .seconds(seconds)
        }
        return .seconds(5)
    }()

    @ObservationIgnored private var rowObserverToken: UUID?
    /// Row frames waiting to be applied, newest per session. The server
    /// coalesces per session; this coalesces across them, so a burst (a bulk
    /// archive, a branch's PR webhook) costs one regroup instead of one each.
    @ObservationIgnored private var pendingRowUpdates: [String: SessionRowUpdate] = [:]
    @ObservationIgnored private var rowFlushTask: Task<Void, Never>?
    /// Row frames applied while a poll was in flight, newest per session,
    /// tagged with the list revision that carries them. A poll's response was
    /// built before those frames, so the poll replays them over it instead
    /// of publishing a row the frame already moved past. Kept only while a
    /// poll is in flight; `refresh` prunes what no in-flight poll predates.
    @ObservationIgnored private var appliedRowUpdates: [String: AppliedRowUpdate] = [:]
    /// `sessionsRevision` at the start of each `refresh` still in flight.
    @ObservationIgnored private var inFlightRefreshRevisions: [Int] = []
    /// Polls are ordered by when their request went out. One that finishes
    /// after a later-started poll already published is discarded: its rows
    /// are older than the list.
    @ObservationIgnored private var refreshSequence = 0
    @ObservationIgnored private var publishedRefreshSequence = 0

    /// The server's archived index, kept apart from `archivedSessions` so the
    /// local overlay (a row archived on this device, one restored a moment
    /// ago) can be re-applied without a refetch.
    @ObservationIgnored private var serverArchived: [Session] = []
    @ObservationIgnored private var archivedFetchedAt: Date?
    @ObservationIgnored private var archivedFetchInFlight = false
    @ObservationIgnored private var liveActivityConnection: OS1API.LiveActivityConnection?

    /// Memoized sidebar rows for the current list — see `sidebarRows`.
    ///
    /// Observation-ignored on purpose: `sidebarWorkspaces` fills it from its
    /// own getter, and an observed write during a view body evaluation would
    /// invalidate the view that is being evaluated.
    @ObservationIgnored private var sidebarRowsCache: [SidebarWorkspace]?

    /// Sessions this user has claimed, as of the last refresh — one of the two
    /// things that earns a spawned worker a row (`Session.belongsInList`).
    /// Snapshotted rather than read live so the grouping can run off the main
    /// actor with the same answer the publish decided on.
    @ObservationIgnored private var claimedSessionIds: Set<String> = []

    /// Bumped by every mutation of the grouping's inputs, so a detached prime
    /// can tell whether the list moved under it without an O(n) comparison.
    @ObservationIgnored private var sessionsRevision = 0

    /// The sidebar's rows: workspace groups, memoized.
    ///
    /// The grouping walks every session — dictionary builds, worktree path
    /// parsing, a sort per row — and the list view reads it several times per
    /// body evaluation. A `sample` of a cold launch (5.5k rows) had the main
    /// thread inside this call for ~70% of the trace, which is why the app
    /// took minutes to become usable. `refresh` primes the cache off the main
    /// actor, so in the steady state a read here costs nothing.
    var sidebarWorkspaces: [SidebarWorkspace] {
        // Read the inputs even on a cache hit: that is what registers the
        // reading view's observation dependency. Without it, a cached read
        // would silently stop re-rendering when the list changes.
        let sessions = self.sessions
        let names = workspaceNames
        let workspaces = self.workspaces
        let claimed = claimedSessionIds
        if let cached = sidebarRowsCache { return cached }
        let rows = Self.sidebarRows(
            in: Self.listedSessions(in: sessions, claimed: claimed),
            workspaceNames: names,
            workspaces: workspaces,
            occupiedWorkspaceIds: Set(sessions.compactMap(\.workspaceId))
        )
        sidebarRowsCache = rows
        return rows
    }

    /// The one way to replace the list — keeps the grouping cache honest.
    ///
    /// `rows` is the grouping for `next` when the caller already has it;
    /// passing nil leaves the next read to group lazily. Publishing both in
    /// one step matters: assigning `sessions` alone wakes every observing
    /// view immediately, and a body that runs before the grouping lands is
    /// exactly the main-thread pass this cache exists to avoid.
    private func setSessions(_ next: [Session], rows: [SidebarWorkspace]? = nil) {
        sessions = next
        sidebarRowsCache = rows
        sessionsRevision += 1
        #if os(iOS)
        LiveActivityCoordinator.shared.sync(next)
        #endif
    }

    /// Cached rows with one session spliced in as a row of its own, or nil when
    /// the insert can't be proven row-local — the caller then invalidates and
    /// the next read regroups.
    ///
    /// The local mutations below (create, resolve, restore) publish straight
    /// into a body evaluation, and a body that finds the cache empty regroups
    /// thousands of rows on the main actor: the pass `refresh` goes out of its
    /// way to keep off-main. Creating a session did exactly that at the moment
    /// the new conversation was being pushed, which is why the list sat there
    /// for seconds before the session appeared.
    private func rowsInserting(
        _ session: Session, into rows: [SidebarWorkspace]
    ) -> [SidebarWorkspace]? {
        // A parked draft row is the one workspace row the Mac list carries.
        // Starting it replaces that placeholder on either platform.
        if let workspaceId = session.workspaceId, !workspaceId.isEmpty,
           let index = rows.firstIndex(where: {
               $0.workspaceId == workspaceId && $0.isDraftWorkspace
           }),
           let row = Self.sidebarRows(
               in: [session], workspaceNames: workspaceNames
           ).first {
            var next = rows
            next[index] = row
            return next
        }
        #if !os(macOS)
        // A session started inside a workspace joins that workspace's row rather
        // than opening one of its own: rebuild the one row from its sessions plus
        // this one, and move it to the front — where a full regroup puts it,
        // since the new session leads the list that pass walks.
        if let workspaceId = session.workspaceId, !workspaceId.isEmpty {
            guard let index = rows.firstIndex(where: { $0.workspaceId == workspaceId })
            else { return nil }
            let merged = Self.sidebarRows(
                in: [session] + rows[index].sessions, workspaceNames: workspaceNames
            )
            guard merged.count == 1 else { return nil }
            var next = rows
            next.remove(at: index)
            return merged + next
        }
        #endif
        guard ownsItsRow(session),
              let row = Self.sidebarRows(in: [session], workspaceNames: workspaceNames).first,
              !rows.contains(where: { $0.id == row.id })
        else { return nil }
        return [row] + rows
    }

    /// Cached rows with one session dropped, regrouping just the row that held
    /// it. Nil when that regroup doesn't reproduce the same single row, i.e.
    /// the removal moved the grouping and only a full pass can say how.
    private func rowsRemoving(
        sessionId id: String, from rows: [SidebarWorkspace]
    ) -> [SidebarWorkspace]? {
        guard let index = rows.firstIndex(where: { $0.sessions.contains { $0.id == id } })
        else { return rows }
        var next = rows
        let remaining = rows[index].sessions.filter { $0.id != id }
        if remaining.isEmpty {
            next.remove(at: index)
            return next
        }
        let regrouped = Self.sidebarRows(in: remaining, workspaceNames: workspaceNames)
        guard regrouped.count == 1, regrouped[0].id == rows[index].id else { return nil }
        next[index] = regrouped[0]
        return next
    }

    /// A session no existing row can absorb and that absorbs none: no workspace,
    /// no isolated worktree. (Every Mac row is a single session, so there the
    /// question doesn't arise.)
    private func ownsItsRow(_ session: Session) -> Bool {
        #if os(macOS)
        return true
        #else
        return session.workspaceId?.isEmpty != false
            && Self.isolatedWorktree(for: session) == nil
        #endif
    }

    /// Group a list off the main actor, ready to publish with it. The session
    /// titles that label `bks-…` links in transcripts are built in the same
    /// detached pass — it walks every row already, and doing it on the main
    /// actor would put another thousands-of-rows loop in the 5s poll.
    private static func groupedOffMain(
        _ sessions: [Session],
        workspaceNames names: [String: String],
        workspaces: [OS1API.WorkspaceSummary],
        claimed: Set<String>
    ) async -> Grouped {
        await Task.detached(priority: .userInitiated) {
            grouped(sessions, workspaceNames: names, workspaces: workspaces, claimed: claimed)
        }.value
    }

    private typealias Grouped = (rows: [SidebarWorkspace], titles: [String: String], prs: PrLinks.Index)

    /// The synchronous half of `groupedOffMain`, for a caller that is already
    /// off the main actor (the row-frame apply).
    nonisolated private static func grouped(
        _ sessions: [Session],
        workspaceNames names: [String: String],
        workspaces: [OS1API.WorkspaceSummary],
        claimed: Set<String>
    ) -> Grouped {
        var titles: [String: String] = [:]
        titles.reserveCapacity(sessions.count)
        for session in sessions {
            // The WORKSPACE's name, not the session's own. A reference is
            // read as "that piece of work", and the screen it opens is
            // titled after the workspace, so labelling the chip after one
            // of its conversations promised a name the destination never
            // shows. That name is often a per-run label ("Review · PR
            // #5741 …"). The web labels its chips from the same rule
            // (`setSessionTitles` in App.tsx). Session title is the
            // fallback, for a workspace this client has no name for.
            let workspace = session.workspaceName ?? ""
            let title = workspace.isEmpty ? session.displayTitle : workspace
            if !title.isEmpty {
                titles[session.id] = title
                for aliasId in session.aliasIds ?? [] { titles[aliasId] = title }
            }
        }
        return (
            sidebarRows(
                in: listedSessions(in: sessions, claimed: claimed),
                workspaceNames: names,
                workspaces: workspaces,
                occupiedWorkspaceIds: Set(sessions.compactMap(\.workspaceId))
            ),
            titles,
            // What tints a `#5528` chip in a transcript, and what tells a
            // bare one which repo it belongs to — the same fields the web
            // hands `setKnownPrStates`, off the main actor for the same
            // reason the titles are. Built from every session, including
            // the spawned workers the rows leave out: a chip in a
            // transcript still has to resolve.
            PrLinks.Index.build(sessions)
        )
    }

    /// Honor the web sidebar's shared order, then append newly seen repositories
    /// by frequency with a stable alphabetical tie-breaker.
    nonisolated static func repositoryOrder(
        in sessions: [Session],
        workspaceRepos: [String] = [],
        preferredOrderJSON: String = "[]"
    ) -> [String] {
        var counts: [String: Int] = [:]
        for session in sessions where session.archived != true {
            counts[session.effectiveRepo, default: 0] += 1
        }
        for repo in workspaceRepos where !repo.isEmpty {
            counts[repo, default: 0] += 1
        }
        let discovered = counts.keys.sorted {
            let left = counts[$0, default: 0]
            let right = counts[$1, default: 0]
            return left != right ? left > right : $0.localizedStandardCompare($1) == .orderedAscending
        }
        let preferred = (try? JSONDecoder().decode(
            [String].self,
            from: Data(preferredOrderJSON.utf8)
        )) ?? []
        var seen = Set<String>()
        let ordered = preferred.filter { counts[$0] != nil && seen.insert($0).inserted }
        return ordered + discovered.filter { seen.insert($0).inserted }
    }

    /// Live sibling sessions shown in the conversation tab strip. This mirrors
    /// the web client: workspace membership wins, with isolated worktrees as
    /// the fallback for legacy rows, and the natural order is oldest first.
    /// Worker sessions are drill-ins reached from their parent's More menu,
    /// never tabs of their own. Opening one directly therefore produces a
    /// one-session view with no strip.
    nonisolated static func tabSessions(
        in sessions: [Session], containing current: Session
    ) -> [Session] {
        // NavigationPath retains the row snapshot that was originally pushed.
        // Prefer the latest polled copy so a newly filed optimistic session
        // joins its workspace without requiring the conversation to reopen.
        let current = sessions.first { $0.id == current.id } ?? current
        if current.parentSessionId?.isEmpty == false { return [current] }
        guard hasWorkspaceGroup(current) else {
            return [current]
        }
        var tabs = sessions.filter {
            inWorkspaceGroup($0, containing: current)
                && $0.parentSessionId?.isEmpty != false
                && ($0.archived != true || $0.id == current.id)
        }
        if !tabs.contains(where: { $0.id == current.id }) {
            tabs.append(current)
        }
        tabs.sort {
            let left = $0.createdAt ?? ""
            let right = $1.createdAt ?? ""
            return left == right ? $0.id < $1.id : left < right
        }
        let main = mainSession(in: tabs)
        guard let main else { return [] }
        return [main] + tabs.filter { $0.id != main.id }
    }

    /// Direct, live workers delegated by one session, in the order they were
    /// created. The web header derives its worker menu from this same parent
    /// relationship rather than workspace membership because a worker may use
    /// a temporary workspace of its own.
    nonisolated static func workerSessions(
        in sessions: [Session], parentId: String
    ) -> [Session] {
        sessions
            .filter { $0.parentSessionId == parentId && $0.archived != true }
            .sorted {
                let left = $0.createdAt ?? ""
                let right = $1.createdAt ?? ""
                return left == right ? $0.id < $1.id : left < right
            }
    }

    /// Closed siblings shown by a workspace's history menu.
    ///
    /// This mirrors the protocol's shared rule: a matching workspace id OR the
    /// same isolated worktree. The second half joins older duplicate workspace
    /// records without grouping unrelated sessions in a shared checkout.
    ///
    /// `known` wins over `fetched`: it contains the local close/restore that may
    /// not have reached the scoped archive response yet. A known live row also
    /// suppresses its stale archived summary.
    nonisolated static func workspaceArchivedSessions(
        known: [Session],
        fetched: [Session],
        containing current: Session
    ) -> [Session] {
        let current = known.last { $0.id == current.id } ?? current
        guard hasWorkspaceGroup(current) else { return [] }

        var knownById: [String: Session] = [:]
        for session in known { knownById[session.id] = session }
        var rows = knownById.values.filter {
            $0.archived == true
                && $0.id != current.id
                && inWorkspaceGroup($0, containing: current)
        }
        for session in fetched where knownById[session.id] == nil {
            if session.id != current.id,
               inWorkspaceGroup(session, containing: current) {
                rows.append(session)
            }
        }
        return byRecency(rows)
    }

    /// Which surface carries a workspace's closed sessions.
    ///
    /// The tab strip carries them while it is on screen. A workspace down to
    /// one conversation draws no strip, since a bar holding a single tab only
    /// repeats what the header already says, so its history moves to the
    /// session's overflow menu: reopening one is an action, and that menu is
    /// where this workspace's other actions already live. Exactly one surface
    /// holds the list, so the two can never both offer it.
    nonisolated static func historyPlacement(
        liveTabs: Int, archived: Int
    ) -> SessionHistoryPlacement {
        guard archived > 0 else { return .none }
        return liveTabs > 1 ? .tabStrip : .actionsMenu
    }

    /// The session that takes over the strip when `closed` is closed from it: the
    /// tab to its right, or the one to its left when it was the rightmost. Nil
    /// when it was the workspace's last session and there is nothing left to show.
    nonisolated static func tabAfterClosing(
        _ closed: Session, in tabs: [Session]
    ) -> Session? {
        let remaining = tabs.filter { $0.id != closed.id }
        guard !remaining.isEmpty else { return nil }
        let index = tabs.firstIndex { $0.id == closed.id } ?? 0
        return index < remaining.count ? remaining[index] : remaining.last
    }

    /// The sidebar's rows on this platform: workspace groups on iOS, and one
    /// row per session on the Mac, whose detail has no sibling-tab strip yet.
    nonisolated static func sidebarRows(
        in sessions: [Session],
        workspaceNames: [String: String],
        workspaces: [OS1API.WorkspaceSummary] = [],
        occupiedWorkspaceIds: Set<String>? = nil
    ) -> [SidebarWorkspace] {
        #if os(macOS)
        let rows = sessions.map {
            SidebarWorkspace(
                id: "session:\($0.id)",
                title: $0.displayTitle,
                sessions: [$0],
                mainSession: $0
            )
        }
        return rows + draftWorkspaceRows(
            in: workspaces,
            occupiedWorkspaceIds: occupiedWorkspaceIds
                ?? Set(sessions.compactMap(\.workspaceId))
        )
        #else
        return sidebarWorkspaces(
            in: sessions,
            workspaceNames: workspaceNames,
            workspaces: workspaces,
            occupiedWorkspaceIds: occupiedWorkspaceIds
        )
        #endif
    }

    /// The sessions that earn a row, dropping an agent's own spawned workers
    /// until they need a human or someone claims them. Applied where the web
    /// applies it — while BUILDING the rows, not to the list itself, so a
    /// `@session:` link in a transcript still opens the worker it spawned.
    nonisolated static func listedSessions(
        in sessions: [Session], claimed: Set<String>
    ) -> [Session] {
        sessions.filter { $0.belongsInList(claimed: claimed) }
    }

    /// One sidebar row per workspace, with isolated worktrees as the fallback
    /// for legacy workspace-less rows. Such a row adopts the one workspace
    /// already using its worktree, but separate workspaces are never merged
    /// merely because their paths happen to match.
    nonisolated static func sidebarWorkspaces(
        in sessions: [Session],
        workspaceNames: [String: String] = [:],
        workspaces: [OS1API.WorkspaceSummary] = [],
        occupiedWorkspaceIds: Set<String>? = nil
    ) -> [SidebarWorkspace] {
        let workspaceKeyByWorktree = Dictionary(grouping: sessions.filter {
            $0.workspaceId?.isEmpty == false && isolatedWorktree(for: $0) != nil
        }, by: { isolatedWorktree(for: $0)! }).compactMapValues { group in
            let keys = Set(group.compactMap(\.workspaceId))
            return keys.count == 1 ? "workspace:\(keys.first!)" : nil
        }
        var order: [String] = []
        var grouped: [String: [Session]] = [:]
        for session in sessions {
            let key: String
            if session.workspaceId?.isEmpty != false,
               let dir = isolatedWorktree(for: session),
               let groupKey = workspaceKeyByWorktree[dir] {
                key = groupKey
            } else {
                key = workspaceKey(for: session)
            }
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(session)
        }
        let rows: [SidebarWorkspace] = order.compactMap { key in
            guard var rowSessions = grouped[key] else { return nil }
            rowSessions.sort(by: sessionNaturalOrder)
            guard let main = mainSession(in: rowSessions) else { return nil }
            let named = rowSessions.compactMap(\.workspaceId)
                .compactMap { workspaceNames[$0] }.first
                ?? rowSessions.compactMap(\.workspaceName).first
            let renamed = rowSessions.first { $0.titleOverridden == true }
            let worktreeName = main.worktreeDir.flatMap {
                $0.contains("/worktrees/")
                    ? URL(fileURLWithPath: $0).lastPathComponent
                    : nil
            }
            // A real workspace row NEVER falls back to the branch, matching the
            // web sidebar. The names map is fetched separately from the sessions
            // list and is empty until that request lands — or for good, if an
            // app build outlives a rename of the endpoint it reads
            // (`/api/projects` -> `/api/workspaces`, which is exactly how every
            // row came to be titled by its branch). The name each session now
            // carries covers both cases, so a row is titled after its workspace
            // from the first paint rather than after one of its tabs. Falling
            // to the session's own title degrades to something a person wrote;
            // falling to `branch` degrades to machine slugs across the sidebar.
            // Branch/worktree naming stays where it's the only identity there
            // is: the legacy workspace-less isolated-worktree rows.
            let title: String
            if key.hasPrefix("workspace:") {
                title = named ?? renamed?.displayTitle ?? main.displayTitle
            } else {
                title = renamed?.displayTitle ?? main.branch ?? worktreeName
                    ?? main.displayTitle
            }
            return SidebarWorkspace(
                id: key,
                title: title,
                sessions: rowSessions,
                mainSession: main
            )
        }
        return rows + draftWorkspaceRows(
            in: workspaces,
            occupiedWorkspaceIds: occupiedWorkspaceIds
                ?? Set(sessions.compactMap(\.workspaceId))
        )
    }

    /// A parked prompt is the one sessionless workspace that earns a row. A
    /// leftover empty workspace does not: it has nothing a person can resume.
    nonisolated private static func draftWorkspaceRows(
        in workspaces: [OS1API.WorkspaceSummary],
        occupiedWorkspaceIds: Set<String>
    ) -> [SidebarWorkspace] {
        return workspaces.compactMap { workspace in
            guard workspace.draft != nil,
                  !occupiedWorkspaceIds.contains(workspace.id) else { return nil }
            return SidebarWorkspace(
                id: "workspace:\(workspace.id)",
                title: workspace.name,
                sessions: [],
                mainSession: workspace.draftSession,
                workspace: workspace
            )
        }
    }

    /// Workspace rows split into the web sidebar's Inbox bands. The bands are
    /// exclusive, with priority needs-action > live-or-today > yesterday >
    /// earlier, and every band ranks by last activity — deliberately ignoring
    /// the "Created" sort, since an inbox orders by what moved last. Empty
    /// bands are dropped.
    nonisolated static func inboxBands(
        _ workspaces: [SidebarWorkspace],
        mentionedSessionIds: Set<String> = [],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [(band: InboxBand, workspaces: [SidebarWorkspace])] {
        let dayStart = calendar.startOfDay(for: now)
        let yesterdayStart = dayStart.addingTimeInterval(-24 * 60 * 60)
        // Decorated: each row's activity date is derived once (it walks the
        // row's sessions), not once per comparison — this runs on every body
        // evaluation over a list that can be thousands of rows.
        var bucketed: [InboxBand: [(workspace: SidebarWorkspace, date: Date)]] = [:]
        for workspace in workspaces {
            let date = workspace.lastActivityDate
            let band: InboxBand
            if workspace.lane == .needsInput
                || workspace.sessions.contains(where: { mentionedSessionIds.contains($0.id) }) {
                band = .needsAction
            } else if workspace.isRunning || date >= dayStart {
                // A live row is recent whatever its day — work in flight is
                // recent by definition — but ranks by activity like the rest.
                band = .recent
            } else if date >= yesterdayStart {
                band = .yesterday
            } else {
                band = .earlier
            }
            bucketed[band, default: []].append((workspace, date))
        }
        return InboxBand.allCases.compactMap { band in
            guard let rows = bucketed[band] else { return nil }
            return (band, rows.sorted { $0.date > $1.date }.map(\.workspace))
        }
    }

    /// The name of the WORKTREE a conversation sits in — what the session bar
    /// puts where the chat's own title used to be.
    ///
    /// A workspace holds several chats and the strip under the bar already
    /// names each one, so the bar spending itself on the active chat said the
    /// same thing twice and never said where you were. This resolves through
    /// the sidebar's own rule, so a renamed workspace, an unnamed one (its
    /// first conversation's title) and a legacy worktree row (its branch) come
    /// out exactly as they read in the list.
    ///
    /// `tabs` is one worktree's sessions (`tabSessions`). A solo conversation
    /// is its own row, and that row's title falls back to the BRANCH — "main"
    /// for every session in a shared checkout — so there being no worktree
    /// above it, it keeps its own title.
    nonisolated static func worktreeTitle(
        for session: Session,
        in tabs: [Session],
        workspaceNames: [String: String]
    ) -> String {
        let row = sidebarWorkspaces(in: tabs, workspaceNames: workspaceNames)
            .first { $0.sessions.contains { $0.id == session.id } }
        guard let row, !row.id.hasPrefix("session:") else {
            return session.displayTitle
        }
        return row.title
    }

    nonisolated private static func workspaceKey(for session: Session) -> String {
        if let workspaceId = session.workspaceId, !workspaceId.isEmpty {
            return "workspace:\(workspaceId)"
        }
        if let dir = isolatedWorktree(for: session) { return "worktree:\(dir)" }
        return "session:\(session.id)"
    }

    nonisolated private static func isolatedWorktree(for session: Session) -> String? {
        guard let dir = session.worktreeDir,
              dir.contains("/worktrees/") else { return nil }
        return dir
    }

    nonisolated private static func hasWorkspaceGroup(_ session: Session) -> Bool {
        session.workspaceId?.isEmpty == false || isolatedWorktree(for: session) != nil
    }

    nonisolated private static func inWorkspaceGroup(
        _ session: Session, containing current: Session
    ) -> Bool {
        if let workspaceId = current.workspaceId, !workspaceId.isEmpty,
           session.workspaceId == workspaceId {
            return true
        }
        guard let worktree = isolatedWorktree(for: current) else { return false }
        return session.worktreeDir == worktree
    }

    nonisolated private static func sessionNaturalOrder(_ left: Session, _ right: Session) -> Bool {
        let leftDate = left.createdAt ?? ""
        let rightDate = right.createdAt ?? ""
        return leftDate == rightDate ? left.id < right.id : leftDate < rightDate
    }

    nonisolated private static func mainSession(in sessions: [Session]) -> Session? {
        sessions.first { !$0.isAutomation && !$0.neverRan }
            ?? sessions.first { !$0.neverRan }
            ?? sessions.first
    }

    /// Just-created sessions rendered before the server's list includes them.
    /// Dropped once the real row appears (or after a 2-minute safety window).
    private var optimistic: [String: (session: Session, added: Date)] = [:]

    /// Show a locally-built row for a just-created session immediately.
    ///
    /// The pending row is prepended rather than re-merged: `sessions` already
    /// carries any earlier pending rows, and re-merging would see their ids in
    /// the list and retire their overlay entries, dropping them on the next
    /// poll until the server's own rows arrive.
    func addOptimistic(_ session: Session) {
        optimistic[session.id] = (session, Date())
        setSessions(
            [session] + sessions,
            rows: sidebarRowsCache.flatMap { rowsInserting(session, into: $0) }
        )
    }

    /// The background create resolved: move a pending row onto the server's
    /// real id (still in the optimistic overlay until polling returns the
    /// server's own row for it).
    func resolveOptimistic(tempId: String, realId: String) {
        guard let entry = optimistic.removeValue(forKey: tempId) else { return }
        let old = entry.session
        let real = Session.optimistic(
            id: realId,
            title: old.title ?? "",
            repo: old.effectiveRepo,
            repoLess: old.repoLess == true,
            mode: old.mode ?? "code",
            model: old.model,
            effort: old.effort,
            fastMode: old.fastMode ?? false,
            startedBy: old.startedBy ?? "",
            // Keep the workspace: a session created into one stays in its row
            // (and its tab strip) across the create resolving, instead of
            // falling out until the server's own row arrives.
            workspaceId: old.workspaceId
        )
        optimistic[realId] = (real, entry.added)
        setSessions(
            sessions.map { $0.id == tempId ? real : $0 },
            rows: sidebarRowsCache.flatMap { cached in
                rowsRemoving(sessionId: tempId, from: cached)
                    .flatMap { rowsInserting(real, into: $0) }
            }
        )
    }

    /// Roll back a pending row whose create failed.
    func removeOptimistic(_ id: String) {
        let removed = optimistic.removeValue(forKey: id)?.session
        let restoresDraft = removed?.workspaceId.flatMap { workspaceId in
            workspaces.first { $0.id == workspaceId }?.draft
        } != nil
        setSessions(
            sessions.filter { $0.id != id },
            rows: restoresDraft
                ? nil
                : sidebarRowsCache.flatMap { rowsRemoving(sessionId: id, from: $0) }
        )
    }

    /// Sessions archived locally that the server's (2s-cached) list may still
    /// include for a poll or two — suppressed until it catches up, with a
    /// safety expiry so a failed archive doesn't hide the row forever.
    private var locallyArchived: [String: (session: Session, added: Date)] = [:]
    /// Retained after a failed archive so the row can offer the action again
    /// instead of leaving an optimistic removal to read as an empty inbox.
    private(set) var archiveFailure: Session?

    /// Swipe-to-archive: drop the row immediately, tell the server in the
    /// background, and roll back (surfacing the error) if that fails.
    func archive(_ session: Session) {
        archiveFailure = nil
        setSessions(
            sessions.filter { $0.id != session.id },
            rows: sidebarRowsCache.flatMap { rowsRemoving(sessionId: session.id, from: $0) }
        )
        var archived = session
        archived.archived = true
        locallyArchived[session.id] = (archived, Date())
        publishArchived()
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: true)
                // Archived rows travel on their own request now, so the one
                // just archived reaches the Archived screen only when that
                // request is made again — ask straight away instead of
                // leaving the local placeholder to stand in for half a minute.
                await refreshArchived(force: true)
            } catch {
                locallyArchived.removeValue(forKey: session.id)
                publishArchived()
                if !sessions.contains(where: { $0.id == session.id }) {
                    setSessions(
                        [session] + sessions,
                        rows: sidebarRowsCache.flatMap { rowsInserting(session, into: $0) }
                    )
                }
                archiveFailure = session
                self.error = "Couldn't archive: \(error.localizedDescription)"
            }
        }
    }

    func retryArchive() {
        guard let archiveFailure else { return }
        archive(archiveFailure)
    }

    /// Restore from the archived list immediately, then reconcile with the
    /// server. The short-lived suppression avoids a cached archived row
    /// flashing back into the sheet before the PATCH reaches `/api/sessions`.
    func unarchive(_ session: Session) {
        locallyUnarchived[session.id] = Date()
        var restored = session
        restored.archived = false
        publishArchived()
        setSessions(
            [restored] + sessions,
            rows: sidebarRowsCache.flatMap { rowsInserting(restored, into: $0) }
        )
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: false)
                // The restored row is a summary until the live list carries
                // it (and the archived index stops), so ask both rather than
                // leaving a half-populated row in the sidebar until the next
                // poll comes round.
                await refresh()
                await refreshArchived(force: true)
            } catch {
                locallyUnarchived.removeValue(forKey: session.id)
                setSessions(sessions.filter { $0.id != session.id })
                publishArchived()
                self.error = "Couldn't restore: \(error.localizedDescription)"
                await refresh()
            }
        }
    }

    func rename(_ workspace: SidebarWorkspace, to proposedName: String) {
        let name = proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
        if workspace.workspaceId != nil, name.isEmpty { return }

        Task {
            do {
                if let workspaceId = workspace.workspaceId {
                    try await OS1API.renameWorkspace(workspaceId: workspaceId, name: name)
                } else if name.isEmpty {
                    for session in workspace.sessions where session.titleOverridden == true {
                        try await OS1API.renameSession(sessionId: session.id, title: "")
                    }
                } else {
                    let session = workspace.sessions.first { $0.titleOverridden == true }
                        ?? workspace.mainSession
                    try await OS1API.renameSession(
                        sessionId: session.id,
                        title: name
                    )
                }
                await refresh()
            } catch {
                self.error = workspace.workspaceId == nil
                    ? "Couldn't rename session: \(error.localizedDescription)"
                    : "Couldn't rename workspace: \(error.localizedDescription)"
            }
        }
    }

    func deleteDraftWorkspace(_ workspace: SidebarWorkspace) {
        guard workspace.isDraftWorkspace, let workspaceId = workspace.workspaceId else { return }
        Task {
            do {
                try await OS1API.deleteWorkspace(workspaceId: workspaceId)
                await refresh()
            } catch {
                self.error = "Couldn't delete draft: \(error.localizedDescription)"
            }
        }
    }

    /// Permanently delete an established workspace and every session in it.
    /// Confirmation belongs to the view; this method owns in-flight/error
    /// state, calls the API, removes stale local rows, and refreshes metadata.
    func deleteWorkspace(_ workspace: SidebarWorkspace) async -> Bool {
        guard !workspace.isDraftWorkspace,
              let workspaceId = workspace.workspaceId,
              !workspaceId.isEmpty,
              workspaceDeletion.deletingWorkspaceId == nil
        else { return false }

        workspaceDeletion.begin(workspaceId)
        do {
            try await OS1API.deleteWorkspace(workspaceId: workspaceId)
            let deletedIds = Set(workspace.sessions.map(\.id))
            setSessions(sessions.filter { !deletedIds.contains($0.id) })
            workspaces.removeAll { $0.id == workspaceId }
            workspaceNames[workspaceId] = nil
            workspaceDeletion.succeed(workspaceId)
            // Selection can clear as soon as DELETE succeeds; refresh follows
            // independently so a large sessions payload cannot hold the dead
            // workspace open on screen.
            Task { await self.refresh() }
            return true
        } catch {
            let message = "Couldn't delete workspace: \(error.localizedDescription)"
            workspaceDeletion.fail(workspaceId, message: message)
            self.error = message
            return false
        }
    }

    private func isLocallyArchived(_ id: String) -> Bool {
        guard let entry = locallyArchived[id] else { return false }
        if Date().timeIntervalSince(entry.added) > 30 {
            locallyArchived.removeValue(forKey: id)
            return false
        }
        return true
    }

    private var locallyUnarchived: [String: Date] = [:]

    private func isLocallyUnarchived(_ id: String) -> Bool {
        guard let added = locallyUnarchived[id] else { return false }
        if Date().timeIntervalSince(added) > 30 {
            locallyUnarchived.removeValue(forKey: id)
            return false
        }
        return true
    }

    private func mergeOptimistic(into list: [Session]) -> [Session] {
        guard !optimistic.isEmpty else { return list }
        let serverIds = Set(list.map(\.id))
        var extras: [Session] = []
        for (id, entry) in optimistic {
            if serverIds.contains(id) || Date().timeIntervalSince(entry.added) > 120 {
                optimistic.removeValue(forKey: id)
            } else {
                extras.append(entry.session)
            }
        }
        return extras.isEmpty ? list : extras + list
    }

    #if DEBUG
    func prepareTeamActivityFixture() {
        hasLoaded = true
        archivedHasLoaded = true
    }
    #endif

    func startPolling() {
        stopPolling()
        rowObserverToken = PresenceStore.shared.addSessionListObserver { [weak self] event in
            self?.receive(event)
        }
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                // The archived index rides the same loop on its own, slower
                // clock, and detached so the bigger, less urgent half of the
                // list is never in the live one's way. `refreshArchived`
                // throttles itself, so most turns here cost nothing.
                Task { await self.refreshArchived() }
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        if let rowObserverToken {
            PresenceStore.shared.removeSessionListObserver(rowObserverToken)
        }
        rowObserverToken = nil
        rowFlushTask?.cancel()
        rowFlushTask = nil
        pendingRowUpdates.removeAll()
    }

    // MARK: - Row frames

    private func receive(_ event: SessionListEvent) {
        switch event {
        case .row(let row):
            pendingRowUpdates[row.id] = .row(row)
            scheduleRowFlush()
        case .removed(let sessionId):
            pendingRowUpdates[sessionId] = .removed(sessionId)
            scheduleRowFlush()
        case .invalidated, .subscribed:
            // Nothing row-shaped to apply: re-read the list, as the web does
            // on an invalidation and on every reconnect. Before the first
            // list has landed the poll is already asking.
            guard hasLoaded else { return }
            Task { await self.refresh() }
        }
    }

    private func scheduleRowFlush() {
        guard rowFlushTask == nil else { return }
        rowFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self, !Task.isCancelled else { return }
            await self.flushRowUpdates()
            // One flush at a time. Frames that arrived during this one wait
            // for the next, on a list that already carries this one's result.
            self.rowFlushTask = nil
            if !self.pendingRowUpdates.isEmpty { self.scheduleRowFlush() }
        }
    }

    private func flushRowUpdates() async {
        let updates = Array(pendingRowUpdates.values)
        guard !updates.isEmpty else { return }
        pendingRowUpdates.removeAll()
        // No list to merge into yet: a flush would publish a one-row list.
        // Frames that arrived while the first request was out are newer
        // than its response, though, so they go to that request's replay
        // rather than being dropped, or the response would publish a row
        // (an archive made elsewhere, a rename) they already moved past.
        // With no request out, the first poll's answer carries them anyway.
        guard hasLoaded else {
            guard !inFlightRefreshRevisions.isEmpty else { return }
            // Nothing published, but the list's truth moved: the bump is
            // what puts these frames after the request's start revision,
            // and reruns a pass that snapshotted before them.
            sessionsRevision += 1
            recordAppliedRowUpdates(updates)
            return
        }
        // Snapshot the main-actor state, then merge and regroup off it: the
        // list can be thousands of rows and a frame lands mid-typing.
        let connection = OS1API.LiveActivityConnection.current()
        let revision = sessionsRevision
        let current = sessions
        let optimisticIds = Set(optimistic.keys)
        let hiddenIds = Set(Array(locallyArchived.keys).filter { isLocallyArchived($0) })
        let restoredIds = Set(Array(locallyUnarchived.keys).filter { isLocallyUnarchived($0) })
        let hideKeys = Set(HideStore.shared.hides.keys)
        let names = workspaceNames
        let currentWorkspaces = workspaces
        let claimed = claimedSessionIds
        let (applied, grouped) = await Task.detached(priority: .userInitiated) {
            let applied = Self.applyingRowUpdates(
                updates,
                to: current,
                optimisticIds: optimisticIds,
                hiding: hiddenIds,
                restoring: restoredIds,
                hidden: hideKeys
            )
            let grouped: Grouped? = applied.changed
                ? Self.grouped(
                    applied.sessions,
                    workspaceNames: names,
                    workspaces: currentWorkspaces,
                    claimed: claimed
                )
                : nil
            return (applied, grouped)
        }.value
        guard connection == OS1API.LiveActivityConnection.current() else { return }
        // The list moved under the merge (a poll landed, a local archive).
        // That publish is newer for everything but these rows, so replay
        // them onto it rather than publishing this stale base over it.
        guard revision == sessionsRevision else {
            for update in updates where pendingRowUpdates[update.id] == nil {
                pendingRowUpdates[update.id] = update
            }
            return
        }
        guard applied.changed, let grouped else { return }
        for id in applied.retiredOptimisticIds { optimistic.removeValue(forKey: id) }
        HideStore.shared.clear(applied.resurfacedHideKeys)
        SessionLinks.register(titles: grouped.titles)
        PrLinks.register(index: grouped.prs)
        setSessions(applied.sessions, rows: grouped.rows)
        recordAppliedRowUpdates(updates)
        // A row that left the live list usually went to the archive. Let the
        // next archived turn refetch instead of trusting a fresh-looking
        // index for another half minute.
        if !applied.removedIds.isEmpty { archivedFetchedAt = nil }
    }

    /// Keep what a flush applied, at the current revision, for the polls
    /// still in flight to replay over their responses. Nothing is kept when
    /// no poll is out: `refresh` prunes on completion, and there would be
    /// nothing to prune this for.
    private func recordAppliedRowUpdates(_ updates: [SessionRowUpdate]) {
        guard !inFlightRefreshRevisions.isEmpty else { return }
        for update in updates {
            appliedRowUpdates[update.id] = AppliedRowUpdate(
                revision: sessionsRevision, update: update
            )
        }
    }

    /// The side effects of a poll pass, applied only once the pass has been
    /// accepted: the list is still at the revision it snapshotted and no
    /// later poll has published.
    private func accept(
        _ polled: (active: [Session], archived: [Session], resurfacedHideKeys: [String])
    ) {
        // A hidden row comes back while one of its sessions is blocked on a
        // question, and the entry is consumed when it does — so a hide can
        // never swallow work that needs you. Consuming it here (not in the
        // row filter) keeps the mutation out of view body evaluation.
        HideStore.shared.clear(polled.resurfacedHideKeys)
        // Archived rows arrive on their own request, so `polled.archived`
        // is normally empty here. It isn't against a server that predates
        // the `archived=exclude` parameter and answers with the whole list
        // — those rows ARE the index in that case, which is what makes an
        // older server degrade to the old behaviour instead of to an
        // Archived screen that is permanently empty.
        if !polled.archived.isEmpty {
            setServerArchived(polled.archived)
        }
    }

    /// One pass of row frames over the live list, pure so it can run off the
    /// main actor and be tested.
    ///
    /// The frames are server snapshots, so they reconcile the way a poll
    /// does, for those rows only: the same filters as `prepared` (no desk
    /// rows, a row archived on this device stays hidden, one restored here
    /// reads as live), a pending create retires when its own row arrives,
    /// and the result keeps recency order with the remaining pending creates
    /// in front, where the poll's merge leaves them.
    nonisolated static func applyingRowUpdates(
        _ updates: [SessionRowUpdate],
        to sessions: [Session],
        optimisticIds: Set<String>,
        hiding hiddenIds: Set<String>,
        restoring restoredIds: Set<String>,
        hidden hideKeys: Set<String> = []
    ) -> SessionRowUpdateResult {
        var next = sessions
        var changed = false
        var retired: [String] = []
        var removed: [String] = []
        var resurfaced = Set<String>()
        func drop(_ id: String) {
            guard let index = next.firstIndex(where: { $0.id == id }) else { return }
            next.remove(at: index)
            removed.append(id)
            changed = true
        }
        for update in updates {
            switch update {
            case .removed(let id):
                // A pending create is local until the server publishes it,
                // and a row restored here stays until the overlay expires or
                // the server's own row arrives. The poll reconciles both.
                if optimisticIds.contains(id) || restoredIds.contains(id) { continue }
                drop(id)
            case .row(var row):
                if row.desk == true || hiddenIds.contains(row.id) {
                    drop(row.id)
                    continue
                }
                if restoredIds.contains(row.id) { row.archived = false }
                if row.archived == true {
                    drop(row.id)
                    continue
                }
                if optimisticIds.contains(row.id) { retired.append(row.id) }
                if let index = next.firstIndex(where: { $0.id == row.id }) {
                    if next[index] == row { continue }
                    next[index] = row
                } else {
                    next.append(row)
                }
                changed = true
                if !hideKeys.isEmpty, row.lane == .needsInput, !row.isAutomation {
                    for key in SidebarRowKeys.candidateKeys(for: row) where hideKeys.contains(key) {
                        resurfaced.insert(key)
                    }
                }
            }
        }
        guard changed else {
            return SessionRowUpdateResult(
                sessions: sessions,
                changed: false,
                retiredOptimisticIds: [],
                removedIds: [],
                resurfacedHideKeys: []
            )
        }
        let pending = optimisticIds.subtracting(retired)
        let ordered = pending.isEmpty
            ? byRecency(next)
            : next.filter { pending.contains($0.id) }
                + byRecency(next.filter { !pending.contains($0.id) })
        return SessionRowUpdateResult(
            sessions: ordered,
            changed: true,
            retiredOptimisticIds: retired,
            removedIds: removed,
            resurfacedHideKeys: Array(resurfaced)
        )
    }

    /// The frames applied after a list revision, oldest first, so a poll
    /// whose request went out at that revision can replay them over its
    /// response.
    nonisolated static func replay(
        _ applied: [String: AppliedRowUpdate], after revision: Int
    ) -> [SessionRowUpdate] {
        applied.values
            .filter { $0.revision > revision }
            .sorted { $0.revision < $1.revision }
            .map(\.update)
    }

    /// A poll response the way the list will hold it: `prepared`, then the
    /// row frames that landed while the request was out replayed on top.
    /// Pure, so it can run off the main actor and be tested.
    nonisolated static func polled(
        _ all: [Session],
        replaying updates: [SessionRowUpdate],
        optimisticIds: Set<String>,
        hiding hiddenIds: Set<String>,
        restoring restoredIds: Set<String>,
        hidden hideKeys: Set<String> = []
    ) -> (active: [Session], archived: [Session], resurfacedHideKeys: [String]) {
        let prepared = prepared(all, hiding: hiddenIds, restoring: restoredIds, hidden: hideKeys)
        guard !updates.isEmpty else { return prepared }
        let applied = applyingRowUpdates(
            updates,
            to: prepared.active,
            optimisticIds: optimisticIds,
            hiding: hiddenIds,
            restoring: restoredIds,
            hidden: hideKeys
        )
        return (
            applied.sessions,
            prepared.archived,
            resurfacedHideKeys(in: applied.sessions, hidden: hideKeys)
        )
    }

    func refresh() async {
        // A tailnet server with the tunnel down answers nothing at all, and
        // URLSession takes a full minute to admit it. Ask why alongside the
        // first request instead of after its timeout — the banner is up in
        // milliseconds, and a request that lands clears it.
        if !hasLoaded { diagnoseUnreachableServer() }
        let requestConnection = OS1API.LiveActivityConnection.current()
        // Everything the list holds at this revision predates the response;
        // everything published after it (a row frame, a later poll) does not,
        // and the response must not be published over it.
        let startRevision = sessionsRevision
        refreshSequence += 1
        let sequence = refreshSequence
        inFlightRefreshRevisions.append(startRevision)
        defer {
            if let index = inFlightRefreshRevisions.firstIndex(of: startRevision) {
                inFlightRefreshRevisions.remove(at: index)
            }
            let floor = inFlightRefreshRevisions.min() ?? sessionsRevision
            appliedRowUpdates = appliedRowUpdates.filter { $0.value.revision > floor }
        }
        do {
            async let workspaceRequest = try? OS1API.workspaces()
            let all = try await OS1API.sessions()
            // A server or account can change while this request is in flight.
            // Never publish the old account's rows into its replacement.
            guard requestConnection == OS1API.LiveActivityConnection.current() else { return }
            let connectionChanged = requestConnection != liveActivityConnection
            // Workspace metadata is held back rather than published on arrival:
            // names feed every row's title, and draft-only workspaces create
            // rows of their own. Publish both with an already-built grouping.
            var renamed: [String: String]?
            var refreshedWorkspaces: [OS1API.WorkspaceSummary]?
            let fetchedWorkspaces = await workspaceRequest
            if let fetched = fetchedWorkspaces {
                let nextNames = Dictionary(uniqueKeysWithValues: fetched.map { ($0.id, $0.name) })
                if nextNames != workspaceNames { renamed = nextNames }
                if fetched != workspaces { refreshedWorkspaces = fetched }
            }
            // A failed metadata request on a newly selected connection must
            // clear the previous account's resumable prompt text.
            if connectionChanged, fetchedWorkspaces == nil {
                refreshedWorkspaces = []
                renamed = [:]
            }
            // The detached passes below run against a snapshot of the list.
            // A row flush that publishes while they run makes the snapshot
            // stale, so they rerun over the moved list, with that flush's
            // frames in the replay. Once a list is on screen, two reruns
            // cover any realistic burst and one that will not hold still is
            // left to the next poll. Before the first list there is nothing
            // to leave it to: giving up would mark the load done with an
            // empty screen and prune the frames it needed, so the first
            // response reruns until it lands.
            var next: [Session] = []
            var claimsChanged = false
            var reruns = 0
            while true {
                let snapshotRevision = sessionsRevision
                let replay = Self.replay(appliedRowUpdates, after: startRevision)
                // Snapshot the main-actor state the filter needs, then do the
                // heavy pass (thousands of rows) off the main thread — inline it
                // ran on the main actor every 5s poll and hitched typing.
                let optimisticIds = Set(optimistic.keys)
                let hiddenIds = Set(Array(locallyArchived.keys).filter { isLocallyArchived($0) })
                let restoredIds = Set(Array(locallyUnarchived.keys).filter { isLocallyUnarchived($0) })
                let hideKeys = Set(HideStore.shared.hides.keys)
                // Claims decide which spawned workers earn a row, and they land on
                // their own clock (`LaneStore.hydrate`) — so a set that moved has
                // to republish the grouping even when the list itself didn't.
                let claimed = LaneStore.shared.claims
                if claimed != claimedSessionIds {
                    claimsChanged = true
                    claimedSessionIds = claimed
                }
                let polled = await Task.detached(priority: .userInitiated) {
                    Self.polled(
                        all,
                        replaying: replay,
                        optimisticIds: optimisticIds,
                        hiding: hiddenIds,
                        restoring: restoredIds,
                        hidden: hideKeys
                    )
                }.value
                // Nothing this pass produced is applied until the list is
                // known to still be the one it snapshotted: a hide it would
                // consume, or an archive index it would install, may already
                // be wrong after a frame that landed while it ran, and a
                // cleared hide is persisted to the server and cannot be
                // taken back. The checks are repeated after grouping below.
                guard requestConnection == OS1API.LiveActivityConnection.current() else { return }
                guard sequence > publishedRefreshSequence else { break }
                if snapshotRevision != sessionsRevision {
                    if !hasLoaded || reruns < 2 {
                        reruns += 1
                        continue
                    }
                    break
                }
                next = mergeOptimistic(into: polled.active)
                // Most 5s polls change nothing — skip the assignment so the whole
                // list doesn't re-diff (grouping, sorting, row rebuilds) for a
                // byte-identical result.
                let shouldPublish =
                    next != sessions || refreshedWorkspaces != nil || connectionChanged || claimsChanged
                guard shouldPublish else {
                    // The list already says what the response says, but this
                    // accepted response must still supersede older polls.
                    publishedRefreshSequence = sequence
                    accept(polled)
                    break
                }
                // Group before publishing, not after: the assignment wakes
                // every observing view, so a grouping that starts afterwards
                // always loses the race to the body that needs it.
                let names = renamed ?? workspaceNames
                let nextWorkspaces = refreshedWorkspaces ?? workspaces
                let grouped = await Self.groupedOffMain(
                    next,
                    workspaceNames: names,
                    workspaces: nextWorkspaces,
                    claimed: claimed
                )
                guard requestConnection == OS1API.LiveActivityConnection.current() else { return }
                // A later poll already published rows newer than these.
                guard sequence > publishedRefreshSequence else { break }
                if snapshotRevision != sessionsRevision {
                    if !hasLoaded || reruns < 2 {
                        reruns += 1
                        continue
                    }
                    break
                }
                accept(polled)
                SessionLinks.register(titles: grouped.titles)
                PrLinks.register(index: grouped.prs)
                if let renamed { workspaceNames = renamed }
                if let refreshedWorkspaces { workspaces = refreshedWorkspaces }
                liveActivityConnection = requestConnection
                publishedRefreshSequence = sequence
                setSessions(next, rows: grouped.rows)
                break
            }
            #if os(iOS)
            // An authoritative empty first response still matters: without it
            // the coordinator cannot distinguish "not loaded" from "no runs".
            if !hasLoaded { LiveActivityCoordinator.shared.sync(next) }
            #endif
            error = nil
            loadFailure = nil
            hasLoaded = true
        } catch {
            // Keep showing the last good list; surface the error alongside it.
            let diagnosis = await Reachability.diagnose(error)
            // The banner sits over a list that's still good, so it takes the
            // headline: "Can't reach the server" is the news, and the system's
            // wording underneath it is for the screen that has room.
            self.error = diagnosis.isConnection ? diagnosis.title : diagnosis.detail
            self.loadFailure = diagnosis
        }
    }

    /// How stale the archived index may get before a poll refetches it. The
    /// live list moves constantly; this one changes when someone archives
    /// something, which the local overlay already covers on this device.
    private static let archivedMaxAge: TimeInterval = 30

    /// Fetch the archived index, unless a recent enough one is in hand.
    ///
    /// Separate from `refresh` because it is a separate response with its own
    /// ETag: it settles into a 304 while the live slice keeps churning on
    /// `isRunning` and `lastActivity`, so the archived half of the list stops
    /// being re-sent every time anything moves.
    func refreshArchived(force: Bool = false) async {
        if archivedFetchInFlight { return }
        if !force, let fetchedAt = archivedFetchedAt,
           Date().timeIntervalSince(fetchedAt) < Self.archivedMaxAge {
            return
        }
        archivedFetchInFlight = true
        defer { archivedFetchInFlight = false }
        do {
            let index = try await OS1API.archivedSessions()
            // Sort off the main actor for the same reason the live list does:
            // this can be thousands of rows, and it lands while someone is
            // typing.
            let sorted = await Task.detached(priority: .userInitiated) {
                Self.byRecency(index)
            }.value
            setServerArchived(sorted, presorted: true)
            archivedLoadFailure = nil
        } catch {
            // Keep the last good index. An empty one must not masquerade as a
            // successful response, though: the Archived sheet offers retry.
            archivedLoadFailure = "Couldn't load archived sessions: \(error.localizedDescription)"
        }
        // The request answered either way. The view distinguishes failure from
        // a true empty archive with `archivedLoadFailure`.
        archivedHasLoaded = true
    }

    private func setServerArchived(_ rows: [Session], presorted: Bool = false) {
        serverArchived = presorted ? rows : Self.byRecency(rows)
        archivedFetchedAt = Date()
        archivedHasLoaded = true
        publishArchived()
    }

    /// Re-apply the local overlay to the server's index.
    ///
    /// Two corrections, both of them about a change this device made that the
    /// index hasn't caught up with: a row archived here stands in until the
    /// server's own copy of it arrives, and one restored here is held out of
    /// the list so it can't flash back into the sheet it just left.
    private func publishArchived() {
        let restored = Set(Array(locallyUnarchived.keys).filter { isLocallyUnarchived($0) })
        let serverRows = serverArchived.filter { !restored.contains($0.id) }
        let serverIds = Set(serverRows.map(\.id))
        for id in serverIds { locallyArchived.removeValue(forKey: id) }
        let localRows = Array(locallyArchived.keys)
            .filter { isLocallyArchived($0) && !serverIds.contains($0) }
            .compactMap { locallyArchived[$0]?.session }
        let next = localRows.isEmpty
            ? serverRows
            : Self.byRecency(localRows + serverRows)
        if next != archivedSessions { archivedSessions = next }
    }

    /// Newest first, parsing each row's date once rather than once per
    /// comparison — the same decorated sort the live list uses.
    nonisolated static func byRecency(_ sessions: [Session]) -> [Session] {
        sessions
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
    }

    /// A session whole, for a summary row from the archived index. Anything
    /// else is returned untouched, and a failed fetch falls back to the row
    /// in hand: an archived session that opens missing its walkthrough beats
    /// one that doesn't open.
    func hydrated(_ session: Session) async -> Session {
        guard session.slim == true else { return session }
        return (try? await OS1API.session(id: session.id)) ?? session
    }

    /// Name the reason a first load can't land while it's still trying. Only
    /// speaks up if the answer is still useful — a list that arrived in the
    /// meantime has already said more than any diagnosis could.
    ///
    /// It sets `loadFailure` and not `error`: the request hasn't failed yet,
    /// so this belongs under the spinner as a diagnosis, not in the red
    /// capsule reserved for something that actually went wrong.
    private func diagnoseUnreachableServer() {
        Task { [weak self] in
            guard let diagnosis = await Reachability.tailnetDiagnosis(),
                  let self, !self.hasLoaded
            else { return }
            self.loadFailure = diagnosis
        }
    }

    /// Drop archived/desk/locally-hidden rows and sort by last activity, and
    /// report which sidebar hides a blocked session resurfaces.
    /// Decorated sort on purpose: the comparator form re-parsed each row's
    /// ISO date ~2·log n times, which multiplied into hundreds of
    /// milliseconds per poll at this list size — parse once per row instead.
    nonisolated static func prepared(
        _ all: [Session],
        hiding hiddenIds: Set<String>,
        restoring restoredIds: Set<String>,
        hidden hideKeys: Set<String> = []
    ) -> (active: [Session], archived: [Session], resurfacedHideKeys: [String]) {
        let visible = all.filter { $0.desk != true }
        let active = visible
            .filter {
                ($0.archived != true || restoredIds.contains($0.id))
                    && !hiddenIds.contains($0.id)
            }
            .map { session -> Session in
                guard restoredIds.contains(session.id) else { return session }
                var restored = session
                restored.archived = false
                return restored
            }
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
        let archived = visible
            .filter { $0.archived == true && !restoredIds.contains($0.id) }
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
        return (active, archived, resurfacedHideKeys(in: active, hidden: hideKeys))
    }

    /// Hides are consumed by the final rows, never by a superseded poll row.
    nonisolated private static func resurfacedHideKeys(
        in sessions: [Session], hidden hideKeys: Set<String>
    ) -> [String] {
        var resurfaced = Set<String>()
        if !hideKeys.isEmpty {
            for session in sessions where session.lane == .needsInput && !session.isAutomation {
                for key in SidebarRowKeys.candidateKeys(for: session) where hideKeys.contains(key) {
                    resurfaced.insert(key)
                }
            }
        }
        return Array(resurfaced)
    }
}

/// Which surface offers a workspace's closed sessions. See
/// `SessionsListViewModel.historyPlacement`.
enum SessionHistoryPlacement: Equatable {
    case none, tabStrip, actionsMenu
}

/// The web sidebar's Inbox bands: an email-style split of the rows by when
/// they last moved, with "blocked on you" lifted out in front.
enum InboxBand: String, CaseIterable {
    case needsAction, recent, yesterday, earlier

    var label: String {
        switch self {
        case .needsAction: "Needs action"
        case .recent: "Recent"
        case .yesterday: "Yesterday"
        case .earlier: "Earlier"
        }
    }
}

private extension OS1API.WorkspaceSummary {
    /// Session-shaped presentation data for the existing row component. The
    /// workspace remains sessionless (`SidebarWorkspace.sessions` is empty);
    /// this only supplies dates, repo and owner to shared row rendering.
    var draftSession: Session {
        var session = Session(id: "workspace-draft:\(id)")
        session.title = name
        session.repo = repo
        session.workspaceId = id
        session.workspaceName = name
        session.createdAt = createdAt
        session.lastActivity = draft?.updatedAt
        session.startedBy = createdBy
        return session
    }
}

struct SidebarWorkspace: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let sessions: [Session]
    let mainSession: Session
    var workspace: OS1API.WorkspaceSummary? = nil

    var statusSession: Session {
        let humanSessions = sessions.filter { !$0.isAutomation }
        let candidates = humanSessions.isEmpty ? sessions : humanSessions
        return candidates.min { statusRank($0) < statusRank($1) } ?? mainSession
    }

    var lane: Session.Lane { statusSession.lane }
    var workspaceId: String? {
        if let workspace { return workspace.id }
        return sessions.compactMap(\.workspaceId).first { !$0.isEmpty }
    }
    var isDraftWorkspace: Bool { sessions.isEmpty && workspace?.draft != nil }
    var isOptimistic: Bool {
        sessions.contains(where: \.isOptimistic)
    }
    var effectiveRepo: String { workspace?.repo ?? mainSession.effectiveRepo }

    /// The open PR is the actionable one when sibling tabs have several. Once
    /// none are open, keep a merged/closed PR so the menu can suggest Archive.
    var pullRequestSession: Session? {
        sessions.first { $0.prState == "OPEN" }
            ?? sessions.first { $0.prNumber != nil || $0.prState != nil }
    }

    /// This row's page on the web app, for sharing: the workspace session URL
    /// when the row is a real workspace, the bare session URL otherwise.
    @MainActor var shareURL: URL? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        if let workspaceId, !workspaceId.isEmpty {
            let workspaceURL = base
                .appendingPathComponent("workspace")
                .appendingPathComponent(workspaceId)
            if isDraftWorkspace { return workspaceURL }
            return workspaceURL
                .appendingPathComponent("session")
                .appendingPathComponent(mainSession.id)
        }
        return base
            .appendingPathComponent("session")
            .appendingPathComponent(mainSession.id)
    }
    /// Any session of the row is mid-turn — the row counts as live even when a
    /// blocked sibling owns its lane.
    var isRunning: Bool {
        sessions.contains { $0.safety == nil && $0.isRunning == true }
    }
    var lastActivityDate: Date {
        if let draft = workspace?.draft,
           let date = Session.parseISO(draft.updatedAt) { return date }
        return sessions.compactMap(\.lastActivityDate).max() ?? .distantPast
    }
    var createdDate: Date {
        if let date = Session.parseISO(workspace?.createdAt) { return date }
        return sessions.compactMap { Session.parseISO($0.createdAt) }.min() ?? .distantPast
    }

    private func statusRank(_ session: Session) -> Int {
        switch session.lane {
        case .needsInput: 0
        case .inProgress: 1
        case .inReview: 2
        case .done: 3
        case .backlog: 4
        }
    }
}
