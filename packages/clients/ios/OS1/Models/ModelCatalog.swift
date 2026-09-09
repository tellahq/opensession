import Foundation

/// One row from `GET /api/models` — a pickable model or preset. Tolerant
/// decoding (everything but `id` optional) so server additions never break us.
struct ModelOption: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String?
    var provider: String?
    /// Picker section override: "dial" / "orchestrator" presets.
    var group: String?
    /// One-line subtitle (dial/orchestrator presets only today).
    var description: String?
    /// Reasoning-effort variants this model supports (may be empty — presets).
    var efforts: [String]?
    var fastModeSupported: Bool?
    /// The subscription pool this model spends from ("claude", "codex",
    /// "xai"), or nil for a model without a managed account pool.
    var accountProvider: String?
    /// A preset's member models, lead first. The pool a preset draws on is
    /// its lead's.
    var composition: [String]?

    var displayLabel: String { label ?? id }
    var isPreset: Bool { group != nil }
}

/// One execution engine from `GET /api/models`. `available` is optional so an
/// older server that only sent an id and label still leaves the engine usable.
struct ModelEngineOption: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var label: String
    var available: Bool?

    var isAvailable: Bool { available != false }
}

/// `GET /api/models`: the pickable catalog, interactive default, and the
/// routing choices that can carry each model.
struct ModelCatalog: Decodable, Sendable {
    var models: [ModelOption]
    var defaultModel: String?
    var engines: [ModelEngineOption]?
    var modelEngines: [String: String]?

    enum CodingKeys: String, CodingKey {
        case models
        case defaultModel = "default"
        case engines
        case modelEngines
    }

    var presets: [ModelOption] { models.filter(\.isPreset) }
    var regular: [ModelOption] { models.filter { !$0.isPreset } }
    var availableEngines: [ModelEngineOption] {
        (engines ?? [ModelEngineOption(id: "pi", label: "Pi", available: true)])
            .filter(\.isAvailable)
    }

    private static let presetHeads = ["dial/", "orchestrator/", "workspace-preset/"]
    private static func isPresetID(_ id: String) -> Bool {
        presetHeads.contains { id.hasPrefix($0) }
    }

    static func engine(_ id: String) -> String { "pi" }
    static func baseID(_ id: String) -> String { id }

    static func routedID(_ id: String, engine: String) -> String? {
        guard engine == "pi", !id.isEmpty else { return nil }
        if id.hasPrefix("pi/") { return id }
        if isPresetID(id) { return "pi/\(id)" }
        if id.hasPrefix("claude-") { return "pi/anthropic/\(id)" }
        if id.hasPrefix("gpt-") || id.hasPrefix("codex-") {
            return "pi/openai/\(id)"
        }
        return id.contains("/") ? "pi/\(id)" : nil
    }

    static func vendor(_ id: String) -> String? {
        let tail = id.hasPrefix("pi/") ? String(id.dropFirst(3)) : id
        if isPresetID(tail) { return nil }
        return tail.split(separator: "/", maxSplits: 1).count == 2
            ? String(tail.split(separator: "/", maxSplits: 1)[0])
            : nil
    }

    static func engineKey(_ id: String) -> String {
        let tail = id.hasPrefix("pi/") ? String(id.dropFirst(3)) : id
        if isPresetID(tail) { return tail }
        guard let slash = tail.firstIndex(of: "/") else { return tail }
        return String(tail[tail.index(after: slash)...])
    }

    func routingEngine(for id: String) -> String { "pi" }

    func preferredID(_ id: String, engine: String) -> String {
        guard engine.isEmpty || engine == "pi" else { return id }
        return Self.routedID(id, engine: "pi") ?? id
    }

    func option(for id: String?) -> ModelOption? {
        guard let id, !id.isEmpty else { return nil }
        let base = Self.baseID(id)
        return models.first { $0.id == base }
    }

    /// Short human label for a model id ("Sonnet 5", "Medium"), falling back
    /// to the id's last path segment for ids the catalog doesn't know.
    func label(for id: String?) -> String {
        guard let id, !id.isEmpty else { return "Default" }
        if let option = option(for: id) { return option.displayLabel }
        return id.components(separatedBy: "/").last ?? id
    }
}

/// Display names for the server's reasoning-effort levels.
enum EffortLevel {
    static func label(_ effort: String) -> String {
        switch effort {
        case "none": "None"
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh": "Extra high"
        case "max": "Max"
        default: effort.capitalized
        }
    }
}
