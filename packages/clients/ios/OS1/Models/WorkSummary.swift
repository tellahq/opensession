import Foundation

/// What a run of tool calls did, as a sentence: "Ran 3 commands, read 2
/// files, edited 1 file". A count of steps says how much happened; this says
/// what, which is the question a folded run is asked. Mirrors the web's
/// `workSummary` (`frontend/lib/work-summary.ts`).
///
/// Families, not tool names: three engines name the same tool three ways.
/// Clauses keep the order the work first happened in, so the sentence reads
/// the way the turn went. Failures are left to the call's own row.
enum WorkSummary {
    private enum Kind: Hashable {
        case run, file, edit, find, web, agent, skill, checklist, tool, followUp
    }

    /// Waiting on or stopping a background command is not another command
    /// run: five looks at one build are one command checked on.
    private static let followUps: Set<String> = ["BashOutput", "KillShell"]

    /// The sentence standing on its own line, capitalized. Empty when the run
    /// made no tool calls.
    static func title(_ items: [ToolCallItem]) -> String {
        let text = sentence(items)
        guard let first = text.first else { return "" }
        return first.uppercased() + text.dropFirst()
    }

    /// The sentence in lower case, so it can follow other text.
    static func sentence(_ items: [ToolCallItem]) -> String {
        var order: [Kind] = []
        var calls: [Kind: Int] = [:]
        var named: [Kind: Set<String>] = [:]
        var unnamed: [Kind: Int] = [:]

        for item in items {
            let presentation = item.presentation
            let kind = kind(of: presentation)
            if calls[kind] == nil { order.append(kind) }
            calls[kind, default: 0] += 1
            switch kind {
            case .file, .edit:
                let paths = presentation.touchedFiles.map(\.path)
                if !paths.isEmpty {
                    named[kind, default: []].formUnion(paths)
                } else if presentation.summaryIsPath, !presentation.summary.isEmpty {
                    named[kind, default: []].insert(presentation.summary)
                } else {
                    unnamed[kind, default: 0] += 1
                }
            case .followUp:
                if presentation.summary.isEmpty {
                    unnamed[kind, default: 0] += 1
                } else {
                    named[kind, default: []].insert(presentation.summary)
                }
            default:
                break
            }
        }

        return order.map { kind in
            // Four passes over one file are one file edited. A call that
            // names no file still counts, so a clause is never "0 files".
            let count: Int
            switch kind {
            case .file, .edit, .followUp:
                count = (named[kind]?.count ?? 0) + (unnamed[kind] ?? 0)
            default:
                count = calls[kind] ?? 0
            }
            return clause(kind, count: count)
        }.joined(separator: ", ")
    }

    private static func kind(of presentation: ToolPresentation) -> Kind {
        if followUps.contains(presentation.canonical) { return .followUp }
        switch presentation.family {
        case .run: return .run
        case .file: return .file
        case .edit: return .edit
        case .find: return .find
        case .web: return .web
        case .agent: return .agent
        case .skill: return .skill
        case .checklist: return .checklist
        case .mcp, .branch, .other: return .tool
        }
    }

    private static func clause(_ kind: Kind, count: Int) -> String {
        switch kind {
        case .run: "ran \(plural(count, "command"))"
        case .file: "read \(plural(count, "file"))"
        case .edit: "edited \(plural(count, "file"))"
        case .find: "ran \(plural(count, "search", "searches"))"
        case .web: "read \(plural(count, "web page"))"
        case .agent: "started \(plural(count, "agent"))"
        case .skill: "loaded \(plural(count, "skill"))"
        case .checklist: "updated the plan"
        case .tool: "called \(plural(count, "tool"))"
        case .followUp: "checked on \(plural(count, "command"))"
        }
    }

    private static func plural(_ count: Int, _ one: String, _ many: String? = nil) -> String {
        "\(count) \(count == 1 ? one : (many ?? one + "s"))"
    }
}
