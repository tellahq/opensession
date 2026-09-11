import Foundation

/// Answers a `user_map_changed` socket frame: one of this person's sidebar
/// maps (lanes, snoozes, hides) was written from another client, so the
/// matching store re-reads it and the sessions list refetches its rows.
///
/// The stores otherwise re-hydrate only at launch, on foreground, and every
/// 30 seconds while active. A Mac window that stays in front never
/// foregrounds, so a workspace claimed on the phone kept computing
/// `claimed == false` there and filed the row as outside until the next tick.
/// The frame carries no entries; the GET stays the authority, and each
/// store's hydrate already replays pending local writes over the response.
@MainActor
enum UserMapSync {
    /// Posted after a store re-read its map. The sessions list refetches on
    /// it: lanes, snoozes and hides decide which rows the scoped list holds.
    static let didResyncNotification = Notification.Name("os1.userMapResynced")

    /// The server names the person the way it resolved them (verified sign-in
    /// or picker name); the local picker name may differ in case or padding.
    /// Another person's write is never ours to fetch.
    nonisolated static func isSameUser(_ user: String, as current: String) -> Bool {
        let wanted = user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { return false }
        return wanted == current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Route one frame from the ACTIVE account's socket. Callers scope it to
    /// that account already; this scopes it to the account's user.
    static func receive(map: UserMapName, user: String) async {
        guard isSameUser(user, as: NativePreferences.context().user) else { return }
        switch map {
        case .lanes: await LaneStore.shared.hydrate()
        case .snoozes: await WorkspaceSnoozeStore.shared.hydrate()
        case .hides: await HideStore.shared.hydrate()
        }
        NotificationCenter.default.post(name: didResyncNotification, object: map)
    }
}
