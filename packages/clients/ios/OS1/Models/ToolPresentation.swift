import Foundation

/// Canonical tool identity for the transcript. Current servers provide these
/// facts on `TranscriptEntry.presentation`; the local derivation below remains
/// the tolerant compatibility path for older servers and unknown metadata.
///
/// Built once per entry in the view model's display pass — never inside a
/// view `body`, where it would re-run for every visible row on each update.
struct ToolPresentation: Equatable, Sendable {
    /// Canonical tool name ("Bash", "Read", "Edit"), or the raw name when the
    /// tool isn't one we know.
    var canonical: String
    /// MCP server for `mcp__linear__list_issues` style names ("linear").
    var mcpServer: String?
    /// What the row labels the call: the bare tool name for MCP calls (the
    /// server rides beside it), else the canonical name. This stays raw for
    /// behavioral checks; `label` is the human-facing form.
    var name: String
    var family: ToolFamily
    /// One-line description of what the call is doing. May be empty.
    var summary: String
    /// The summary is a filesystem path, so the row dims the directory part.
    var summaryIsPath: Bool
    /// Lines added/removed by an Edit or Write, when derivable from the input.
    var lineStats: ToolLineStats?
    /// Files this call touched, for the turn footer's chips.
    var touchedFiles: [TouchedFile]

    var serverLabel: String? {
        mcpServer.map(Self.mcpServerDisplayName)
    }

    var label: String {
        mcpServer == nil ? name : Self.mcpToolDisplayName(name)
    }

    /// Derived once in the display pass, not while SwiftUI redraws a row.
    var hierarchy: [String] = []

    /// The hierarchy a row renders, with the repeated Open Session scope split
    /// from its server and removed from the action where possible.
    var labelParts: [String] { hierarchy.isEmpty ? [label] : hierarchy }

    /// Full label used in rows, collapsed previews and accessibility.
    var displayName: String { labelParts.joined(separator: " · ") }
}

/// The icon buckets. One glyph per family is what makes a collapsed turn
/// legible at a glance ("terminal, pencil, pencil, magnifier" reads as
/// "ran something, edited twice, searched").
enum ToolFamily: String, Equatable, Sendable, CaseIterable {
    case run, file, edit, find, web, agent, mcp, skill, branch, checklist, other

    var symbol: String {
        switch self {
        case .run: "terminal"
        case .file: "doc.text"
        case .edit: "pencil"
        case .find: "magnifyingglass"
        case .web: "globe"
        case .agent: "sparkles"
        case .mcp: "powerplug"
        case .skill: "book"
        case .branch: "arrow.triangle.branch"
        case .checklist: "checklist"
        case .other: "wrench.and.screwdriver"
        }
    }
}

struct ToolLineStats: Equatable, Sendable {
    var additions: Int = 0
    var deletions: Int = 0

    var isEmpty: Bool { additions == 0 && deletions == 0 }

    static func + (lhs: ToolLineStats, rhs: ToolLineStats) -> ToolLineStats {
        ToolLineStats(
            additions: lhs.additions + rhs.additions,
            deletions: lhs.deletions + rhs.deletions
        )
    }
}

/// A file a turn touched, with its line counts — the turn footer's chips.
struct TouchedFile: Equatable, Sendable, Identifiable {
    var path: String
    var additions: Int
    var deletions: Int
    /// Unified-diff hunks for this file, so a chip can show WHAT changed
    /// rather than only how much. Empty for tools that report paths without
    /// content (Bash, FileChange).
    var hunks: [String] = []

    var id: String { path }

    var basename: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// The name's extension, lowercased, or "" when it has none. This is what
    /// the badge keys its mark and its hue on, NOT the display label below: a
    /// label is capped at four characters, so keying colour on it meant
    /// `.swift` arrived as "SWI" and Swift files wore the fallback grey.
    var ext: String { LangMark.ext(of: basename) }

    /// The badge's letters, for a file whose language has no brand mark.
    var extensionBadge: String { LangMark.label(for: ext) }
}

extension ToolPresentation {
    /// Engine dialects that mean the same tool. Mirrors the web's
    /// `TOOL_ALIASES` so both clients name a call the same way.
    private static let aliases: [String: String] = [
        "read": "Read", "view_image": "Read",
        "write": "Write",
        "edit": "Edit", "multiedit": "Edit", "patch": "Edit", "apply_patch": "Edit",
        "str_replace_editor": "Edit",
        "bash": "Bash", "shell": "Bash", "exec_command": "Bash",
        "notebook_edit": "NotebookEdit",
        "grep": "Grep",
        "find": "Find",
        "glob": "Glob", "list": "Glob", "ls": "Glob",
        "webfetch": "WebFetch", "web_fetch": "WebFetch",
        "websearch": "WebSearch", "web_search": "WebSearch",
        "task": "Task", "skill": "Skill",
        "todowrite": "TodoWrite", "todoread": "TodoWrite", "update_plan": "TodoWrite",
    ]

    /// Names that look like `server_tool` but are native tools, not MCP.
    private static let nativeTools: Set<String> = [
        "invalid", "oracle", "exit_plan_mode", "notebook_edit", "web_search",
        "web_fetch", "str_replace_editor", "update_plan", "apply_patch",
        "exec_command", "view_image",
    ]

    private static let families: [String: ToolFamily] = [
        "Bash": .run, "BashOutput": .run,
        "Read": .file, "NotebookEdit": .file,
        "Edit": .edit, "Write": .edit, "FileChange": .edit,
        "Grep": .find, "Find": .find, "Glob": .find, "LSP": .find, "ToolSearch": .find,
        "WebFetch": .web, "WebSearch": .web,
        "Task": .agent, "Agent": .agent, "Workflow": .agent,
        "Skill": .skill,
        "EnterWorktree": .branch, "ExitWorktree": .branch,
        "TaskCreate": .checklist, "TaskUpdate": .checklist, "TaskList": .checklist,
        "TaskGet": .checklist, "TodoWrite": .checklist,
    ]

    /// Server-internal input keys the transcript never shows.
    private static let hiddenInputKeys: Set<String> = ["__bks_oc_session"]

    private static let identifierNames: [String: String] = [
        "api": "API",
        "github": "GitHub",
        "ios": "iOS",
        "mcp": "MCP",
        "opensession": "Open Session",
        "posthog": "PostHog",
        "sql": "SQL",
        "tella": "Tella",
        "url": "URL",
        "workos": "WorkOS",
    ]

    static func make(
        toolName: String?,
        input: JSONValue?,
        server: TranscriptToolPresentation? = nil,
        worktreeDir: String? = nil
    ) -> ToolPresentation {
        let outerRaw = (toolName ?? "tool").trimmingCharacters(in: .whitespaces)
        let resolved = resolveCall(toolName: outerRaw, input: input)
        let raw = resolved.toolName
        let callInput = resolved.input
        let fallbackMcp = parseMcpTool(raw)
        let fallbackCanonical = fallbackMcp == nil ? canonicalName(raw) : raw
        let canonical = nonempty(server?.canonical) ?? fallbackCanonical
        let mcpServer = nonempty(server?.mcpServer) ?? fallbackMcp?.server
        let name = nonempty(server?.name) ?? fallbackMcp?.tool ?? canonical
        let fallbackFamily: ToolFamily = mcpServer != nil
            ? .mcp
            : (families[canonical] ?? .other)
        let family = server?.family.flatMap(ToolFamily.init(rawValue:)) ?? fallbackFamily
        let localSummary = summarize(
            canonical: canonical,
            isMcp: mcpServer != nil,
            input: callInput,
            worktreeDir: worktreeDir
        )
        let (summary, isPath) = serverSummary(
            server?.detail,
            textIsPath: mcpServer == "opensession-assets" && name == "write_asset",
            worktreeDir: worktreeDir
        ) ?? localSummary
        let files = touchedFiles(
            canonical: canonical,
            input: callInput,
            worktreeDir: worktreeDir
        )
        let stats = files.reduce(into: ToolLineStats()) {
            $0 = $0 + ToolLineStats(additions: $1.additions, deletions: $1.deletions)
        }
        let serverStats = server?.lineStats.flatMap { value -> ToolLineStats? in
            guard value.additions != nil || value.deletions != nil else { return nil }
            return ToolLineStats(
                additions: value.additions ?? 0,
                deletions: value.deletions ?? 0
            )
        }
        return ToolPresentation(
            canonical: canonical,
            mcpServer: mcpServer,
            name: name,
            family: family,
            summary: summary,
            summaryIsPath: isPath,
            lineStats: serverStats ?? (stats.isEmpty ? nil : stats),
            touchedFiles: files,
            hierarchy: mcpServer.map { mcpLabelParts(server: $0, tool: name) } ?? []
        )
    }

    private static func serverSummary(
        _ detail: TranscriptToolDetail?,
        textIsPath: Bool,
        worktreeDir: String?
    ) -> (String, Bool)? {
        guard let detail, let kind = detail.kind else { return nil }
        switch kind {
        case "path":
            guard let path = nonempty(detail.path) else { return nil }
            return (tidyPath(path, worktreeDir: worktreeDir), true)
        case "paths":
            guard let paths = detail.paths else { return nil }
            let values = paths.enumerated().compactMap { index, path -> String? in
                let label = detail.labels.flatMap { labels in
                    labels.indices.contains(index) ? labels[index] : nil
                } ?? ""
                let tidy = path.isEmpty ? "" : tidyPath(path, worktreeDir: worktreeDir)
                let value = [label, tidy].filter { !$0.isEmpty }.joined(separator: " ")
                return value.isEmpty ? nil : value
            }
            var summary = values.joined(separator: "  ·  ")
            if let more = detail.more, more > 0 {
                summary += summary.isEmpty ? "+\(more)" : "  ·  +\(more)"
            }
            guard !summary.isEmpty else { return nil }
            return (summary, false)
        case "command":
            guard let command = nonempty(detail.command) else { return nil }
            return (command, false)
        case "text":
            let text = detail.text ?? ""
            let path = detail.path.map { tidyPath($0, worktreeDir: worktreeDir) } ?? ""
            let summary = [text, path].filter { !$0.isEmpty }.joined(separator: " ")
            return summary.isEmpty ? nil : (summary, textIsPath)
        case "todo":
            guard let total = detail.total, let done = detail.done else { return nil }
            let progress = "\(done)/\(total) done"
            return ([detail.current, progress].compactMap { $0 }.filter { !$0.isEmpty }
                .joined(separator: "  ·  "), false)
        case "none":
            return ("", false)
        default:
            return nil
        }
    }

    /// A leading `cd <dir> &&` only sets up the working directory. The summary
    /// shows the command that follows; the expanded view keeps the full text.
    private static let leadingCdPattern =
        #"^cd[ \t]+(?:"[^"]*"|'[^']*'|\S+)[ \t]*(?:&&|;|\n)\s*"#

    private static func stripLeadingCd(_ command: String) -> String {
        guard let range = command.range(of: leadingCdPattern, options: .regularExpression) else {
            return command
        }
        let rest = String(command[range.upperBound...])
        return rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? command : rest
    }

    private static func identifierWords(_ value: String) -> [String] {
        value
            .replacingOccurrences(
                of: "([a-z0-9])([A-Z])",
                with: "$1 $2",
                options: .regularExpression
            )
            .components(separatedBy: CharacterSet(charactersIn: " _-"))
            .filter { !$0.isEmpty }
    }

    static func mcpServerDisplayName(_ name: String) -> String {
        identifierWords(name).map { word in
            let lower = word.lowercased()
            return identifierNames[lower]
                ?? lower.prefix(1).uppercased() + String(lower.dropFirst())
        }.joined(separator: " ")
    }

    private static func mcpServerParts(_ name: String) -> [String] {
        let prefix = "opensession-"
        guard name.lowercased().hasPrefix(prefix), name.count > prefix.count else {
            return [mcpServerDisplayName(name)]
        }
        return ["Open Session", mcpServerDisplayName(String(name.dropFirst(prefix.count)))]
    }

    private static func normalizedIdentifierWords(_ value: String) -> [String] {
        identifierWords(value).map { $0.lowercased().replacingOccurrences(
            of: "s$",
            with: "",
            options: .regularExpression
        ) }
    }

    private static func withoutRepeatedScope(_ words: [String], scope: String) -> [String] {
        let normalized = words.map { $0.lowercased().replacingOccurrences(
            of: "s$",
            with: "",
            options: .regularExpression
        ) }
        let scopeWords = normalizedIdentifierWords(scope)
        guard words.count > scopeWords.count, !scopeWords.isEmpty else { return words }
        func same(at offset: Int) -> Bool {
            scopeWords.indices.allSatisfy { normalized[offset + $0] == scopeWords[$0] }
        }
        if same(at: 0) { return Array(words.dropFirst(scopeWords.count)) }
        let tail = words.count - scopeWords.count
        return same(at: tail) ? Array(words.dropLast(scopeWords.count)) : words
    }

    static func mcpLabelParts(server: String, tool: String) -> [String] {
        let parts = mcpServerParts(server)
        let rawWords = identifierWords(tool)
        let words = parts.count > 1
            ? withoutRepeatedScope(rawWords, scope: parts.last ?? "")
            : rawWords
        let leaf = words.joined(separator: "_")
        return parts + [mcpToolDisplayName(leaf.isEmpty ? tool : leaf)]
    }

    static func mcpToolDisplayName(_ name: String) -> String {
        let words = identifierWords(name).map { word in
            identifierNames[word.lowercased()] ?? word.lowercased()
        }
        guard let first = words.first else { return name }
        return (first.prefix(1).uppercased() + String(first.dropFirst())
            + (words.count > 1 ? " " + words.dropFirst().joined(separator: " ") : ""))
    }

    /// "mcp__oc__linear_list_issues" and "linear_list_issues" both resolve to
    /// server "linear", tool "list_issues".
    static func parseMcpTool(_ raw: String) -> (server: String, tool: String)? {
        var name = raw
        for prefix in ["mcp__oc__", "mcp__"] where name.hasPrefix(prefix) {
            name = String(name.dropFirst(prefix.count))
        }
        let explicit = name != raw
        if explicit {
            let parts = name.components(separatedBy: "__")
            if parts.count >= 2, !parts[0].isEmpty {
                return (parts[0], parts.dropFirst().joined(separator: "__"))
            }
        }
        guard !nativeTools.contains(name.lowercased()) else { return nil }
        guard aliases[name.lowercased()] == nil else { return nil }
        guard let underscore = name.firstIndex(of: "_") else {
            return explicit ? ("mcp", name) : nil
        }
        let server = String(name[name.startIndex..<underscore])
        let tool = String(name[name.index(after: underscore)...])
        guard !server.isEmpty, !tool.isEmpty,
              server.first?.isLetter == true,
              server.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" })
        else { return explicit ? ("mcp", name) : nil }
        return (server, tool)
    }

    static func canonicalName(_ raw: String) -> String {
        aliases[raw.lowercased()] ?? raw
    }

    /// Pi stores bridged MCP calls as an `mcp_call` envelope. Resolve the call
    /// inside it so old servers and expanded native rows show the actual tool.
    static func resolveCall(
        toolName: String,
        input: JSONValue?
    ) -> (toolName: String, input: JSONValue?) {
        guard toolName.lowercased() == "mcp_call",
              let inner = input?["name"]?.stringValue,
              !inner.isEmpty
        else { return (toolName, input) }
        guard let arguments = input?["arguments"], case .object = arguments else {
            return (inner, .object([:]))
        }
        return (inner, arguments)
    }

    // MARK: - Summaries

    private static func summarize(
        canonical: String,
        isMcp: Bool,
        input: JSONValue?,
        worktreeDir: String?
    ) -> (String, Bool) {
        // An assets write is the one MCP call whose generic summary actively
        // misleads: `content` sorts before `path`, so the row shows a slice of
        // the file's own text where the one fact worth reading — which file
        // this wrote — belongs.
        if isMcp, canonical.hasSuffix("write_asset"), let path = string(input, "path") {
            return (path, true)
        }
        guard !isMcp else { return (compactInput(input), false) }
        switch canonical {
        case "Read", "Edit", "Write":
            if let path = filePath(input) {
                return (tidyPath(path, worktreeDir: worktreeDir), true)
            }
            return (patchFilesSummary(input, worktreeDir: worktreeDir), true)
        case "FileChange":
            return (fileChangeSummary(input, worktreeDir: worktreeDir), true)
        case "Bash":
            let command = string(input, "command") ?? string(input, "cmd") ?? ""
            let flat = stripLeadingCd(command)
                .components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: " ⏎ ")
            return (String(flat.prefix(160)), false)
        case "Grep":
            let pattern = string(input, "pattern") ?? ""
            let path = string(input, "path").map { tidyPath($0, worktreeDir: worktreeDir) }
            return (["/\(pattern)/", path].compactMap { $0 }.joined(separator: " "), false)
        case "Find", "Glob":
            let pattern = string(input, "pattern") ?? ""
            let path = string(input, "path").map { tidyPath($0, worktreeDir: worktreeDir) }
            return ([pattern, path].compactMap { $0 }.joined(separator: " "), false)
        case "Task", "Agent":
            let kind = string(input, "subagent_type") ?? string(input, "subagentType")
            let description = string(input, "description") ?? string(input, "prompt") ?? ""
            if let kind, !kind.isEmpty {
                return (description.isEmpty ? kind : "\(kind): \(description)", false)
            }
            return (String(description.prefix(160)), false)
        case "Workflow":
            let value = string(input, "name") ?? string(input, "description")
            return (value ?? "orchestration script", false)
        case "Skill":
            return (string(input, "skill") ?? string(input, "name") ?? "", false)
        case "TodoWrite":
            return (todoSummary(input), false)
        case "WebFetch", "WebSearch":
            return (string(input, "url") ?? string(input, "query") ?? "", false)
        case "TaskCreate":
            return (string(input, "subject") ?? string(input, "title") ?? "", false)
        default:
            return (compactInput(input), false)
        }
    }

    /// "Wire the fold  ·  3/7 done" — the active item plus progress, so a
    /// collapsed plan row still says where the agent is.
    private static func todoSummary(_ input: JSONValue?) -> String {
        guard case .array(let todos)? = input?["todos"] ?? input?["plan"], !todos.isEmpty else {
            return compactInput(input)
        }
        var done = 0
        var active: String?
        for todo in todos {
            let status = todo["status"]?.stringValue ?? ""
            let content = todo["content"]?.stringValue
                ?? todo["step"]?.stringValue
                ?? todo["activeForm"]?.stringValue
            if status == "completed" { done += 1 }
            if active == nil, status == "in_progress" { active = content }
        }
        let progress = "\(done)/\(todos.count) done"
        guard let active, !active.isEmpty else { return progress }
        return "\(active)  ·  \(progress)"
    }

    /// Fallback for tools with no bespoke shape (MCP calls, mostly): the
    /// first few inputs as `key: value`, so the row still says something.
    private static func compactInput(_ input: JSONValue?) -> String {
        guard case .object(let dict)? = input else { return "" }
        var parts: [String] = []
        for key in dict.keys.sorted() where !hiddenInputKeys.contains(key) {
            guard let value = scalarString(dict[key]), !value.isEmpty else { continue }
            let flat = value
                .components(separatedBy: .whitespacesAndNewlines)
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            parts.append("\(key): \(String(flat.prefix(48)))")
            if parts.count == 4 { break }
        }
        return parts.joined(separator: "  ·  ")
    }

    // MARK: - Paths and line counts

    /// Repo-relative when the path sits inside the session's worktree, else
    /// `~/`-shortened. Long absolute paths are the single biggest source of
    /// unreadable tool rows on a phone.
    static func tidyPath(_ path: String, worktreeDir: String?) -> String {
        var value = path
        if let root = worktreeDir, !root.isEmpty {
            let normalized = root.hasSuffix("/") ? root : root + "/"
            if value.hasPrefix(normalized) {
                return String(value.dropFirst(normalized.count))
            }
        }
        for prefix in ["/home/", "/Users/"] where value.hasPrefix(prefix) {
            let rest = value.dropFirst(prefix.count)
            if let slash = rest.firstIndex(of: "/") {
                value = "~/" + rest[rest.index(after: slash)...]
            }
        }
        return value
    }

    private static func filePath(_ input: JSONValue?) -> String? {
        for key in ["file_path", "filePath", "path", "notebook_path", "notebookPath"] {
            if let value = string(input, key) { return value }
        }
        return nil
    }

    /// Codex-style `*** Update File: path` headers, when there's no
    /// `file_path` to read.
    private static func patchFilesSummary(_ input: JSONValue?, worktreeDir: String?) -> String {
        let paths = patchTouchedPaths(input).map { tidyPath($0.0, worktreeDir: worktreeDir) }
        guard !paths.isEmpty else { return "" }
        let shown = paths.prefix(3).joined(separator: ", ")
        return paths.count > 3 ? "\(shown) · +\(paths.count - 3)" : shown
    }

    private static func fileChangeSummary(_ input: JSONValue?, worktreeDir: String?) -> String {
        guard case .object(let dict)? = input?["changes"] ?? input else { return "" }
        let entries = dict.keys.sorted().prefix(4).map { key -> String in
            let kind = dict[key]?["kind"]?.stringValue ?? dict[key]?.stringValue ?? ""
            let path = tidyPath(key, worktreeDir: worktreeDir)
            return kind.isEmpty ? path : "\(kind) \(path)"
        }
        return entries.joined(separator: " · ")
    }

    /// `(path, additions, deletions)` for every `*** Add|Update|Delete File:`
    /// section in a codex patch body.
    private static func patchTouchedPaths(_ input: JSONValue?) -> [(String, Int, Int)] {
        let patch = string(input, "patchText")
            ?? string(input, "patch_text")
            ?? string(input, "patch")
            ?? string(input, "input")
        guard let patch, !patch.isEmpty else { return [] }
        var files: [(String, Int, Int)] = []
        var current: (String, Int, Int)?
        for line in patch.components(separatedBy: .newlines) {
            if line.hasPrefix("*** ") {
                if let open = current { files.append(open) }
                current = nil
                for marker in ["*** Add File: ", "*** Update File: ", "*** Delete File: "]
                where line.hasPrefix(marker) {
                    current = (String(line.dropFirst(marker.count)), 0, 0)
                }
                continue
            }
            guard current != nil else { continue }
            if line.hasPrefix("+") && !line.hasPrefix("+++") { current!.1 += 1 }
            if line.hasPrefix("-") && !line.hasPrefix("---") { current!.2 += 1 }
        }
        if let open = current { files.append(open) }
        return files
    }

    /// Per-file line counts derived from the tool INPUT (the result body is
    /// often just "ok"). Tools that only name paths — Bash, FileChange —
    /// deliberately contribute no counts rather than wrong ones.
    private static func touchedFiles(
        canonical: String,
        input: JSONValue?,
        worktreeDir: String?
    ) -> [TouchedFile] {
        switch canonical {
        case "Edit":
            if case .array(let edits)? = input?["edits"] {
                guard let path = filePath(input) else { return [] }
                var stats = ToolLineStats()
                var hunks: [String] = []
                for edit in edits {
                    let old = edit["old_string"]?.stringValue ?? edit["oldString"]?.stringValue
                        ?? edit["oldText"]?.stringValue
                    let new = edit["new_string"]?.stringValue ?? edit["newString"]?.stringValue
                        ?? edit["newText"]?.stringValue
                    stats = stats + ToolLineStats(
                        additions: lineCount(new),
                        deletions: lineCount(old)
                    )
                    if let hunk = unifiedHunk(old: old, new: new) { hunks.append(hunk) }
                }
                return [TouchedFile(
                    path: tidyPath(path, worktreeDir: worktreeDir),
                    additions: stats.additions,
                    deletions: stats.deletions,
                    hunks: hunks
                )]
            }
            let old = string(input, "old_string") ?? string(input, "oldString") ?? string(input, "oldText")
            let new = string(input, "new_string") ?? string(input, "newString") ?? string(input, "newText")
            if old != nil || new != nil, let path = filePath(input) {
                return [TouchedFile(
                    path: tidyPath(path, worktreeDir: worktreeDir),
                    additions: lineCount(new),
                    deletions: lineCount(old),
                    hunks: [unifiedHunk(old: old, new: new)].compactMap { $0 }
                )]
            }
            return patchTouchedPaths(input).map {
                TouchedFile(
                    path: tidyPath($0.0, worktreeDir: worktreeDir),
                    additions: $0.1,
                    deletions: $0.2
                )
            }
        case "Write":
            guard let path = filePath(input) else { return [] }
            let content = string(input, "content") ?? string(input, "contents")
            return [TouchedFile(
                path: tidyPath(path, worktreeDir: worktreeDir),
                additions: lineCount(content),
                deletions: 0,
                hunks: [unifiedHunk(old: nil, new: content)].compactMap { $0 }
            )]
        case "NotebookEdit":
            guard let path = filePath(input) else { return [] }
            return [TouchedFile(
                path: tidyPath(path, worktreeDir: worktreeDir),
                additions: lineCount(string(input, "new_source") ?? string(input, "newSource")),
                deletions: 0
            )]
        default:
            return []
        }
    }

    /// Old lines as removals then new lines as additions — the same shape the
    /// expanded Edit row renders, reused so a chip preview and the tool call
    /// never disagree about what changed.
    private static func unifiedHunk(old: String?, new: String?) -> String? {
        var lines: [String] = []
        if let old, !old.isEmpty {
            lines.append(contentsOf: old.components(separatedBy: .newlines).map { "-\($0)" })
        }
        if let new, !new.isEmpty {
            lines.append(contentsOf: new.components(separatedBy: .newlines).map { "+\($0)" })
        }
        guard !lines.isEmpty else { return nil }
        // A chip preview is for recognising a change, not auditing it.
        return lines.prefix(200).joined(separator: "\n")
    }

    private static func lineCount(_ text: String?) -> Int {
        guard let text, !text.isEmpty else { return 0 }
        return text.components(separatedBy: .newlines).count
    }

    // MARK: - JSON helpers

    private static func string(_ input: JSONValue?, _ key: String) -> String? {
        guard let value = input?[key], let text = scalarString(value), !text.isEmpty else {
            return nil
        }
        return text
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    /// Scalars render as themselves; containers are skipped (their shape is
    /// what the expanded body is for).
    private static func scalarString(_ value: JSONValue?) -> String? {
        switch value {
        case .string(let text): text
        case .number(let number):
            number == number.rounded() && abs(number) < 1e15
                ? String(Int(number)) : String(number)
        case .bool(let flag): flag ? "true" : "false"
        default: nil
        }
    }
}

// MARK: - Formatting shared with the turn header and footer

enum TranscriptFormat {
    /// "12s" / "3m 4s" / "1h 4m". Nil under a second — sub-second durations
    /// are noise, not information.
    static func duration(_ seconds: TimeInterval) -> String? {
        guard seconds >= 1 else { return nil }
        let total = Int(seconds.rounded())
        if total < 60 { return "\(total)s" }
        if total < 3600 {
            let remainder = total % 60
            return remainder == 0 ? "\(total / 60)m" : "\(total / 60)m \(remainder)s"
        }
        let minutes = (total % 3600) / 60
        return minutes == 0 ? "\(total / 3600)h" : "\(total / 3600)h \(minutes)m"
    }

    /// "840 chars" / "12 KB" — the size hint on a clamped message's expander.
    static func size(_ characters: Int) -> String {
        characters < 1024 ? "\(characters) chars" : "\(characters / 1024) KB"
    }

    /// "a.ts, b.ts +3" — two basenames then a count, like the web header.
    static func editedFiles(_ files: [TouchedFile]) -> String {
        guard !files.isEmpty else { return "" }
        let shown = files.prefix(2).map(\.basename).joined(separator: ", ")
        return files.count > 2 ? "\(shown) +\(files.count - 2)" : shown
    }

    /// "pi/anthropic/claude-sonnet-5" and "claude-sonnet-5-20250929"
    /// both read as "Sonnet 5" in the per-message attribution.
    static func modelLabel(_ raw: String) -> String {
        var slug = raw.components(separatedBy: "/").last ?? raw
        // Drop a trailing release date ("-20250929").
        if let range = slug.range(of: "-20[0-9]{6}$", options: .regularExpression) {
            slug.removeSubrange(range)
        }
        for prefix in ["claude-", "gpt-", "openai-", "anthropic-"] where slug.hasPrefix(prefix) {
            slug = String(slug.dropFirst(prefix.count))
        }
        let words = slug.components(separatedBy: CharacterSet(charactersIn: "-_"))
            .filter { !$0.isEmpty }
            .map { word -> String in
                word.allSatisfy(\.isNumber) ? word : word.prefix(1).uppercased() + word.dropFirst()
            }
        let label = words.joined(separator: " ")
        return label.isEmpty ? raw : label
    }
}
