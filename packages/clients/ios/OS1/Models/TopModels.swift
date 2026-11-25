import Foundation

/// The model menus' top level: five curated models, in the order the person
/// dragged them into on the web (`top-model-order`), with the rest of the
/// catalog one hop away under "More models", grouped by provider.
///
/// Which five is curated here; only their order is the person's. Menus can't
/// drag, so this app reads the synced order and never writes it.
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

    /// Split a catalog into the top-level five and the rest. The curated five
    /// come first; a catalog missing some of them fills the gap from its own
    /// order, so the top level is never short while models remain. `order`
    /// reorders the five but never changes which five they are; a model it
    /// does not name keeps its curated place after the ones it does.
    static func split(
        _ options: [ModelOption], order: [String] = []
    ) -> (top: [ModelOption], more: [ModelOption]) {
        let curated = curatedTails.compactMap { wanted in
            options.first { tail($0.id) == wanted }
        }
        let curatedIDs = Set(curated.map(\.id))
        let picked = Array((curated + options.filter { !curatedIDs.contains($0.id) }).prefix(count))
        let rank = { (option: ModelOption) in
            order.firstIndex(of: tail(option.id)) ?? order.count
        }
        let top = picked.enumerated()
            .sorted { a, b in
                let (ra, rb) = (rank(a.element), rank(b.element))
                return ra != rb ? ra < rb : a.offset < b.offset
            }
            .map(\.element)
        let topIDs = Set(top.map(\.id))
        return (top, options.filter { !topIDs.contains($0.id) })
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
    func topModels(order: [String]) -> (top: [ModelOption], more: [ModelOption]) {
        TopModels.split(regular + presets, order: order)
    }
}
