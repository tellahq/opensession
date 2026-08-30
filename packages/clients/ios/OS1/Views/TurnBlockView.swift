import SwiftUI

/// The collapsible work fold: one header line standing in for everything a
/// turn did before it answered.
///
/// Folded is the default because the answer is what people came for. The
/// header has to carry enough for the fold to be skippable without opening
/// it — what kind of work (the family glyphs), how much (steps, duration),
/// whether it went wrong (failures, in red), and what it changed (edited
/// files and ± lines).
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

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var glyphLimit: Int {
        horizontalSizeClass == .compact ? 4 : 6
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(turn.reasoningSummaries) { entry in
                ReasoningSummaryRow(
                    entry: entry,
                    isActive: entry.id == turn.activeReasoningId
                )
                .padding(.bottom, 4)
            }

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
                VStack(alignment: .leading, spacing: 8) {
                    TurnStepsView(
                        items: turn.items,
                        sessionId: sessionId,
                        worktreeDir: worktreeDir,
                        isLive: turn.isLive,
                        showsTools: true,
                        // The turn header already summarizes a tool-only run.
                        // Opening it reveals calls directly instead of adding
                        // a second row with the same step count.
                        rendersToolCallsInPlace: turn.rendersToolCallsInPlace(
                            preference: activity
                        ),
                        expansionState: expansionState
                    )

                    touchedFileSummary
                }
                .padding(.leading, Self.foldContentInset)
                .padding(.top, 8)
                .overlay(alignment: .leading) { foldRail }
                .transition(.opacity)
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
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Where the open fold's hairline sits: under the chevron it drops from.
    private static let railInset: CGFloat = 5
    /// Where the fold's rows start: under the header's own word, clear of the
    /// rail rather than crowding it.
    private static let foldContentInset: CGFloat = 16

    /// The rail down an open fold. A turn can run for pages, and once the
    /// header has scrolled away nothing said whether a paragraph was still
    /// part of the work or already the answer. The answer sits back at the
    /// column edge with no rail beside it, so the seam reads from any scroll
    /// position. Mirrors the web viewer's turn fold.
    private var foldRail: some View {
        Rectangle()
            .fill(OS1VisualStyle.border)
            .frame(width: 1)
            .offset(x: Self.railInset)
            .accessibilityHidden(true)
    }

    /// Files named in the open fold before the rest become one chip. A
    /// refactor can touch thirty, and thirty wrapped chips would bury the
    /// steps they belong to. A phone chip carries a name and its ± counts, so
    /// two rarely share a line: there the fold names one and counts the rest.
    private static let foldFileChips = 6
    private static let phoneFoldFileChips = 1

    private var foldFileChips: Int {
        horizontalSizeClass == .compact ? Self.phoneFoldFileChips : Self.foldFileChips
    }

    /// What the turn changed, by name, closing the open fold.
    ///
    /// Shut, the header's trailing detail names the files; open, it steps
    /// aside and the fold used to say nothing about them at all — so opening
    /// a turn to see its work took away the one line saying what the work
    /// came to. These are the same chips the answer's footer ends with, and
    /// they open the same diff: the header keeps the turn's totals, these
    /// carry each file's own.
    @ViewBuilder
    private var touchedFileSummary: some View {
        if !turn.touchedFiles.isEmpty {
            FlowLayout(spacing: 6) {
                ForEach(turn.touchedFiles.prefix(foldFileChips)) { file in
                    FileChipView(file: file)
                }
                if turn.touchedFiles.count > foldFileChips {
                    MoreFilesChipView(
                        sessionId: sessionId,
                        count: turn.touchedFiles.count - foldFileChips
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var header: some View {
        Group {
            if horizontalSizeClass == .compact {
                compactHeader
            } else if dynamicTypeSize.isAccessibilitySize {
                wrappedHeader
            } else {
                singleLineHeader
            }
        }
        .foregroundStyle(OS1VisualStyle.textDim)
        #if os(iOS)
        // The label is visually one line, but its touch target still needs the
        // platform minimum. The previous 24pt frame made otherwise-working
        // folds easy to miss with a thumb.
        .frame(minHeight: 44)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
    }

    /// Phones keep the outcome, step count, and code totals visible. Tool
    /// families and changed-file names remain one tap away inside the fold.
    private var compactHeader: some View {
        // “Worked” is subheadline-sized while its counts are footnotes. Align
        // their baselines rather than the tops of two different font boxes.
        FlowLayout(spacing: 6, alignment: .firstTextBaseline) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                chevron
                Text(turn.isLive ? "Working" : "Worked")
                    .font(.subheadline.weight(.medium))
            }
            .fixedSize()

            if !counters.isEmpty {
                Text(counters)
                    .font(.footnote)
                    .fixedSize()
            }

            failureLabel
            lineStats
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var singleLineHeader: some View {
        HStack(spacing: 6) {
            chevron

            // Everything on this line is intrinsically sized, so a long turn
            // on a narrow screen used to make the header wider than the
            // transcript itself — and because a vertical ScrollView centers
            // content it can't fit, that dragged every paragraph below the
            // fold off the left edge. Fitting is now the layout's job: the
            // glyphs go first, because a symbol says the least per pixel of
            // anything here, and the numbers are what the fold is for.
            ViewThatFits(in: .horizontal) {
                summary(glyphs: glyphLimit)
                summary(glyphs: 2)
                summary(glyphs: 0)
                compressedSummary
            }
            .layoutPriority(1)

            Spacer(minLength: 6)

            trailingDetail
        }
    }

    /// At an accessibility type size no arrangement of one line fits — the
    /// stats alone can take half the width — and squeezing it turns "Worked"
    /// into "Wo…" and the counters into a lone separator. So it wraps
    /// instead: the fold is metadata, and metadata is allowed a second line.
    /// The glyphs sit this one out because they are drawn at a fixed 11pt and
    /// read as specks beside text this large, and so does the edited-file
    /// name, which the footer's chips give in full anyway.
    private var wrappedHeader: some View {
        FlowLayout(spacing: 6) {
            // One subview, so the chevron can never be left stranded on a
            // line of its own above the word it points at.
            HStack(spacing: 6) {
                chevron
                Text(turn.isLive ? "Working" : "Worked")
                    .font(.subheadline.weight(.medium))
            }
            .fixedSize()

            if !counters.isEmpty {
                Text(counters)
                    .font(.footnote)
                    .fixedSize()
            }

            if turn.failureCount > 0 {
                Text("· \(turn.failureCount) failed")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.redInk)
                    .fixedSize()
            }

            if !turn.lineStats.isEmpty {
                LineStatsView(stats: turn.lineStats)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var chevron: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(OS1VisualStyle.textFaint)
            .rotationEffect(.degrees(state.expanded ? 0 : -90))
    }

    /// What the turn did, at a given glyph budget. Rigid by construction —
    /// `ViewThatFits` picks between these by their ideal width, so a flexible
    /// child here would report the width of its untruncated text and make
    /// every candidate look too big.
    private func summary(glyphs: Int) -> some View {
        HStack(spacing: 6) {
            Text(turn.isLive ? "Working" : "Worked")
                .font(.subheadline.weight(.medium))
                .fixedSize()

            if glyphs > 0, !turn.families.isEmpty {
                HStack(spacing: 5) {
                    ForEach(turn.families.prefix(glyphs), id: \.self) { family in
                        Image(systemName: family.symbol)
                            .font(.system(size: 11))
                    }
                }
                .foregroundStyle(OS1VisualStyle.textFaint)
                .fixedSize()
            }

            Text(counters)
                .font(.footnote)
                .fixedSize()

            failureLabel
        }
    }

    /// The last resort, and the only summary with any give in it: a narrow
    /// window with nothing left to trade away. The counters yield first —
    /// they are the one piece a reader can do without — and failures hold
    /// their width to the end, because a "1 failed" cut down to "1 fa…"
    /// would be worse than not having said it.
    private var compressedSummary: some View {
        HStack(spacing: 6) {
            Text(turn.isLive ? "Working" : "Worked")
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .layoutPriority(1)

            Text(counters)
                .font(.footnote)
                .lineLimit(1)

            failureLabel
                .layoutPriority(2)
        }
    }

    @ViewBuilder
    private var failureLabel: some View {
        if turn.failureCount > 0 {
            Text("· \(turn.failureCount) failed")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.redInk)
                .fixedSize()
        }
    }

    /// "· 12s · 5 steps" — omitted pieces collapse rather than leaving
    /// stray separators.
    private var counters: String {
        var parts: [String] = []
        if let duration = turn.duration, let label = TranscriptFormat.duration(duration) {
            parts.append(label)
        }
        if turn.toolCount > 0 {
            parts.append("\(turn.toolCount) step\(turn.toolCount == 1 ? "" : "s")")
        }
        return parts.isEmpty ? "" : "· " + parts.joined(separator: " · ")
    }

    /// While a collapsed fold is live, what it is doing right now; once it
    /// settles, what it changed. Line stats hold their space, the file names
    /// truncate — a count is useless truncated, a filename still reads.
    @ViewBuilder
    private var trailingDetail: some View {
        if state.expanded {
            lineStats
        } else if turn.isLive, turn.hasNarration, let preview = turn.livePreview {
            HStack(spacing: 6) {
                Text(preview)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
                    .truncationMode(.middle)
                lineStats
            }
        } else if turn.touchedFiles.isEmpty {
            lineStats
        } else {
            // A name cut down to "….ts" is noise wearing a filename's
            // clothes, and the footer's chips name every file anyway. So
            // it shows whole, shows head-truncated while that still
            // reads, or steps aside for the counts.
            ViewThatFits(in: .horizontal) {
                editedFiles(width: nil)
                editedFiles(width: 72)
                lineStats
            }
        }
    }

    private func editedFiles(width: CGFloat?) -> some View {
        HStack(spacing: 6) {
            Text(TranscriptFormat.editedFiles(turn.touchedFiles))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .lineLimit(1)
                .truncationMode(.head)
                .frame(width: width, alignment: .trailing)
            lineStats
        }
    }

    @ViewBuilder
    private var lineStats: some View {
        if !turn.lineStats.isEmpty {
            LineStatsView(stats: turn.lineStats)
                .layoutPriority(1)
        }
    }

    private var accessibilityLabel: String {
        var parts = [turn.isLive ? "Working" : "Worked"]
        if turn.toolCount > 0 {
            parts.append("\(turn.toolCount) step\(turn.toolCount == 1 ? "" : "s")")
        }
        if let duration = turn.duration, let label = TranscriptFormat.duration(duration) {
            parts.append(label)
        }
        if turn.failureCount > 0 { parts.append("\(turn.failureCount) failed") }
        return parts.joined(separator: ", ")
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
        VStack(alignment: .leading, spacing: 8) {
            ForEach(sections) { section in
                switch section {
                case .message(let entry):
                    if entry.isReasoning == true {
                        ReasoningSummaryRow(entry: entry)
                            .padding(.trailing, 16)
                    } else {
                        // Narration is prose to read, just like the final answer.
                        // The fold and its indent distinguish it; only tool rows
                        // keep the dimmed treatment.
                        MarkdownBody(entry.text)
                            .padding(.trailing, 16)
                    }
                case .tools(let calls, let kind):
                    if showsTools {
                        if rendersToolCallsInPlace {
                            // Nothing left to disclose: a grouped row and its
                            // indent would only wrap rows already on screen.
                            // Each call still owns its own body.
                            ForEach(calls) { item in
                                ToolCallRow(
                                    item: item,
                                    sessionId: sessionId,
                                    worktreeDir: worktreeDir,
                                    state: expansionState(item.id, item.hasFeaturedMedia)
                                )
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
    /// Routine calls — shell, reads, searches, edits — behind one "N steps"
    /// line.
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
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    withAnimation(.snappy(duration: 0.2, extraBounce: 0)) {
                        state.toggle()
                    }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "square.stack")
                            .font(.system(size: 10))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .frame(width: 18)
                        // Just the count. Which tools ran is what the row is
                        // folding away, and one tap puts every step back with
                        // its own glyph, so naming them here only asks to be
                        // read twice. The names stay in the accessibility
                        // label, where the count alone would say nothing.
                        Text("\(items.count) step\(items.count == 1 ? "" : "s")")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                        // What the count cannot say: a run that edited files
                        // moved lines. Summed from the rows themselves, so
                        // opening the run adds up to what was on it.
                        if !stats.isEmpty {
                            LineStatsView(stats: stats)
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
                        }
                    }
                    #if os(iOS)
                    .frame(minHeight: 44)
                    #else
                    .padding(.vertical, 2)
                    #endif
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityHint(state.expanded ? "Hide the steps" : "Show the steps")

                if state.expanded {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(items) { item in
                            ToolCallRow(
                                item: item,
                                sessionId: sessionId,
                                worktreeDir: worktreeDir,
                                state: expansionState(item.id, false)
                            )
                        }
                    }
                    .padding(.leading, 20)
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

    private var failureCount: Int { items.filter(\.isError).count }
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
        if isLive, items.contains(where: \.isPending) { parts.append("running") }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if hasMeta {
                HStack(spacing: 8) {
                    if let duration = footer.duration,
                       let label = TranscriptFormat.duration(duration) {
                        Text(label)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .fixedSize()
                    }

                    if let model = footer.model, !model.isEmpty {
                        Text(TranscriptFormat.modelLabel(model))
                            .font(.caption2)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .lineLimit(1)
                            .fixedSize()
                    }

                    Spacer(minLength: 0)
                }
            }

            if !footer.files.isEmpty || !footer.assets.isEmpty {
                // Wrapped, not scrolled: a strip inside the transcript fights
                // the vertical drag for the same gesture and hides its
                // overflow behind an edge with nothing to say it's there, so
                // the third chip onward simply wasn't reachable. Assets stay
                // individually named because the transcript has no other way
                // into them. A phone names the first file and counts the rest,
                // which opens the complete Changes panel.
                FlowLayout(spacing: 6) {
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
            }
        }
        .padding(.top, 1)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var hasMeta: Bool {
        if footer.duration != nil { return true }
        if let model = footer.model, !model.isEmpty { return true }
        return false
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
