import SwiftUI

/// A ```tree fence as a collapsible file tree. Directories fold, the top two
/// levels open. A file row opens that file in the Changes panel when it is
/// one of the session's changed files (`FileLinks`); the app has no viewer
/// for an arbitrary repo file, so any other row is a label.
struct TreeBlockView: View {
    let nodes: [TreeNode]

    @Environment(\.openPanel) private var openPanel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Paths of folded directories, materialised on the first toggle; until
    /// then every directory follows the depth rule.
    @State private var folded: Set<String>?

    private var openable: Set<String> {
        // Subscribes to the registry the way MarkdownBody does, so a tree
        // drawn before the transcript's tool calls were read learns which
        // rows open once they are.
        _ = TranscriptLinks.shared.generation
        return openPanel.isAvailable ? FileLinks.paths(for: openPanel.sessionId) : []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TreeRows(
                nodes: nodes,
                depth: 0,
                prefix: "",
                root: TreeBlock.root(of: nodes),
                folded: folded,
                openable: openable,
                onToggle: toggle,
                onOpen: open
            )
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OS1VisualStyle.markdownCodeWell, in: BlockChrome.shape)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("File tree")
    }

    private func open(_ target: String) {
        guard let sessionId = openPanel.sessionId else { return }
        openPanel(.changes(sessionId: sessionId, path: target))
    }

    private func toggle(_ key: String, isFolded: Bool) {
        var next = folded ?? defaultFolded()
        if isFolded { next.remove(key) } else { next.insert(key) }
        if reduceMotion {
            folded = next
        } else {
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { folded = next }
        }
    }

    private func defaultFolded() -> Set<String> {
        var set: Set<String> = []
        let root = TreeBlock.root(of: nodes)
        func walk(_ nodes: [TreeNode], depth: Int, prefix: String) {
            for node in nodes where node.dir {
                let path = TreeRows.path(of: node, prefix: prefix, root: root)
                if depth > TreeBlock.openDepth { set.insert(TreeRows.key(path)) }
                walk(node.children, depth: depth + 1, prefix: path)
            }
        }
        walk(nodes, depth: 0, prefix: "")
        return set
    }
}

/// One level of the tree; nests itself for the children of an open folder.
private struct TreeRows: View {
    let nodes: [TreeNode]
    let depth: Int
    let prefix: String
    /// The lone root directory: drawn, but not part of the paths under it.
    let root: TreeNode?
    let folded: Set<String>?
    let openable: Set<String>
    let onToggle: (String, Bool) -> Void
    let onOpen: (String) -> Void

    static func path(of node: TreeNode, prefix: String, root: TreeNode?) -> String {
        if let root, node == root { return "" }
        return prefix.isEmpty ? node.name : prefix + "/" + node.name
    }

    static func key(_ path: String) -> String { path.isEmpty ? "/" : path }

    var body: some View {
        ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
            let path = Self.path(of: node, prefix: prefix, root: root)
            let key = Self.key(path)
            let isFolded = folded?.contains(key) ?? (depth > TreeBlock.openDepth)
            let target = node.dir ? nil : TreeBlock.match(path: path, in: openable)
            TreeRow(node: node, depth: depth, folded: isFolded, target: target) {
                if node.dir {
                    onToggle(key, isFolded)
                } else if let target {
                    onOpen(target)
                }
            }
            if node.dir, !node.children.isEmpty, !isFolded {
                TreeRows(
                    nodes: node.children,
                    depth: depth + 1,
                    prefix: path,
                    root: nil,
                    folded: folded,
                    openable: openable,
                    onToggle: onToggle,
                    onOpen: onOpen
                )
            }
        }
    }
}

private struct TreeRow: View {
    let node: TreeNode
    let depth: Int
    let folded: Bool
    /// The changed file this row opens, when it is one.
    let target: String?
    let action: () -> Void

    private var interactive: Bool { node.dir || target != nil }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .rotationEffect(.degrees(node.dir && !folded ? 90 : 0))
                    .opacity(node.dir ? 1 : 0)
                    .frame(width: 12)
                Image(systemName: node.dir ? (folded ? "folder" : "folder.fill") : "text.document")
                    .font(.footnote)
                    .foregroundStyle(node.dir ? OS1VisualStyle.iconTint : OS1VisualStyle.textFaint)
                    .frame(width: 16)
                Text(node.name)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(target != nil ? OS1VisualStyle.link : OS1VisualStyle.text)
                    .lineLimit(1)
                if let note = node.note {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 10 + CGFloat(depth) * 16)
            .padding(.trailing, 10)
            .frame(minHeight: 26)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!interactive)
        .accessibilityLabel(node.dir ? "\(node.name) folder" : node.name)
        .accessibilityValue(node.dir ? (folded ? "Collapsed" : "Expanded") : "")
        .accessibilityHint(target != nil ? "Opens the file in Changes" : "")
        .accessibilityAddTraits(interactive ? .isButton : .isStaticText)
    }
}
