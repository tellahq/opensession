import Foundation

/// What a tool row says, as one plain phrase: "Read ToolCallRow.swift",
/// "Edited 3 files", "Publish walkthrough", or a shell call's own command.
///
/// The row used to name the tool ("Bash", "Walkthrough · Publish") and then
/// print its arguments beside it ("summary: Built-in ba…"). On a phone that
/// was two or three tones of gray to say one thing, and the glyph already
/// names the kind of call. The full command, path and arguments are one tap
/// away in the row's detail.
struct ToolRowTitle: Equatable {
    var title: String
    /// A quiet second part, only where the title alone would hide what
    /// changed: the plan's progress, an unknown tool's argument.
    var detail: String?
}

extension ToolPresentation {
    var rowTitle: ToolRowTitle {
        if mcpServer != nil { return mcpRowTitle }
        switch canonical {
        case "Bash":
            return ToolRowTitle(title: summary.isEmpty ? "Ran a command" : summary)
        case "BashOutput":
            return ToolRowTitle(title: "Checked on a command")
        case "KillShell":
            return ToolRowTitle(title: "Stopped a command")
        case "Codemode":
            return ToolRowTitle(title: "Ran a script")
        case "Read", "NotebookEdit":
            return ToolRowTitle(title: phrase("Read", files: "files"))
        case "Write":
            return ToolRowTitle(title: phrase("Wrote", files: "files"))
        case "Edit", "FileChange":
            return ToolRowTitle(title: phrase("Edited", files: "files"))
        case "Grep":
            return ToolRowTitle(title: phrase("Searched for", object: Self.grepPattern(summary)))
        case "Glob", "Find":
            return ToolRowTitle(title: phrase("Found files", object: summary))
        case "ToolSearch":
            return ToolRowTitle(title: "Looked up tools")
        case "WebFetch":
            return ToolRowTitle(title: phrase("Read", object: Self.host(summary)))
        case "WebSearch":
            return ToolRowTitle(title: phrase("Searched the web for", object: summary))
        case "Task", "Agent":
            let description = summary.split(separator: ":", maxSplits: 1).last
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            return ToolRowTitle(title: description.isEmpty ? "Started an agent" : description)
        case "Workflow":
            return ToolRowTitle(title: "Ran a workflow", detail: nonEmpty(summary))
        case "Skill":
            return ToolRowTitle(title: summary.isEmpty ? "Loaded a skill" : "Loaded \(summary)")
        case "TodoWrite", "TaskUpdate":
            return ToolRowTitle(title: "Updated the plan", detail: nonEmpty(summary))
        case "TaskCreate":
            return ToolRowTitle(title: phrase("Added", object: summary, fallback: "a task"))
        case "TaskList", "TaskGet":
            return ToolRowTitle(title: "Checked the plan")
        case "EnterWorktree":
            return ToolRowTitle(title: "Entered a worktree")
        case "ExitWorktree":
            return ToolRowTitle(title: "Left the worktree")
        default:
            return ToolRowTitle(title: label, detail: nonEmpty(summary))
        }
    }

    /// An MCP call reads as its action: "Publish walkthrough", "Start
    /// portal". Open Session's own servers drop their scope, since every
    /// row in the fold would repeat it; another service keeps its name in
    /// front ("Linear · List issues"), which is the one part worth saying.
    /// Arguments never ride on the row.
    private var mcpRowTitle: ToolRowTitle {
        if summaryIsPath, !summary.isEmpty {
            return ToolRowTitle(title: "Saved \(Self.basename(summary))")
        }
        let action = Self.mcpToolDisplayName(name)
        guard let server = mcpServer,
              !server.lowercased().hasPrefix("opensession"),
              server.lowercased() != "mcp"
        else { return ToolRowTitle(title: action) }
        return ToolRowTitle(title: "\(Self.mcpServerDisplayName(server)) · \(action)")
    }

    /// "Read ToolCallRow.swift", or "Edited 3 files" when a patch named
    /// several. The directory stays in the detail, where there is room.
    private func phrase(_ verb: String, files: String) -> String {
        let paths = Set(touchedFiles.map(\.path))
        if paths.count > 1 { return "\(verb) \(paths.count) \(files)" }
        if let only = paths.first { return "\(verb) \(Self.basename(only))" }
        if summaryIsPath, !summary.isEmpty, !summary.contains("  ·  ") {
            return "\(verb) \(Self.basename(summary))"
        }
        return summary.isEmpty ? "\(verb) a file" : "\(verb) \(summary)"
    }

    private func phrase(_ verb: String, object: String, fallback: String? = nil) -> String {
        if !object.isEmpty { return "\(verb) \(object)" }
        return fallback.map { "\(verb) \($0)" } ?? verb
    }

    private func nonEmpty(_ value: String) -> String? {
        value.isEmpty ? nil : value
    }

    static func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// The pattern out of "/needle/ src", which is how the summary writes a
    /// grep with its path.
    static func grepPattern(_ summary: String) -> String {
        guard summary.hasPrefix("/"), summary.count > 2 else { return summary }
        let body = summary.dropFirst()
        let end = body.range(of: "/ ")?.lowerBound
            ?? (body.hasSuffix("/") ? body.index(before: body.endIndex) : nil)
        guard let end else { return summary }
        let pattern = body[body.startIndex..<end]
        return pattern.isEmpty ? summary : "“\(pattern)”"
    }

    static func host(_ value: String) -> String {
        URL(string: value)?.host().map { $0.replacingOccurrences(of: "www.", with: "") } ?? value
    }
}
