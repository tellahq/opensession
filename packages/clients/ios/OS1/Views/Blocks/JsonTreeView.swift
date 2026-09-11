import SwiftUI

/// A large ```json fence as a collapsible tree: the root and its children
/// open, anything deeper folded behind its count, and a Tree / Raw toggle
/// that swaps to the highlighted text. Copy still copies the JSON text.
struct JsonTreeView: View {
    let root: JsonNode
    let raw: String

    @State private var showRaw = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        BlockWell(label: "JSON", symbol: "curlybraces") {
            BlockControl(showRaw ? "Tree" : "Raw", symbol: showRaw ? "list.bullet.indent" : "text.alignleft") {
                if reduceMotion {
                    showRaw.toggle()
                } else {
                    withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { showRaw.toggle() }
                }
            }
            CopyBlockControl(text: raw)
        } content: {
            if showRaw {
                SyntaxHighlightedCodeText(text: raw, language: "json")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    JsonNodeRows(node: root, key: nil, depth: 0, path: "")
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            }
        }
        .accessibilityLabel("JSON")
    }
}

private struct JsonNodeRows: View {
    let node: JsonNode
    let key: String?
    let depth: Int
    let path: String

    @State private var folded: Bool?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isFolded: Bool { folded ?? (depth >= JsonTreeBlock.collapseDepth) }

    var body: some View {
        if node.isContainer {
            row(open: !isFolded)
            if !isFolded {
                children
                closing
            }
        } else {
            row(open: false)
        }
    }

    private func row(open: Bool) -> some View {
        let container = node.isContainer
        return Button {
            guard container else { return }
            if reduceMotion {
                folded = !isFolded
            } else {
                withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { folded = !isFolded }
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .opacity(container ? 1 : 0)
                    .frame(width: 12)
                Text(line(open: open))
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(container ? 1 : nil)
                Spacer(minLength: 0)
            }
            .padding(.leading, 10 + CGFloat(depth) * 14)
            .padding(.trailing, 10)
            .frame(minHeight: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!container)
        .accessibilityLabel(accessibilityText)
        .accessibilityValue(container ? (open ? "Expanded" : "Collapsed") : "")
        .accessibilityAddTraits(container ? .isButton : .isStaticText)
    }

    @ViewBuilder
    private var children: some View {
        switch node {
        case .array(let items):
            ForEach(Array(items.prefix(JsonTreeBlock.maxChildren).enumerated()), id: \.offset) { index, item in
                JsonNodeRows(node: item, key: nil, depth: depth + 1, path: path + "/\(index)")
            }
            overflow(items.count)
        case .object(let entries):
            ForEach(Array(entries.prefix(JsonTreeBlock.maxChildren).enumerated()), id: \.offset) { _, entry in
                JsonNodeRows(node: entry.value, key: entry.key, depth: depth + 1, path: path + "/" + entry.key)
            }
            overflow(entries.count)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func overflow(_ count: Int) -> some View {
        if count > JsonTreeBlock.maxChildren {
            Text("… \(count - JsonTreeBlock.maxChildren) more")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .padding(.leading, 26 + CGFloat(depth + 1) * 14)
                .frame(minHeight: 20)
        }
    }

    private var closing: some View {
        Text(node.childCount == 0 ? "" : (isArray ? "]" : "}"))
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(OS1VisualStyle.textDim)
            .padding(.leading, 26 + CGFloat(depth) * 14)
            .frame(minHeight: node.childCount == 0 ? 0 : 20)
    }

    private var isArray: Bool {
        if case .array = node { return true }
        return false
    }

    private func line(open: Bool) -> AttributedString {
        var out = AttributedString()
        if let key {
            var name = AttributedString("\"\(key)\"")
            name.foregroundColor = OS1VisualStyle.text
            out.append(name)
            var colon = AttributedString(": ")
            colon.foregroundColor = OS1VisualStyle.textDim
            out.append(colon)
        }
        var value: AttributedString
        switch node {
        case .null:
            value = AttributedString("null")
            value.foregroundColor = OS1VisualStyle.purpleInk
        case .bool(let flag):
            value = AttributedString(flag ? "true" : "false")
            value.foregroundColor = OS1VisualStyle.purpleInk
        case .number(let text):
            value = AttributedString(text)
            value.foregroundColor = OS1VisualStyle.blueInk
        case .string(let text):
            value = AttributedString("\"\(text)\"")
            value.foregroundColor = OS1VisualStyle.greenInk
        case .array, .object:
            if node.childCount == 0 {
                value = AttributedString(isArray ? "[]" : "{}")
            } else if open {
                value = AttributedString(isArray ? "[" : "{")
            } else {
                value = AttributedString(JsonTreeBlock.summary(of: node))
            }
            value.foregroundColor = OS1VisualStyle.textDim
        }
        out.append(value)
        return out
    }

    private var accessibilityText: String {
        let name = key.map { "\($0): " } ?? ""
        switch node {
        case .null: return name + "null"
        case .bool(let flag): return name + (flag ? "true" : "false")
        case .number(let text): return name + text
        case .string(let text): return name + text
        case .array, .object: return name + JsonTreeBlock.summary(of: node)
        }
    }
}
