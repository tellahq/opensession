import Foundation
import Observation

/// Per-user "last read" marks — what makes a sidebar row read as unread.
///
/// Same store the web sidebar writes (`GET/PUT /api/reads`, see
/// src/server/reads.ts and src/frontend/lib/reads.ts): session id → the
/// `lastActivity` the session carried the last time you looked at it. A session is
/// unread when its current `lastActivity` is NEWER than that mark, so a session
/// you have never opened never lights up — the flag means "new since you read
/// it", not "never seen". Because the marks live on the server, reading a session
/// on the phone clears its emphasis in the browser too.
@Observable
@MainActor
final class ReadsStore {
    static let shared = ReadsStore()

    /// Session id → ISO `lastActivity` at the moment it was last read.
    private(set) var reads: [String: String] = [:]

    private enum Change {
        case set(String)
        case remove
    }

    /// Changes made before (or while) a hydrate is in flight. A settings PUT
    /// replaces the whole map, so these must be replayed over the server copy
    /// before the first save rather than treating the initial empty map as truth.
    private var pendingChanges: [String: Change] = [:]
    private var mutationRevision = 0
    private var hydratedContext: NativePreferences.Context?

    /// The session on screen right now. Its row is never unread: the web sidebar
    /// skips the selected session the same way, so activity arriving while
    /// you watch it can't bold the row behind the conversation for the few
    /// seconds before the next poll re-marks it.
    private(set) var openSessionId: String?

    /// Nothing is pushed before the first hydrate succeeds. A PUT replaces the
    /// whole map, so saving a map that is empty-but-for-this-launch's reads
    /// would wipe every mark you made in the browser. Marks taken meanwhile
    /// stay local and ride out with the first hydrate that carries them.
    ///
    /// Readable because "unread" is meaningless before it: an empty map says
    /// nothing is unread, which is indistinguishable from a caught-up inbox.
    /// Anything that shows a person a claim about their unread work has to
    /// wait for this (see `CatchUpViewModel.settle`).
    private(set) var hasHydrated = false

    /// The server caps a user's map (src/server/reads.ts) and silently drops
    /// whatever spills, so bound it here first — and drop the OLDEST marks,
    /// which are the ones worth missing, rather than whatever order JSON took.
    private static let cap = 500

    /// Where a deliberate "mark as unread" parks a session's mark: older than
    /// any real `lastActivity`, so `isUnread` says yes. The same value the web
    /// sidebar writes (src/frontend/lib/reads.ts), since the two clients share
    /// one map and have to agree about what an unread mark looks like.
    private static let epoch = "1970-01-01T00:00:00.000Z"

    init() {}

    /// Load this user's marks from the server. Guarded like
    /// `HideStore.hydrate`: a stale response (server/user switched, or a mark
    /// landed meanwhile) is dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        guard let loaded = try? await SettingsAPI.reads(user: requestContext.user) else { return }
        guard NativePreferences.context() == requestContext else { return }
        applyHydrated(loaded)
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        reads = [:]
        pendingChanges.removeAll()
        hasHydrated = false
        mutationRevision += 1
        unreadStateDidChange()
    }

    /// Kept internal so the merge contract can be tested without a server.
    func applyHydrated(_ loaded: [String: String], persist: Bool = true) {
        var merged = loaded
        for (id, change) in pendingChanges {
            switch change {
            case .set(let mark): merged[id] = mark
            case .remove: merged.removeValue(forKey: id)
            }
        }
        hasHydrated = true
        if merged != reads { reads = merged }
        unreadStateDidChange()
        if persist, !pendingChanges.isEmpty { save() }
    }

    private static func isNewer(_ mark: String, than other: String?) -> Bool {
        guard let other else { return true }
        guard mark != other else { return false }
        guard let lhs = Session.parseISO(mark), let rhs = Session.parseISO(other) else {
            return false
        }
        return lhs > rhs
    }

    /// A session came on screen: it reads up to its current activity, and stays
    /// out of the unread emphasis until it's closed. Called again with each
    /// fresh copy from the poll, which is what keeps an open session read while
    /// new output lands in it — the web viewer's markRead-on-activity tick.
    func open(_ session: Session) {
        if openSessionId != session.id {
            openSessionId = session.id
            unreadStateDidChange()
        }
        markRead(session)
    }

    func close(_ id: String) {
        if openSessionId == id {
            openSessionId = nil
            unreadStateDidChange()
        }
    }

    /// Record that `session` has been read up to its current `lastActivity`.
    /// A no-op when the mark already matches, so calling it on every poll of
    /// an open session costs nothing and doesn't spam the server mirror.
    func markRead(_ session: Session) {
        guard let activity = session.lastActivity, !activity.isEmpty else { return }
        guard reads[session.id] != activity else { return }
        reads[session.id] = activity
        record(.set(activity), for: session.id)
        enforceCap()
        unreadStateDidChange()
        save()
    }

    /// Put a session back in the unread pile — the inverse of `markRead`, and
    /// what the row's long-press menu calls. A session on screen right now is
    /// held read by `openSessionId` and re-marked by the next `open`, so this
    /// is only meaningful from the list.
    func markUnread(_ session: Session) {
        guard reads[session.id] != Self.epoch else { return }
        reads[session.id] = Self.epoch
        record(.set(Self.epoch), for: session.id)
        enforceCap()
        unreadStateDidChange()
        save()
    }

    /// True when the session finished a turn with activity past your read
    /// mark. A running session is never unread: your own prompt and streaming
    /// output move `lastActivity`, but nothing is ready to read until the turn
    /// completes.
    func isUnread(_ session: Session) -> Bool {
        guard hasHydrated, session.isRunning != true, session.id != openSessionId,
              let mark = reads[session.id] else { return false }
        guard let activity = session.lastActivity, activity != mark else { return false }
        guard let read = Session.parseISO(mark),
              let last = Session.parseISO(activity)
        else { return false }
        return last > read
    }

    /// A sidebar row is unread when any visible session under it is. Spawned
    /// workers stay behind their parent, so counting one would leave the row
    /// bold with no session the reader could open to clear it.
    func isUnread(_ sessions: [Session]) -> Bool {
        let visible = sessions.filter { $0.spawnedBy?.isEmpty != false }
        return (visible.isEmpty ? sessions : visible).contains { isUnread($0) }
    }

    private func enforceCap() {
        guard reads.count > Self.cap else { return }
        let doomed = reads
            // An unread mark is parked at the epoch, so ordering by date alone
            // would evict exactly the marks someone asked for. Spend the cap on
            // the oldest real reads instead.
            .filter { $0.value != Self.epoch }
            .map { (id: $0.key, date: Session.parseISO($0.value) ?? .distantPast) }
            .sorted { $0.date < $1.date }
            .prefix(reads.count - Self.cap)
        for entry in doomed {
            reads.removeValue(forKey: entry.id)
            record(.remove, for: entry.id)
        }
    }

    private func record(_ change: Change, for id: String) {
        pendingChanges[id] = change
        mutationRevision += 1
    }

    private func unreadStateDidChange() {
        #if os(iOS)
        LiveActivityCoordinator.shared.refreshUnreadStatus()
        #endif
    }

    private func save() {
        guard hasHydrated else { return }
        let user = ServerConfig.shared.userName
        let snapshot = reads
        let revision = mutationRevision
        // Fire-and-forget, like the web's mirror: the map is local truth and a
        // failed PUT costs nothing worth an error banner.
        Task { [weak self] in
            guard (try? await SettingsAPI.saveReads(user: user, reads: snapshot)) != nil,
                  let self,
                  self.mutationRevision == revision
            else { return }
            self.pendingChanges.removeAll()
        }
    }
}
