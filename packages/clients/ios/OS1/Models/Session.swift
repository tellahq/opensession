import Foundation

/// One row from `GET /api/sessions` — a subset of the server's UnifiedSession.
/// Decoding is deliberately tolerant: almost everything is optional and unknown
/// fields are ignored, so server-side additions never break the client.
struct Session: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    /// Other stable ids that resolve to this same session. Transcript links can
    /// carry one of these after a session source is unified under a new id.
    var aliasIds: [String]?
    /// This session has an engine conversation behind it — it ran at least one
    /// turn. The list carries this instead of the engine session ids
    /// themselves (`sessionRan` in src/server/routes/sessions.ts): nothing here
    /// ever compared an id, and at ~105 bytes a row they were 9% of the
    /// response. Absent means it never ran.
    var ran: Bool?
    var title: String?
    var titleOverridden: Bool?
    var source: String?
    var repo: String?
    /// The server has deliberately given this session no repository. A
    /// missing `repo` alone is not enough: older Ask sessions omit it while
    /// still running in the instance's default checkout.
    var repoLess: Bool?
    var branch: String?
    var worktreeDir: String?
    var workspaceId: String?
    /// The name of that workspace, stamped on every row by the sessions route.
    /// A sidebar row names its workspace, and this is what lets it do so
    /// before (or without) the separate workspace-name request.
    var workspaceName: String?
    var mode: String?
    var model: String?
    var effort: String?
    var fastMode: Bool?
    var isRunning: Bool?
    var runState: String?
    /// Present when the server fenced an ambiguous operation rather than risk
    /// repeating it. Optional on every generation of server and every field is
    /// tolerant so a partial safety projection still leaves the session usable.
    var safety: SessionSafetyState?
    /// Journaled start of the current run — only present while running.
    var runStartedAt: String?
    var waitingForInput: Bool?
    /// The last run died on a terminal failure (usage limits exhausted,
    /// credit or API errors). A human must act, so while idle the session
    /// reads as Needs input rather than sinking into Backlog. Cleared by the
    /// next run that ends cleanly.
    var lastRunError: RunError?
    /// The create run is still preparing this session's worktree (git fetch,
    /// worktree add, dep install). The viewer says so and messages queue
    /// until it flips off.
    var workspacePreparing: Bool?
    var queuedCount: Int?
    var archived: Bool?
    /// Why the session was archived. Missing means a manual archive from a
    /// server or session record that predates this field.
    var archivedReason: String?
    /// This row is a summary from the archived index, not a whole session —
    /// it carries what a list renders and nothing else. Anything that opens
    /// one fetches the real thing first (`SessionsListViewModel.hydrated`);
    /// without that, an archived session renders quietly missing its PR, its
    /// walkthrough and its model.
    var slim: Bool?
    var desk: Bool?
    var createdAt: String?
    var lastActivity: String?
    var prUrl: String?
    var prState: String?
    /// Rich PR state from the sessions-list cache. These fields let list rows
    /// offer the same next action as the web status strip without fetching
    /// every PR individually.
    var prMergeable: String?
    var prNumber: Int?
    var prIsDraft: Bool?
    var prReviewDecision: String?
    var prChecks: PrChecksSummary?
    /// How big the change is. The sessions list already carries these (the web
    /// Reviews table reads them off the same rows), so a row can size its own
    /// diff without fetching the PR.
    var prAdditions: Int?
    var prDeletions: Int?
    var prChangedFiles: Int?
    /// Person keys ("kent") of teammates with a pending review request.
    var prReviewRequested: [String]?
    /// GitHub login of whoever opened the PR — who is waiting when one of
    /// those requests is pointed at you (`ReviewRequests`).
    var prAuthor: String?
    /// Person keys whose review has already LANDED on the PR. With
    /// `prUpdatedAt` this is what turns an open request into a completed one
    /// without anybody pressing anything (`WorkspaceReview.completion`).
    var prReviewedBy: [String]?
    var prUpdatedAt: String?
    /// The last automated review of this PR, when one has run. Feeds the
    /// transcript's review-loop verdict (`ReviewLoopResult`).
    var prOsReview: OsReviewSummary?
    /// Open Session's own "please look at this" request, pointed at one
    /// teammate or a review team (server: review-requests.ts). Separate from
    /// GitHub's reviewer list in `prReviewRequested`: the picker writes this
    /// one and mirrors it onto GitHub, a request made on GitHub writes only
    /// that one, and both mean somebody is waiting.
    var reviewRequest: SessionReviewRequest?
    var startedBy: String?
    var createdBy: String?
    var createdByLogin: String?
    /// Parent/orchestrator when this is a visible worker session.
    var parentSessionId: String?
    /// The opening turn came from a server-side action, not a person's composer.
    var agentStarted: Bool?
    /// The session id of the run that started this one from inside itself
    /// (`create_session` in an agent's own turn). Set only for those: work the
    /// Desk delegates on a person's behalf is deliberately unmarked
    /// (server: session-control-wiring). See `belongsInList`.
    var spawnedBy: String?
    var automation: AutomationFlag?
    var attachedRepos: [AttachedRepo]?
    /// Every pull-request branch associated with this session, including
    /// attached, linked, and discovered branches. The native workspace and PR
    /// surfaces use the enriched refs to show the complete series.
    var prs: [SessionPrRef]?
    /// The requested sandbox provider and materialized sandbox id. This is a
    /// reference only; Workspace details resolves its live state on demand.
    var sandbox: SessionSandbox?
    /// A persistent machine chosen explicitly for this session. It is separate
    /// from `sandbox`: runners are trusted hardware, not isolated compute.
    var runner: SessionRunner?
    /// The agent-published demo of a user-visible change, rendered inline in
    /// the transcript where it was published.
    var walkthrough: SessionWalkthrough?
    /// What this conversation has cost so far, and how full the model's
    /// context window is. Absent until the first run reports usage; the live
    /// value during a run arrives on the socket as `usage_update`.
    var usage: SessionUsage?
    /// Local-only marker for a just-created row that the sessions endpoint has
    /// not returned yet. Its id may already be real after create resolves.
    var isOptimisticPlaceholder: Bool?

    /// True for automation-owned sessions (triage runs, scheduled jobs) —
    /// the bulk of server noise a person's list should hide by default.
    var isAutomation: Bool {
        automation?.isAutomation ?? (startedBy?.hasSuffix("(automation)") ?? false)
    }

    /// The opening turn came from an agent action rather than a composer.
    /// The branch/id fallbacks preserve this mark on older PR and report runs.
    var wasAgentStarted: Bool {
        agentStarted == true
            || isAutomation
            || parentSessionId?.isEmpty == false
            || spawnedBy?.isEmpty == false
            || id.hasPrefix("bks-ghpr-")
            || (branch?.hasPrefix("report-") ?? false)
            || [createdBy, startedBy].contains { name in
                name?.trimmingCharacters(in: .whitespaces).lowercased() == "automation"
            }
    }

    /// The ordinary user entries belong to this person when they carry no
    /// explicit sender. Stored sessions may have only the newer `createdBy`.
    var transcriptOwner: String? {
        guard !isAutomation else { return nil }
        return [startedBy, createdBy]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .first
    }

    /// Whether this session earns a row of its own in the list.
    ///
    /// A session an agent started for its own purposes — a throwaway fixture,
    /// a probe — belongs to the run that spawned it, not to you: it gets a
    /// workspace like anything else, but no row here. It surfaces the moment
    /// it needs a human (a blocked question), or once you claim it. Same rule
    /// as the web sidebar's `spawnedSessionBelongsInSidebar`
    /// (lib/sidebar-workspaces), so a worker hidden in the browser is hidden
    /// on the phone too.
    ///
    /// `claimed` is `LaneStore`'s claim set — see `PeopleLens`.
    func belongsInList(claimed: Set<String>) -> Bool {
        guard let spawnedBy, !spawnedBy.isEmpty else { return true }
        return lane == .needsInput || claimed.contains(id)
    }

    /// A just-created row the server hasn't published yet. Archiving one would
    /// PATCH a session `/api/sessions` doesn't know about, so the affordances
    /// that archive (list swipe, tab close) stay hidden until it resolves.
    var isOptimistic: Bool {
        id.hasPrefix("pending-") || isOptimisticPlaceholder == true
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return id
    }

    /// Reserved create value and display bucket for an explicit no-repo
    /// session. The server distinguishes this from an omitted repo, which
    /// still means inherit-or-default.
    static let noRepoID = "none"

    /// Older/default-repo sessions may omit `repo` on the wire. Current
    /// servers normalize it to the configured default repository, including
    /// on repo-less rows, so the positive marker must win.
    var effectiveRepo: String {
        if repoLess == true { return Self.noRepoID }
        guard let repo, !repo.isEmpty else { return "opensession" }
        return repo
    }

    /// Untouched tabs are eagerly created before their first prompt. They are
    /// valid tabs, but should not displace the conversation that started the
    /// workspace from the leading position.
    var neverRan: Bool {
        ran != true
            && isRunning != true
            && (queuedCount ?? 0) == 0
            && lastActivity == createdAt
    }

    var lastActivityDate: Date? {
        Self.parseISO(lastActivity)
    }

    var runStartedDate: Date? {
        Self.parseISO(runStartedAt)
    }

    enum Status: Equatable {
        case needsInput
        case running
        case idle
    }

    struct RunError: Decodable, Equatable, Hashable, Sendable {
        var message: String?
        var at: String?
    }

    /// A run that died on a terminal failure needs a human to act, exactly
    /// like a blocked question. A live run means a retry is underway, so the
    /// stale flag never overrides running states. Mirrors the web's
    /// runNeedsAttention (frontend/lib/sidebar-lanes.tsx).
    var runNeedsAttention: Bool {
        safety != nil || (lastRunError != nil && isRunning != true)
    }

    var status: Status {
        if safety != nil { return .needsInput }
        if waitingForInput == true { return .needsInput }
        if runNeedsAttention { return .needsInput }
        if isRunning == true { return .running }
        return .idle
    }

    /// Status lanes in native display order. Running sessions stay above all
    /// other work; within a session, waiting still takes precedence over running.
    enum Lane: String, CaseIterable {
        case inProgress, needsInput, inReview, done, backlog

        var label: String {
            switch self {
            case .needsInput: "Needs input"
            case .inProgress: "In progress"
            case .inReview: "In review"
            case .done: "Done"
            case .backlog: "Backlog"
            }
        }
    }

    var lane: Lane {
        if safety != nil { return .needsInput }
        if waitingForInput == true { return .needsInput }
        if runNeedsAttention { return .needsInput }
        if isRunning == true { return .inProgress }
        if prState == "OPEN" { return .inReview }
        if prState == "MERGED" { return .done }
        return .backlog
    }

    /// Shared formatters — NSISO8601DateFormatter is documented thread-safe,
    /// and allocating one per call was a real cost: this runs inside list
    /// sort comparators, thousands of times per 5s sessions poll.
    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    private static let isoCache = ISODateCache()

    /// Date parsing used to run from computed properties inside SwiftUI view
    /// bodies. A scene update could ask hundreds of transcript rows for the
    /// same timestamps again and spend the watchdog's whole allowance in ICU.
    /// Cache by the immutable wire value so every timestamp pays that cost at
    /// most once for the process.
    static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        if let cached = isoCache.value(for: string) { return cached }
        guard let parsed = isoFractional.date(from: string) ?? isoPlain.date(from: string) else {
            return nil
        }
        isoCache.insert(parsed, for: string)
        return parsed
    }

    private final class ISODateCache: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Date] = [:]
        private let limit = 20_000

        func value(for key: String) -> Date? {
            lock.lock()
            defer { lock.unlock() }
            return values[key]
        }

        func insert(_ value: Date, for key: String) {
            lock.lock()
            defer { lock.unlock() }
            if values.count >= limit { values.removeAll(keepingCapacity: true) }
            values[key] = value
        }
    }
}

/// Public, user-facing safety state shared by REST session rows and
/// `session_status` socket frames. Fields remain optional for forward and
/// backward compatibility; unknown additions are ignored by Codable.
struct SessionSafetyState: Codable, Equatable, Hashable, Sendable {
    var status: String?
    var explanation: String?
    var automaticReconciliationRunning: Bool?
    var pausedAt: String?
    var operation: String?
    var repairAvailable: Bool?
}

struct PrChecksSummary: Decodable, Equatable, Hashable {
    var total: Int?
    var passed: Int?
    var failed: Int?
    var pending: Int?
}

/// The automated review the PR last got (`OsReviewSummary` on the server).
/// Every field is optional here: an older server sends none of it, and a
/// missing verdict has to read as "no verdict" rather than as a passing one.
struct OsReviewSummary: Decodable, Equatable, Hashable {
    /// approve | comment | request_changes.
    var verdict: String?
    /// 1-5: how safe the reviewer thought this was to merge.
    var confidence: Int?
    var findings: Int?
    /// P0/P1 findings — what would block a merge.
    var blocking: Int?
    /// The branch has moved on since this verdict — it describes older code.
    var stale: Bool?
    var at: String?
}

extension Session {
    /// The PR fact and next action shown in a workspace row's context menu.
    /// Precedence matches the web PR strip: never offer Merge over a conflict,
    /// failed checks, a running check, a draft, or requested changes.
    enum PullRequestContextState: Equatable {
        case merged
        case closed
        case conflicts
        case failing
        case running(Int)
        case draft
        case changesRequested
        case ready

        var label: String {
            switch self {
            case .merged: "Merged"
            case .closed: "Pull request closed"
            case .conflicts: "Merge conflicts"
            case .failing: "Checks failed"
            case let .running(count):
                "\(count) check\(count == 1 ? "" : "s") running"
            case .draft: "Draft pull request"
            case .changesRequested: "Changes requested"
            case .ready: "Ready to merge"
            }
        }
    }

    var pullRequestContextState: PullRequestContextState? {
        guard prNumber != nil || prState != nil else { return nil }
        switch prState ?? "" {
        case "MERGED": return .merged
        case "CLOSED": return .closed
        default: break
        }
        if prMergeable == "CONFLICTING" { return .conflicts }
        if (prChecks?.failed ?? 0) > 0 { return .failing }
        if (prChecks?.pending ?? 0) > 0 { return .running(prChecks?.pending ?? 0) }
        if prIsDraft == true { return .draft }
        if prReviewDecision == "CHANGES_REQUESTED" { return .changesRequested }
        return .ready
    }
}

struct AttachedRepo: Decodable, Equatable, Hashable, Identifiable {
    let repo: String
    let branch: String
    let dir: String

    var id: String { repo }
}

/// One pull request associated with a session. Every enriched field remains
/// optional so older servers and unresolved branches still decode safely.
struct SessionPrRef: Decodable, Equatable, Hashable {
    let repo: String
    let branch: String
    var source: String? = nil
    var url: String? = nil
    var state: String? = nil
    var number: Int? = nil
    var title: String? = nil
    var isDraft: Bool? = nil
    var reviewDecision: String? = nil
    var additions: Int? = nil
    var deletions: Int? = nil
    var checks: PrChecksSummary? = nil
}

extension Session {
    /// Locally-built placeholder for a session the server just created but
    /// hasn't persisted to the list yet — rendered (and opened) immediately
    /// instead of polling until `GET /api/sessions` includes it.
    static func optimistic(
        id: String,
        title: String,
        repo: String,
        repoLess: Bool = false,
        mode: String,
        model: String?,
        effort: String?,
        fastMode: Bool,
        startedBy: String,
        workspaceId: String? = nil
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.source = "opensession"
        session.repo = repoLess ? nil : repo
        session.repoLess = repoLess ? true : nil
        // A session created into an existing workspace carries its id from the
        // start, so the pending row joins that workspace's tab strip (and its
        // sidebar row) immediately instead of flashing as a separate session
        // until the first poll lands.
        session.workspaceId = workspaceId
        session.mode = mode
        session.model = model
        session.effort = effort
        session.fastMode = fastMode ? true : nil
        session.isRunning = true
        session.runStartedAt = ISO8601DateFormatter().string(from: .now)
        session.createdAt = session.runStartedAt
        session.lastActivity = session.runStartedAt
        session.startedBy = startedBy
        session.isOptimisticPlaceholder = true
        return session
    }

    /// Bare session with just an id; every other field starts nil.
    init(id: String) {
        self.id = id
    }
}

/// The server's `automation` field is `true` OR the automation's name —
/// either way it means "not a person's session". Tolerant of both shapes.
struct AutomationFlag: Decodable, Equatable, Hashable {
    let isAutomation: Bool
    /// The configured automation name, when the wire sent the string form.
    /// Team activity uses it to file a run under that automation's owner.
    let name: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let flag = try? container.decode(Bool.self) {
            isAutomation = flag
            name = nil
        } else if let value = try? container.decode(String.self) {
            isAutomation = !value.isEmpty
            name = value.isEmpty ? nil : value
        } else {
            isAutomation = false
            name = nil
        }
    }
}
