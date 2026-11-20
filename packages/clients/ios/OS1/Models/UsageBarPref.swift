import Foundation

/// Whether the composer carries the usage bar: context, spend, the account's
/// limits and which account the session runs on, in one strip above the
/// field. The web's `usage-bar` pref (`lib/usage-bar-pref.ts`), same key and
/// "on"/"off" values, so the choice follows the person across clients. Off
/// by default; switched from the model menu or Settings → Preferences.
enum UsageBarPref {
    static let prefKey = "usage-bar"
    static let storageKey = "os1.composer.usageBar"
    static let standard = false

    /// "on" / "off" as the web writes them. Anything else is no answer, so a
    /// newer client's value cannot flip the bar by accident.
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
        let defaults = UserDefaults.standard
        defaults.set(on, forKey: storageKey)
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
