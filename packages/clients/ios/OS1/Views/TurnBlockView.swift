import SwiftUI

/// The collapsible work fold: one header line standing in for everything a
/// turn did before it answered.
///
/// Folded is the default because the answer is what people came for. The
/// header is one quiet gray line, "Worked for 12s ›". Open, the steps sit
/// flush under it and a hairline closes the fold; the step count,
/// failures and line changes head it only when the calls render flat, since
/// grouped rows already name their own. The files the turn touched are not
/// repeated here: the answer's footer right below names them.
struct TurnBlockView: View {
    let turn: WorkTurn
    let sessionId: String
    var worktreeDir: String?
    let state: TurnFoldState
    /// The two transcript preferences. The outer state owns this turn's steps;
    /// `activity.tools` owns the grouped tool runs nested inside it.
    var activity = TurnActivity.standard
    /// Resolves each nested tool row's own detail state, which must survive
    /// the row scrolling out of the lazy stack.
    let expansionState: (String, Bool) -> TurnFoldState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.22, extraBounce: 0)) {
                    state.toggle()
                }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityHint(state.expanded ? "Hide the work" : "Show the work")

            if state.expanded {
                let flatTools = turn.rendersToolCallsInPlace(preference: activity)
                VStack(alignment: .leading, spacing: 8) {
                    // Grouped rows each name their own counts and lines, so
                    // the turn-wide line above them would read as the same
                    // summary twice. It stays only when calls render flat
                    // and it is the one summary there is.
                    if flatTools {
                        foldSummary
                    }

                    TurnStepsView(
                        items: turn.items,
                        sessionId: sessionId,
                        worktreeDir: worktreeDir,
                        isLive: turn.isLive,
                        showsTools: true,
                        // The turn header already summarizes a tool-only run.
                        // Opening it reveals calls directly instead of adding
                        // a second row with the same step count.
                        rendersToolCallsInPlace: flatTools,
                        expansionState: expansionState
                    )
                }
                // The header's touch target already leaves air above the
                // first step.
                .padding(.bottom, 8)
                .overlay(alignment: .bottom) { foldEnd }
                .padding(.bottom, 4)
                .transition(.opacity)
            }

            // A page the agent showed with html_render is the answer, so
            // like a suggestion it stays whether the fold is open or shut.
            if !turn.htmlRenders.isEmpty {
                HtmlRendersView(renders: turn.htmlRenders)
            }

            // A marked screenshot or recording is the result, not the work.
            // Closing the fold hides the steps and leaves that result visible.
            if !state.expanded, !turn.featuredMedia.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ConversationImageStrip(
                        sources: turn.featuredMedia.images,
                        sessionId: sessionId
                    )
                    ConversationVideoStrip(
                        sources: turn.featuredMedia.videos,
                        sessionId: sessionId
                    )
                }
                .padding(.leading, 6)
                .padding(.top, 8)
            }

            // A proposal addressed to the reader: the agent suggests, the
            // person starts it. Unlike media it stays put when the fold
            // opens, because the row inside only names it and the card is
            // the one place to read and start it.
            if !turn.suggestedTasks.isEmpty {
                SuggestedTasksView(proposals: turn.suggestedTasks, sessionId: sessionId)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The hairline that closes an open fold, so where the work ends and the
    /// turn's final answer begins stays legible. It replaced a rail down the
    /// fold's leading edge, as on the web viewer's turn fold.
    private var foldEnd: some View {
        Rectangle()
            .fill(OS1VisualStyle.border)
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    /// "Worked for 12s ›", nothing more, in one quiet gray. The fold is
    /// skippable because the answer sits below it; what the work came to
    /// (steps, failures, lines) is one tap away at the top of the open fold.
    /// Mirrors the web's `TurnBlock` header.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(turn.headerTitle)
                    .font(.subheadline)
                    .monospacedDigit()
                chevron
            }
            .fixedSize()
            // While a closed fold is live, name the step it is on so a long
            // build never looks stalled.
            if !state.expanded, turn.isLive, let preview = turn.livePreview {
                Text(preview)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(OS1VisualStyle.textDim)
        #if os(iOS)
        // The label is visually one line, but its touch target still needs the
        // platform minimum.
        .frame(minHeight: 44)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .rotationEffect(.degrees(state.expanded ? 90 : 0))
    }

    /// The counts the header used to carry, opening the fold: "5 steps",
    /// failures in red, and the lines the work moved.
    @ViewBuilder
    private var foldSummary: some View {
        if !turn.foldCounts.isEmpty || turn.failureCount > 0 || !turn.lineStats.isEmpty {
            FlowLayout(spacing: 6, alignment: .firstTextBaseline) {
                if !turn.foldCounts.isEmpty {
                    Text(turn.foldCounts)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .fixedSize()
                }
                if turn.failureCount > 0 {
                    Text("\(turn.failureCount) failed")
                        .foregroundStyle(OS1VisualStyle.redInk)
                        .fixedSize()
                }
                if !turn.lineStats.isEmpty {
                    LineStatsView(stats: turn.lineStats)
                }
            }
            .font(.footnote)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    private var accessibilityLabel: String { turn.headerTitle }
}

extension WorkTurn {
    /// A settled turn's duration, as the header shows it.
    var durationLabel: String? {
        guard !isLive, let duration else { return nil }
        return TranscriptFormat.duration(duration)
    }

    /// "Worked for 12s", or "Working" while the turn runs.
    var headerTitle: String {
        if isLive { return "Working" }
        return durationLabel.map { "Worked for \($0)" } ?? "Worked"
    }

    /// "5 steps", or "2 messages" for a fold with narration and no tools.
    var foldCounts: String {
        if toolCount > 0 { return "\(toolCount) step\(toolCount == 1 ? "" : "s")" }
        let messages = items.filter { if case .message = $0 { true } else { false } }.count
        return messages > 0 ? "\(messages) message\(messages == 1 ? "" : "s")" : ""
    }
}

/// The inside of a turn: its narration and its tool calls, grouped into runs.
///
/// Split out of `TurnBlockView` because a review loop shows the same steps
/// without a second "Worked · N steps" header over them — the loop's own
/// disclosure already stands for that work, and nesting one worker fold inside
/// another makes a reader open two things to see one.
struct TurnStepsView: View {
    let items: [TurnItem]
    let sessionId: String
    var worktreeDir: String?
    let isLive: Bool
    /// False under the "Fold tool calls" preference with the fold shut: the
    /// narration keeps reading as transcript while the tool runs stay away.
    var showsTools = true
    /// The "Tool calls · Open" preference. It renders every call in place
    /// instead of behind a grouped row. It does NOT open the calls
    /// themselves: a tool's own body (a diff, a command's output, raw JSON)
    /// stays behind its row's disclosure, the way the web reads.
    var rendersToolCallsInPlace = false
    let expansionState: (String, Bool) -> TurnFoldState

    private enum TurnSection: Identifiable {
        case message(TranscriptEntry)
        case tools([ToolCallItem], kind: ToolRunKind)

        var id: String {
            switch self {
            case .message(let entry): entry.id
            case .tools(let items, _): "tools-\(items.first?.id ?? "empty")"
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(sections) { section in
                switch section {
                case .message(let entry):
                    if entry.isReasoning == true {
                        ReasoningSummaryRow(
                            entry: entry,
                            isActive: entry.id == activeReasoningId
                        )
                        .padding(.trailing, 16)
                    } else {
                        // Narration is prose to read, just like the final answer.
                        // The fold and its indent distinguish it; only tool rows
                        // keep the dimmed treatment.
                        MarkdownBody(entry.text)
                            .environment(\.transcriptAnchorEntryId, entry.id)
                            .padding(.trailing, 16)
                    }
                case .tools(let calls, let kind):
                    if showsTools {
                        if rendersToolCallsInPlace {
                            // Nothing left to disclose: a grouped row and its
                            // indent would only wrap rows already on screen.
                            // Each call still owns its own body.
                            VStack(alignment: .leading, spacing: ToolRowMetrics.rowSpacing) {
                                ForEach(calls) { item in
                                    ToolCallRow(
                                        item: item,
                                        sessionId: sessionId,
                                        worktreeDir: worktreeDir,
                                        state: expansionState(item.id, item.hasFeaturedMedia)
                                    )
                                }
                            }
                        } else {
                            ToolRunView(
                                items: calls,
                                sessionId: sessionId,
                                worktreeDir: worktreeDir,
                                state: expansionState("run-\(calls[0].id)", false),
                                isLive: isLive,
                                // A run of one has nothing to fold: "1 step"
                                // hides a call behind a tap and says less
                                // than the call's own row does.
                                isCompact: kind == .compact && calls.count > 1,
                                expansionState: expansionState
                            )
                        }
                    }
                }
            }
        }
    }

    /// The thinking still under way: the turn's newest message, while it is
    /// thinking (web: `activeReasoning`). Once narration follows it, that
    /// thought is over and keeps no live label above the prose after it.
    private var activeReasoningId: String? {
        guard isLive else { return nil }
        let lastMessage = items.reversed().lazy.compactMap { item -> TranscriptEntry? in
            guard case .message(let entry) = item else { return nil }
            return entry
        }.first
        guard let lastMessage, lastMessage.isReasoning == true else { return nil }
        return lastMessage.id
    }

    private var sections: [TurnSection] {
        var sections: [TurnSection] = []
        for item in items {
            switch item {
            case .message(let entry):
                sections.append(.message(entry))
            case .tool(let call):
                let kind = runKind(call)
                if let last = sections.last,
                   case .tools(let existing, let lastKind) = last,
                   lastKind == kind,
                   kind.groups {
                    var tools = existing
                    tools.append(call)
                    sections[sections.count - 1] = .tools(tools, kind: kind)
                } else {
                    sections.append(.tools([call], kind: kind))
                }
            }
        }
        return sections
    }

    /// Which run, if any, a call joins. With tool calls folded, the step row
    /// stands for the turn's work, so every call joins it — a spawned worker,
    /// an MCP call and a shell command are all one step, and one tap puts
    /// them back with their own glyphs and chips. A worker's transcript is
    /// still a row away, where a row outside the run only made the count lie
    /// and split one run into three. Edits join too, as they do on the web:
    /// four passes over a file are as mechanical as the shell calls around
    /// them, and giving them their own run left a turn as a ladder of
    /// alternating rows. What an edit adds is its ± lines, which the run's
    /// own counts carry for the whole stretch.
    private func runKind(_ item: ToolCallItem) -> ToolRunKind {
        guard item.assetPath == nil,
              // Media the agent asked to show keeps its own row, as everywhere.
              item.result?.featuredMedia?.isEmpty != false
        else { return .single }
        return .compact
    }
}

/// What kind of run a consecutive stretch of tool calls forms.
private enum ToolRunKind: Equatable {
    /// Routine calls (shell, reads, searches, edits) behind one summary
    /// line: "Ran 3 commands, read 2 files".
    case compact
    /// Stands on its own: an asset write, anything with media — a row whose
    /// content the fold would hide rather than summarize.
    case single

    /// Whether a neighbour of the same kind joins, or starts its own run.
    var groups: Bool {
        if case .single = self { return false }
        return true
    }
}

private struct ToolRunView: View {
    let items: [ToolCallItem]
    let sessionId: String
    var worktreeDir: String?
    let state: TurnFoldState
    let isLive: Bool
    let isCompact: Bool
    let expansionState: (String, Bool) -> TurnFoldState

    var body: some View {
        if isCompact {
            VStack(alignment: .leading, spacing: ToolRowMetrics.rowSpacing) {
                Button {
                    withAnimation(.snappy(duration: 0.2, extraBounce: 0)) {
                        state.toggle()
                    }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: ToolRowMetrics.iconSpacing) {
                        // Open, the row heads the steps under it, so it
                        // takes the chevron rather than a stack of what is
                        // already on screen (as on the web).
                        ToolRowIcon(
                            symbol: state.expanded ? "chevron.down" : "rectangle.stack"
                        )
                        // What the run did, as a sentence: "Ran 3 commands,
                        // read 2 files". Which calls those were is what the
                        // row folds away; one tap puts each back with its own
                        // glyph. The tool names stay in the accessibility
                        // label.
                        Text(summaryTitle)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                            .layoutPriority(1)
                        // What the sentence cannot say: a run that edited
                        // files moved lines. Summed from the rows themselves,
                        // so opening the run adds up to what was on it.
                        if !stats.isEmpty {
                            LineStatsView(stats: stats, font: ToolRowMetrics.metaFont)
                        }
                        // Folded, the sentence alone hides what the run is
                        // waiting on, so a long build looked stalled. Name
                        // the step still running.
                        if let runningStep {
                            Text(runningStep.presentation.stepLabel)
                                .font(.footnote)
                                .foregroundStyle(OS1VisualStyle.textFaint)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 4)
                        if mediaCount > 0 {
                            Text(mediaLabel)
                                .font(.caption2)
                                .foregroundStyle(OS1VisualStyle.textFaint)
                                .fixedSize()
                        }
                        if failureCount > 0 {
                            Text("\(failureCount) failed")
                                .font(.caption2)
                                .foregroundStyle(OS1VisualStyle.redInk)
                                .fixedSize()
                        }
                        if isLive, items.contains(where: \.isPending) {
                            ProgressView()
                                .controlSize(.mini)
                                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        }
                    }
                    .toolRowFrame()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityHint(state.expanded ? "Hide the steps" : "Show the steps")

                if state.expanded {
                    VStack(alignment: .leading, spacing: ToolRowMetrics.rowSpacing) {
                        ForEach(items) { item in
                            ToolCallRow(
                                item: item,
                                sessionId: sessionId,
                                worktreeDir: worktreeDir,
                                state: expansionState(item.id, false)
                            )
                        }
                    }
                    // A small step in, so the calls read as the run's own
                    // without spending a phone's width on a deep indent.
                    .padding(.leading, ToolRowMetrics.nestedIndent)
                    .transition(.opacity)
                }
            }
        } else if let item = items.first {
            ToolCallRow(
                item: item,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: expansionState(item.id, item.hasFeaturedMedia)
            )
        }
    }

    private var label: String {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for item in items {
            let name = item.presentation.label
            if counts[name] == nil { order.append(name) }
            counts[name, default: 0] += 1
        }
        return order.map { name in
            let count = counts[name, default: 0]
            return count > 1 ? "\(name) ×\(count)" : name
        }.joined(separator: " · ")
    }

    private var summaryTitle: String {
        let title = WorkSummary.title(items)
        return title.isEmpty ? "\(items.count) step\(items.count == 1 ? "" : "s")" : title
    }
    private var failureCount: Int { items.filter(\.isError).count }
    private var runningStep: ToolCallItem? {
        guard isLive, !state.expanded else { return nil }
        return items.last(where: \.isPending)
    }
    private var stats: ToolLineStats {
        items.reduce(ToolLineStats()) { $0 + ($1.presentation.lineStats ?? ToolLineStats()) }
    }
    private var media: TranscriptMedia {
        items.reduce(into: TranscriptMedia()) {
            $0.images.append(contentsOf: $1.media.images)
            $0.videos.append(contentsOf: $1.media.videos)
        }
    }
    private var mediaCount: Int { media.count }
    private var mediaLabel: String { media.label }
    private var accessibilityLabel: String {
        var parts = ["\(items.count) grouped steps", label]
        if !stats.isEmpty {
            parts.append("plus \(stats.additions), minus \(stats.deletions)")
        }
        if failureCount > 0 { parts.append("\(failureCount) failed") }
        if mediaCount > 0 { parts.append(mediaLabel) }
        if isLive, let step = items.last(where: \.isPending) {
            parts.append("running \(step.presentation.stepLabel)")
        }
        return parts.joined(separator: ", ")
    }
}

/// `+40 −12`. Both halves are omitted when zero — a bare `+0` reads as a
/// claim that nothing changed, which is different from "no counts known".
struct LineStatsView: View {
    let stats: ToolLineStats
    /// The footer's chips run a step above the tool rows, and the counts
    /// belong to the name they sit beside rather than to a fixed size.
    var font: Font = .caption2.weight(.medium)

    var body: some View {
        // `verbatim`, because the interpolating initializer takes a
        // LocalizedStringKey and formats an Int through the current locale:
        // 2933 changed lines came out as "+2.933" on a Dutch device, which
        // reads as a decimal rather than a count.
        HStack(spacing: 4) {
            if stats.additions > 0 {
                Text(verbatim: "+\(stats.additions)")
                    .foregroundStyle(OS1VisualStyle.greenInk)
            }
            if stats.deletions > 0 {
                Text(verbatim: "−\(stats.deletions)")
                    .foregroundStyle(OS1VisualStyle.redInk)
            }
        }
        .font(font)
        .monospacedDigit()
        .fixedSize()
    }
}

// MARK: - Turn footer

/// The metadata row closing a settled turn: how long it took, which model
/// wrote it, and which files it touched.
struct TurnFooterView: View {
    let footer: TurnFooter
    /// Whose scratch folder the asset chips open into.
    let sessionId: String
    /// "Duplicate from here", as on the web footer's ⋯.
    var onFork: (() -> Void)? = nil

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// How many chips a footer draws before it points at the whole list
    /// instead. A refactor can touch thirty files, and thirty wrapped chips
    /// would bury the answer they belong to.
    private static let chipLimit = 8

    /// A phone chip carries a name and its ± counts, so two rarely share a
    /// line and four became a column under every answer. One name plus the
    /// count of the rest keeps the footer to a single row, matching the web.
    private static let phoneChipLimit = 1

    private var chipLimit: Int {
        horizontalSizeClass == .compact ? Self.phoneChipLimit : Self.chipLimit
    }

    /// Assets come first and are never cut. A touched file is named in the
    /// Changes list too, so the chip is a shortcut; a scratch file the turn
    /// wrote is named nowhere else in the transcript, so the chip is the
    /// only way to it.
    private var shownFiles: [TouchedFile] {
        Array(footer.files.prefix(max(0, chipLimit - footer.assets.count)))
    }

    private var hiddenFileCount: Int {
        footer.files.count - shownFiles.count
    }

    @State private var copied = false

    var body: some View {
        // One wrapped row, as the web's TurnFooter: how long the turn took,
        // copy and ⋯ (when, which model, every changed file), then the
        // assets and touched files. The model name lives in the menu, so
        // the row under every answer stays short.
        FlowLayout(spacing: 6, alignment: .center) {
            if let duration = footer.duration,
               let label = TranscriptFormat.duration(duration) {
                Text(label)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .fixedSize()
                    .frame(height: 28)
                    .padding(.leading, 2)
            }
            if !footer.text.isEmpty {
                Button {
                    copyToPasteboard(footer.text)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(copied ? OS1VisualStyle.greenInk : OS1VisualStyle.textFaint)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied" : "Copy message")
            }
            Menu {
                if let onFork {
                    Button(action: onFork) {
                        Label("Duplicate from here", systemImage: "doc.on.doc")
                    }
                    Divider()
                }
                if let timestamp = footer.timestamp {
                    Label(
                        timestamp.formatted(date: .abbreviated, time: .shortened),
                        systemImage: "clock"
                    )
                }
                if let model = footer.model, !model.isEmpty {
                    Label(
                        "Written by \(TranscriptFormat.modelLabel(model))",
                        systemImage: "sparkles"
                    )
                }
                if !footer.files.isEmpty {
                    Section("Changed files") {
                        ForEach(footer.files.prefix(20)) { file in
                            Text(verbatim: "\(file.basename)  +\(file.additions) −\(file.deletions)")
                        }
                        if footer.files.count > 20 {
                            Text(verbatim: "+\(footer.files.count - 20) more")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("More message actions")
            ForEach(footer.assets, id: \.self) { path in
                AssetChipView(sessionId: sessionId, path: path)
            }
            ForEach(shownFiles) { file in
                FileChipView(file: file)
            }
            if hiddenFileCount > 0 {
                MoreFilesChipView(
                    sessionId: sessionId,
                    count: hiddenFileCount
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 1)
        .padding(.bottom, 2)
    }
}

/// The one shell the footer's three chips share, so a change to the surface
/// can never leave a footer wearing two generations of chip at once. The web
/// keeps the same promise with a single `CHIP` class string.
///
/// A pill, like the web's: `rounded-control` is 12px, and on a chip this tall
/// the two corners of an edge cannot both fit, so the authored radius has
/// always clamped to half the height and drawn a capsule.
///
/// Squircle ends rather than circular ones, because that is the pill base.css
/// authors: it grants `corner-shape: squircle` to every `rounded-*` class, so
/// Chrome carries the chip's width further into each end before turning. See
/// `SquircleCapsule` for the curve and for why `Capsule` cannot draw it.
private extension View {
    func footerChip(leading: CGFloat, trailing: CGFloat) -> some View {
        self
            .padding(.leading, leading)
            .padding(.trailing, trailing)
            .padding(.vertical, 4)
            .background(OS1VisualStyle.chipFill, in: SquircleCapsule())
    }
}

/// The files the footer didn't have room to name, as one chip that opens all
/// of them. A cut that admits how much it cut and where the rest went.
struct MoreFilesChipView: View {
    let sessionId: String
    let count: Int

    @Environment(\.openPanel) private var openPanel

    var body: some View {
        Button {
            openPanel(.changes(sessionId: sessionId))
        } label: {
            Text("+\(count) more")
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .footerChip(leading: 9, trailing: 9)
        }
        .buttonStyle(.plain)
        // The Mac app installs no handler; a chip that does nothing when
        // tapped is worse than one that plainly can't be.
        .disabled(!openPanel.isAvailable)
        .accessibilityLabel("\(count) more files")
        .accessibilityHint("Opens everything this session changed")
    }
}

/// One touched file: its language mark, the basename, and its ±.
///
/// Tapping opens what actually changed. On a phone the chips are the only
/// place a turn's edits are named, and a name without a diff is a dead end.
struct FileChipView: View {
    let file: TouchedFile
    @State private var showingDiff = false

    var body: some View {
        Button {
            guard !file.hunks.isEmpty else { return }
            showingDiff = true
        } label: {
            chip
        }
        .buttonStyle(.plain)
        .disabled(file.hunks.isEmpty)
        .sheet(isPresented: $showingDiff) {
            FileDiffSheet(file: file)
        }
    }

    private var chip: some View {
        HStack(spacing: 6) {
            ExtBadge(name: file.basename)
            Text(file.basename)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
            if file.additions > 0 || file.deletions > 0 {
                LineStatsView(
                    stats: ToolLineStats(
                        additions: file.additions,
                        deletions: file.deletions
                    ),
                    font: .caption.weight(.medium)
                )
            }
        }
        .footerChip(leading: 4, trailing: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: file.path))
        .accessibilityValue(Text(changeSummary))
    }

    /// The counts as words. `.combine` would otherwise read the ± glyphs, and
    /// the label above replaces them with the path to say WHICH file this is.
    private var changeSummary: String {
        var parts: [String] = []
        if file.additions > 0 { parts.append("\(file.additions) added") }
        if file.deletions > 0 { parts.append("\(file.deletions) removed") }
        return parts.joined(separator: ", ")
    }
}

/// One scratch file the turn wrote: the kind's glyph and the file's name.
///
/// Tapping opens the file itself, the same way the tool row's chip does — a
/// picture over the conversation, anything else one level deeper (see
/// `AssetOpen`) — so an artifact can be checked where it was announced instead
/// of hunted for in the Assets tab. Assets live outside every worktree, so
/// unlike a touched file there is no diff to show and nothing else in the app
/// knows what the path means.
struct AssetChipView: View {
    let sessionId: String
    let path: String

    @Environment(\.openPanel) private var openPanel
    /// The file this chip lifted over the conversation.
    @State private var assetOverlay: AssetOverlayItem?

    private var asset: OS1API.SessionAsset {
        OS1API.SessionAsset(path: path, size: 0, mtime: "")
    }

    var body: some View {
        Button {
            AssetOpen.open(
                sessionId: sessionId,
                path: path,
                overlay: $assetOverlay
            )
        } label: {
            chip
        }
        .buttonStyle(.plain)
        // The Mac app can open neither kind; a chip that does nothing when
        // tapped is worse than one that plainly can't be.
        .disabled(!AssetOpen.canOpen(path))
        .assetOverlayPreview($assetOverlay, openPanel: openPanel)
        .accessibilityLabel(Text(verbatim: asset.name))
        .accessibilityHint("Opens this file")
    }

    private var chip: some View {
        HStack(spacing: 6) {
            Image(systemName: AssetKind.of(asset).symbol)
                .font(.system(size: 10))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(minWidth: 13)
            Text(asset.name)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
        }
        .footerChip(leading: 8, trailing: 8)
        .accessibilityElement(children: .combine)
    }
}

/// What one file's edits did, reusing the tool row's diff rendering so a chip
/// preview and the Edit call it came from never disagree.
struct FileDiffSheet: View {
    let file: TouchedFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Text(file.path)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .textSelection(.enabled)
                        Spacer(minLength: 8)
                        LineStatsView(
                            stats: ToolLineStats(
                                additions: file.additions,
                                deletions: file.deletions
                            )
                        )
                    }
                    ForEach(Array(file.hunks.enumerated()), id: \.offset) { index, hunk in
                        ToolCodeBox(label: file.hunks.count > 1 ? "Change \(index + 1)" : "Diff") {
                            DiffText(patch: hunk)
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(OS1VisualStyle.background.ignoresSafeArea())
            .navigationTitle(file.basename)
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topTrailingCompat) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
