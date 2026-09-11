import Foundation
import Observation

/// Per-user sidebar lane claims. A claim pulls teammate, automation, or
/// spawned work into this person's own sidebar without changing workspace
/// state for anyone else.
@Observable
@MainActor
final class LaneStore {
    static let shared = LaneStore()

    /// Session ids this user has claimed, regardless of the lane value.
    private(set) var claims: Set<String> = []

    private var lanes: [String: String] = [:]
    /// Local intent survives hydration and in-flight writes. Each key is a
    /// delta, never a whole-map snapshot, so other clients' claims are safe.
    private var pendingChanges: [String: String] = [:]
    private var hydratedContext: NativePreferences.Context?
    private(set) var hasHydrated = false
    private var isSaving = false
    private var hydrations = HydrationClock()

    init() {}

    /// Load this user's map from the server. A response for a server/user that
    /// has since changed is dropped, as is one overtaken by a newer GET or by
    /// a confirmed write; mutations made before it landed are replayed over it.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let ticket = beginHydration()
        guard let loaded = try? await SettingsAPI.lanes(user: requestContext.user) else { return }
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
        lanes = [:]
        claims = []
        pendingChanges.removeAll()
        hasHydrated = false
        isSaving = false
    }

    /// Claim every session represented by a sidebar row. Optimistic locally;
    /// persistence waits for hydration so a startup mutation cannot overwrite
    /// remote state it has not seen yet.
    func claim(_ sessions: [Session]) {
        let requestContext = NativePreferences.context()
        resetForNewContext(requestContext)
        let ids = Set(sessions.map(\.id)).subtracting(claims)
        guard !ids.isEmpty else { return }
        for id in ids {
            lanes[id] = "mine"
            pendingChanges[id] = "mine"
        }
        claims.formUnion(ids)
        save()
    }

    /// Internal so pre-hydration mutation reconciliation is unit-testable.
    /// With a `ticket`, the map is applied only while that GET is still the
    /// newest and no write was confirmed since it began.
    func applyHydrated(
        _ loaded: [String: String],
        ticket: HydrationClock.Ticket? = nil,
        persist: Bool = true
    ) {
        if let ticket, !hydrations.isCurrent(ticket) { return }
        var merged = loaded
        for (key, value) in pendingChanges { merged[key] = value }
        hasHydrated = true
        apply(merged)
        if persist, !pendingChanges.isEmpty { save() }
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
        acknowledging captured: [String: String],
        begunAt mark: HydrationClock.Ticket? = nil
    ) -> Bool {
        for (key, value) in captured where pendingChanges[key] == value {
            pendingChanges.removeValue(forKey: key)
        }
        let needsHydration = mark.map { hydrations.hasHydrationBegun(since: $0) } ?? false
        hydrations.confirmWrite()
        if needsHydration { return false }
        applyHydrated(saved, persist: false)
        return true
    }

    private func apply(_ next: [String: String]) {
        lanes = next
        let nextClaims = Set(next.keys)
        if nextClaims != claims { claims = nextClaims }
    }

    private func save() {
        guard hasHydrated,
              !isSaving,
              !pendingChanges.isEmpty,
              let requestContext = hydratedContext,
              NativePreferences.context() == requestContext else { return }
        let captured = pendingChanges
        let mark = hydrations.mark()
        isSaving = true
        Task { [weak self] in
            let saved = try? await SettingsAPI.saveLanes(
                user: requestContext.user,
                set: captured
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
}
