import Foundation

/// Per-user visibility for the session list's SOURCE rows — the sections fed by
/// something other than sessions. Plain is the only one the phone renders; the
/// web sidebar has more, and may gain others from an instance's feed config.
///
/// This is the same account-level preference the web band's right-click writes
/// (`sidebar-hidden-feeds`, see `src/frontend/lib/sidebar-feeds.ts`), so a
/// source hidden by a long press here is hidden in the browser too. The value
/// is a JSON array of feed ids, kept whole on every write: an id this build
/// never renders still belongs to the account, and dropping it would silently
/// restore a band the person hid in the browser.
///
/// Hiding a source stops its polling as well as its row — an off-screen queue
/// refreshing in the background is battery spent on something you asked not to
/// see. The way back is Settings → Appearance, which is also why hiding is
/// offered on the phone at all: the web only puts a tool's removal behind a
/// right-click because a phone can't reach the menu that restores it.
enum SidebarFeeds {
    /// The Plain support queue: the one source row this app DRAWS, named here
    /// because the row is built in Swift rather than from the descriptor. Which
    /// sources the account can show is a different question, and the server
    /// answers it (`/api/feeds`, see `sources(known:hidden:)`).
    static let plain = "plain"
    /// Product-facing name for the support queue. `plain` remains its wire id.
    static let supportTitle = "Support"

    /// A source this instance offers, as `/api/feeds` describes it. A tolerant
    /// subset of the server's `FeedDescriptor`: the rest of that shape names
    /// web surfaces this client has no equivalent of.
    struct Feed: Codable, Identifiable, Hashable, Sendable {
        let id: String
        let title: String?
    }

    /// One switch in Settings → Appearance.
    struct Source: Identifiable, Hashable, Sendable {
        let id: String
        /// The server's band title, or the id when nothing names it.
        let title: String
        /// True when only the hidden list knows this id.
        let unknown: Bool
    }

    /// The switches the Sources list should draw: every feed the server
    /// describes, then every hidden id it did not mention.
    ///
    /// That second half is the point. The hidden list belongs to the ACCOUNT
    /// and the browser writes it too, so an instance's feed hidden there would
    /// otherwise be stranded: no row on the phone to hide, and no row in
    /// Settings to bring back. An id nothing can name still gets a switch,
    /// because a source you cannot name beats a source you cannot restore.
    static func sources(known: [Feed], hidden json: String) -> [Source] {
        var rows: [Source] = []
        var seen = Set<String>()
        for feed in known {
            let id = feed.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { continue }
            let title = feed.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            rows.append(Source(
                id: id,
                title: (title?.isEmpty == false ? title : nil) ?? id,
                unknown: false
            ))
        }
        for id in decode(json) where seen.insert(id).inserted {
            rows.append(Source(id: id, title: id, unknown: true))
        }
        return rows
    }

    /// Mirrors the server pref into `@AppStorage`, like every other
    /// cross-device preference (`NativePreferences`).
    static let storageKey = "os1.sidebar.hiddenFeeds"
    static let prefKey = "sidebar-hidden-feeds"

    /// Hidden feed ids, in their stored order. Anything malformed reads as
    /// "nothing hidden": a source you can't see and can't explain is worse
    /// than one that came back.
    static func decode(_ json: String) -> [String] {
        guard let data = json.data(using: .utf8),
              let ids = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        var seen = Set<String>()
        return ids.compactMap { id in
            let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return id
        }
    }

    static func encode(_ ids: [String]) -> String {
        guard let data = try? JSONEncoder().encode(ids) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    static func isHidden(_ id: String, in json: String) -> Bool {
        decode(json).contains(id)
    }

    /// The list with one id set either way, every other id left exactly where
    /// it was. Returns the input unchanged when nothing moves, so a caller can
    /// use that to skip a needless write.
    static func setting(_ id: String, hidden: Bool, in json: String) -> String {
        var ids = decode(json)
        if hidden {
            guard !ids.contains(id) else { return encode(ids) }
            ids.append(id)
        } else {
            guard ids.contains(id) else { return encode(ids) }
            ids.removeAll { $0 == id }
        }
        return encode(ids)
    }
}

@MainActor
extension SidebarFeeds {
    static func isHidden(_ id: String) -> Bool {
        isHidden(id, in: UserDefaults.standard.string(forKey: storageKey) ?? "[]")
    }

    /// Write the local copy the list reads through `@AppStorage`, then push the
    /// same value to the account. Fire-and-forget like the web's own save and
    /// like `HideStore`: this is a preference, not work, so a failed PUT costs
    /// a second long press rather than an error banner.
    static func setVisible(_ id: String, _ visible: Bool) {
        let defaults = UserDefaults.standard
        let current = defaults.string(forKey: storageKey) ?? "[]"
        let next = setting(id, hidden: !visible, in: current)
        guard next != current else { return }
        defaults.set(next, forKey: storageKey)
        let user = ServerConfig.shared.userName
        Task {
            _ = try? await SettingsAPI.updateUiPrefs(user: user, prefs: [prefKey: next])
        }
    }
}
