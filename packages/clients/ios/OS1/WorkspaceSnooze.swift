import Foundation
import Observation

/// The account-level value used when a workspace is intentionally parked with
/// no wake date. Timed values remain ISO timestamps shared with the web.
enum WorkspaceSnooze {
    static let someDay = "someday"

    static func isActive(_ value: String?, now: Date = Date()) -> Bool {
        guard let value else { return false }
        if value == someDay { return true }
        return Session.parseISO(value).map { $0 > now } ?? false
    }

    static func label(_ value: String, now: Date = Date()) -> String {
        if value == someDay { return "Someday" }
        guard let wake = Session.parseISO(value) else { return "Snoozed" }
        let seconds = max(0, wake.timeIntervalSince(now))
        if seconds < 3_600 { return "\(max(1, Int(ceil(seconds / 60))))m" }
        if seconds < 86_400 { return "\(Int(round(seconds / 3_600)))h" }
        return "\(Int(round(seconds / 86_400)))d"
    }

    static func createdAt(_ workspace: SidebarWorkspace) -> Date {
        Session.parseISO(workspace.workspace?.createdAt)
            ?? workspace.sessions.compactMap { Session.parseISO($0.createdAt) }.min()
            ?? .distantPast
    }

    static func sortActive(_ workspaces: [SidebarWorkspace]) -> [SidebarWorkspace] {
        workspaces.sorted { left, right in
            let leftDate = createdAt(left)
            let rightDate = createdAt(right)
            return leftDate == rightDate ? left.id < right.id : leftDate > rightDate
        }
    }

    static func sortSnoozed(
        _ workspaces: [SidebarWorkspace],
        values: [String: String]
    ) -> [SidebarWorkspace] {
        workspaces.sorted { left, right in
            let leftValue = values[SidebarRowKeys.rowKey(for: left)]
            let rightValue = values[SidebarRowKeys.rowKey(for: right)]
            if leftValue == someDay, rightValue != someDay { return false }
            if rightValue == someDay, leftValue != someDay { return true }
            let leftDate = Session.parseISO(leftValue) ?? .distantFuture
            let rightDate = Session.parseISO(rightValue) ?? .distantFuture
            return leftDate == rightDate ? left.id < right.id : leftDate < rightDate
        }
    }
}

/// Per-person workspace snoozes shared with the web sidebar.
@Observable
@MainActor
final class WorkspaceSnoozeStore {
    static let shared = WorkspaceSnoozeStore()

    private(set) var snoozes: [String: String] = [:]
    private var context: NativePreferences.Context?

    enum Change: Equatable {
        case set(String)
        case remove
    }

    private var pending: [String: Change] = [:]
    private var hasHydrated = false
    private var isSaving = false
    private var hydrations = HydrationClock()

    init() {}

    /// Load this user's map from the server, at launch, on foreground, and
    /// when another client wrote it (`UserMapSync`). A response for a
    /// server/user that has since changed is dropped, as is one overtaken by
    /// a newer GET or by a confirmed write.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        resetIfNeeded(requestContext)
        let ticket = beginHydration()
        guard let loaded = try? await SettingsAPI.snoozes(user: requestContext.user),
              NativePreferences.context() == requestContext else { return }
        applyHydrated(loaded, ticket: ticket, context: requestContext)
    }

    /// Marks the start of one GET. Internal so the ordering is unit-testable.
    func beginHydration() -> HydrationClock.Ticket {
        hydrations.begin()
    }

    /// Replay local intent over the server's map. Internal so the merge is
    /// unit-testable; `persist` is off for the write path's own response.
    /// With a `ticket`, the map is applied only while that GET is still the
    /// newest and no write was confirmed since it began.
    func applyHydrated(
        _ loaded: [String: String],
        ticket: HydrationClock.Ticket? = nil,
        context requestContext: NativePreferences.Context? = nil,
        persist: Bool = true
    ) {
        if let ticket, !hydrations.isCurrent(ticket) { return }
        var merged = loaded
        for (key, change) in pending {
            switch change {
            case .set(let value): merged[key] = value
            case .remove: merged.removeValue(forKey: key)
            }
        }
        if merged != snoozes { snoozes = merged }
        hasHydrated = true
        if persist, !pending.isEmpty, let requestContext { save(context: requestContext) }
    }

    func value(for workspace: SidebarWorkspace, now: Date = Date()) -> String? {
        for key in matchingKeys(workspace) {
            let value = snoozes[key]
            if WorkspaceSnooze.isActive(value, now: now) { return value }
        }
        return nil
    }

    func isSnoozed(_ workspace: SidebarWorkspace, now: Date = Date()) -> Bool {
        value(for: workspace, now: now) != nil
    }

    func toggleSomeDay(_ workspace: SidebarWorkspace) {
        set(workspace, until: isSnoozed(workspace) ? nil : WorkspaceSnooze.someDay)
    }

    func set(_ workspace: SidebarWorkspace, until: String?) {
        let requestContext = NativePreferences.context()
        resetIfNeeded(requestContext)
        let rowKey = SidebarRowKeys.rowKey(for: workspace)
        guard SidebarRowKeys.isPersistable(rowKey) else { return }

        for key in matchingKeys(workspace) {
            snoozes.removeValue(forKey: key)
            pending[key] = .remove
        }
        if let until {
            snoozes[rowKey] = until
            pending[rowKey] = .set(until)
        }
        if hasHydrated { save(context: requestContext) }
    }

    private func matchingKeys(_ workspace: SidebarWorkspace) -> [String] {
        [SidebarRowKeys.rowKey(for: workspace)] + workspace.sessions.map(\.id)
    }

    /// Reconcile one successful delta response without dropping a newer local
    /// mutation that landed while that request was in flight. A GET still in
    /// flight may carry the pre-write map, so it is stale from here on.
    func applySaved(_ saved: [String: String], acknowledging captured: [String: Change]) {
        for (key, change) in captured where pending[key] == change {
            pending.removeValue(forKey: key)
        }
        hydrations.confirmWrite()
        applyHydrated(saved, persist: false)
    }

    private func save(context requestContext: NativePreferences.Context) {
        guard hasHydrated, !isSaving, !pending.isEmpty else { return }
        let captured = pending
        let set = captured.compactMapValues { change -> String? in
            if case .set(let value) = change { return value }
            return nil
        }
        let remove = captured.compactMap { key, change in
            if case .remove = change { return key }
            return nil
        }
        isSaving = true
        Task { [weak self] in
            let saved = try? await SettingsAPI.saveSnoozes(
                user: requestContext.user,
                set: set,
                remove: remove
            )
            guard let self,
                  self.context == requestContext,
                  NativePreferences.context() == requestContext else { return }
            self.isSaving = false
            guard let saved else { return }
            self.applySaved(saved, acknowledging: captured)
            self.save(context: requestContext)
        }
    }

    private func resetIfNeeded(_ next: NativePreferences.Context) {
        guard let context else {
            self.context = next
            return
        }
        guard context != next else { return }
        self.context = next
        snoozes = [:]
        pending = [:]
        hasHydrated = false
        isSaving = false
    }
}
