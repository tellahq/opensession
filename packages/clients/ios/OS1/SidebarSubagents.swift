import Foundation

/// Whether a session's delegated workers are offered alongside it.
///
/// This is the account's `sidebar-subagents` ui-pref, the one the web writes
/// from Settings → Appearance → Show sub-agents
/// (`src/frontend/lib/sidebar-subagents-pref.ts`). The web nests worker
/// sessions under the selected workspace row; this app has no nested rows, so
/// the same choice governs the parent session's "Delegated workers" menu, the
/// native place those workers are reached from. Hiding removes that menu and
/// nothing else: a hidden worker never becomes a top-level row
/// (`Session.belongsInList` is untouched), and a direct link to it, or a
/// `Task` row's transcript sheet, still opens.
enum SidebarSubagents {
    static let storageKey = "os1.sidebar.subagents"
    static let prefKey = "sidebar-subagents"

    /// The web's "show"/"hide" pair. Unknown values are nil so a newer client
    /// cannot hide workers by accident.
    static func shown(_ value: String?) -> Bool? {
        switch value {
        case "show": true
        case "hide": false
        default: nil
        }
    }

    static func encode(_ shown: Bool) -> String {
        shown ? "show" : "hide"
    }

    /// The workers a parent session offers, given the preference.
    static func menuWorkers(_ workers: [Session], shown: Bool) -> [Session] {
        shown ? workers : []
    }
}

@MainActor
extension SidebarSubagents {
    static var isShown: Bool {
        UserDefaults.standard.object(forKey: storageKey) as? Bool ?? true
    }

    /// Write the local copy the views read through `@AppStorage`, then push the
    /// same value to the account.
    static func setShown(_ shown: Bool) {
        let defaults = UserDefaults.standard
        guard shown != isShown else { return }
        defaults.set(shown, forKey: storageKey)
        let context = NativePreferences.context()
        NativePreferences.beginLocalWrite()
        Task {
            defer { NativePreferences.endLocalWrite() }
            guard let prefs = try? await SettingsAPI.updateUiPrefs(
                user: context.user,
                prefs: [prefKey: encode(shown)]
            ) else { return }
            NativePreferences.apply(prefs, for: context)
        }
    }
}
