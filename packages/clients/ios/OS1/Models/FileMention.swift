import Foundation

/// One `@`-mention target from `GET /api/files`: a file, directory, skill,
/// session or teammate. `insert` is what follows the "@" in a prompt (a
/// repo-relative path, `repo:path` for an attached repo, or `session:<id>`);
/// `display` is the readable form the picker lists.
struct FileMention: Decodable, Sendable, Identifiable, Equatable {
    var display: String
    var insert: String
    /// Set only when more than one repo was searched, so the row can say which.
    var repo: String?
    /// Absent means a file.
    var kind: String?
    /// Secondary context, such as a branch or tool description.
    var sub: String?

    init(
        display: String,
        insert: String,
        repo: String? = nil,
        kind: String? = nil,
        sub: String? = nil
    ) {
        self.display = display
        self.insert = insert
        self.repo = repo
        self.kind = kind
        self.sub = sub
    }

    var id: String { "\(kind ?? "file"):\(insert)" }
    var isFile: Bool { kind == nil || kind == "dir" }

    var detail: String? {
        if let sub, !sub.isEmpty, sub.caseInsensitiveCompare(display) != .orderedSame {
            return sub
        }
        if let repo, !repo.isEmpty { return repo }
        return nil
    }

    var category: String {
        switch kind {
        case "person": "People"
        case "tool": "Tools"
        case "workspace": "Workspaces"
        case "session": "Sessions"
        case "skill": "Skills"
        default: "Files"
        }
    }

    var categoryOrder: Int {
        switch kind {
        case "person": 0
        case "tool": 1
        case "workspace": 2
        case "session": 3
        case "skill": 5
        default: 4
        }
    }

    var symbol: String {
        switch kind {
        case "dir": "folder"
        case "session": "bubble.left.and.bubble.right"
        case "workspace": "rectangle.stack"
        case "tool": "wrench.and.screwdriver"
        case "skill": "sparkles"
        case "person": "person.crop.circle"
        default: "text.document"
        }
    }
}
