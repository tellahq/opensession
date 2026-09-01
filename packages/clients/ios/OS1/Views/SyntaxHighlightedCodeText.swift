import HighlightSwift
import Foundation
import SwiftUI

/// Shared language inference and highlighting for native code surfaces.
/// The language set mirrors the PWA's Shiki bundle where HighlightSwift has
/// an equivalent highlight.js grammar.
enum SyntaxHighlighting {
    static let maxCharacters = 20_000

    private static let languagesByExtension: [String: String] = [
        "bash": "bash",
        "c": "c",
        "cc": "cpp",
        "cjs": "javascript",
        "cpp": "cpp",
        "cs": "csharp",
        "cts": "typescript",
        "css": "css",
        "diff": "diff",
        "go": "go",
        "h": "c",
        "hpp": "cpp",
        "html": "html",
        "htm": "html",
        "java": "java",
        "js": "javascript",
        "json": "json",
        "jsonc": "json",
        "jsx": "javascript",
        "kt": "kotlin",
        "kts": "kotlin",
        "md": "markdown",
        "mjs": "javascript",
        "mts": "typescript",
        "patch": "diff",
        "php": "php",
        "py": "python",
        "rb": "ruby",
        "rs": "rust",
        "rust": "rust",
        "scss": "scss",
        "sh": "bash",
        "sql": "sql",
        "swift": "swift",
        "toml": "toml",
        "ts": "typescript",
        "tsx": "typescript",
        "xml": "html",
        "yaml": "yaml",
        "yml": "yaml",
        "zsh": "bash",
    ]

    static func language(forPath path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let name = path.split(separator: "/").last.map(String.init) ?? path
        switch name.lowercased() {
        case "dockerfile": return "dockerfile"
        case "makefile": return "makefile"
        default: break
        }
        guard let ext = name.split(separator: ".").last, ext != Substring(name) else {
            return nil
        }
        return language(forExtension: String(ext))
    }

    static func language(forExtension ext: String?) -> String? {
        guard let ext else { return nil }
        return languagesByExtension[ext.lowercased()]
    }

    struct Gutter: Equatable {
        let labels: String
        let code: String
    }

    /// Split the two numbered output forms the PWA recognizes: Read's
    /// tab-separated line numbers and Grep's `line:` / `line-` prefixes.
    static func splitGutter(_ text: String) -> Gutter? {
        let lines = text.components(separatedBy: .newlines)
        let formats: [(pattern: String, separator: String?)] = [
            (#"^(\s*\d+)\t"#, nil),
            (#"^(\d+[-:])"#, "--"),
        ]

        for format in formats {
            let regex = try? NSRegularExpression(pattern: format.pattern)
            let matches = lines.map { line -> (full: Range<String.Index>, label: String)? in
                let range = NSRange(line.startIndex..<line.endIndex, in: line)
                guard let match = regex?.firstMatch(in: line, range: range),
                      match.numberOfRanges > 1,
                      let full = Range(match.range(at: 0), in: line),
                      let label = Range(match.range(at: 1), in: line)
                else { return nil }
                return (full, String(line[label]))
            }
            let separators = lines.map { format.separator != nil && $0 == format.separator }
            let nonEmpty = lines.filter { !$0.isEmpty }.count
            let matched = matches.compactMap { $0 }.count
                + separators.filter { $0 }.count
            guard matched > 0, Double(matched) >= Double(nonEmpty) * 0.8 else { continue }

            let width = matches.compactMap { $0?.label.count }.max() ?? 0
            var labels: [String] = []
            var code: [String] = []
            for index in lines.indices {
                if separators[index] {
                    labels.append(format.separator ?? "")
                    code.append("")
                } else if let match = matches[index] {
                    let label = match.label
                    labels.append(
                        String(repeating: " ", count: max(0, width - label.count)) + label
                    )
                    code.append(String(lines[index][match.full.upperBound...]))
                } else {
                    labels.append("")
                    code.append(lines[index])
                }
            }
            return Gutter(
                labels: labels.joined(separator: "\n"),
                code: code.joined(separator: "\n")
            )
        }
        return nil
    }

    static func attributedText(
        _ text: String,
        language: String,
        colorScheme: ColorScheme
    ) async -> AttributedString? {
        guard text.count <= maxCharacters else { return nil }
        let colors: HighlightColors = colorScheme == .dark
            ? .dark(.github)
            : .light(.github)
        return await store.attributedText(
            text,
            language: language,
            colors: colors
        )
    }

    private static let store = Store()

    private actor Store {
        private struct Key: Hashable {
            let text: String
            let language: String
            let colors: HighlightColors
        }

        private let highlighter = Highlight()
        private var cache: [Key: AttributedString] = [:]
        private var order: [Key] = []

        func attributedText(
            _ text: String,
            language: String,
            colors: HighlightColors
        ) async -> AttributedString? {
            let key = Key(text: text, language: language, colors: colors)
            if let cached = cache[key] { return cached }
            guard let value = try? await highlighter.attributedText(
                text,
                language: language,
                colors: colors
            ) else { return nil }
            if let cached = cache[key] { return cached }
            cache[key] = value
            order.append(key)
            if order.count > 300, let oldest = order.first {
                order.removeFirst()
                cache.removeValue(forKey: oldest)
            }
            return value
        }
    }
}

/// Paints plain code immediately, then replaces it with GitHub-themed syntax
/// ink once HighlightSwift finishes. Large snippets intentionally stay plain,
/// matching the PWA's guard against expensive highlighting work.
struct SyntaxHighlightedCodeText: View {
    let text: String
    let language: String
    var fallbackColor = OS1VisualStyle.codeWellText
    var gutter = false
    var requireGutter = false
    /// Optional diff-style marker kept outside the highlighted source, so a
    /// whole-file Write retains both its additions gutter and file language.
    var linePrefix: String?
    var linePrefixColor = OS1VisualStyle.codeWellGutter

    @Environment(\.colorScheme) private var colorScheme
    @State private var highlighted: AttributedString?

    private struct Request: Hashable {
        let text: String
        let language: String
        let colorScheme: ColorScheme
        let gutter: Bool
        let requireGutter: Bool
    }

    private var split: SyntaxHighlighting.Gutter? {
        gutter ? SyntaxHighlighting.splitGutter(text) : nil
    }

    private var renderedText: String {
        if requireGutter, split == nil { return text }
        return split?.code ?? text
    }

    var body: some View {
        Text(numbered)
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
            .task(
            id: Request(
                text: renderedText,
                language: language,
                colorScheme: colorScheme,
                gutter: gutter,
                requireGutter: requireGutter
            )
        ) {
            highlighted = nil
            guard !requireGutter || split != nil else { return }
            let result = await SyntaxHighlighting.attributedText(
                renderedText,
                language: language,
                colorScheme: colorScheme
            )
            guard !Task.isCancelled else { return }
            highlighted = result.map(restoringWhitespace)
        }
    }

    private var fallback: AttributedString {
        var value = AttributedString(renderedText)
        value.foregroundColor = fallbackColor
        return value
    }

    /// The highlighted body with its line numbers put back INSIDE it, one per
    /// line, rather than beside it in a second `Text`.
    ///
    /// A parallel column only lines up while nothing wraps, and this body
    /// wraps — it is read at phone width, where a column of numbers would
    /// drift a line further out of step with every line that folds. The web
    /// solves it the same way: its highlighter prepends a `.shiki-gutter`
    /// span to each line inside the same `pre`, so a wrapped continuation
    /// simply starts under its own number.
    private var numbered: AttributedString {
        let body = highlighted ?? fallback
        guard split != nil || linePrefix != nil else { return body }
        let labels = split?.labels.components(separatedBy: "\n") ?? []
        let characters = body.characters
        var output = AttributedString()
        var lineIndex = 0
        var lineStart = characters.startIndex

        func appendLine(_ range: Range<AttributedString.Index>) {
            if split != nil {
                var label = AttributedString(
                    (lineIndex < labels.count ? labels[lineIndex] : "") + "  "
                )
                label.foregroundColor = OS1VisualStyle.codeWellGutter
                output.append(label)
            }
            if let linePrefix {
                var prefix = AttributedString(linePrefix)
                prefix.foregroundColor = linePrefixColor
                output.append(prefix)
            }
            output.append(AttributedString(body[range]))
        }

        var index = characters.startIndex
        while index < characters.endIndex {
            if characters[index] == "\n" {
                appendLine(lineStart..<index)
                output.append(AttributedString("\n"))
                lineIndex += 1
                lineStart = characters.index(after: index)
            }
            index = characters.index(after: index)
        }
        appendLine(lineStart..<characters.endIndex)
        return output
    }

    /// HighlightSwift trims the input before converting its HTML. Put those
    /// exact characters back so selecting a code asset still copies its source.
    private func restoringWhitespace(_ value: AttributedString) -> AttributedString {
        let trimmed = renderedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let range = renderedText.range(of: trimmed) else {
            return fallback
        }
        var output = AttributedString(String(renderedText[..<range.lowerBound]))
        output.foregroundColor = fallbackColor
        output.append(value)
        var suffix = AttributedString(String(renderedText[range.upperBound...]))
        suffix.foregroundColor = fallbackColor
        output.append(suffix)
        return output
    }
}
