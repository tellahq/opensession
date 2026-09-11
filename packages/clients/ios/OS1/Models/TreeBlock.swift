import Foundation

/// File trees: a ```tree fence holds either an indented listing (two spaces
/// or a tab per level, a trailing `/` marks a directory) or `tree` CLI output
/// with its box-drawing connectors (docs/blocks.md, "File trees"). Mirrors
/// the web's `lib/tree-block.ts`.
struct TreeNode: Equatable {
    var name: String
    var dir: Bool
    /// A trailing `# note` on the line, shown dim beside the name.
    var note: String?
    var children: [TreeNode] = []
}

enum TreeBlock {
    /// Directories this deep and shallower start open (root is depth 0).
    static let openDepth = 1
    static let maxLines = 400

    private struct ParsedLine {
        let depth: Int
        let name: String
        let dir: Bool
        let note: String?
    }

    /// `├── `, `└── ` and their ASCII spellings (`|-- `, `` `-- ``).
    private static let connector = try! NSRegularExpression(pattern: #"(?:├|└|\||`)[─-]{2}\s?"#)
    /// One level of a `tree` prefix: `│   `, `|   ` or four blanks.
    private static let prefixUnit = try! NSRegularExpression(pattern: #"^(?:[│|] {0,3}| {4})"#)
    private static let summary = try! NSRegularExpression(
        pattern: #"^\d+ director(?:y|ies)(?:, \d+ files?)?$"#
    )

    /// Both grammars, decided by whether any line carries a `tree` connector.
    /// Nil for anything else: mixed forms, a level skipped, a box line whose
    /// prefix does not divide into levels, or nothing at all.
    static func parse(_ source: String) -> [TreeNode]? {
        let lines = source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                var text = String(line)
                while let last = text.last, last.isWhitespace { text.removeLast() }
                return text
            }
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.isEmpty && !matches(summary, trimmed)
            }
        guard !lines.isEmpty, lines.count <= maxLines else { return nil }
        let boxed = lines.contains { matches(connector, $0) }
        let unit = indentUnit(lines)
        var parsed: [ParsedLine] = []
        for line in lines {
            guard let entry = boxed ? parseBoxLine(line) : parseIndentedLine(line, unit: unit) else {
                return nil
            }
            parsed.append(entry)
        }
        guard parsed.first?.depth == 0 else { return nil }
        return nest(parsed)
    }

    /// A lone top-level directory names the tree and is not part of the paths
    /// under it; otherwise the fence itself is the root.
    static func root(of nodes: [TreeNode]) -> TreeNode? {
        nodes.count == 1 && nodes[0].dir ? nodes[0] : nil
    }

    /// The session file a tree row stands for. An exact path wins; otherwise a
    /// tree rooted below the repo (`src/` drawn as the root) matches the one
    /// changed file that ends in the row's path.
    static func match(path: String, in candidates: Set<String>) -> String? {
        var clean = path
        if clean.hasPrefix("./") { clean.removeFirst(2) } else if clean.hasPrefix("/") { clean.removeFirst() }
        if candidates.contains(clean) { return clean }
        let suffix = "/" + clean
        let tails = candidates.filter { $0.hasSuffix(suffix) }
        return tails.count == 1 ? tails.first : nil
    }

    // MARK: - Lines

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func splitName(_ raw: String) -> (name: String, dir: Bool, note: String?) {
        var text = raw.trimmingCharacters(in: .whitespaces)
        var note: String?
        if let range = text.range(of: #"\s+#\s"#, options: .regularExpression),
           range.lowerBound > text.startIndex {
            let tail = text[range.upperBound...].trimmingCharacters(in: .whitespaces)
            note = tail.isEmpty ? nil : tail
            text = text[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
        }
        // `tree -F` marks executables and links too; only the directory mark
        // matters here, the rest is dropped so the name reads clean.
        let dir = text.hasSuffix("/")
        if let last = text.last, "/*@=|>".contains(last) { text.removeLast() }
        return (text.trimmingCharacters(in: .whitespaces), dir, note)
    }

    private static func parseBoxLine(_ line: String) -> ParsedLine? {
        let whole = NSRange(line.startIndex..., in: line)
        guard let hit = connector.firstMatch(in: line, range: whole),
              let at = Range(hit.range, in: line)
        else {
            // A root line: no connector, no prefix.
            if let first = line.first, first.isWhitespace || first == "│" || first == "|" { return nil }
            let parts = splitName(line)
            return ParsedLine(depth: 0, name: parts.name, dir: parts.dir, note: parts.note)
        }
        var prefix = String(line[..<at.lowerBound])
        var depth = 1
        while !prefix.isEmpty {
            let range = NSRange(prefix.startIndex..., in: prefix)
            guard let unit = prefixUnit.firstMatch(in: prefix, range: range),
                  let unitRange = Range(unit.range, in: prefix),
                  !unitRange.isEmpty
            else {
                // A short run of blanks right before the connector is still a level.
                if prefix.allSatisfy({ $0 == " " }) { depth += 1 } else { return nil }
                break
            }
            prefix = String(prefix[unitRange.upperBound...])
            depth += 1
        }
        let parts = splitName(String(line[at.upperBound...]))
        guard !parts.name.isEmpty else { return nil }
        return ParsedLine(depth: depth, name: parts.name, dir: parts.dir, note: parts.note)
    }

    private static func parseIndentedLine(_ line: String, unit: Int) -> ParsedLine? {
        let lead = line.prefix { $0 == " " || $0 == "\t" }
        let spaces = lead.reduce(0) { $0 + ($1 == "\t" ? unit : 1) }
        guard spaces % unit == 0 else { return nil }
        let parts = splitName(String(line.dropFirst(lead.count)))
        guard !parts.name.isEmpty, let first = parts.name.first,
              !"│├└─".contains(first)
        else { return nil }
        return ParsedLine(depth: spaces / unit, name: parts.name, dir: parts.dir, note: parts.note)
    }

    private static func indentUnit(_ lines: [String]) -> Int {
        var unit = 0
        for line in lines {
            let lead = line.prefix { $0 == " " || $0 == "\t" }
            if lead.isEmpty { continue }
            let width = lead.contains("\t") ? 2 * lead.count : lead.count
            unit = unit == 0 ? width : min(unit, width)
        }
        return unit == 0 ? 2 : unit
    }

    private static func nest(_ lines: [ParsedLine]) -> [TreeNode]? {
        var roots: [TreeNode] = []
        // Indices into the tree, root first: the path to the node last added.
        var stack: [[Int]] = []
        for line in lines {
            if line.depth > stack.count { return nil }
            stack.removeLast(stack.count - line.depth)
            let node = TreeNode(name: line.name, dir: line.dir, note: line.note)
            if let parent = stack.last {
                let index = insert(node, under: parent, in: &roots)
                stack.append(parent + [index])
            } else {
                roots.append(node)
                stack.append([roots.count - 1])
            }
        }
        return roots
    }

    private static func insert(_ node: TreeNode, under path: [Int], in roots: inout [TreeNode]) -> Int {
        func walk(_ nodes: inout [TreeNode], _ path: ArraySlice<Int>) -> Int {
            guard let head = path.first else { fatalError("empty path") }
            if path.count == 1 {
                nodes[head].dir = true
                nodes[head].children.append(node)
                return nodes[head].children.count - 1
            }
            return walk(&nodes[head].children, path.dropFirst())
        }
        return walk(&roots, path[...])
    }
}
