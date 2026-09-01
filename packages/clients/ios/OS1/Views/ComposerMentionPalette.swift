import SwiftUI

/// The unfinished `@token` surrounding the insertion point. Offsets use UTF-16
/// because that is the coordinate space shared by SwiftUI's text selection and
/// Foundation's safe string replacement APIs.
struct ComposerMentionContext: Equatable {
    let range: NSRange
    let query: String

    static func active(in text: String, caretUTF16Offset: Int) -> ComposerMentionContext? {
        let source = text as NSString
        guard caretUTF16Offset >= 0, caretUTF16Offset <= source.length else { return nil }
        let beforeCaret = source.substring(to: caretUTF16Offset) as NSString
        let at = beforeCaret.range(of: "@", options: .backwards)
        guard at.location != NSNotFound else { return nil }

        if at.location > 0 {
            let previous = beforeCaret.substring(with: NSRange(location: at.location - 1, length: 1))
            guard previous.rangeOfCharacter(from: .whitespacesAndNewlines) != nil else { return nil }
        }

        let queryRange = NSRange(
            location: NSMaxRange(at),
            length: caretUTF16Offset - NSMaxRange(at)
        )
        let query = beforeCaret.substring(with: queryRange)
        guard query.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
        return ComposerMentionContext(
            range: NSRange(location: at.location, length: caretUTF16Offset - at.location),
            query: query
        )
    }

    static func active(in text: String, selection: TextSelection?) -> ComposerMentionContext? {
        guard let caret = caretUTF16Offset(in: text, selection: selection) else { return nil }
        return active(in: text, caretUTF16Offset: caret)
    }

    func inserting(_ item: FileMention, into text: String) -> ComposerMentionEdit {
        let replacement = "@\(item.insert) "
        let next = (text as NSString).replacingCharacters(in: range, with: replacement)
        return ComposerMentionEdit(
            text: next,
            caretUTF16Offset: range.location + (replacement as NSString).length
        )
    }

    private static func caretUTF16Offset(in text: String, selection: TextSelection?) -> Int? {
        guard let selection else { return (text as NSString).length }
        guard case .selection(let range) = selection.indices, range.isEmpty,
              let caret = range.lowerBound.samePosition(in: text.utf16)
        else { return nil }
        return text.utf16.distance(from: text.utf16.startIndex, to: caret)
    }
}

struct ComposerMentionEdit: Equatable {
    let text: String
    let caretUTF16Offset: Int

    var selection: TextSelection {
        TextSelection(insertionPoint: String.Index(utf16Offset: caretUTF16Offset, in: text))
    }
}

struct ComposerMentionScope: Equatable {
    var sessionId: String?
    var repo: String?
}

/// Native inline `@` palette shared by the active-session input and the new
/// session composer. It stays in SwiftUI rather than wrapping UITextView, so
/// selection, dictation, undo, Dynamic Type, and accessibility remain native.
struct ComposerMentionPalette: View {
    let text: String
    let selection: TextSelection?
    let scope: ComposerMentionScope
    let onPick: (ComposerMentionEdit) -> Void

    @State private var suggestions: [FileMention] = []
    @State private var loading = false

    private var context: ComposerMentionContext? {
        ComposerMentionContext.active(in: text, selection: selection)
    }

    private var request: Request? {
        context.map { Request(query: $0.query, scope: scope) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let context, loading || !suggestions.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                        if loading, suggestions.isEmpty {
                            ProgressView()
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        ForEach(groupedSuggestions, id: \.category) { group in
                            Section {
                                ForEach(group.items) { item in
                                    Button {
                                        onPick(context.inserting(item, into: text))
                                    } label: {
                                        MentionSuggestionRow(item: item)
                                    }
                                    .buttonStyle(.plain)
                                }
                            } header: {
                                Text(group.category)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(OS1VisualStyle.textFaint)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 5)
                                    .background(OS1VisualStyle.panel)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .frame(maxHeight: 280)
                .background(
                    OS1VisualStyle.panel,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
                .accessibilityLabel("References")
                .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
            }
        }
        .animation(.smooth(duration: 0.18), value: request)
        .task(id: request) {
            guard let request else {
                suggestions = []
                loading = false
                return
            }
            loading = true
            await TeamDirectory.shared.ensureLoaded()
            let people = people(matching: request.query)
            suggestions = people
            async let palette = try? OS1API.mentionSuggestions(
                query: request.query,
                sessionId: request.scope.sessionId
            )
            async let files = try? OS1API.fileMentions(
                query: request.query,
                sessionId: request.scope.sessionId,
                repo: request.scope.repo
            )
            let (paletteResults, fileResults) = await (palette, files)
            let found = merged(
                people: people,
                palette: paletteResults ?? [],
                files: fileResults ?? []
            )
            guard !Task.isCancelled else { return }
            suggestions = found
            loading = false
        }
    }

    private var groupedSuggestions: [SuggestionGroup] {
        Dictionary(grouping: suggestions, by: \.category)
            .compactMap { category, items in SuggestionGroup(category: category, items: items) }
            .sorted { $0.items[0].categoryOrder < $1.items[0].categoryOrder }
    }

    private func people(matching query: String) -> [FileMention] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let current = ServerConfig.shared.userName.lowercased()
        return TeamDirectory.shared.names
            .filter { name in
                normalized.isEmpty
                    || name.lowercased().contains(normalized)
                    || TeamDirectory.shared.fullName(for: name).lowercased().contains(normalized)
            }
            .sorted { left, right in
                let leftIsCurrent = left.lowercased() == current
                let rightIsCurrent = right.lowercased() == current
                if leftIsCurrent != rightIsCurrent { return leftIsCurrent }
                return false
            }
            .map { name in
                FileMention(
                    display: name,
                    insert: name,
                    kind: "person",
                    sub: TeamDirectory.shared.fullName(for: name)
                )
            }
    }

    private func merged(
        people: [FileMention],
        palette: [FileMention],
        files: [FileMention]
    ) -> [FileMention] {
        var seen: Set<String> = []
        return (people + palette + files)
            .filter { seen.insert($0.id).inserted }
            .sorted { left, right in left.categoryOrder < right.categoryOrder }
    }

    private struct Request: Equatable {
        let query: String
        let scope: ComposerMentionScope
    }

    private struct SuggestionGroup {
        let category: String
        let items: [FileMention]
    }

    private struct MentionSuggestionRow: View {
        let item: FileMention

        var body: some View {
            HStack(spacing: 10) {
                if item.kind == "person" {
                    UserAvatar(person: item.display, size: 26)
                        .frame(width: 28)
                } else {
                    Image(systemName: item.symbol)
                        .font(.body)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 28)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.display)
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                        .truncationMode(item.isFile ? .head : .tail)
                    if let detail = item.detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
    }
}
