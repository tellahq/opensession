import Foundation
import Observation

/// Per-user sidebar hides — the personal counterpart to archiving.
///
/// Archiving is global (it removes a session for the whole team), which is the
/// wrong tool for "this isn't mine to watch anymore" while a teammate is still
/// working in the session. A hide is an overlay on a sidebar ROW key that only
/// ever affects one user; the session keeps running and stays in everyone else's
/// sidebar. Same store the web sidebar writes (`GET/PUT /api/hides`, see
/// src/server/hides.ts and src/frontend/lib/hides.ts), so a row hidden on the
/// phone is hidden in the browser too.
///
/// There is deliberately no "Hidden" band: hiding means the row is off your
/// sidebar, not filed into a drawer. Search ignores hides — that's how a
/// hidden row is found again, and its context menu then offers to restore it.
/// Two rules keep a hide from swallowing work: a hidden row resurfaces (and
/// its entry is consumed) while one of its sessions is blocked on a question, and
/// prompting in a session clears its hide outright.
@Observable
@MainActor
final class HideStore {
    static let shared = HideStore()

    /// Sidebar row key → ISO timestamp of when this user hid it.
    private(set) var hides: [String: String] = [:]

    enum Change: Equatable {
        case set(String)
        case remove
    }

    /// Local intent survives the first remote response. Without tombstones, a
    /// pre-hydration restore could be undone by an older server hide.
    private var pendingChanges: [String: Change] = [:]
    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false
    private var isSaving = false
    private var hydrations = HydrationClock()

    init() {}

    /// Load this user's map from the server. Guarded like
    /// `NativePreferences.hydrate`: a stale response (server/user switched,
    /// a newer GET begun, or a write confirmed meanwhile) is dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let ticket = beginHydration()
        guard let loaded = try? await SettingsAPI.hides(user: requestContext.user) else { return }
        guard NativePreferences.context() == requestContext else { return }
        applyHydrated(loaded, ticket: ticket)
    }

    /// Marks the start of one GET. Internal so the ordering is unit-testable.
    func beginHydration() -> HydrationClock.Ticket {
        hydrations.begin()
    }

    /// The clock as a write would see it when it starts. Internal for tests.
    func hydrationMark() -> HydrationClock.Ticket {
        hydrations.mark()
    }

    private func resetForNewContext(_ context: NativePreferences.Context) {
        guard let hydratedContext else {
            self.hydratedContext = context
            return
        }
        guard hydratedContext != context else { return }
        self.hydratedContext = context
        hides = [:]
        pendingChanges.removeAll()
        hasHydrated = false
        isSaving = false
    }

    /// Kept internal so the local-before-remote merge can be covered in tests.
    /// With a `ticket`, the map is applied only while that GET is still the
    /// newest and no write was confirmed since it began.
    func applyHydrated(
        _ loaded: [String: String],
        ticket: HydrationClock.Ticket? = nil,
        persist: Bool = true
    ) {
        if let ticket, !hydrations.isCurrent(ticket) { return }
        var merged = loaded
        for (key, change) in pendingChanges {
            switch change {
            case .set(let timestamp): merged[key] = timestamp
            case .remove: merged.removeValue(forKey: key)
            }
        }
        hasHydrated = true
        if merged != hides { hides = merged }
        if persist, !pendingChanges.isEmpty { save() }
    }

    func isHidden(_ workspace: SidebarWorkspace) -> Bool {
        hides[SidebarRowKeys.rowKey(for: workspace)] != nil
    }

    func hide(_ workspace: SidebarWorkspace) {
        let key = SidebarRowKeys.rowKey(for: workspace)
        guard SidebarRowKeys.isPersistable(key), hides[key] == nil else { return }
        let timestamp = Self.timestamp.string(from: .now)
        hides[key] = timestamp
        record(.set(timestamp), for: key)
        save()
    }

    /// Drop hide entries. Takes a list so a poll can consume several resurfaced
    /// rows in one write; idempotent.
    func clear(_ keys: [String]) {
        let doomed = keys.filter { hides[$0] != nil }
        guard !doomed.isEmpty else { return }
        for key in doomed {
            hides.removeValue(forKey: key)
            record(.remove, for: key)
        }
        save()
    }

    /// Clear the hide covering a session, whichever row key its row uses. Called
    /// when the user PROMPTS in a session: you can't be done with a session you're
    /// actively working in, and "I replied but it's still gone" reads as a bug.
    /// Opening a hidden session deliberately does NOT unhide it.
    func unhide(for session: Session) {
        clear(SidebarRowKeys.candidateKeys(for: session))
    }

    private func record(_ change: Change, for key: String) {
        pendingChanges[key] = change
    }

    /// Reconcile one successful delta response without dropping a newer local
    /// mutation that landed while that request was in flight.
    ///
    /// The response is a whole-map snapshot taken when the server applied
    /// the delta, and the server broadcasts `user_map_changed` before it
    /// answers, so a re-read begun after the write started (`begunAt`) can
    /// hold a newer map. Then the snapshot is not installed: the intents are
    /// acknowledged, the newer map stays, and the caller re-reads; a GET
    /// begun after the response is post-write. Returns false in that case.
    @discardableResult
    func applySaved(
        _ saved: [String: String],
        acknowledging captured: [String: Change],
        begunAt mark: HydrationClock.Ticket? = nil
    ) -> Bool {
        for (key, change) in captured where pendingChanges[key] == change {
            pendingChanges.removeValue(forKey: key)
        }
        let needsHydration = mark.map { hydrations.hasHydrationBegun(since: $0) } ?? false
        hydrations.confirmWrite()
        if needsHydration { return false }
        applyHydrated(saved, persist: false)
        return true
    }

    private func save() {
        guard hasHydrated,
              !isSaving,
              !pendingChanges.isEmpty,
              let requestContext = hydratedContext,
              NativePreferences.context() == requestContext else { return }
        let captured = pendingChanges
        let set = captured.compactMapValues { change -> String? in
            if case .set(let value) = change { return value }
            return nil
        }
        let remove = captured.compactMap { key, change in
            if case .remove = change { return key }
            return nil
        }
        let mark = hydrations.mark()
        isSaving = true
        Task { [weak self] in
            let saved = try? await SettingsAPI.saveHides(
                user: requestContext.user,
                set: set,
                remove: remove
            )
            guard let self,
                  self.hydratedContext == requestContext,
                  NativePreferences.context() == requestContext else { return }
            self.isSaving = false
            guard let saved else { return }
            let applied = self.applySaved(saved, acknowledging: captured, begunAt: mark)
            self.save()
            if !applied { await self.hydrate() }
        }
    }

    private static let timestamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

}
