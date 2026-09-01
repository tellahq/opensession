import SwiftUI

/// One tool call: a single summary line that expands into a rendering shaped
/// for that particular tool — a diff for an edit, a command for a shell call,
/// file content for a write. Raw JSON is the fallback, never the default.
struct ToolCallRow: View {
    let item: ToolCallItem
    let sessionId: String
    var worktreeDir: String?
    let state: TurnFoldState

    /// Built once per expansion and cached: parsing tool input to synthesize
    /// a diff must never happen inside `body`.
    @State private var detail: ToolDetail?
    /// The worker sheet opened from a Task row.
    @State private var openWorker: WorkerLink?
    /// The file an asset chip lifted over the conversation.
    @State private var assetOverlay: AssetOverlayItem?
    /// Installed by the iOS session screen; absent everywhere else, which is
    /// what lets the cover offer "Show in Assets" when a stack is available.
    @Environment(\.openPanel) private var openPanel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var presentation: ToolPresentation { item.presentation }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                withAnimation(.snappy(duration: 0.2, extraBounce: 0)) {
                    state.toggle()
                }
            } label: {
                summaryRow
            }
            .buttonStyle(.plain)

            if state.expanded {
                detailBody
                    .padding(.leading, 22)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: detailKey) {
            guard state.expanded, detail == nil else { return }
            let hydratedResultText: String?
            if let result = item.result, result.contentClamped == true {
                hydratedResultText = try? await OS1API.fullEntryContent(
                    sessionId: sessionId,
                    entryId: result.id
                )
            } else {
                hydratedResultText = nil
            }
            guard !Task.isCancelled else { return }
            detail = ToolDetail.make(
                item: item,
                hydratedResultText: hydratedResultText
            )
        }
        .onChange(of: item.result?.id) { _, _ in detail = nil }
        .sheet(item: $openWorker) { link in
            SubagentView(
                sessionId: sessionId,
                agentId: link.id,
                worktreeDir: worktreeDir
            )
        }
        .assetOverlayPreview($assetOverlay, openPanel: openPanel)
    }

    /// Identifies the sheet's subject; `sheet(item:)` needs Identifiable.
    private struct WorkerLink: Identifiable { let id: String }

    /// The row's drill-in: a worker's transcript, a written file. One pill for
    /// both, so a row that leads somewhere always says so the same way.
    private struct RowChip: View {
        let title: String
        let action: () -> Void

        var body: some View {
            Button(action: action) {
                HStack(spacing: 3) {
                    Text(title)
                    Image(systemName: "arrow.up.right")
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                // The row's summary takes every point it can get, which on a
                // phone leaves the chip narrow enough to break "Open" across
                // two lines; the label is two syllables, so it holds its size
                // and the summary truncates instead.
                .fixedSize()
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .overlay {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private var detailKey: String {
        "\(item.id)|\(state.expanded)|\(item.result?.id ?? "")"
    }

    // MARK: - Summary line

    private var summaryRow: some View {
        HStack(spacing: 7) {
            // The glyph doubles as the disclosure control: it turns into a
            // chevron when open, which costs no width on a phone.
            Image(systemName: state.expanded ? "chevron.down" : presentation.family.symbol)
                .font(.system(size: 11))
                .foregroundStyle(
                    item.isError ? OS1VisualStyle.red : OS1VisualStyle.textFaint
                )
                .frame(width: 15)

            // "server · tool", the way the web writes it. The server used to
            // wear a filled pill, but `panel` is `.tertiarySystemBackground` —
            // pure white in light appearance — so it read as a white box
            // punched into the row rather than as part of the call's name.
            //
            // Priority rather than `fixedSize`: the name outranks the summary
            // and takes its width first, but it still has to yield to the row.
            // An MCP call carries its server too — "opensession-walkthrough ·
            // publish_walkthrough" measures 340pt against a 344pt row on a
            // phone — and rigid at that width it made the row wider than the
            // transcript. A vertical `ScrollView` does not clamp content it
            // can't fit, it CENTERS it, so that one row dragged every
            // paragraph in the turn off both edges and took the margin with
            // it.
            nameText
                .lineLimit(1)
                // The tool is the half worth keeping; the server prefix
                // repeats down the fold.
                .truncationMode(.middle)
                .layoutPriority(1)

            if !presentation.summary.isEmpty {
                summaryText
            }

            Spacer(minLength: 4)

            // A Task call is otherwise a dead end: the row says a worker was
            // spawned and nothing says what it did.
            if let agentId = item.subagentId {
                RowChip(title: item.isPending ? "Watch" : "Open") {
                    openWorker = WorkerLink(id: agentId)
                }
                .accessibilityLabel("Open this sub-agent's transcript")
            }

            // Same dead end for a written asset: the row names a file the
            // conversation itself can't show. The chip opens the file itself —
            // a picture over the conversation, anything else one level deeper
            // (see AssetOpen).
            if let assetPath = item.assetPath,
               AssetOpen.canOpen(assetPath) {
                RowChip(title: "Open") {
                    AssetOpen.open(
                        sessionId: sessionId,
                        path: assetPath,
                        overlay: $assetOverlay
                    )
                }
                .accessibilityLabel("Open this file")
            }

            if let stats = presentation.lineStats {
                LineStatsView(stats: stats)
            }

            // What the call cost, in the trailing meta the web puts it in.
            // Anything under a second and a half is noise rather than
            // information, so it stays off the row (same floor as the viewer).
            if let label = item.durationLabel {
                Text(label)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .fixedSize()
            }

            statusGlyph
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(presentation.displayName). \(presentation.summary)")
    }

    private var nameText: some View {
        let fullParts = presentation.labelParts
        let parts = horizontalSizeClass == .compact
            && fullParts.first == "Open Session"
            && fullParts.count > 2
            ? Array(fullParts.dropFirst())
            : fullParts
        return HStack(spacing: 4) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                if index > 0 {
                    Text("·")
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .fixedSize()
                }
                let isContext = index < parts.count - 1
                Text(part)
                    .font(.subheadline.weight(isContext ? .regular : .medium))
                    .foregroundStyle(
                        isContext ? OS1VisualStyle.textFaint : OS1VisualStyle.textDim
                    )
                    .fixedSize(horizontal: isContext, vertical: false)
            }
        }
    }

    private var summaryText: some View {
        ToolSummaryText(
            summary: presentation.summary,
            isPath: presentation.summaryIsPath,
            isError: item.isError
        )
    }

    @ViewBuilder
    private var statusGlyph: some View {
        if item.isPending {
            ProgressView()
                .controlSize(.mini)
        } else if item.isError {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.red)
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detailBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let detail {
                if detail.inputKind != .none {
                    let inputLines = ToolCodeMetrics.lines(detail.inputText)
                    switch detail.inputKind {
                    case .diff:
                        ToolCodeBox(label: detail.inputLabel, lines: inputLines) {
                            DiffText(patch: detail.inputText)
                        }
                    case .additionDiff:
                        ToolCodeBox(label: detail.inputLabel, lines: inputLines) {
                            SyntaxHighlightedCodeText(
                                text: detail.inputText,
                                language: detail.inputLanguage ?? "plaintext",
                                linePrefix: "+",
                                linePrefixColor: OS1VisualStyle.codeWellAdd
                            )
                        }
                    case .code, .json:
                        ToolCodeBox(label: detail.inputLabel, lines: inputLines) {
                            SyntaxHighlightedCodeText(
                                text: detail.inputText,
                                language: detail.inputLanguage ?? "plaintext"
                            )
                        }
                    case .none:
                        EmptyView()
                    }
                }
                ConversationImageStrip(
                    sources: item.media.images,
                    sessionId: sessionId,
                    size: 120,
                    cornerRadius: 10
                )
                ConversationVideoStrip(
                    sources: item.media.videos,
                    sessionId: sessionId,
                    maxWidth: 480,
                    cornerRadius: 10
                )
                if let result = detail.resultText {
                    ToolCodeBox(
                        label: detail.resultLabel,
                        isError: item.isError,
                        lines: ToolCodeMetrics.lines(result)
                    ) {
                        if detail.resultIsDiff {
                            DiffText(patch: result)
                        } else if let language = detail.resultLanguage {
                            SyntaxHighlightedCodeText(
                                text: result,
                                language: language,
                                gutter: detail.resultHasGutter,
                                requireGutter: detail.resultRequiresGutter
                            )
                        } else {
                            PlainCodeText(text: result, isError: item.isError)
                        }
                    }
                }
            } else {
                ProgressView().controlSize(.mini)
            }
        }
    }
}

/// What a call is doing, on the row's own line. A path's directory dims, and
/// middle truncation keeps both its beginning and filename visible only when
/// the full path cannot fit.
struct ToolSummaryText: View {
    let summary: String
    let isPath: Bool
    var isError = false

    var body: some View {
        Group {
            if isPath, let slash = summary.lastIndex(of: "/") {
                Text(summary[summary.startIndex...slash])
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    + Text(summary[summary.index(after: slash)...])
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else {
                Text(summary)
                    .foregroundStyle(
                        isError ? OS1VisualStyle.redInk : OS1VisualStyle.textFaint
                    )
            }
        }
        .font(.system(.caption, design: .monospaced))
        .lineLimit(1)
        .truncationMode(isPath ? .middle : .tail)
    }
}

// MARK: - Code surfaces

/// A labelled code pane, using the same theme-following GitHub well as the PWA.
///
/// The body WRAPS, as the web's does. It used to sit in a horizontal scroll
/// view, which on a phone put the tail of every command and every output line
/// off the right edge behind a gesture nobody makes — and the fixed 260pt
/// height it carried clipped the rest outright, with no way to reach it. A
/// long body is clamped to a readable stub with a disclosure instead, so
/// nothing is unreachable and one call still can't swallow the screen.
struct ToolCodeBox<Content: View>: View {
    let label: String
    var isError = false
    /// Roughly how many rendered lines the body needs — the caller has the
    /// text, this view only has an opaque `Content`. See `ToolCodeMetrics`.
    var lines = 0
    @ViewBuilder var content: Content

    @State private var showingAll = false

    /// About what the web's 320px cap holds at this type size.
    private static var collapsedLines: Int { 18 }

    private var clamped: Bool { lines > Self.collapsedLines }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(
                    isError ? OS1VisualStyle.redInk : OS1VisualStyle.textFaint
                )
            VStack(alignment: .leading, spacing: 6) {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(clamped && !showingAll ? Self.collapsedLines : nil)
                if clamped {
                    Button(showingAll ? "Show less" : "Show more") {
                        withAnimation(.snappy(duration: 0.2, extraBounce: 0)) {
                            showingAll.toggle()
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                }
            }
            .padding(8)
            .background(
                OS1VisualStyle.codeWell,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(
                        isError
                            ? OS1VisualStyle.red.opacity(0.35)
                            : OS1VisualStyle.codeWellBorder,
                        lineWidth: 0.5
                    )
            }
        }
    }
}

enum ToolCodeMetrics {
    /// Roughly how many lines a monospaced body occupies once it wraps. The
    /// column count is deliberately narrower than a phone actually fits, so
    /// the estimate errs toward offering the disclosure on a body that didn't
    /// need it rather than clamping one that did with no way to open it.
    static func lines(_ text: String, columns: Int = 40) -> Int {
        text.components(separatedBy: .newlines).reduce(0) { total, line in
            total + max(1, (line.count + columns - 1) / columns)
        }
    }
}

/// Mono text on the dark surface. Kept as ONE `Text` so selection can span
/// lines and so a long body is one layout pass rather than hundreds.
struct PlainCodeText: View {
    let text: String
    var isError = false

    var body: some View {
        Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(
                isError
                    ? OS1VisualStyle.redInk.opacity(0.85)
                    : OS1VisualStyle.codeWellText
            )
            .textSelection(.enabled)
    }
}

/// A unified diff, tinted per line.
///
/// One `AttributedString` in a single `Text`, not a view per line: an edit to
/// a large file would otherwise put hundreds of `HStack`s inside a row inside
/// a lazy stack. The trade-off is that the tint follows the glyphs instead of
/// painting a full-width bar — so each line keeps its `+`/`-` gutter
/// character, which is what actually survives at this size anyway.
struct DiffText: View {
    let patch: String
    /// Inside a transcript row a long diff is for reading the shape of a
    /// change, not auditing it — but the Changes view IS the audit, so it
    /// raises the cap rather than sending people to the browser.
    var maxLines = 300

    var body: some View {
        Text(attributed)
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
    }

    private var attributed: AttributedString {
        var output = AttributedString()
        let lines = patch.components(separatedBy: .newlines)
        for line in lines.prefix(maxLines) {
            var piece = AttributedString(line.isEmpty ? " " : line)
            piece.foregroundColor = Self.color(for: line)
            output.append(piece)
            output.append(AttributedString("\n"))
        }
        if lines.count > maxLines {
            var more = AttributedString("… \(lines.count - maxLines) more lines")
            more.foregroundColor = OS1VisualStyle.codeWellGutter
            output.append(more)
        }
        return output
    }

    /// Every colour here resolves per appearance. They were white at three
    /// opacities plus the chrome's status palette, which is a dark-theme set:
    /// on a light well the context lines were white on near-white — invisible —
    /// and the ± lines sat around 2:1.
    private static func color(for line: String) -> Color {
        if line.hasPrefix("+++") || line.hasPrefix("---") {
            return OS1VisualStyle.codeWellGutter
        }
        if line.hasPrefix("+") { return OS1VisualStyle.codeWellAdd }
        if line.hasPrefix("-") { return OS1VisualStyle.codeWellRemove }
        if line.hasPrefix("@@") || line.hasPrefix("*** ") {
            return OS1VisualStyle.codeWellHunk
        }
        return OS1VisualStyle.codeWellText
    }
}

// MARK: - Bespoke bodies

/// What a tool call's expanded view should show, resolved per tool.
struct ToolDetail: Equatable {
    enum Kind: Equatable { case none, code, diff, additionDiff, json }

    var inputKind: Kind = .none
    var inputLabel = "Input"
    var inputText = ""
    var inputLanguage: String?
    var resultLabel = "Output"
    var resultText: String?
    var resultIsDiff = false
    var resultLanguage: String?
    var resultHasGutter = false
    var resultRequiresGutter = false

    private static let maxBodyCharacters = 4000

    static func make(
        item: ToolCallItem,
        hydratedResultText: String? = nil
    ) -> ToolDetail {
        var detail = ToolDetail()
        let canonical = item.presentation.canonical
        let input = ToolPresentation.resolveCall(
            toolName: item.use?.toolName ?? "",
            input: item.use?.toolInput
        ).input

        switch canonical {
        case "Bash":
            detail.inputKind = .code
            detail.inputLabel = "Command"
            detail.inputText = bashBody(input)
            detail.inputLanguage = "bash"
        case "Edit":
            if let patch = diffBody(input) {
                detail.inputKind = .diff
                detail.inputLabel = "Diff"
                detail.inputText = patch
            } else {
                detail.inputKind = .json
                detail.inputText = clamp(input?.pretty ?? "")
                detail.inputLanguage = "json"
            }
        case "Write":
            if let content = writeContent(input) {
                detail.inputKind = .additionDiff
                detail.inputLabel = "Diff"
                detail.inputText = clamp(content)
                detail.inputLanguage = SyntaxHighlighting.language(forPath: filePath(input))
                    ?? "markdown"
            } else {
                detail.inputKind = .json
                detail.inputText = clamp(input?.pretty ?? "")
                detail.inputLanguage = "json"
            }
        case "Read":
            // The path is already in the summary line; only extra arguments
            // (offset, limit) are worth repeating.
            let extras = otherKeys(input, ignoring: [
                "file_path", "filePath", "path", "notebook_path", "notebookPath",
            ])
            if !extras.isEmpty {
                detail.inputKind = .json
                detail.inputText = extras
                detail.inputLanguage = "json"
            }
        default:
            if case .object(let dict)? = input, !dict.isEmpty {
                detail.inputKind = .json
                detail.inputText = clamp(input?.pretty ?? "")
                detail.inputLanguage = "json"
            }
        }

        if let result = item.result {
            let text = (hydratedResultText ?? result.text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let hasMedia = !result.media.isEmpty
            // "Image read successfully." next to the image it describes is
            // noise; the image is the result.
            let redundant = hasMedia && text == "Image read successfully."
            if !redundant {
                detail.resultLabel = item.isError
                    ? "Error"
                    : (result.contentClamped == true && hydratedResultText == nil
                        ? "Output (truncated)"
                        : "Output")
                detail.resultText = text.isEmpty
                    ? (hasMedia ? nil : "(empty)")
                    : clamp(text)
                detail.resultIsDiff = looksLikeDiff(text)
                if !item.isError, !detail.resultIsDiff {
                    switch canonical {
                    case "Read":
                        detail.resultLanguage = SyntaxHighlighting.language(
                            forPath: filePath(input)
                        )
                        detail.resultHasGutter = detail.resultLanguage != nil
                    case "Grep":
                        detail.resultLanguage = grepLanguage(input)
                        detail.resultHasGutter = detail.resultLanguage != nil
                        detail.resultRequiresGutter = detail.resultLanguage != nil
                    default:
                        break
                    }
                }
            }
        }
        return detail
    }

    /// The command, with the model's own description carried above it as
    /// shell comments so the metadata survives inside valid bash.
    private static func bashBody(_ input: JSONValue?) -> String {
        var lines: [String] = []
        if let description = string(input, "description") {
            lines.append("# \(description)")
        }
        for key in ["timeout", "cwd", "workdir", "run_in_background"] {
            if let value = string(input, key) { lines.append("# \(key): \(value)") }
        }
        let command = string(input, "command") ?? string(input, "cmd") ?? ""
        lines.append(command)
        return clamp(lines.joined(separator: "\n"))
    }

    /// A real patch when the engine sent one, else a synthesized unified diff
    /// from the old/new strings — the shape of the change is what an edit row
    /// is for, and two opaque blobs of text don't show it.
    private static func diffBody(_ input: JSONValue?) -> String? {
        for key in ["patchText", "patch_text", "patch", "diff"] {
            if let patch = string(input, key) { return clamp(patch) }
        }
        if case .array(let edits)? = input?["edits"], !edits.isEmpty {
            let hunks = edits.compactMap { edit -> String? in
                synthesize(
                    old: edit["old_string"]?.stringValue ?? edit["oldString"]?.stringValue
                        ?? edit["oldText"]?.stringValue,
                    new: edit["new_string"]?.stringValue ?? edit["newString"]?.stringValue
                        ?? edit["newText"]?.stringValue
                )
            }
            return hunks.isEmpty ? nil : clamp(hunks.joined(separator: "\n@@\n"))
        }
        return synthesize(
            old: string(input, "old_string") ?? string(input, "oldString") ?? string(input, "oldText"),
            new: string(input, "new_string") ?? string(input, "newString") ?? string(input, "newText")
        ).map(clamp)
    }

    private static func synthesize(old: String?, new: String?) -> String? {
        guard old != nil || new != nil else { return nil }
        var lines: [String] = []
        if let old, !old.isEmpty {
            lines.append(contentsOf: old.components(separatedBy: .newlines).map { "-\($0)" })
        }
        if let new, !new.isEmpty {
            lines.append(contentsOf: new.components(separatedBy: .newlines).map { "+\($0)" })
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    private static func looksLikeDiff(_ text: String) -> Bool {
        if text.hasPrefix("diff --git") { return true }
        return text.range(of: "^@@ -[0-9]", options: [.regularExpression]) != nil
    }

    private static func otherKeys(_ input: JSONValue?, ignoring: Set<String>) -> String {
        guard case .object(let dict)? = input else { return "" }
        let remaining = dict.keys.sorted().filter { !ignoring.contains($0) }
        guard !remaining.isEmpty else { return "" }
        return remaining
            .map { "\($0): \(dict[$0]!.pretty.trimmingCharacters(in: .whitespacesAndNewlines))" }
            .joined(separator: "\n")
    }

    private static func filePath(_ input: JSONValue?) -> String? {
        for key in ["file_path", "filePath", "path", "notebook_path", "notebookPath"] {
            if let path = string(input, key) { return path }
        }
        return nil
    }

    private static func grepLanguage(_ input: JSONValue?) -> String? {
        if let language = SyntaxHighlighting.language(forPath: filePath(input)) {
            return language
        }
        for key in ["glob", "include"] {
            if let pattern = string(input, key),
               let ext = pattern.range(
                   of: #"\.([A-Za-z0-9]+)$"#,
                   options: .regularExpression
               ).map({ String(pattern[$0]).dropFirst() }) {
                return SyntaxHighlighting.language(forExtension: String(ext))
            }
        }
        return SyntaxHighlighting.language(forExtension: string(input, "type"))
    }

    /// Unlike ordinary string arguments, an empty Write body is meaningful: it
    /// creates an empty file and still gets an additions gutter in the row.
    private static func writeContent(_ input: JSONValue?) -> String? {
        for key in ["content", "contents"] {
            if case .string(let value)? = input?[key] { return value }
        }
        return nil
    }

    private static func string(_ input: JSONValue?, _ key: String) -> String? {
        guard let value = input?[key]?.stringValue, !value.isEmpty else { return nil }
        return value
    }

    private static func clamp(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > maxBodyCharacters else { return trimmed }
        return String(trimmed.prefix(maxBodyCharacters)) + "\n… truncated"
    }
}
