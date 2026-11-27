import Foundation

/// The model menus' top level: five models, in the order the person dragged
/// them into on the web (`top-model-order`), with the rest of the catalog one
/// hop away under "More models", grouped by provider.
///
/// Which five follows the person's recent picks (`recent-models`), with the
/// curated best filling the slots they leave. Menus can't drag, so this app
/// reads the synced order and never writes it; picks it records itself.
enum TopModels {
    /// How many models a menu lists at its top level.
    static let count = 5

    /// The best current models, by id tail. Mirrors `TOP_MODEL_TAILS` in the
    /// web's `src/frontend/components/ModelEffortSelect.tsx`: change both
    /// together when a model ships or retires.
    static let curatedTails = [
        "claude-fable-5-2",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "gpt-6.2-astra",
        "gpt-6.2-sol",
    ]

    /// Synced ui-pref the web writes when the five are dragged.
    static let prefKey = "top-model-order"
    /// The local cache `NativePreferences` hydrates and the menus read.
    static let storageKey = "os1.models.topOrder"

    /// Synced ui-pref of models picked from a model menu: a JSON list of id
    /// tails, newest first. The web's `lib/model-recents.ts`.
    static let recentPrefKey = "recent-models"
    /// Its local cache, the same JSON.
    static let recentStorageKey = "os1.models.recent"
    /// Kept beyond the five shown so a smaller catalog still fills the top.
    static let recentLimit = 12

    /// Stored form ("claude-opus-5-5,gpt-6.2-sol") to tails, trimmed, with
    /// blanks and repeats dropped and the first occurrence's place kept. The
    /// web's `decodeTopModelOrder`.
    static func decodeOrder(_ raw: String?) -> [String] {
        guard let raw else { return [] }
        var seen = Set<String>()
        return raw.split(separator: ",", omittingEmptySubsequences: false).compactMap { part in
            let tail = part.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !tail.isEmpty, seen.insert(tail).inserted else { return nil }
            return tail
        }
    }

    /// What `NativePreferences` stores: the cleaned list, or nil for a value
    /// it can't use so the cache keeps the default.
    static func normalized(_ raw: String?) -> String? {
        guard let raw else { return nil }
        return decodeOrder(raw).joined(separator: ",")
    }

    static func tail(_ id: String) -> String {
        id.split(separator: "/").last.map(String.init) ?? id
    }

    /// Stored recents to tails, newest first, without blanks or repeats; nil
    /// when the value is not a JSON list. Full ids an earlier web menu stored
    /// read as their tails. The web's `decodeRecentModels`.
    static func decodeRecent(_ raw: String?) -> [String]? {
        guard let data = raw?.data(using: .utf8),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
        else { return nil }
        var seen = Set<String>()
        let tails = list.compactMap { item -> String? in
            guard let id = item as? String else { return nil }
            let value = tail(id.trimmingCharacters(in: .whitespacesAndNewlines))
            guard !value.isEmpty, seen.insert(value).inserted else { return nil }
            return value
        }
        return Array(tails.prefix(recentLimit))
    }

    static func encodeRecent(_ tails: [String]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: tails),
              let text = String(data: data, encoding: .utf8)
        else { return "[]" }
        return text
    }

    /// What `NativePreferences` stores for the recents, or nil to keep the
    /// default.
    static func normalizedRecent(_ raw: String?) -> String? {
        decodeRecent(raw).map(encodeRecent)
    }

    /// `tails` with `id`'s tail moved to the front. The web's `addRecentModel`.
    static func addRecent(_ tails: [String], _ id: String) -> [String] {
        let value = tail(id)
        let rest = tails.filter { $0 != value }
        return Array((value.isEmpty ? rest : [value] + rest).prefix(recentLimit))
    }

    /// Record a pick from a model menu here at once, then sync the account's
    /// pref so the web and other devices list it too.
    @MainActor
    static func recordPick(_ id: String) {
        let defaults = UserDefaults.standard
        let current = decodeRecent(defaults.string(forKey: recentStorageKey)) ?? []
        let next = addRecent(current, id)
        guard next != current else { return }
        let encoded = encodeRecent(next)
        defaults.set(encoded, forKey: recentStorageKey)
        guard ServerConfig.shared.isConfigured else { return }
        let requestContext = NativePreferences.context()
        NativePreferences.beginLocalWrite()
        Task {
            defer { NativePreferences.endLocalWrite() }
            guard var confirmed = try? await SettingsAPI.updateUiPrefs(
                user: requestContext.user,
                prefs: [recentPrefKey: encoded]
            ) else { return }
            // A newer pick made while this one was in flight wins locally.
            confirmed[recentPrefKey] = UserDefaults.standard.string(forKey: recentStorageKey) ?? encoded
            _ = NativePreferences.apply(confirmed, for: requestContext)
        }
    }

    /// Split a catalog into the top-level five and the rest. `recent` (tails,
    /// newest first) decides which five: recent picks come in first, and the
    /// curated best, then the catalog's own order, fill what is left, so the
    /// top level is never short while models remain. The five are listed in
    /// a fixed order so a pick never moves the rows: `order` first, then
    /// curated, then catalog order. The web's `pickTopModels`.
    static func split(
        _ options: [ModelOption], order: [String] = [], recent: [String] = []
    ) -> (top: [ModelOption], more: [ModelOption]) {
        let byTails = { (tails: [String]) in
            tails.compactMap { wanted in options.first { tail($0.id) == wanted } }
        }
        let curated = byTails(curatedTails)
        let curatedIDs = Set(curated.map(\.id))
        let best = curated + options.filter { !curatedIDs.contains($0.id) }
        var chosen = Set<String>()
        for option in byTails(recent) + best where chosen.count < count {
            chosen.insert(option.id)
        }
        let rank = { (option: ModelOption) in
            order.firstIndex(of: tail(option.id)) ?? order.count
        }
        let top = best.filter { chosen.contains($0.id) }.enumerated()
            .sorted { a, b in
                let (ra, rb) = (rank(a.element), rank(b.element))
                return ra != rb ? ra < rb : a.offset < b.offset
            }
            .map(\.element)
        return (top, options.filter { !chosen.contains($0.id) })
    }

    /// One "More models" section.
    struct ProviderGroup: Identifiable, Equatable {
        let id: String
        let label: String
        var options: [ModelOption]
    }

    /// Section order, the web's `PROVIDER_ORDER`; unlisted providers follow in
    /// catalog order.
    private static let providerOrder = [
        "anthropic", "openai", "xai-oauth", "pi", "cerebras", "wafer", "xai", "meta", "moonshotai",
    ]

    /// Display names, the web's `PROVIDER_LABELS`; anything else is
    /// capitalized.
    private static let providerLabels = [
        "anthropic": "Anthropic",
        "openai": "OpenAI",
        "pi": "Pi",
        "xai-oauth": "xAI SuperGrok",
        "xai": "xAI",
        "meta": "Meta",
        "google": "Google",
        "openrouter": "OpenRouter",
        "groq": "Groq",
        "mistral": "Mistral",
        "deepseek": "DeepSeek",
        "moonshotai": "Moonshot AI",
    ]

    /// The upstream provider an id routes to: the segment after `pi/`, the
    /// way the web reads it, so presets land under their own head ("dial").
    static func provider(_ id: String) -> String {
        let routed = ModelCatalog.routedID(id, engine: "pi") ?? id
        guard routed.hasPrefix("pi/") else { return "other" }
        let rest = routed.dropFirst(3)
        guard let slash = rest.firstIndex(of: "/"), slash > rest.startIndex else { return "other" }
        return String(rest[..<slash])
    }

    /// "More models" in sections by provider, in the web's order.
    static func providerGroups(_ options: [ModelOption]) -> [ProviderGroup] {
        var groups: [ProviderGroup] = []
        for option in options {
            let key = provider(option.id)
            if let index = groups.firstIndex(where: { $0.id == key }) {
                groups[index].options.append(option)
            } else {
                let label = providerLabels[key] ?? (key.prefix(1).uppercased() + key.dropFirst())
                groups.append(ProviderGroup(id: key, label: label, options: [option]))
            }
        }
        let rank = { (key: String) in providerOrder.firstIndex(of: key) ?? providerOrder.count }
        return groups.enumerated()
            .sorted { a, b in
                let (ra, rb) = (rank(a.element.id), rank(b.element.id))
                return ra != rb ? ra < rb : a.offset < b.offset
            }
            .map(\.element)
    }
}

extension ModelCatalog {
    /// The catalog as the menus list it, top five first. Regular models fill
    /// a gap in the five before presets do.
    func topModels(
        order: [String], recent: [String] = []
    ) -> (top: [ModelOption], more: [ModelOption]) {
        TopModels.split(regular + presets, order: order, recent: recent)
    }
}
