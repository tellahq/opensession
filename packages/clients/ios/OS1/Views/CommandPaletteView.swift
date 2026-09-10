import SwiftUI

#if os(macOS)
import AppKit

/// A palette row and what selecting it does.
struct CommandPaletteItem: Identifiable {
    let entry: CommandPaletteEntry
    let run: () -> Void

    var id: String { entry.id }
}

/// What the person has typed and what is highlighted.
///
/// A class rather than `@State` on the view, because the arrow keys are read
/// by an `NSEvent` monitor: a monitor closure captures the view struct once,
/// and a write it makes to a captured `@State` lands in the box without
/// invalidating anything — measured, with the selection jumping two rows the
/// next time an unrelated update repainted the palette. An observable object
/// publishes from wherever it is mutated.
@Observable
@MainActor
final class CommandPaletteModel {
    var query = ""
    /// Whatever the arrows last landed on. `nil` means "the first result",
    /// which is also where a new query leaves it.
    var selectedID: String?
    /// The rows as of the host's last update, so a row created since the
    /// palette opened is still the row Return runs.
    var items: [CommandPaletteItem] = []
    var transcriptSnippets: [String: String] = [:]
    var searchingTranscripts = false
    private var transcriptSearchRevision = 0

    var results: [CommandPaletteEntry] {
        let contentMatches = Set(transcriptSnippets.keys.map { "session:\($0)" })
        let ranked = CommandPaletteRanking.results(
            items.map(\.entry),
            query: query,
            contentMatches: contentMatches
        )
        return ranked.map { entry in
            guard entry.kind == .session, entry.id.hasPrefix("session:"),
                  let snippet = transcriptSnippets[String(entry.id.dropFirst(8))],
                  CommandPaletteRanking.results([entry], query: query).isEmpty
            else { return entry }
            var contentMatch = entry
            contentMatch.subtitle = snippet
            return contentMatch
        }
    }

    func updateTranscriptSearch() async {
        transcriptSearchRevision += 1
        let revision = transcriptSearchRevision
        let searched = query.trimmingCharacters(in: .whitespacesAndNewlines)
        transcriptSnippets = [:]
        guard searched.count >= 2 else {
            searchingTranscripts = false
            return
        }
        searchingTranscripts = true
        do {
            try await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let matches = try await OS1API.searchTranscripts(searched)
            guard !Task.isCancelled, revision == transcriptSearchRevision,
                  searched == query.trimmingCharacters(in: .whitespacesAndNewlines)
            else { return }
            var next: [String: String] = [:]
            for match in matches where next[match.id] == nil {
                next[match.id] = match.snippet
            }
            transcriptSnippets = next
        } catch {
            // Local command and session metadata search remains available.
        }
        if revision == transcriptSearchRevision { searchingTranscripts = false }
    }

    /// The highlighted row: a query that drops the selected row must not leave
    /// Return pointing at nothing.
    var selection: String? {
        if let selectedID, results.contains(where: { $0.id == selectedID }) {
            return selectedID
        }
        return results.first?.id
    }

    func move(_ offset: Int) {
        let rows = results
        guard !rows.isEmpty else { return }
        let current = rows.firstIndex { $0.id == selection } ?? 0
        selectedID = rows[min(max(current + offset, 0), rows.count - 1)].id
    }

    func item(_ id: String) -> CommandPaletteItem? {
        items.first { $0.id == id }
    }
}

/// Command-K on the Mac: type a few letters, land on a session or run a
/// command.
///
/// The Mac window is a sidebar and a session. Everything else it can reach —
/// the Desk, the support queue, archived sessions, settings — is a button in
/// the sidebar header or a menu item, and the sessions themselves are a list
/// long enough that finding one is a scroll. The palette is the one control
/// that reaches all of it from the keyboard.
///
/// Its rows are this app's own data, not a copy of the web palette's list. A
/// destination the native app does not have (Notes, Tasks, Reports, Catch up,
/// the session panels the iPhone pushes) gets no row: an entry that opens
/// nothing is worse than an entry that isn't there.
///
/// Presented as a sheet. It was an overlay over the split view first, which is
/// the shape a palette wants — but a SwiftUI overlay on the Mac's
/// `NavigationSplitView` does not repaint: the rows were laid out and nothing
/// was drawn until an unrelated change dirtied the window. The host parks what
/// a row does and runs it once this has dismissed, so the rows that open a
/// sheet of their own still work.
struct CommandPaletteView: View {
    let items: [CommandPaletteItem]
    let onRun: (CommandPaletteItem) -> Void
    let onClose: () -> Void

    @State private var model = CommandPaletteModel()
    @State private var keyMonitor: Any?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            field
            Divider()
            if model.results.isEmpty {
                empty
            } else {
                list
            }
            Divider()
            footer
        }
        .frame(width: 620, height: 460)
        .background(OS1VisualStyle.background)
        .onChange(of: items.map(\.id), initial: true) { model.items = items }
        .onAppear {
            installKeyMonitor()
            #if DEBUG
            // Screenshot hook, paired with the host's OS1_COMMAND_PALETTE_QUERY
            // that opens the sheet.
            if let query = ProcessInfo.processInfo.environment["OS1_COMMAND_PALETTE_QUERY"] {
                model.query = query
            }
            #endif
        }
        .onDisappear { removeKeyMonitor() }
        .task(id: model.query) { await model.updateTranscriptSearch() }
        .task {
            // The field is created in the same frame the sheet is, and focus
            // asked for in `onAppear` lands before it exists.
            try? await Task.sleep(for: .milliseconds(40))
            fieldFocused = true
        }
    }

    private var field: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15))
                .foregroundStyle(OS1VisualStyle.textFaint)
            TextField("Search sessions and commands", text: $model.query)
                .textFieldStyle(.plain)
                .font(.system(size: 17))
                .focused($fieldFocused)
                // Return is the key monitor's, which runs the selected row.
                .onSubmit {}
        }
        .padding(.horizontal, 16)
        .frame(height: 50)
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(model.results) { entry in
                        CommandPaletteRow(
                            entry: entry,
                            selected: entry.id == model.selection
                        )
                        .id(entry.id)
                        .contentShape(Rectangle())
                        .onTapGesture { activate(entry.id) }
                        .onHover { inside in
                            if inside { model.selectedID = entry.id }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
            }
            .onChange(of: model.selection) { _, id in
                guard let id else { return }
                proxy.scrollTo(id, anchor: .center)
            }
        }
    }

    private var empty: some View {
        VStack {
            Spacer()
            Text("No matches")
                .font(.system(size: 13))
                .foregroundStyle(OS1VisualStyle.textDim)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    /// The keys this palette is listening for, said once at the bottom instead
    /// of on every row.
    private var footer: some View {
        HStack(spacing: 12) {
            hint("↑↓", "Move")
            hint("↩", "Open")
            hint("esc", "Close")
            Spacer()
            if model.searchingTranscripts {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Searching conversations")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 30)
    }

    private func hint(_ keys: String, _ label: String) -> some View {
        HStack(spacing: 5) {
            KeyCap(text: keys, selected: false)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
    }

    private func activate(_ id: String) {
        guard let item = model.item(id) else { return }
        onRun(item)
    }

    /// Arrow keys and Return belong to the list, but focus is in the text
    /// field, which eats both. A local monitor is how this app already reads
    /// keys out from under a focused field (see the composer's Shift-Return
    /// handling) — it sees the event first and consumes what it uses.
    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            MainActor.assumeIsolated {
                // An arrow key is not a bare keypress: macOS puts `.function`
                // and `.numericPad` in its modifier flags, so a plain
                // `isEmpty` check passes every arrow through to the field,
                // which moves its caret and leaves the selection where it was.
                let mods = event.modifierFlags
                    .intersection(.deviceIndependentFlagsMask)
                    .subtracting([.capsLock, .function, .numericPad])
                guard mods.isEmpty else { return event }
                switch event.keyCode {
                case 125: model.move(1); return nil
                case 126: model.move(-1); return nil
                case 36, 76:
                    if let id = model.selection { activate(id) }
                    return nil
                case 53: onClose(); return nil
                default: return event
                }
            }
        }
    }

    private func removeKeyMonitor() {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
    }
}

private struct CommandPaletteRow: View {
    let entry: CommandPaletteEntry
    let selected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: entry.symbol)
                .font(.system(size: 14))
                .frame(width: 18)
                .foregroundStyle(selected ? Color.white : OS1VisualStyle.textDim)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: entry.title)
                    .font(.system(size: 13))
                    .foregroundStyle(selected ? Color.white : OS1VisualStyle.text)
                    .lineLimit(1)
                if let subtitle = entry.subtitle, !subtitle.isEmpty {
                    Text(verbatim: subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(
                            selected
                                ? Color.white.opacity(0.75)
                                : OS1VisualStyle.textFaint
                        )
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            ForEach(Array(entry.shortcut.enumerated()), id: \.offset) { _, key in
                KeyCap(text: key, selected: selected)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color(nsColor: .selectedContentBackgroundColor))
            }
        }
    }
}

/// One key, drawn as a cap. Keeps its contrast on a selected row, where the
/// dim border and dim ink both disappear into the accent fill.
private struct KeyCap: View {
    let text: String
    let selected: Bool

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(selected ? Color.white : OS1VisualStyle.textDim)
            .frame(minWidth: 18)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background {
                RoundedRectangle(cornerRadius: 4)
                    .fill(
                        selected
                            ? Color.white.opacity(0.22)
                            : OS1VisualStyle.hover
                    )
            }
    }
}

#endif
