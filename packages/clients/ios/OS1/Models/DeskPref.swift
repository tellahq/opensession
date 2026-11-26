import Foundation

/// Whether the Desk shows at all: its toolbar buttons and the command
/// palette's "Open the Desk". The web's `desk` pref (`lib/desk-pref.ts`), same
/// key and "on"/"off" values, so the choice follows the person across
/// clients. Off by default; switched in Settings → Preferences → Desk.
///
/// An explicit request still opens the Desk with it off: "Talk to Desk" from
/// Siri, Shortcuts or the Action Button, the call's Live Activity, and a Desk
/// reminder tapped in the inbox. Those are the person asking for it by name,
/// not an entry point sitting in the way.
enum DeskPref {
    static let prefKey = "desk"
    static let storageKey = "os1.desk.shown"
    static let standard = false

    /// "on" / "off" as the web writes them. Anything else is no answer, so a
    /// newer client's value cannot flip the Desk by accident.
    static func decode(_ value: String?) -> Bool? {
        switch value {
        case "on": true
        case "off": false
        default: nil
        }
    }

    static func encode(_ on: Bool) -> String { on ? "on" : "off" }

    /// This device's cached answer.
    static var isOn: Bool {
        UserDefaults.standard.object(forKey: storageKey) as? Bool ?? standard
    }

    /// Flip it here at once, then sync the account's pref so the browser and
    /// other devices follow. Hydration holds off while the write is in
    /// flight, so a poll cannot repaint the old value over it.
    @MainActor
    static func set(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: storageKey)
        guard ServerConfig.shared.isConfigured else { return }
        let requestContext = NativePreferences.context()
        NativePreferences.beginLocalWrite()
        Task {
            defer { NativePreferences.endLocalWrite() }
            guard var confirmed = try? await SettingsAPI.updateUiPrefs(
                user: requestContext.user,
                prefs: [prefKey: encode(on)]
            ) else { return }
            // A newer flip made while this one was in flight wins locally.
            confirmed[prefKey] = encode(isOn)
            _ = NativePreferences.apply(confirmed, for: requestContext)
        }
    }
}
